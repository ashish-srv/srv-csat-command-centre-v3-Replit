// Optional integration check against disposable embedded PostgreSQL. Pass an
// installed @electric-sql/pglite directory; no production connection is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BroadcastRepository } = require('../src/lib/broadcast-repository');
const { deliveryEvent } = require('../src/lib/broadcast-delivery');
const { captureBroadcastInbound } = require('../src/lib/broadcast-inbound');

async function main() {
  if (!process.argv[2]) throw new Error('Pass the path to a temporary @electric-sql/pglite installation. This test never uses DATABASE_URL.');
  const { PGlite } = require(path.resolve(process.argv[2]));
  const database = new PGlite();
  try {
    await database.exec('create table public.feedback_cycles(id uuid primary key);');
    await database.exec(fs.readFileSync('database/migrations/026-whatsapp-broadcasts.sql','utf8'));
    await database.exec(fs.readFileSync('database/migrations/027-broadcast-delivery-and-history.sql','utf8'));
    await database.exec(fs.readFileSync('database/migrations/027-broadcast-delivery-and-history.sql','utf8'));
    const pool = { query: (sql, values=[])=>database.query(sql, values), connect: async()=>({query:(sql,values=[])=>database.query(sql,values),release:()=>{}}) };
    const repo = new BroadcastRepository({pool});
    const cluster = crypto.randomUUID(), poc = crypto.randomUUID();
    const associations=[{id:poc,name:'Test Person',clientName:'Test Client',projectName:'Test Project',clusterId:cluster}];
    const template=await repo.saveTemplate({name:'approved_test',language:'en',body:'Test announcement'},'tester');
    const make=async(title='Announcement')=>repo.create({requestId:crypto.randomUUID(),hash:title,title,template,parameters:[]},[{phone:'919876543210',associations,message:'Test announcement',parameterValues:[],reason:''}],'tester');
    const first=await make();
    let original=(await repo.recipients(first.campaign.id,null))[0];
    const failureTime=Date.now()-2*86400000;
    const failed=deliveryEvent({id:'wamid.first',status:'failed',timestamp:String(Math.floor(failureTime/1000)),errors:[{code:131049,error_data:{details:'Recipient marketing limit'}}]});
    // Receipt arrives before the sender response has persisted its provider ID.
    await repo.delivery(failed);
    await database.query("update public.whatsapp_broadcast_recipients set status='sending',dispatch_at=$2,claimed_at=$2 where id=$1",[original.id,new Date(failureTime).toISOString()]);
    await repo.finish(original.id,'template',{status:'accepted',providerMessageId:'wamid.first'});
    original=await repo.recipient(original.id,null);
    assert.equal(original.status,'failed');assert.equal(original.error_code,'131049');
    assert.equal(new Date(original.retry_after).toISOString(),failed.retryAfter);
    await repo.delivery({...failed,status:'sent',reason:'',errorCode:null,retryAfter:null});
    assert.equal((await repo.recipient(original.id,null)).status,'failed','late sent callback cannot replace failed');
    const retryInput={requestId:crypto.randomUUID(),hash:'retry',title:'Retry',template,parameters:[],retrySourceId:original.id};
    const retryRows=[{phone:original.phone,associations,message:original.message_body,parameterValues:[],reason:''}];
    const retry=await repo.create(retryInput,retryRows,'tester');
    assert.equal((await repo.create(retryInput,retryRows,'tester')).duplicate,true);
    await assert.rejects(repo.create({...retryInput,requestId:crypto.randomUUID()},retryRows,'tester'),/already/);
    const retried=(await repo.recipients(retry.campaign.id,[cluster]))[0];
    assert.notEqual(retried.id,original.id);assert.equal(retried.retry_source_id,original.id);
    assert.equal((await repo.recipient(original.id,null)).retry_recipient_id,retried.id);
    assert.equal((await repo.recipients(first.campaign.id,[crypto.randomUUID()])).length,0);
    await assert.rejects(repo.removeHistory(retry.campaign.id,'tester'),/queued/);
    await repo.delivery({...failed,status:'delivered',reason:'',errorCode:null,retryAfter:null});
    assert.match(await repo.retryStillFailed(retried,pool),/Only a confirmed failed/,'late success prevents the queued retry from dispatching');
    await repo.delivery({...failed,status:'read',reason:'',errorCode:null,retryAfter:null});
    await repo.delivery(failed);
    assert.equal((await repo.recipient(original.id,null)).status,'read');
    assert.equal((await repo.recipient(original.id,null)).error_code,null);
    const totals=(await repo.campaigns(null)).campaigns.find(row=>row.id===first.campaign.id);
    assert.equal(totals.delivered,1);assert.equal(totals.read,1);assert.equal(totals.failed,0);
    await repo.saveIncoming(original,{text:'Congratulations',messageId:'wamid.client',replyTo:'wamid.first',providerAt:new Date().toISOString()});
    const info=await repo.historyInfo(first.campaign.id);assert.equal(info.recipients,1);assert.equal(info.messages,1);
    await repo.removeHistory(first.campaign.id,'tester');
    assert.equal((await repo.campaigns(null)).campaigns.some(row=>row.id===first.campaign.id),false);
    assert.equal((await repo.messages(original.id)).length,0);
    const filter={offset:0,replies:[],statuses:[],from:'',to:'',search:''};
    assert.equal((await repo.inbox(null,filter)).recipients.some(row=>row.id===original.id),false);
    let evidence=await repo.routingEvidence(original.phone,'wamid.client','wamid.first',new Date().toISOString());
    assert.ok(evidence.duplicate);assert.equal(evidence.duplicate.body,'');assert.equal(evidence.latest.id,original.id);assert.equal(evidence.quoted.id,original.id);
    // Exercise the real inbound router after deletion: no CSAT auto reply.
    const oldStart=repo.latestFeedbackStart.bind(repo);
    repo.latestFeedbackStart=async()=>null;
    let result=await captureBroadcastInbound({store:{},repository:repo,body:{from:original.phone,text:'New question',providerMessageId:'wamid.late',replyToMessageId:'wamid.first'}});
    assert.equal(result.routedTo,'broadcast');assert.equal(result.sendToWhatsapp,false);
    assert.equal((await repo.messages(original.id))[0].body,'New question');
    assert.ok((await repo.inbox(null,filter)).recipients.some(row=>row.id===original.id));
    repo.latestFeedbackStart=async()=>new Date().toISOString();
    result=await captureBroadcastInbound({store:{},repository:repo,body:{from:original.phone,text:'Feedback',providerMessageId:'wamid.feedback'}});
    assert.equal(result,null,'new feedback still takes priority after an announcement');
    repo.latestFeedbackStart=oldStart;
    // Existing client messages remain deduplicated even after their contents are erased.
    const duplicate=await repo.saveIncoming(original,{text:'Must not restore deleted text',messageId:'wamid.client',replyTo:'wamid.first',providerAt:new Date().toISOString()});
    assert.equal(duplicate.body,'');assert.ok(duplicate.deleted_at);
    await repo.removeTemplate(template.id);
    assert.equal((await repo.templates()).length,0);
    assert.equal((await repo.recipient(retried.id,null)).template.body,'Test announcement');
    const immediate=await make('Immediate rejection');
    const immediateRow=(await repo.recipients(immediate.campaign.id,null))[0];
    await database.query("update public.whatsapp_broadcast_recipients set status='sending' where id=$1",[immediateRow.id]);
    await repo.finish(immediateRow.id,'template',{status:'failed',reason:'HTTP 400 / Meta 131049: Limited marketing delivery'});
    const rejected=await repo.recipient(immediateRow.id,null);
    assert.equal(rejected.error_code,'131049');assert.ok(Date.parse(rejected.retry_after)>Date.now());
    console.log('Embedded PostgreSQL checks passed: additive/idempotent migration, early/late/duplicate receipts, retry uniqueness, scope, cleanup, late reply isolation and newer CSAT priority.');
  } finally { await database.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
