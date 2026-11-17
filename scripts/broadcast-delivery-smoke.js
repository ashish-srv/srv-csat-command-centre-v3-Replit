const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { upgradeVisitor, upgradeCsat } = require('./upgrade-broadcast-workflows');
const { deliveryEvent, retryBlock } = require('../src/lib/broadcast-delivery');
const { handleBroadcastRequest } = require('../src/lib/broadcast-service');
const { BroadcastRepository } = require('../src/lib/broadcast-repository');

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now = Date.parse('2026-11-17T12:21:08Z');
const receipt = (status='failed') => ({ id:'wamid.receipt',status,timestamp:String(now/1000),errors:status==='failed'?[{code:131049,title:'Not delivered',error_data:{details:'Healthy ecosystem engagement'}}]:undefined });
const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/shared-router-before-receipts.json'));
const upgraded = upgradeVisitor(fixture);
assert.deepEqual(upgraded.nodes[1],fixture.nodes[1]);
assert.deepEqual(upgradeVisitor(upgraded),upgraded,'upgrade is idempotent');
const config = {visitorWebhookUrl:'https://n8n.example.test/webhook/visitor',csatWebhookUrl:'https://n8n.example.test/webhook/csat',phoneNumberId:'10001'};
const envelope = (value,phone='10001') => ({object:'whatsapp_business_account',entry:[{id:'account',changes:[{field:'messages',value:{metadata:{phone_number_id:phone},...value}}]}]});
const run = (body,verified=true) => JSON.parse(JSON.stringify(vm.runInNewContext(`(function(){${upgraded.nodes[0].parameters.jsCode}})()`,{$input:{first:()=>({json:{verified,envelope:body,config}})}}))).map(item=>item.json);
const textMessage = {id:'wamid.text',from:'919876543210',timestamp:String(now/1000),type:'text',text:{body:'Additional feedback'},context:{id:'wamid.old'}};
const visitorMessage = {id:'wamid.visitor',from:textMessage.from,type:'button',button:{payload:'rms|approve',text:'Approve'}};
const otpMessage = {id:'wamid.otp',from:textMessage.from,type:'button',button:{payload:'DID_NOT_REQUEST_CODE'},context:{id:'wamid.authentication'}};
assert.throws(()=>run(envelope({messages:[textMessage]}),false),/verified/);
assert.equal(run(envelope({statuses:[receipt()]},'99999'))[0].route,'ignore','other sender phones are ignored');
assert.equal(run(envelope({statuses:[receipt()]}))[0].route,'csat');
assert.equal(run(envelope({statuses:[receipt()]}))[0].body.entry[0].changes[0].value.messages,undefined);
for (const msg of [textMessage,{...textMessage,type:'button',button:{text:'Share feedback',payload:'quick'},text:undefined},{...textMessage,type:'interactive',interactive:{button_reply:{id:'feedback',title:'Start Feedback'}},text:undefined}]) {
  const result=run(envelope({messages:[msg]}));
  assert.deepEqual(result[0].body.entry[0].changes[0].value.messages,JSON.parse(JSON.stringify([msg])));
}
const mixed=run(envelope({messages:[textMessage,visitorMessage,otpMessage],statuses:[receipt()],contacts:[{wa_id:textMessage.from},{wa_id:'447700900999'}]}));
assert.equal(mixed.length,4);
assert.deepEqual(mixed.map(job=>job.route),['csat','csat','visitor','visitor']);
assert.equal(mixed[1].body.entry[0].changes[0].value.statuses,undefined);
assert.equal(mixed[1].body.entry[0].changes[0].value.contacts.length,1);
assert.deepEqual(mixed[2].body,{message:visitorMessage});
assert.deepEqual(mixed[3].body,{phone:otpMessage.from,messageId:'wamid.authentication'});
const batched=run(envelope({statuses:Array.from({length:205},(_,i)=>({...receipt(),id:`wamid.${i}`}))}));
assert.deepEqual(batched.map(job=>job.body.entry[0].changes[0].value.statuses.length),[100,100,5]);
assert.equal(run(envelope({messages:[textMessage,textMessage]})).length,1);
const invalidOtp={...otpMessage,context:{}};
assert.equal(run(envelope({messages:[invalidOtp]}))[0].route,'ignore');
const router=JSON.parse(fs.readFileSync('n8n/workflows/01 - CSAT v6 - WhatsApp Inbound Router (Broadcast Priority).json'));
assert.deepEqual(upgradeCsat(router),router);
const restore=router.nodes.find(n=>n.name==='Restore Incoming Event');
const restored=vm.runInNewContext(`(function(){${restore.parameters.jsCode}})()`,{$:()=>({first:()=>({json:{body:envelope({messages:[textMessage]})}})})});
assert.deepEqual(JSON.parse(JSON.stringify(restored[0].json.body)),envelope({messages:[textMessage]}));
assert.ok(!router.nodes.find(n=>n.name==='Record Broadcast Delivery Status').continueOnFail);
assert.ok(!router.nodes.find(n=>n.name==='Record Broadcast Delivery Status').onError,'save failure must prevent webhook success');

