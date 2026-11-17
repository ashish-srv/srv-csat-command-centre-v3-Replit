const { PostgresStore } = require('./postgres-store');
const { explicitOptOut } = require('./whatsapp-recipients');
const { deliveryEvent, retryBlock } = require('./broadcast-delivery');

const statusRank = status => ({ accepted: 0, sent: 10, failed: 15, delivered: 20, read: 30 }[status] ?? -1);
// A shared-number chat cannot be split into separate cluster conversations.
// Require access to every linked cluster before exposing that shared history.
const visibleSql = `($1::uuid[] is null or (jsonb_array_length(r.associations)>0 and not exists(
  select 1 from jsonb_array_elements(r.associations) a where not coalesce(a->>'clusterId'=any($1::text[]),false))))`;

class BroadcastRepository {
  constructor(store) {
    if (!store.pool) throw Object.assign(new Error('WhatsApp Broadcasts requires PostgreSQL.'), { status: 503 });
    this.pool = store.pool;
  }

  async templates() {
    return (await this.pool.query('select * from public.whatsapp_broadcast_templates order by name,language')).rows;
  }

  async setPermission(phone, allowed, note, actor, query = this.pool) {
    await query.query(`insert into public.whatsapp_messaging_preferences(phone,opted_out,note,updated_by)
      values($1,$2,$3,$4) on conflict(phone) do update set opted_out=excluded.opted_out,note=excluded.note,updated_by=excluded.updated_by,updated_at=now()`,
    [phone, !allowed, note, actor]);
  }

  async saveTemplate(template, actor) {
    return (await this.pool.query(`insert into public.whatsapp_broadcast_templates(name,language,body,created_by)
      values($1,$2,$3,$4) on conflict(name,language) do update set body=excluded.body,active=true
      returning *`, [template.name, template.language, template.body, actor])).rows[0];
  }

  async removeTemplate(id) {
    // Campaigns have immutable template snapshots; this only removes the picker entry.
    return (await this.pool.query('delete from public.whatsapp_broadcast_templates where id=$1 returning id', [id])).rows.length > 0;
  }

  async historyInfo(id, query = this.pool) {
    return (await query.query(`select b.id,b.title,b.deleted_at,
      (select count(*)::int from public.whatsapp_broadcast_recipients r where r.broadcast_id=b.id) as recipients,
      (select count(*)::int from public.whatsapp_broadcast_messages m join public.whatsapp_broadcast_recipients r on r.id=m.recipient_id where r.broadcast_id=b.id and m.deleted_at is null) as messages
      from public.whatsapp_broadcasts b where b.id=$1`, [id])).rows[0];
  }

  async removeHistory(id, actor) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select id from public.whatsapp_broadcasts where id=$1 for update', [id]);
      const rows = (await client.query('select id,status from public.whatsapp_broadcast_recipients where broadcast_id=$1 order by id for update', [id])).rows;
      const pending = (await client.query(`select m.id from public.whatsapp_broadcast_messages m join public.whatsapp_broadcast_recipients r on r.id=m.recipient_id
        where r.broadcast_id=$1 and m.status in ('queued','sending')`, [id])).rows;
      if (rows.some(row => ['queued','sending'].includes(row.status)) || pending.length) throw Object.assign(new Error('Wait for queued sends and replies to finish before removing history.'), { status: 409 });
      const info = await this.historyInfo(id, client);
      if (!info) throw Object.assign(new Error('Announcement not found.'), { status: 404 });
      // Keep message IDs/timestamps and routing ownership, but erase message content.
      // Deleting those routing anchors would send late announcement replies into CSAT.
      await client.query(`update public.whatsapp_broadcast_messages m set body='',error='',deleted_at=now() from public.whatsapp_broadcast_recipients r
        where r.id=m.recipient_id and r.broadcast_id=$1 and m.deleted_at is null`, [id]);
      await client.query(`update public.whatsapp_broadcast_recipients set message_body='',parameter_values='[]',latest_reply_at=null,last_staff_reply_at=null where broadcast_id=$1`, [id]);
      await client.query(`update public.whatsapp_broadcasts set title='Removed announcement',template='{}',parameters='[]',deleted_at=now(),deleted_by=$2 where id=$1`, [id, actor]);
      await client.query('commit');
      return info;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async campaigns(clusters, offset = 0) {
    const rows = (await this.pool.query(`select b.id,b.title,b.created_by,b.created_at,b.template,
      count(r.id)::int as total, count(*) filter(where r.status='skipped')::int as skipped,
      count(*) filter(where r.status in ('accepted','sent','delivered','read'))::int as accepted,
      count(*) filter(where r.status in ('delivered','read'))::int as delivered,
      count(*) filter(where r.status='read')::int as read,
      count(*) filter(where r.status in ('accepted','sent','unknown'))::int as unconfirmed,
      count(*) filter(where r.status='failed')::int as failed,
      count(*) filter(where r.latest_reply_at is not null)::int as replied
      from public.whatsapp_broadcasts b join public.whatsapp_broadcast_recipients r on r.broadcast_id=b.id
      where ${visibleSql} and b.deleted_at is null group by b.id order by b.created_at desc,b.id limit 51 offset $2`, [clusters, offset])).rows;
    return { campaigns: rows.slice(0, 50), hasMore: rows.length > 50 };
  }

