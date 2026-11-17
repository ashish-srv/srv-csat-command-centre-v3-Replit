const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { whatsappNumber, feedbackRecipients, explicitOptOut } = require('../src/lib/whatsapp-recipients');
const { BroadcastRepository, statusRank } = require('../src/lib/broadcast-repository');
const { PostgresStore } = require('../src/lib/postgres-store');
const { SupabaseStore } = require('../src/lib/supabase-store');
const { captureBroadcastInbound } = require('../src/lib/broadcast-inbound');
const { handleBroadcastRequest, audience, expandedParameters, renderTemplate, parameterCount } = require('../src/lib/broadcast-service');

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const superAdmin = { role: 'super_admin', email: 'super@example.com' };
const admin = { role: 'admin', email: 'admin@example.com', permissions: { broadcast_view: true, broadcast_send: true, broadcast_reply: true }, clusterAccess: [{ clusterId: id(1) }] };
const pocs = [
  { id: id(11), name: 'Person A', projectId: id(21), projectName: 'Project B', clientId: id(31), clientName: 'Client A', clusterId: id(1), contactWhatsapp: '+91 98765 43210', active: true, weightPercentage: 30 },
  { id: id(12), name: 'Person A', projectId: id(22), projectName: 'Project A', clientId: id(32), clientName: 'Client B', clusterId: id(1), contactWhatsapp: '919876543210', active: true, weightPercentage: 40 },
  { id: id(13), name: 'Missing Number', projectId: id(21), projectName: 'Project B', clientId: id(31), clientName: 'Client A', clusterId: id(1), contactWhatsapp: '', active: true },
  { id: id(14), name: 'Inactive Person', projectId: id(21), projectName: 'Project B', clientId: id(31), clientName: 'Client A', clusterId: id(1), contactWhatsapp: '447700900123', active: false },
  { id: id(15), name: 'Foreign Person', projectId: id(21), projectName: 'Project B', clientId: id(31), clientName: 'Client A', clusterId: id(1), contactWhatsapp: '+44 7700 900124', active: true, weightPercentage: 70 },
  { id: id(16), name: 'Outside Cluster', projectId: id(23), projectName: 'Project C', clientId: id(33), clientName: 'Client C', clusterId: id(2), contactWhatsapp: '14155552671', active: true }
];
const directory = { clientPocs: pocs, clusters: [{ id: id(1), name: 'Cluster A' }, { id: id(2), name: 'Cluster B' }],
  clients: [{ id: id(31), clusterId: id(1) }, { id: id(32), clusterId: id(1) }, { id: id(33), clusterId: id(2) }],
  projects: [{ id: id(21) }, { id: id(22) }, { id: id(23) }] };
const template = { id: id(41), name: 'approved_announcement', language: 'en', body: 'Hello {{1}}, {{2}}', active: true };
let activePhone = '', latestAt = null, saveCount = 0, duplicate = null, birthdayAt = null, birthdayQuote = false, birthdayDuplicate = false;
const store = { getDirectory: async () => directory, getMessagingStatus: async () => ({ enabled: true }),
  getWhatsappRoutingContext: async phone => phone === activePhone ? { status: 'active', session: { startedAt: latestAt } } : { status: 'no_session' },
  hasProviderMessage: async () => false, pool: { query: async sql => ({ rows: sql.includes('from public.birthday_replies')
    ? (birthdayDuplicate ? [{id:id(73)}] : []) : sql.includes('provider_message_id=$2')
      ? (birthdayQuote ? [{dispatched_at:'2026-11-16T04:00:00Z'}] : [])
      : birthdayAt ? [{dispatched_at:birthdayAt}] : [] }) } };
const records = [];
const repository = { templates: async () => [template], campaigns: async () => ({ campaigns: [], hasMore: false }),
  create: async (input, rows) => { records.push({ input, rows }); return { campaign: { id: id(51) } }; },
  routingEvidence: async () => ({ latest: { id: id(61), sent_at: '2026-11-17T04:00:00Z' }, duplicate }),
  latestFeedbackStart: async () => latestAt,
  saveIncoming: async (_recipient, message) => { saveCount++; return { id: id(71), ...message }; } };
const call = (method, path, body = {}, access = superAdmin, headers = {}) => handleBroadcastRequest({ store, access, repository, method, pathname: path, body, request: { headers }, searchParams: new URLSearchParams() });