const failed=deliveryEvent(receipt(),now);
assert.equal(failed.errorCode,'131049');assert.match(failed.reason,/Meta 131049.*Healthy/);
assert.equal(failed.retryAfter,'2026-11-18T12:21:08.000Z');
assert.equal(deliveryEvent(null),null);assert.equal(deliveryEvent({id:'one',status:'received'}),null);
assert.equal(deliveryEvent(receipt('read'),now).errorCode,null);
assert.equal(deliveryEvent({...receipt(),timestamp:'bad'},now).deliveryAt,new Date(now).toISOString());
const failedRow={status:'failed',error_code:failed.errorCode,retry_after:failed.retryAfter};
assert.match(retryBlock(failedRow,now),/wait until/);
assert.equal(retryBlock(failedRow,now+86400000),'');
assert.match(retryBlock({...failedRow,retry_recipient_id:id(9)},now+86400000),/already/);
for (const status of ['accepted','sent','delivered','read','unknown','queued','sending','skipped']) assert.match(retryBlock({status},now),/Only a confirmed failed/);
assert.match(retryBlock({...failedRow,deleted_at:new Date(now).toISOString()},now+86400000),/removed/);

async function main() {
  process.env.N8N_WEBHOOK_SECRET='fixture-shared-secret';process.env.ADMIN_PIN='fixture-password';
  const events=[];let removes=0;
  const repository={delivery:async event=>events.push(event),removeTemplate:async()=>{removes++;return true;},historyInfo:async()=>({id:id(1),recipients:2,messages:3}),removeHistory:async()=>{removes++;return {};}};
  const invoke=(pathname,method='POST',body={},access={role:'super_admin'},headers={})=>handleBroadcastRequest({pathname,method,body,access,request:{headers},repository,store:{},searchParams:new URLSearchParams()});
  assert.equal((await invoke('/api/automation/broadcasts/status','POST',{statuses:[receipt(),receipt('read'),null]},{},{'x-csat-webhook-secret':'fixture-shared-secret'})).statusCode,200);
  assert.equal(events.length,2);assert.equal(events[0].errorCode,'131049');
  const path=`/api/broadcasts/templates/${id(2)}`;
  assert.equal((await invoke(path,'DELETE',{confirmation:'DELETE'})).statusCode,403);
  assert.equal((await invoke(path,'DELETE',{confirmation:'DELETE'},{role:'admin',permissions:{broadcast_view:true}},{'x-admin-pin':'fixture-password'})).statusCode,403);
  assert.equal((await invoke(path,'DELETE',{confirmation:'DELETE'},{role:'super_admin'},{'x-admin-pin':'fixture-password'})).statusCode,200);assert.equal(removes,1);
  assert.equal((await invoke(`/api/broadcasts/history/${id(1)}`,'GET')).statusCode,200);

  // Retry endpoint rechecks current permissions and live CSAT ownership. A
  // mocked sender wake-up is the only external call permitted by this test.
  const retryTemplate={id:id(4),name:'approved',language:'en',body:'Approved announcement',active:true};
  const retryRow={id:id(5),phone:'919876543210',status:'failed',associations:[{id:id(6),clusterId:id(7)}],template:retryTemplate,parameters:[],parameter_values:[],message_body:'Approved announcement',title:'Original'};
  let routing={status:'none'},optedOut=false,creates=0,currentCluster=id(7);
  repository.recipient=async()=>retryRow;repository.templates=async()=>[retryTemplate];
  repository.create=async(input,rows)=>{creates++;assert.equal(input.retrySourceId,retryRow.id);assert.equal(rows.length,1);assert.equal(rows[0].message,retryRow.message_body);return {campaign:{id:id(8)}};};
  const store={getMessagingStatus:async()=>({enabled:true}),getDirectory:async()=>({clientPocs:[{id:id(6),clusterId:currentCluster,active:true,contactWhatsapp:retryRow.phone}]}),whatsappContactOptedOut:async()=>optedOut,getWhatsappRoutingContext:async()=>routing,whatsappSendInProgress:async()=>false};
  const access={role:'admin',email:'admin@example.test',clusterAccess:[{clusterId:id(7)}],permissions:{broadcast_view:true,broadcast_send:true}};
  const retryCall=(user=access)=>handleBroadcastRequest({pathname:`/api/broadcasts/recipients/${retryRow.id}/retry`,method:'POST',body:{requestId:id(9),consentConfirmed:true},access:user,request:{headers:{}},repository,store,searchParams:new URLSearchParams()});
  process.env.N8N_BROADCAST_WEBHOOK='https://fixture.invalid/queue';
  assert.equal((await retryCall({...access,permissions:{broadcast_view:true}})).statusCode,403);
  retryRow.status='delivered';assert.equal((await retryCall()).statusCode,409);retryRow.status='failed';
  routing={status:'active'};assert.equal((await retryCall()).statusCode,409);routing={status:'none'};
  optedOut=true;assert.equal((await retryCall()).statusCode,409);optedOut=false;
  currentCluster=id(10);assert.equal((await retryCall()).statusCode,403);currentCluster=id(7);
  assert.equal(creates,0);
  const previousFetch=global.fetch;
  try {global.fetch=async url=>{assert.equal(url,'https://fixture.invalid/queue');return {ok:true,status:200,json:async()=>({ok:true})};};assert.equal((await retryCall()).statusCode,201);assert.equal(creates,1);}
  finally {global.fetch=previousFetch;delete process.env.N8N_BROADCAST_WEBHOOK;}

  // Real repository queries: ordered receipts retain provider-specific failure data,
  // and cleanup erases content while preserving all IDs used by inbound routing.
  const queries=[];const client={query:async(sql,values=[])=>{queries.push({sql,values});
    if(sql.startsWith('select * from public.whatsapp_broadcast_delivery_events')) return {rows:[{status:'failed',rank:15,reason:failed.reason,error_code:failed.errorCode,delivery_at:failed.deliveryAt,retry_after:failed.retryAfter}]};
    if(sql.startsWith('select b.id,b.title'))return {rows:[{id:id(1),recipients:2,messages:3}]};
    return {rows:[]};},release:()=>{}};
  const repo=new BroadcastRepository({pool:{connect:async()=>client,query:client.query}});
  await repo.delivery(failed);
  assert.ok(queries.some(q=>q.sql.includes('excluded.rank>') && q.sql.includes('excluded.delivery_at>=')),'older/duplicate callbacks cannot regress delivery');
  assert.ok(queries.some(q=>q.sql.includes('update public.whatsapp_broadcast_recipients') && q.values.includes('131049')));
  queries.length=0;await repo.removeHistory(id(1),'super@example.test');
  assert.ok(queries.some(q=>q.sql.includes("set body='',error='',deleted_at=now()")));
  assert.ok(!queries.some(q=>/^delete from public.whatsapp_broadcast_(recipients|messages)/.test(q.sql)),'late reply routing and duplicate IDs survive cleanup');
  queries.length=0;await repo.routingEvidence('919876543210','wamid.inbound','wamid.quoted',new Date(now).toISOString());
  assert.ok(!queries.some(q=>q.sql.includes('deleted_at is null')),'routing still recognises cleared history');
  console.log('Broadcast delivery regressions passed: shared router isolation, OTP/visitor controls, receipt batches, retry cooldown, access checks and history routing retention.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