  async recipients(broadcastId, clusters) {
    return (await this.pool.query(`select r.*,b.title,b.template,b.parameters,b.deleted_at,
      (select id from public.whatsapp_broadcast_recipients retry where retry.retry_source_id=r.id) as retry_recipient_id,
      (select body from public.whatsapp_broadcast_messages m where m.recipient_id=r.id and m.side='client'
       order by coalesce(m.provider_at,m.created_at) desc,m.id desc limit 1) as latest_reply
      from public.whatsapp_broadcast_recipients r join public.whatsapp_broadcasts b on b.id=r.broadcast_id
      where ${visibleSql} and r.broadcast_id=$2 and b.deleted_at is null order by r.latest_reply_at desc nulls last,r.id`, [clusters, broadcastId])).rows;
  }

  async inbox(clusters, filters) {
    const rows = (await this.pool.query(`select r.*,b.title,b.template,b.parameters,b.deleted_at,
      (select id from public.whatsapp_broadcast_recipients retry where retry.retry_source_id=r.id) as retry_recipient_id,
      (select body from public.whatsapp_broadcast_messages m where m.recipient_id=r.id and m.side='client'
       order by coalesce(m.provider_at,m.created_at) desc,m.id desc limit 1) as latest_reply
      from public.whatsapp_broadcast_recipients r join public.whatsapp_broadcasts b on b.id=r.broadcast_id
      where ${visibleSql}
      and (b.deleted_at is null or r.latest_reply_at>b.deleted_at)
      and (cardinality($2::text[])=0 or case when r.latest_reply_at is null then 'no_reply'
        when r.last_staff_reply_at is null or r.latest_reply_at>r.last_staff_reply_at then 'awaiting_response' else 'responded' end=any($2::text[]))
      and (cardinality($3::text[])=0 or r.status=any($3::text[]))
      and ($4::date is null or (r.latest_reply_at at time zone 'Asia/Kolkata')::date >= $4::date)
      and ($5::date is null or (r.latest_reply_at at time zone 'Asia/Kolkata')::date <= $5::date)
      and ($6='' or r.associations::text ilike $7 or r.phone ilike $7 or exists(select 1 from public.whatsapp_broadcast_messages m
        where m.recipient_id=r.id and m.side='client' and m.body ilike $7))
      order by r.latest_reply_at desc nulls last,b.created_at desc,r.id limit 101 offset $8`,
    [clusters, filters.replies, filters.statuses, filters.from || null, filters.to || null, filters.search, `%${filters.search}%`, filters.offset])).rows;
    return { recipients: rows.slice(0, 100), hasMore: rows.length > 100 };
  }

