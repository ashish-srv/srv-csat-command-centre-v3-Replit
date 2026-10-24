const { initialOccasion, problem } = require('./birthday-domain');
const contactRow = row => row && ({ ...row.data, id: row.id, clusterId: row.cluster_id, version: row.version, removedAt: row.removed_at });
const occasionRow = row => row && ({ ...row.data, id: row.id, contactId: row.contact_id, year: row.birthday_year, version: row.version });

class BirthdayRepository {
  constructor(store) {
    if (!store.pool) problem('Birthday Centre requires the PostgreSQL data provider.', 503);
    this.pool = store.pool;
  }
  async contacts(includeRemoved = false) {
    const r = await this.pool.query(`select * from public.birthday_contacts ${includeRemoved ? '' : 'where removed_at is null'} order by data->>'organization', data->>'name'`);
    return r.rows.map(contactRow);
  }
  async contact(id, includeRemoved = false) { return contactRow((await this.pool.query(`select * from public.birthday_contacts where id=$1 ${includeRemoved ? '' : 'and removed_at is null'}`, [id])).rows[0]); }
  async restore(id) {
    await this.pool.query("update public.birthday_contacts set removed_at=null,data=data || '{\"active\":false,\"emailEnabled\":false,\"whatsappEnabled\":false}'::jsonb,version=version+1 where id=$1", [id]);
  }
  async saveContacts(rows, actor) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const saved = [];
      for (const row of rows) {
        let result;
        if (row.id) {
          result = await client.query('update public.birthday_contacts set identity_key=$2, cluster_id=$3, data=$4::jsonb, version=version+1, updated_at=now() where id=$1 and version=$5 and removed_at is null returning *', [row.id, row.identityKey, row.clusterId, JSON.stringify({ ...row, updatedBy: actor }), row.version]);
          if (!result.rows.length) problem('This contact changed. Reload before saving.', 409);
        } else {
          result = await client.query('insert into public.birthday_contacts(identity_key,cluster_id,data) values($1,$2,$3::jsonb) returning *', [row.identityKey, row.clusterId, JSON.stringify({ ...row, updatedBy: actor })]);
        }
        saved.push(contactRow(result.rows[0]));
      }
      await client.query('commit');
      return saved;
    } catch (e) { await client.query('rollback'); if (e.code === '23505') problem('A birthday contact already uses this WhatsApp number or email. Edit the existing contact instead.', 409); throw e; }
    finally { client.release(); }
  }
  async remove(id) {
    await this.pool.query("update public.birthday_contacts set removed_at=now(), data=data || '{\"active\":false,\"emailEnabled\":false,\"whatsappEnabled\":false}'::jsonb,version=version+1 where id=$1", [id]);
    await this.pool.query("update public.birthday_jobs set status='cancelled', updated_at=now() where contact_id=$1 and status='pending'", [id]);
  }
  async occasions(year) { return (await this.pool.query('select * from public.birthday_occasions where birthday_year=$1', [year])).rows.map(occasionRow); }
  async unfinished() { return (await this.pool.query("select * from public.birthday_occasions where data->>'followupsStarted'='true' and coalesce(data->>'gift','')='' ")).rows.map(occasionRow); }
  async ensure(contact, year, query = this.pool) {
    return occasionRow((await query.query('insert into public.birthday_occasions(contact_id,birthday_year,data) values($1,$2,$3::jsonb) on conflict(contact_id,birthday_year) do update set contact_id=excluded.contact_id returning *', [contact.id, year, JSON.stringify(initialOccasion(contact))])).rows[0]);
  }
  async change(contact, year, category, action, actor, transform) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const existing = await this.ensure(contact, year, client);
      const row = (await client.query('select * from public.birthday_occasions where id=$1 for update', [existing.id])).rows[0];
      const before = occasionRow(row), changed = transform(before);
      if (changed.duplicate) { await client.query('commit'); return { ...before, duplicate: true }; }
      const data = changed.data || changed;
      const after = occasionRow((await client.query('update public.birthday_occasions set data=$2::jsonb,version=version+1,updated_at=now() where id=$1 returning *', [row.id, JSON.stringify(data)])).rows[0]);
      await client.query('insert into public.birthday_events(occasion_id,category,action,actor,details) values($1,$2,$3,$4,$5::jsonb)', [row.id, category, action, actor, JSON.stringify(category === 'gift' ? { before: row.data, after: data } : { status: action })]);
      await client.query('commit'); return after;
    } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  }
  async events(contactIds, year) {
    if (!contactIds.length) return [];
    return (await this.pool.query('select e.*,o.contact_id,o.birthday_year from public.birthday_events e join public.birthday_occasions o on o.id=e.occasion_id where o.contact_id=any($1::uuid[]) and o.birthday_year=$2 order by e.created_at desc limit 2000', [contactIds, year])).rows;
  }
  async enqueue(contact, year, key, kind, channel, payload) {
    return (await this.pool.query('insert into public.birthday_jobs(contact_id,birthday_year,dedupe_key,kind,channel,payload) values($1,$2,$3,$4,$5,$6::jsonb) on conflict(dedupe_key) do nothing returning *', [contact.id, year, key, kind, channel, JSON.stringify(payload)])).rows[0] || null;
  }
  async jobs(contactIds, year) {
    if (!contactIds.length) return [];
    return (await this.pool.query("select * from (select * from public.birthday_jobs where contact_id=any($1::uuid[]) and birthday_year=$2 and kind='wish' union all (select * from public.birthday_jobs where contact_id=any($1::uuid[]) and birthday_year=$2 and kind<>'wish' order by created_at desc limit 2000)) j order by created_at desc", [contactIds, year])).rows;
  }
  async claim(channel, contactIds = null) {
    return (await this.pool.query("update public.birthday_jobs set status='processing',claimed_at=now(),updated_at=now() where id in (select id from public.birthday_jobs where status='pending' and channel=$1 and ($2::uuid[] is null or contact_id=any($2::uuid[])) order by created_at for update skip locked limit 20) returning *", [channel, contactIds])).rows;
  }
  async finish(id, status, result) {
    return (await this.pool.query("update public.birthday_jobs set status=$2,result=$3::jsonb,updated_at=now() where id=$1 and (status='processing' or (status='unknown' and channel='whatsapp' and $2='accepted' and nullif($3::jsonb->>'providerMessageId','') is not null)) returning *", [id, status, JSON.stringify(result)])).rows[0];
  }
  async prepareWhatsappRoute(job, contact, hash) {
    await this.pool.query("insert into public.birthday_whatsapp_routes(job_id,contact_id,birthday_year,phone_hash) values($1,$2,$3,$4) on conflict(job_id) do nothing", [job.id, contact.id, job.birthday_year, hash]);
  }
  async confirmWhatsappRoute(jobId, status, providerId) {
    await this.pool.query("update public.birthday_whatsapp_routes set status=$2,provider_message_id=coalesce(nullif($3,''),provider_message_id) where job_id=$1 and (provider_message_id is null or provider_message_id=$3) and (status<>'accepted' or $2='accepted')", [jobId, status, providerId || '']);
  }
  async birthdayRoutingEvidence(hash, messageId, replyTo, notAfter = new Date().toISOString()) {
    const duplicate = messageId ? (await this.pool.query('select r.id,r.classification from public.birthday_replies r join public.birthday_whatsapp_routes w on w.job_id=r.job_id where r.provider_message_id=$1 and w.phone_hash=$2', [messageId, hash])).rows[0] : null;
    const routes = (await this.pool.query("select * from public.birthday_whatsapp_routes where phone_hash=$1 and status<>'failed' and dispatched_at<=$2 order by dispatched_at desc limit 1", [hash, notAfter])).rows;
    const quoted = replyTo ? (await this.pool.query("select * from public.birthday_whatsapp_routes where phone_hash=$1 and provider_message_id=$2 and status<>'failed'", [hash, replyTo])).rows[0] : null;
    return { duplicate, latest: routes[0] || null, quoted };
  }
  async latestCsatOutbound(phone, notAfter = new Date().toISOString()) {
    const result = await this.pool.query(`select greatest(max(s.started_at),max(m.created_at)) as latest
      from public.client_pocs cp join public.feedback_sessions s on s.client_poc_id=cp.id
      left join public.messages m on m.session_id=s.id and (m.side='srv' or m.metadata->>'source'='cycle_created') and m.created_at<=$2
      where regexp_replace(coalesce(cp.contact_whatsapp,''),'[^0-9]','','g')=$1 and coalesce(s.channel,'whatsapp')='whatsapp' and s.started_at<=$2`, [phone, notAfter]);
    return result.rows[0]?.latest || null;
  }
  async saveBirthdayReply(route, message) {
    const values = [route.job_id, route.contact_id, route.birthday_year, message.providerMessageId, message.replyToMessageId, message.text, message.fromName, message.classification, message.providerSentAt];
    const saved = (await this.pool.query('insert into public.birthday_replies(job_id,contact_id,birthday_year,provider_message_id,reply_to_message_id,body,from_name,classification,provider_sent_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(provider_message_id) do nothing returning *', values)).rows[0];
    if (saved) return saved;
    const existing = (await this.pool.query('select * from public.birthday_replies where provider_message_id=$1 and job_id=$2', [message.providerMessageId, route.job_id])).rows[0];
    if (!existing) problem('This message ID has already been recorded for a different birthday.', 409);
    return { ...existing, duplicate: true };
  }
  async reply(id) { return (await this.pool.query('select * from public.birthday_replies where id=$1', [id])).rows[0]; }
  async replies(contactIds, year, { status = 'awaiting_review', search = '', offset = 0 } = {}) {
    if (!contactIds.length) return { replies: [], hasMore: false };
    const rows = (await this.pool.query(`select r.*,c.data->>'name' as contact_name,c.data->>'organization' as organization
      from public.birthday_replies r join public.birthday_contacts c on c.id=r.contact_id
      where r.contact_id=any($1::uuid[]) and r.birthday_year=$2 and r.status<>'history_cleared'
      and ($3='all' or r.status=$3) and ($4='' or position(lower($4) in lower(concat(c.data->>'name',' ',c.data->>'organization',' ',r.body)))>0)
      order by r.created_at desc,r.id desc limit 51 offset $5`, [contactIds, year, status, search, offset])).rows;
    return { replies: rows.slice(0,50), hasMore: rows.length > 50 };
  }
  async reviewReply(id, actor) {
    return (await this.pool.query("update public.birthday_replies set status='reviewed',reviewed_at=coalesce(reviewed_at,now()),reviewed_by=coalesce(reviewed_by,$2) where id=$1 and status<>'history_cleared' returning *", [id, actor])).rows[0];
  }
  async stale() {
    await this.pool.query("update public.birthday_jobs set status='unknown',result='{\"reason\":\"Sender did not confirm the result. Check the provider before retrying.\"}'::jsonb,updated_at=now() where status='processing' and claimed_at < now()-interval '20 minutes'");
  }
  async settings() { return (await this.pool.query("select setting_value from public.app_settings where setting_key='birthday_centre'")).rows[0]?.setting_value || {}; }
  async saveSettings(value) { await this.pool.query("insert into public.app_settings(setting_key,setting_value) values('birthday_centre',$1::jsonb) on conflict(setting_key) do update set setting_value=excluded.setting_value,updated_at=now()", [JSON.stringify(value)]); }
  async activeFeedback(contact) {
    // Do not mutate, close or advance any CSAT cycle. Check every identity match,
    // including removed project links, so another project's open cycle blocks too.
    return (await this.pool.query(`select distinct p.name as project_name,c.id as cycle_id,c.cycle_type
      from public.client_pocs cp join public.projects p on p.id=cp.project_id
      join public.feedback_cycles c on c.project_id=p.id
      where c.status='open' and (cp.id=any($1::uuid[]) or
        ($2<>'' and regexp_replace(coalesce(cp.contact_whatsapp,''),'[^0-9]','','g')=$2) or
        ($3<>'' and lower(coalesce(cp.contact_email,''))=$3))`, [contact.linkedPocIds || [], contact.whatsapp || '', contact.email || ''])).rows;
  }
  async cleanup(contactIds, year, kind, actor) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const sending = await client.query('select status from public.birthday_jobs where contact_id=any($1::uuid[]) and birthday_year=$2 for update', [contactIds, year]);
      if (sending.rows.some(row => row.status === 'processing')) problem('A birthday send is being processed. Wait for its result before deleting history.', 409);
      const occasions = (await client.query('select * from public.birthday_occasions where contact_id=any($1::uuid[]) and birthday_year=$2 for update', [contactIds, year])).rows;
      const ids = occasions.map(row => row.id);
      const categories = kind === 'all' ? ['followup','wish','gift'] : [kind];
      const deleted = await client.query('delete from public.birthday_events where occasion_id=any($1::uuid[]) and category=any($2::text[])', [ids, categories]);
      if (categories.includes('gift')) for (const row of occasions) {
        // Hide the selected operational history without restarting completed work.
        const keep = { stage: 'History Cleared', gift: '', giftEligible: false, historyCleared: true, followupsStarted: false, changeRequests: [] };
        await client.query('update public.birthday_occasions set data=$2::jsonb,version=version+1,updated_at=now() where id=$1', [row.id, JSON.stringify(keep)]);
      }
      // Retain only an opaque delivery reservation, never the deleted addresses,
      // gift choices or correspondence. This prevents a resend after cleanup.
      if (categories.some(category => ['wish','followup','gift'].includes(category))) {
        await client.query("update public.birthday_jobs set payload='{}',result='{\"reason\":\"History cleared; resend protection retained\"}'::jsonb,status='history_cleared',updated_at=now() where contact_id=any($1::uuid[]) and birthday_year=$2 and ($3='all' or ($3='gift' and kind<>'wish') or ($3='wish' and kind='wish') or ($3='followup' and kind<>'wish')) and status<>'processing'", [contactIds, year, kind]);
      }
      if (categories.includes('wish')) await client.query("update public.birthday_replies set body='',from_name='',status='history_cleared',reviewed_at=null,reviewed_by=null where contact_id=any($1::uuid[]) and birthday_year=$2", [contactIds, year]);
      for (const row of occasions) await client.query("insert into public.birthday_events(occasion_id,category,action,actor,details) values($1,'cleanup','History Deleted',$2,$3::jsonb)", [row.id, actor, JSON.stringify({ kind, year })]);
      await client.query('commit'); return deleted.rowCount;
    } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  }
}
module.exports = { BirthdayRepository, contactRow, occasionRow };