async function main() {
  assert.equal(whatsappNumber('+44 7700 900124'), '447700900124');
  for (const invalid of ['', '123', '0000000000', 'abc919876543210', '1'.repeat(16)]) assert.equal(whatsappNumber(invalid), '');
  for (const phrase of ['STOP','unsubscribe','opt out','Do not contact me again']) assert.equal(explicitOptOut(phrase),true);
  for (const phrase of ['Please stop making mistakes','Do not stop the campaign','Campaign should stop tomorrow']) assert.equal(explicitOptOut(phrase),false);
  const selected = await feedbackRecipients(store, [...pocs.slice(0,5), { ...pocs[0], id: id(17), contactWhatsapp: 'invalid' }]);
  assert.equal(selected.eligible.length, 2);
  assert.deepEqual(selected.skipped.map(row => row.reason), ['WhatsApp Number Already Included','WhatsApp Number Missing','POC Inactive','Invalid WhatsApp Number']);
  activePhone = '919876543210';
  const blocked = await feedbackRecipients(store, [pocs[0],pocs[4]]);
  assert.equal(blocked.eligible.length, 1); assert.equal(blocked.skipped[0].reason, 'Active Feedback in Progress');
  activePhone = '';

  // Exercise the shared cycle entry point for each feedback type. Only sent
  // recipients get sessions and tracker counts; configured weights stay intact.
  for (const cycleType of ['pulse','project_end','quick_checkin']) {
    const database = new SupabaseStore({ skipEnv: true });
    const writes = [];
    database.getProject = async () => ({ id: id(21), key: 'example', pocs: [pocs[0],pocs[4]], feedbackIntervalDays: 30 });
    database.hasAnyCycle = async () => false;
    database.pocsForProject = async () => [pocs[0],pocs[2],pocs[3],pocs[4]];
    database.getWhatsappRoutingContext = store.getWhatsappRoutingContext;
    database.addMessage = async () => ({});
    database.request = async (table, options) => {
      writes.push({ table, options });
      if (table === 'feedback_cycles') return [{ id: id(81), ...options.body[0] }];
      if (table === 'feedback_sessions') return options.body.map((row,index) => ({ id: id(82+index), ...row }));
      return [];
    };
    const cycle = await database.createCycle('example', { cycleType, clientPocIds: [pocs[0].id,pocs[2].id,pocs[3].id,pocs[4].id] });
    assert.equal(cycle.sessions.length, 2); assert.equal(cycle.skippedPocs.length, 2);
    assert.equal(cycle.cycle.pocTotal, 2); assert.equal(cycle.cycle.skippedPocs.length, 2);
    assert.deepEqual(cycle.sessions.map(session => session.conversationState.pocWeightPercentage), [30,70]);
    assert.equal(writes.find(row => row.table === 'feedback_sessions').options.body.length, 2);
    assert.equal(pocs[0].weightPercentage, 30);
    await assert.rejects(database.createCycle('example', { cycleType, clientPocIds: [pocs[2].id,pocs[3].id] }), error => error.skippedPocs.length === 2);
  }

  const grouped = await audience(store, pocs.slice(0,5));
  assert.equal(grouped.filter(row => !row.reason).length, 2, 'shared client/project identities receive one message');
  assert.equal(grouped.find(row => row.phone === '919876543210').associations.length, 2);
  assert.equal(parameterCount('Hi {{1}}. {{1}} {{2}}'), 2);
  assert.throws(() => parameterCount('Hi {{2}}'), /consecutively/);
  const parameters = [{ source: 'poc_name', text: '' }, { source: 'text', text: 'Office announcement' }];
  assert.deepEqual(expandedParameters(parameters, grouped[0].associations), ['Person A', 'Office announcement']);
  assert.equal(renderTemplate(template, parameters, grouped[0].associations), 'Hello Person A, Office announcement');
  const input = { title: 'Announcement', templateId: template.id, parameters, clientPocIds: pocs.slice(0,5).map(row => row.id) };
  const preview = await call('POST','/api/broadcasts/preview',input,admin);
  assert.equal(preview.statusCode, 200, preview.body); assert.equal(JSON.parse(preview.body).uniqueRecipients, 2);
  assert.equal((await call('POST','/api/broadcasts/preview',{...input,clientPocIds:[pocs[5].id]},admin)).statusCode, 403);
  assert.equal((await call('GET','/api/broadcasts',{}, {...admin,permissions:{}})).statusCode, 403);
  assert.equal((await call('GET','/api/broadcasts',{}, {...admin,role:'project_user'})).statusCode, 403);
  const scoped = JSON.parse((await call('GET','/api/broadcasts',{},admin)).body);
  assert.ok(scoped.directory.clientPocs.every(row => row.clusterId === id(1)));
  const historyRecipient = { id:id(61), phone:'919876543210', associations:[pocs[0],pocs[5]], template, parameters,
    message_body:'The exact approved announcement that was sent', sent_at:'2026-11-17T04:00:00Z' };
  repository.recipient=async()=>historyRecipient;
  repository.recipients=async()=>[historyRecipient];
  repository.inbox=async()=>({recipients:[historyRecipient],hasMore:false});
  repository.messages=async()=>[];
  assert.equal((await call('GET',`/api/broadcasts/recipients/${id(61)}/messages`,{},admin)).statusCode,404,'shared history cannot expose a different cluster to an Admin');
  assert.equal(JSON.parse((await call('GET','/api/broadcasts/inbox',{},admin)).body).recipients.length,0);
  assert.equal((await call('GET',`/api/broadcasts/recipients/${id(61)}/messages`,{}, {...admin,clusterAccess:[{clusterId:id(1)},{clusterId:id(2)}]})).statusCode,200);
  const historical=JSON.parse((await call('GET',`/api/broadcasts/recipients/${id(61)}/messages`)).body);
  assert.equal(historical.recipient.message,historyRecipient.message_body,'history keeps the actual message, not a reconstruction from changed POC details');
  const badDates=await handleBroadcastRequest({store,access:admin,repository,method:'GET',pathname:'/api/broadcasts/inbox',request:{headers:{}},searchParams:new URLSearchParams({from:'2026-02-30'})});
  assert.equal(badDates.statusCode,400);
  assert.equal((await call('POST','/api/broadcasts/templates',{name:'template',body:'Body',approvedConfirmed:true},admin)).statusCode, 403);
  assert.equal((await call('POST','/api/automation/broadcasts/claim',{},null)).statusCode, 401);
  process.env.N8N_BROADCAST_WEBHOOK='https://fixture.invalid/broadcast';
  const fetchBefore=global.fetch; global.fetch=async()=>({ok:true,status:200,json:async()=>({ok:true})});
  try {
    const send=await call('POST','/api/broadcasts/send',{...input,requestId:crypto.randomUUID(),consentConfirmed:true},admin);
    assert.equal(send.statusCode,201,send.body); assert.equal(records.length,1);
    assert.equal(records[0].rows.filter(row=>!row.reason).length,2);
    assert.equal((await call('POST','/api/broadcasts/send',{...input,requestId:crypto.randomUUID()},admin)).statusCode,400);
  } finally { global.fetch=fetchBefore; delete process.env.N8N_BROADCAST_WEBHOOK; }

  const inbound = { from: '919876543210', providerMessageId: 'wamid.incoming', text: 'Any wording the client wishes to share' };
  const route = () => captureBroadcastInbound({ store, repository, body: inbound });
  assert.equal((await route()).routedTo,'broadcast'); assert.equal(saveCount,1);
  latestAt='2026-11-16T04:00:00Z';
  assert.equal((await route()).sendToWhatsapp,false,'older closed feedback cannot answer broadcast replies');
  for (const feedbackTime of ['2026-11-17T04:01:00Z','2026-11-17T04:00:00Z']) {
    latestAt=feedbackTime;
    assert.equal(await route(),null,'newer feedback owns replies regardless of active/completed state');
    inbound.replyToMessageId='wamid.old.announcement';
    assert.equal(await route(),null,'quoting an old announcement does not override newer feedback');
  }
  duplicate={id:id(72)}; assert.equal((await route()).duplicate,true,'old webhook retries stay idempotent after feedback starts');
  duplicate=null;latestAt=null;birthdayAt='2026-11-17T04:02:00Z';
  assert.equal(await route(),null,'a newer birthday wish keeps its existing routing');
  birthdayAt=null;birthdayQuote=true;
  assert.equal(await route(),null,'an exact birthday reply reference keeps its birthday inbox even after a later announcement');
  birthdayQuote=false;birthdayDuplicate=true;
  assert.equal(await route(),null,'a previously captured birthday delivery cannot move into a later broadcast');
  birthdayDuplicate=false;
  birthdayAt=null;inbound.buttonPayload='QC_SHARE_FEEDBACK:session';
  assert.equal((await route()).routedTo,'broadcast','an old Quick Check-in button cannot revive closed feedback after a newer broadcast');
  latestAt='2026-11-17T04:01:00Z';
  assert.equal(await route(),null,'newer feedback retains its existing button handler');
  latestAt=null;

  // Send authorisation is consumed once. A changed eligibility result updates
  // the outbox without giving the worker permission to contact the recipient.
  let job={id:id(91),phone:'919876543210',status:'sending',dispatch_at:null};
  let checks=0;
  const queries=[];
  const connection={query:async(sql,values=[])=>{
    queries.push(sql);
    if(sql.startsWith('select * from public.whatsapp_broadcast_recipients')) return {rows:[{...job}]};
    if(sql.includes('set dispatch_at=now()')) job.dispatch_at=new Date().toISOString();
    if(sql.includes('set status=$2')) job.status=values[1];
    return {rows:[]};
  },release:()=>{}};
  const outbox=new BroadcastRepository({pool:{connect:async()=>connection}});
  const authorised=()=>outbox.ready(job.id,'template',async()=>{checks++;return '';});
  assert.equal((await authorised()).allowed,true);
  assert.equal((await authorised()).allowed,false);assert.equal(checks,1,'a duplicate authorisation cannot issue another external send');
  job={...job,dispatch_at:null,status:'sending'};
  assert.equal((await outbox.ready(job.id,'template',async()=> 'Active Feedback in Progress')).allowed,false);
  assert.equal(job.status,'skipped');
  assert.equal(statusRank('read')>statusRank('delivered'),true);assert.equal(statusRank('delivered')>statusRank('failed'),true);
  const routingSql=[];
  await new BroadcastRepository({pool:{query:async(sql)=>{routingSql.push(sql);return {rows:[]};}}}).routingEvidence('919876543210','','',new Date().toISOString());
  assert.match(routingSql[0],/coalesce\(sent_at,dispatch_at\)/,'claiming a queued job must not take over replies before dispatch');
  assert.doesNotMatch(routingSql[0],/coalesce\(sent_at,claimed_at\)/);

  // Preserve the approved preview and idempotency counts across retries, even
  // when eligibility or contact details change after the first request.
  const campaignRows=[];const recipientRows=[];
  const durableClient={query:async(sql,values=[])=>{
    if(sql.startsWith('insert into public.whatsapp_broadcasts')) {
      if(campaignRows.length)return {rows:[]};
      const campaign={id:id(51),request_id:values[0],request_hash:values[1],created_by:values[5]};campaignRows.push(campaign);return {rows:[campaign]};
    }
    if(sql.startsWith('select * from public.whatsapp_broadcasts'))return {rows:campaignRows};
    if(sql.startsWith('insert into public.whatsapp_broadcast_recipients'))recipientRows.push(values);
    if(sql.includes("count(*) filter(where status<>'skipped')"))return {rows:[{queued:1,skipped:1}]};
    return {rows:[]};
  },release:()=>{}};
  const durable=new BroadcastRepository({pool:{connect:async()=>durableClient}});
  const approved={requestId:crypto.randomUUID(),hash:'original',title:'Approved',template,parameters};
  const originalRecipients=[{...grouped[0],message:'Exact preview',parameterValues:['Person A','Announcement']},{...grouped[1],message:'Skipped',parameterValues:[]}];
  const originalCampaign=await durable.create(approved,originalRecipients,'super@example.com');assert.equal(originalCampaign.duplicate,false);
  assert.equal(recipientRows[0][3],'Exact preview');assert.deepEqual(JSON.parse(recipientRows[0][4]),['Person A','Announcement']);
  const retry=await durable.create(approved,[],'super@example.com');assert.equal(retry.duplicate,true);assert.deepEqual(retry.counts,{queued:1,skipped:1});assert.equal(recipientRows.length,2);
  await assert.rejects(durable.create({...approved,hash:'different'},[],'super@example.com'),/different broadcast/);

  // Cycle writes stay on one connection and roll back as a unit. Advisory
  // number locks use the same sorted order as the broadcast worker.
  const savedProjectMethod=PostgresStore.prototype.getProject;
  const savedOpenMethod=PostgresStore.prototype.hasOpenCycle;
  const savedCreate=SupabaseStore.prototype.createCycle;
  const transactionLog=[];
  const transactionClient={query:async(sql,values)=>{transactionLog.push({sql,values});return {rows:[]};},release:()=>{transactionLog.push({sql:'release'});}};
  PostgresStore.prototype.getProject=async()=>({id:id(21),pocs:[pocs[0],pocs[4]]});
  PostgresStore.prototype.hasOpenCycle=async()=>false;
  try {
    const database=new PostgresStore({pool:{connect:async()=>transactionClient}});
    SupabaseStore.prototype.createCycle=async function(){assert.equal(this.pool,transactionClient);return {cycle:{id:id(81)}};};
    await database.createCycle('example',{cycleType:'pulse'});
    assert.equal(transactionLog[0].sql,'begin');assert.ok(transactionLog.some(row=>row.sql==='commit'));
    const phones=transactionLog.filter(row=>row.values?.[0]?.startsWith('whatsapp:')).map(row=>row.values[0]);
    assert.deepEqual(phones,[...phones].sort());
    transactionLog.length=0;
    SupabaseStore.prototype.createCycle=async()=>{throw new Error('Fixture write failure');};
    await assert.rejects(database.createCycle('example',{cycleType:'project_end'}),/write failure/);
    assert.ok(transactionLog.some(row=>row.sql==='rollback'));assert.ok(!transactionLog.some(row=>row.sql==='commit'));
  } finally {PostgresStore.prototype.getProject=savedProjectMethod;PostgresStore.prototype.hasOpenCycle=savedOpenMethod;SupabaseStore.prototype.createCycle=savedCreate;}

  // Workflow contract: existing CSAT calls/credentials are retained. Only the
  // status branch is added; the broadcast Meta sender has no blind retries.
  const original=JSON.parse(fs.readFileSync('n8n/workflows/01 - CSAT v5 - WhatsApp Inbound Router (Birthday Reply Isolation).json'));
  const updated=JSON.parse(fs.readFileSync('n8n/workflows/01 - CSAT v6 - WhatsApp Inbound Router (Broadcast Priority).json'));
  for(const before of original.nodes) assert.deepEqual(updated.nodes.find(node=>node.name===before.name),before);
  for(const [name,connections] of Object.entries(original.connections)) {
    connections.main.forEach((targets,index)=>targets.forEach(target=>assert.ok(updated.connections[name].main[index].some(candidate=>candidate.node===target.node && candidate.index===target.index),'original CSAT routing connections are preserved')));
  }
  const webhook={body:{entry:[{changes:[{value:{messages:[{type:'text'}]}},{value:{statuses:[{id:'one',status:'sent'}]}}]},{changes:[{value:{statuses:[{id:'two',status:'delivered'},{id:'three',status:'read'}]}}]}]}};
  const evaluate=expression=>vm.runInNewContext('('+expression.slice(3,-2)+')',{$:()=>({first:()=>({json:webhook})})});
  assert.equal(evaluate(updated.nodes.find(node=>node.name==='Is Delivery Status?').parameters.conditions.conditions[0].leftValue),true);
  const batched=evaluate(updated.nodes.find(node=>node.name==='Record Broadcast Delivery Status').parameters.jsonBody);
  assert.deepEqual(Array.from(batched.statuses,row=>row.id),['one','two','three'],'delivery updates are retained across entries and changes, including mixed webhook batches');
  const workflow=JSON.parse(fs.readFileSync('n8n/workflows/16 - CSAT v1 - WhatsApp Broadcast Sender.json'));
  assert.equal(workflow.active,false);
  const meta=workflow.nodes.find(node=>node.name==='Send Broadcast WhatsApp');
  assert.ok(!meta.retryOnFail);
  const expression=meta.parameters.jsonBody.slice(3,-2);
  for(const job of [{kind:'template',to:'447700900124',template:{name:'approved',language:'en'},parameters:[]},{kind:'reply',to:'447700900124',text:'Manual reply'}]) {
    const payload=vm.runInNewContext(expression,{$:()=>({item:{json:job}})});
    assert.equal(payload.to,job.to);assert.equal(payload.type,job.kind==='reply'?'text':'template');
    if(job.kind==='template') assert.ok(!payload.template.components);
  }
  console.log('Broadcast and recipient regressions passed: permissions, cluster scope, shared-number deduplication, all three feedback types, skip counts, template preview, routing priority, duplicate deliveries and workflow contracts.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