  async recipient(id, clusters) {
    return (await this.pool.query(`select r.*,b.title,b.template,b.parameters,b.deleted_at,
      (select id from public.whatsapp_broadcast_recipients retry where retry.retry_source_id=r.id) as retry_recipient_id from public.whatsapp_broadcast_recipients r
      join public.whatsapp_broadcasts b on b.id=r.broadcast_id where ${visibleSql} and r.id=$2`, [clusters, id])).rows[0];
  }

  async messages(recipientId) {
    return (await this.pool.query(`select * from (select * from public.whatsapp_broadcast_messages where recipient_id=$1 and deleted_at is null
      order by coalesce(provider_at,created_at) desc,id desc limit 1000) m order by coalesce(provider_at,created_at),id`, [recipientId])).rows;
  }

  async create(input, recipients, actor) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const inserted = await client.query(`insert into public.whatsapp_broadcasts(request_id,request_hash,title,template,parameters,created_by,consent_confirmed)
        values($1,$2,$3,$4::jsonb,$5::jsonb,$6,true) on conflict(request_id) do nothing returning *`,
      [input.requestId, input.hash, input.title, JSON.stringify(input.template), JSON.stringify(input.parameters), actor]);
      let campaign = inserted.rows[0];
      if (!campaign) {
        campaign = (await client.query('select * from public.whatsapp_broadcasts where request_id=$1', [input.requestId])).rows[0];
        if (campaign.created_by !== actor || campaign.request_hash !== input.hash) throw Object.assign(new Error('This request ID belongs to a different broadcast.'), { status: 409 });
        const counts = (await client.query(`select count(*) filter(where status<>'skipped')::int as queued,
          count(*) filter(where status='skipped')::int as skipped from public.whatsapp_broadcast_recipients where broadcast_id=$1`, [campaign.id])).rows[0];
        await client.query('commit');
        return { campaign, duplicate: true, counts };
      }
      if (input.retrySourceId) {
        const source = (await client.query(`select r.*,b.deleted_at from public.whatsapp_broadcast_recipients r join public.whatsapp_broadcasts b on b.id=r.broadcast_id where r.id=$1 for update of r`, [input.retrySourceId])).rows[0];
        const existing = (await client.query('select id from public.whatsapp_broadcast_recipients where retry_source_id=$1', [input.retrySourceId])).rows[0];
        const reason = !source ? 'Original recipient not found.' : retryBlock({ ...source, retry_recipient_id: existing?.id });
        if (reason) throw Object.assign(new Error(reason), { status: 409 });
      }
      for (const row of recipients) {
        await client.query(`insert into public.whatsapp_broadcast_recipients(broadcast_id,phone,associations,message_body,parameter_values,status,reason,retry_source_id)
          values($1,$2,$3::jsonb,$4,$5::jsonb,$6,$7,$8)`, [campaign.id, row.phone || null, JSON.stringify(row.associations), row.message,
          JSON.stringify(row.parameterValues), row.reason ? 'skipped' : 'queued', row.reason || '', input.retrySourceId || null]);
      }
      await client.query('commit');
      return { campaign, duplicate: false, counts: { queued: recipients.filter(row => !row.reason).length, skipped: recipients.filter(row => row.reason).length } };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }

  async enqueueReply(recipient, text, requestId, actor) {
    const client = await this.pool.connect();
    try {
    await client.query('begin');
    await client.query('select id from public.whatsapp_broadcast_recipients where id=$1 for update', [recipient.id]);
    const current = (await client.query(`select b.deleted_at,r.latest_reply_at from public.whatsapp_broadcast_recipients r join public.whatsapp_broadcasts b on b.id=r.broadcast_id where r.id=$1`, [recipient.id])).rows[0];
    if (current?.deleted_at && (!current.latest_reply_at || Date.parse(current.latest_reply_at) <= Date.parse(current.deleted_at))) throw Object.assign(new Error('History was removed. Wait for a new client reply before responding here.'), { status: 409 });
    const row = (await client.query(`insert into public.whatsapp_broadcast_messages(recipient_id,side,body,request_id,status,created_by)
      values($1,'srv',$2,$3,'queued',$4) on conflict(request_id) do nothing returning *`, [recipient.id, text, requestId, actor])).rows[0];
    if (row) { await client.query('commit'); return row; }
    const previous = (await client.query('select * from public.whatsapp_broadcast_messages where request_id=$1', [requestId])).rows[0];
    if (previous?.recipient_id !== recipient.id || previous.body !== text || previous.created_by !== actor) {
      throw Object.assign(new Error('This request ID belongs to a different message.'), { status: 409 });
    }
    await client.query('commit'); return previous;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async retryStillFailed(row, query) {
    if (!row.retry_source_id) return '';
    const source = (await query.query('select * from public.whatsapp_broadcast_recipients where id=$1', [row.retry_source_id])).rows[0];
    return source ? retryBlock(source) : 'Original delivery record is unavailable.';
  }

  async stale() {
    await this.pool.query(`update public.whatsapp_broadcast_recipients set status='unknown',reason='Sender confirmation missing. Check the WhatsApp sender before retrying.'
      where status='sending' and claimed_at<now()-interval '5 minutes'`);
    await this.pool.query(`update public.whatsapp_broadcast_messages set status='unknown',error='Sender confirmation missing. Check the WhatsApp sender before retrying.'
      where side='srv' and status='sending' and claimed_at<now()-interval '5 minutes'`);
    await this.pool.query("delete from public.whatsapp_broadcast_delivery_events where received_at<now()-interval '7 days'");
  }

  async claim(store) {
    await this.stale();
    const jobs = [];
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const transactionStore = new PostgresStore({ pool: client });
      const locked = (await client.query("select pg_try_advisory_xact_lock(hashtextextended('broadcast-claim',0)) as locked")).rows[0]?.locked;
      if (!locked) { await client.query('commit'); return []; }
      const pending = (await client.query(`select r.*,b.template,b.parameters from public.whatsapp_broadcast_recipients r
        join public.whatsapp_broadcasts b on b.id=r.broadcast_id where r.status='queued' order by b.created_at,r.id
        for update of r skip locked limit 25`)).rows;
      const replies = (await client.query(`select m.*,r.phone,r.sent_at,r.claimed_at as template_claimed_at,r.associations
        from public.whatsapp_broadcast_messages m join public.whatsapp_broadcast_recipients r on r.id=m.recipient_id
        where m.side='srv' and m.status='queued' order by m.created_at,m.id for update of m skip locked limit 25`)).rows;
      const phones = [...new Set([...pending, ...replies].map(row => row.phone))].sort();
      for (const phone of phones) await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`whatsapp:${phone}`]);
      for (const row of pending) {
        const reason = await this.retryStillFailed(row, client) || await store.checkBroadcastRecipient(row, transactionStore);
        if (reason === 'Broadcast Sending in Progress') continue;
        if (reason) {
          await client.query("update public.whatsapp_broadcast_recipients set status='skipped',reason=$2,updated_at=now() where id=$1", [row.id, reason]);
          continue;
        }
        await client.query("update public.whatsapp_broadcast_recipients set status='sending',claimed_at=now(),updated_at=now() where id=$1", [row.id]);
        jobs.push({ id: row.id, kind: 'template', to: row.phone, template: row.template, parameters: row.parameters,
          parameterValues: row.parameter_values, associations: row.associations });
      }
      for (const message of replies) {
        const reason = await store.checkBroadcastReply(message, transactionStore, client);
        if (reason === 'Broadcast Sending in Progress') continue;
        if (reason) {
          await client.query("update public.whatsapp_broadcast_messages set status='failed',error=$2 where id=$1", [message.id, reason]);
          continue;
        }
        await client.query("update public.whatsapp_broadcast_messages set status='sending',claimed_at=now() where id=$1", [message.id]);
        jobs.push({ id: message.id, kind: 'reply', to: message.phone, text: message.body });
      }
      await client.query('commit');
      return jobs;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async ready(id, kind, check) {
    const table = kind === 'reply' ? 'whatsapp_broadcast_messages' : 'whatsapp_broadcast_recipients';
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const job = (await client.query(`select * from public.${table} where id=$1 for update`, [id])).rows[0];
      if (!job || job.status !== 'sending' || job.dispatch_at) { await client.query('commit'); return { allowed: false }; }
      const recipient = kind === 'reply' ? (await client.query('select * from public.whatsapp_broadcast_recipients where id=$1', [job.recipient_id])).rows[0] : job;
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`whatsapp:${recipient.phone}`]);
      const reason = (kind === 'template' ? await this.retryStillFailed(recipient, client) : '') || await check(job, recipient, new PostgresStore({ pool: client }), client);
      if (reason) {
        await client.query(`update public.${table} set status=$2,${kind === 'reply' ? 'error' : 'reason'}=$3 where id=$1`, [id, kind === 'reply' ? 'failed' : 'skipped', reason]);
        await client.query('commit'); return { allowed: false, reason };
      }
      await client.query(`update public.${table} set dispatch_at=now()${kind === 'reply' ? ',provider_at=now()' : ''} where id=$1`, [id]);
      await client.query('commit'); return { allowed: true };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async finish(id, kind, result) {
    const table = kind === 'reply' ? 'whatsapp_broadcast_messages' : 'whatsapp_broadcast_recipients';
    const reasonColumn = kind === 'reply' ? 'error' : 'reason';
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const row = (await client.query(`select * from public.${table} where id=$1 for update`, [id])).rows[0];
      if (!row || !['sending','unknown','accepted','sent','delivered','read'].includes(row.status)) { await client.query('commit'); return false; }
      if (row.provider_message_id && result.providerMessageId && row.provider_message_id !== result.providerMessageId) throw new Error('Provider message ID does not match the recorded send.');
      if (['sending','unknown'].includes(row.status)) {
        await client.query(`update public.${table} set status=$2,provider_message_id=coalesce(provider_message_id,nullif($3,'')),${reasonColumn}=$4
          ${kind === 'template' ? ',sent_at=case when $2=\'accepted\' then coalesce(sent_at,dispatch_at,claimed_at,now()) else sent_at end,updated_at=now()' : ''} where id=$1`,
        [id, result.status, result.providerMessageId || '', result.reason || '']);
        if (kind === 'template' && result.status === 'failed') {
          const code = (/Meta\s+(\d+)/i.exec(result.reason || '') || [])[1];
          const failure = deliveryEvent({ id: result.providerMessageId || 'sender-rejection', status: 'failed', errors: [{ code }] });
          await client.query('update public.whatsapp_broadcast_recipients set error_code=$2,delivery_at=$3,retry_after=$4 where id=$1', [id, failure.errorCode, failure.deliveryAt, failure.retryAfter]);
        }
      }
      if (kind === 'reply' && result.status === 'accepted') {
        await client.query("update public.whatsapp_broadcast_recipients set last_staff_reply_at=greatest(coalesce(last_staff_reply_at,'epoch'),$2::timestamptz),updated_at=now() where id=$1", [row.recipient_id, row.dispatch_at || row.created_at]);
      }
      if (result.providerMessageId) await this.applyDelivery(client, result.providerMessageId);
      await client.query('commit');
      return true;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async applyDelivery(client, providerId) {
    const event = (await client.query('select * from public.whatsapp_broadcast_delivery_events where provider_message_id=$1', [providerId])).rows[0];
    if (!event) return;
    for (const [table, reason] of [['whatsapp_broadcast_recipients','reason'], ['whatsapp_broadcast_messages','error']]) {
      await client.query(`update public.${table} set status=$2,${reason}=$3${table === 'whatsapp_broadcast_recipients' ? ',error_code=$5,delivery_at=$6,retry_after=$7,updated_at=now()' : ''} where provider_message_id=$1 and
        case status when 'read' then 30 when 'delivered' then 20 when 'failed' then 15 when 'sent' then 10 else 0 end <= $4`,
      [providerId, event.status, event.reason, event.rank, ...(table === 'whatsapp_broadcast_recipients' ? [event.error_code, event.delivery_at, event.retry_after] : [])]);
    }
  }

  async delivery(event) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into public.whatsapp_broadcast_delivery_events(provider_message_id,status,rank,reason,error_code,delivery_at,retry_after)
        values($1,$2,$3,$4,$5,$6,$7) on conflict(provider_message_id) do update set status=excluded.status,rank=excluded.rank,reason=excluded.reason,
        error_code=excluded.error_code,delivery_at=excluded.delivery_at,retry_after=excluded.retry_after,received_at=now()
        where excluded.rank>whatsapp_broadcast_delivery_events.rank or (excluded.rank=whatsapp_broadcast_delivery_events.rank and (whatsapp_broadcast_delivery_events.delivery_at is null or excluded.delivery_at>=whatsapp_broadcast_delivery_events.delivery_at))`,
      [event.id, event.status, statusRank(event.status), event.reason || '', event.errorCode || null, event.deliveryAt || null, event.retryAfter || null]);
      await this.applyDelivery(client, event.id);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  async routingEvidence(phone, messageId, replyTo, before) {
    const duplicate = messageId ? (await this.pool.query(`select m.* from public.whatsapp_broadcast_messages m
      join public.whatsapp_broadcast_recipients r on r.id=m.recipient_id where m.provider_message_id=$1 and m.side='client' and r.phone=$2`, [messageId, phone])).rows[0] : null;
    const latest = (await this.pool.query(`select * from public.whatsapp_broadcast_recipients where phone=$1 and status in ('sending','unknown','accepted','sent','delivered','read')
      and coalesce(sent_at,dispatch_at)<=$2 order by coalesce(sent_at,dispatch_at) desc,id desc limit 1`, [phone, before])).rows[0];
    const quoted = replyTo ? (await this.pool.query(`select r.* from public.whatsapp_broadcast_recipients r
      left join public.whatsapp_broadcast_messages m on m.recipient_id=r.id and m.side='srv'
      where r.phone=$1 and (r.provider_message_id=$2 or m.provider_message_id=$2) limit 1`, [phone, replyTo])).rows[0] : null;
    return { duplicate, latest, quoted };
  }

  async latestFeedbackStart(phone, before, query = this.pool) {
    return (await query.query(`select max(s.started_at) as started_at from public.feedback_sessions s join public.client_pocs p on p.id=s.client_poc_id
      where regexp_replace(coalesce(p.contact_whatsapp,''),'[^0-9]','','g')=$1 and coalesce(s.channel,'whatsapp')='whatsapp' and s.started_at<=$2`, [phone, before])).rows[0]?.started_at || null;
  }

  async saveIncoming(recipient, input) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select id from public.whatsapp_broadcast_recipients where id=$1 for update', [recipient.id]);
      const row = (await client.query(`insert into public.whatsapp_broadcast_messages(recipient_id,side,body,provider_message_id,reply_to_message_id,status,provider_at)
        values($1,'client',$2,$3,$4,'received',$5) on conflict(provider_message_id) do nothing returning *`,
      [recipient.id, input.text, input.messageId, input.replyTo || null, input.providerAt])).rows[0];
      if (row) await client.query(`update public.whatsapp_broadcast_recipients set latest_reply_at=greatest(coalesce(latest_reply_at,'epoch'),$2::timestamptz),updated_at=now() where id=$1`, [recipient.id, input.providerAt || row.created_at]);
      if (row && explicitOptOut(input.text)) await this.setPermission(recipient.phone, false, input.text, 'Client WhatsApp reply', client);
      const result = row || (await client.query('select * from public.whatsapp_broadcast_messages where provider_message_id=$1', [input.messageId])).rows[0];
      await client.query('commit');
      return result;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
}

module.exports = { BroadcastRepository, statusRank };
