const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { captureBirthdayInbound, phoneHash } = require('../src/lib/birthday-inbound');
const { BirthdayRepository } = require('../src/lib/birthday-repository');
const { handleBirthdayRequest } = require('../src/lib/birthday-service');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const from = '919000000001';
const contact = { id:id(1),clusterId:id(3),name:'Birthday Person',organization:'Organisation',active:true };
const birthdayRoute = { job_id:id(2),contact_id:contact.id,birthday_year:2026,phone_hash:phoneHash(from),provider_message_id:'wamid.birthday',dispatched_at:'2026-10-24T03:00:00Z',status:'accepted' };
const body = { from,text:'A client can say anything here',providerMessageId:'wamid.reply',providerTimestamp:'1792828800' };
let checks=0;
const check=(a,b)=>{assert.deepEqual(a,b);checks++;};
class Repo {
  constructor(){this.routes=[{...birthdayRoute}];this.receipts=[];this.latestCsat='2026-10-23T03:00:00Z';}
  async birthdayRoutingEvidence(hash,messageId,replyTo,notAfter){
    const routes=this.routes.filter(r=>r.phone_hash===hash&&r.status!=='failed');
    return {duplicate:this.receipts.find(r=>r.provider_message_id===messageId&&routes.some(w=>w.job_id===r.job_id)),quoted:routes.find(r=>r.provider_message_id===replyTo),latest:routes.filter(r=>r.dispatched_at<=notAfter).sort((a,b)=>b.dispatched_at.localeCompare(a.dispatched_at))[0]};
  }
  async latestCsatOutbound(){return this.latestCsat;}
  async saveBirthdayReply(route,message){
    const previous=this.receipts.find(r=>r.provider_message_id===message.providerMessageId);
    if(previous)return {...previous,duplicate:true};
    const saved={id:id(100+this.receipts.length),job_id:route.job_id,contact_id:route.contact_id,birthday_year:route.birthday_year,provider_message_id:message.providerMessageId,body:message.text,classification:message.classification,status:'awaiting_review'};
    this.receipts.push(saved);return saved;
  }
  async contacts(){return [contact,{...contact,id:id(4),clusterId:id(5)}];}
  async contact(key){return (await this.contacts()).find(c=>c.id===key);}
  async reply(key){return this.receipts.find(r=>r.id===key);}
  async replies(ids,year,filters){this.lastFilter={ids,year,filters};return {replies:this.receipts.filter(r=>ids.includes(r.contact_id)),hasMore:false};}
  async reviewReply(key,actor){const row=await this.reply(key);if(!row.reviewed_by)Object.assign(row,{status:'reviewed',reviewed_by:actor,reviewed_at:'2026-10-24T04:00:00Z'});return row;}
}
const store={hasProviderMessage:async()=>false};
const run=(repo,patch={},routing={status:'latest'})=>captureBirthdayInbound({store,repository:repo,body:{...body,...patch},routing});
const admin={role:'admin',email:'reviewer@example.com',clusterAccess:[{clusterId:contact.clusterId}],permissions:{birthday_centre:true,birthday_manage:true}};
async function endpoint(repo,method,pathname,access=admin,search='year=2026'){
  return handleBirthdayRequest({store,repository:repo,access,method,pathname,body:{},request:{headers:{}},searchParams:new URLSearchParams(search),baseUrl:'https://fixture.invalid'});
}
async function main(){
  let repo=new Repo();
  check((await run(repo)).classification,'manual_review');check(repo.receipts[0].body,body.text);
  check((await run(repo)).duplicate,true);check(repo.receipts.length,1);
  const messages=['Thank you','okay','9','Nothing else','Please call me','The report is incorrect','Campaign management was good','नमस्ते धन्यवाद','Can we arrange a visit?','We will reply later'];
  for(const [i,text] of messages.entries()){
    const response=await run(repo,{text,providerMessageId:`text-${i}`});
    check(response.sendToWhatsapp,false);check(response.classification,'manual_review');check(repo.receipts.at(-1).body,text);
  }
  for(const status of ['active','ambiguous']){
    repo=new Repo();check(await run(repo,{}, {status}),null);check(repo.receipts.length,0);
    const exact=await run(repo,{replyToMessageId:birthdayRoute.provider_message_id},{status});
    check(exact.classification,'birthday');check(exact.whatsappReplyText,'');
  }
  repo=new Repo();repo.latestCsat='2026-10-24T04:00:00Z';check(await run(repo),null);
  repo.latestCsat=birthdayRoute.dispatched_at;check(await run(repo),null);
  check((await run(repo,{replyToMessageId:birthdayRoute.provider_message_id})).classification,'birthday');
  repo=new Repo();check(await run(repo,{buttonPayload:'quick_checkin:session:abc'}),null);
  check(await run(repo,{replyToMessageId:'wamid.other-message'}),null);
  repo=new Repo();repo.routes[0].provider_message_id=null;repo.routes[0].status='prepared';
  check((await run(repo,{replyToMessageId:'wamid.provider-not-confirmed-yet'})).classification,'manual_review');
  repo=new Repo();
  check(await run(repo,{from:'919000000099',replyToMessageId:birthdayRoute.provider_message_id}),null);
  check(await run(repo,{providerTimestamp:'1700000000'}),null);
  await assert.rejects(()=>run(repo,{providerMessageId:''}),e=>e.status===400);checks++;
  repo=new Repo();repo.routes[0].status='failed';check(await run(repo),null);
  repo=new Repo();repo.routes=[];check(await run(repo),null);
  check(await captureBirthdayInbound({store,body,routing:{status:'latest'}}),null);
  repo=new Repo();repo.birthdayRoutingEvidence=async()=>{const e=new Error('missing table');e.code='42P01';throw e;};check(await run(repo),null);
  repo.birthdayRoutingEvidence=async()=>{throw new Error('temporary database failure');};
  await assert.rejects(()=>run(repo),/temporary database failure/);checks++;
  repo=new Repo();
  check(await captureBirthdayInbound({store:{hasProviderMessage:async()=>true},body,routing:{status:'latest'},repository:repo}),null);check(repo.receipts.length,0);
  await Promise.all([run(repo),run(repo)]);check(repo.receipts.length,1);
  check((await run(repo,{}, {status:'active'})).duplicate,true);
  // Inbox security and review-only side effects; no mail/survey methods exist here.
  let response=await endpoint(repo,'GET','/api/birthdays/replies');check(response.statusCode,200);
  check(repo.lastFilter.ids,[contact.id]);check(repo.lastFilter.year,2026);
  check((await endpoint(repo,'GET','/api/birthdays/replies',admin,'year=2026&status=bad')).statusCode,400);
  check((await endpoint(repo,'GET','/api/birthdays/replies',admin,'year=2026&offset=-1')).statusCode,400);
  check((await endpoint(repo,'GET','/api/birthdays/replies',{role:'project_user',permissions:{birthday_centre:true}})).statusCode,403);
  const receipt=repo.receipts[0], reviewPath=`/api/birthdays/replies/${receipt.id}/review`;
  check((await endpoint(repo,'POST',reviewPath,{...admin,permissions:{birthday_centre:true}})).statusCode,403);
  check((await endpoint(repo,'POST',reviewPath,{...admin,clusterAccess:[{clusterId:id(5)}]})).statusCode,403);
  check((await endpoint(repo,'POST',reviewPath)).statusCode,200);check(receipt.reviewed_by,admin.email);
  check((await endpoint(repo,'POST',reviewPath,{...admin,email:'different@example.com'})).statusCode,200);check(receipt.reviewed_by,admin.email);
  // Real repository emits parameterized, identity-scoped SQL, not survey writes.
  const queries=[];const sqlRepo=new BirthdayRepository({pool:{query:async(sql,values)=>{queries.push({sql,values});return {rows:[]};}}});
  await sqlRepo.birthdayRoutingEvidence(phoneHash(from),'incoming','quoted');await sqlRepo.latestCsatOutbound(from);
  await sqlRepo.replies([contact.id],2026,{status:'all',search:"x' OR true",offset:50});
  check(queries.some(q=>/update\s+public\.(feedback|messages)|insert into public\.(feedback|messages)/i.test(q.sql)),false);
  check(queries.at(-1).values[3],"x' OR true");check(queries.at(-1).sql.includes("x' OR true"),false);
  const file=path.join(__dirname,'../n8n/workflows/01 - CSAT v5 - WhatsApp Inbound Router (Birthday Reply Isolation).json');
  const workflow=JSON.parse(fs.readFileSync(file,'utf8'));
  check(workflow.active,false);const call=workflow.nodes.find(n=>n.name==='Call CSAT Engine');
  const msg={from,id:'wamid.test',text:{body:'Hello'},context:{id:'wamid.birthday'},timestamp:'1792828800'};
  const read=()=>({item:{json:{body:{entry:[{changes:[{value:{messages:[msg],contacts:[]}}]}]}}}});
  const payload=new Function('$',`return (${call.parameters.jsonBody.slice(3,-2)})`)(read);
  check(payload.replyToMessageId,'wamid.birthday');check(payload.providerMessageId,'wamid.test');check(payload.text,'Hello');
  check(call.credentials.httpHeaderAuth.name,'CSAT Webhook Secret');
  check(workflow.nodes.find(n=>n.name==='Send WhatsApp Reply').credentials.httpHeaderAuth.name,'Meta WhatsApp Token');
  check(workflow.nodes.find(n=>n.name==='WhatsApp Provider Webhook').parameters.path,'csat-whatsapp-inbound');
  // Integration: the real inbound API returns before any CSAT turn for a birthday reply.
  const originalEvidence=BirthdayRepository.prototype.birthdayRoutingEvidence;
  const originalSave=BirthdayRepository.prototype.saveBirthdayReply;
  BirthdayRepository.prototype.birthdayRoutingEvidence=async()=>({quoted:birthdayRoute});
  BirthdayRepository.prototype.saveBirthdayReply=async()=>({id:id(900),classification:'birthday'});
  const storePath=require.resolve('../src/lib/store');require(storePath);
  const originalStore=require.cache[storePath].exports;
  require.cache[storePath].exports={createStore:()=>({pool:{},getWhatsappRoutingContext:async()=>({status:'latest'}),hasProviderMessage:async()=>false})};
  process.env.N8N_WEBHOOK_SECRET='isolated-birthday-inbound-secret-123456';
  try{
    const {handleApiRequest}=require('../src/server/api-handler');
    response=await handleApiRequest({method:'POST',path:'/api/whatsapp/inbound',body:{...body,replyToMessageId:birthdayRoute.provider_message_id},headers:{'x-csat-webhook-secret':process.env.N8N_WEBHOOK_SECRET},searchParams:new URLSearchParams(),baseUrl:'https://fixture.invalid'});
    check(response.statusCode,200);check(JSON.parse(response.body).routedTo,'birthday_review');check(JSON.parse(response.body).sendToWhatsapp,false);
  }finally{require.cache[storePath].exports=originalStore;BirthdayRepository.prototype.birthdayRoutingEvidence=originalEvidence;BirthdayRepository.prototype.saveBirthdayReply=originalSave;}
  console.log(`${checks} birthday reply isolation, inbox security and live-workflow contract checks passed. No external messages sent.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
