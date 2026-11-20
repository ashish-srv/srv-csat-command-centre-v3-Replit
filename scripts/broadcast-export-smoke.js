const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');
const { handleBroadcastRequest } = require('../src/lib/broadcast-service');

function load(relative) {
  const filename=path.resolve(relative), loaded=new Module(filename,module);
  loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(transformSync(fs.readFileSync(filename,'utf8'),{loader:'jsx',format:'cjs',jsx:'automatic'}).code,filename);
  return loaded.exports;
}
const { buildBroadcastReport } = load('src/lib/broadcast-report.js');
const exporter = load('src/lib/report-export.js');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const association={id:id(3),name:'Contact A',clientName:'Client A',projectName:'Project A',clusterId:id(1)};
const raw={id:id(4),broadcast_id:id(5),title:'Autumn Announcement',broadcast_created_at:'2026-11-19T18:40:00Z',created_by:'admin@example.test',
  template:{name:'approved_announcement',language:'en'},phone:'919876543210',associations:[association],status:'read',message_body:'Announcement <script>alert(1)</script>',
  delivery_at:'2026-11-19T19:00:00Z',latest_reply_at:'2026-11-19T19:01:00Z',latest_reply:'Thank you <tag>',provider_message_id:'PRIVATE-PROVIDER-ID',automationSecret:'PRIVATE-SECRET'};
const rows=[raw,{...raw,id:id(6),phone:'919876543211',status:'failed',reason:'Meta 131049: Marketing delivery limited',error_code:'131049',retry_after:'2026-11-21T12:00:00Z',latest_reply_at:null,latest_reply:''},
  {...raw,id:id(7),phone:'',status:'skipped',reason:'WhatsApp Number Missing',latest_reply_at:null,latest_reply:''}];
const messages=[{id:id(9),recipient_id:raw.id,side:'client',body:'Thank you <tag>',status:'received',provider_at:raw.latest_reply_at,provider_message_id:'PRIVATE-MESSAGE-ID'},
  {id:id(10),recipient_id:raw.id,side:'srv',body:'Here are the details.',status:'delivered',created_at:'2026-11-19T19:02:00Z'},
  {id:id(11),recipient_id:raw.id,side:'client',body:'ERASED MESSAGE',deleted_at:'2026-11-20T01:00:00Z'}];

async function main() {
  let seen;
  const repo={exportRows:async(clusters,filters)=>{seen={clusters,filters};return {recipients:rows,messages};}};
  const admin={role:'admin',permissions:{broadcast_view:true},clusterAccess:[{clusterId:id(1)}]};
  const request=(params='',access=admin)=>handleBroadcastRequest({store:{},access,request:{headers:{}},pathname:'/api/broadcasts/export',method:'GET',searchParams:new URLSearchParams(params),repository:repo});
  assert.equal((await request('',{role:'project_user',permissions:{broadcast_view:true}})).statusCode,403);
  assert.equal((await request('',{role:'admin',permissions:{}})).statusCode,403);
  for(const invalid of ['section=unknown','section=replies&from=2026-02-30','section=replies&from=2026-11-20&to=2026-11-01','section=replies&campaignId=bad','section=replies&statuses=bad','section=replies&replies=bad']) assert.equal((await request(invalid)).statusCode,400);
  const response=await request(`section=replies&campaignId=${raw.broadcast_id}&statuses=failed,read&replies=no_reply&search=Client&from=2026-11-01&to=2026-11-20`);
  assert.equal(response.statusCode,200);
  assert.deepEqual(seen.clusters,[id(1)]);assert.equal(seen.filters.campaignId,raw.broadcast_id);assert.deepEqual(seen.filters.statuses,['failed','read']);assert.equal(seen.filters.from,'2026-11-01');
  const data=JSON.parse(response.body);
  assert.ok(!response.body.includes('PRIVATE'));assert.ok(!response.body.includes('ERASED MESSAGE'));
  rows.push({...raw,id:id(20),associations:[association,{...association,clusterId:id(2)}]});
  messages.push({id:id(21),recipient_id:id(20),side:'client',body:'OTHER CLUSTER CHAT'});
  const scoped=await request('section=history');
  assert.ok(!scoped.body.includes('OTHER CLUSTER CHAT'));assert.equal(JSON.parse(scoped.body).recipients.length,3,'shared-number foreign-cluster history is excluded entirely');
  assert.equal(seen.filters.campaignId,'');assert.deepEqual(seen.filters.statuses,[]);
  const report=buildBroadcastReport({...data,generatedAt:'2026-11-19T20:00:00Z'});
  assert.equal(report.sections[0].rows[0].recipients,3);assert.equal(report.sections[0].rows[0].delivered,1);assert.equal(report.sections[0].rows[0].failed,1);assert.equal(report.sections[0].rows[0].skipped,1);
  assert.equal(report.sections[2].chatSessions.length,3);assert.equal(report.sections[2].chatSessions[0].messages.length,3);
  assert.match(report.sections[0].rows[0].created,/20 Nov 2026/,'all dates use IST at the UTC day boundary');
  const html=exporter.reportToHtml(report);
  assert.ok(html.includes('WhatsApp Broadcast Report'));assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('WhatsApp Number Missing'));assert.ok(html.includes('Meta 131049'));assert.equal((html.match(/class="chat-session"/g)||[]).length,3);
  assert.ok(html.includes('chat-scroll'));assert.match(html,/max-height: none !important/,'PDF prints full transcripts beyond the HTML scroll window');
  const workbook=await exporter.buildExcelReport(report);
  assert.deepEqual(workbook.worksheets.map(sheet=>sheet.name),['Summary','Announcements','Recipients','Conversations']);
  assert.equal(workbook.getWorksheet('Recipients').getCell('C2').value,raw.phone);
  assert.equal(workbook.getWorksheet('Recipients').getCell('G3').value,'131049');
  assert.equal(workbook.getWorksheet('Recipients').views[0].ySplit,1);assert.ok(workbook.getWorksheet('Recipients').autoFilter);
  const bytes=await workbook.xlsx.writeBuffer();const ExcelJS=require('exceljs');const reopened=await new ExcelJS.Workbook().xlsx.load(bytes);
  assert.equal(reopened.getWorksheet('Recipients').getCell('C2').value,raw.phone);assert.equal(reopened.getWorksheet('Announcements').getCell('F2').value,3);
  assert.ok(reopened.getWorksheet('Announcements').getCell('B2').value instanceof Date);
  assert.equal(reopened.getWorksheet('Announcements').getCell('B2').value.toISOString(),'2026-11-20T00:10:00.000Z','Excel date cells display sortable IST dates');
  assert.equal(reopened.getWorksheet('Summary').getCell('B3').value.toISOString(),'2026-11-20T01:30:00.000Z','generated time is also in IST');
  const literal=reopened.getWorksheet('Conversations').getCell('C3').value;assert.equal(typeof literal,'string');assert.ok(literal.includes('<script>'));
  assert.throws(()=>buildBroadcastReport({recipients:[]}),/No broadcast records/);
  const removed=buildBroadcastReport({...data,recipients:[{...data.recipients[0],removedAt:'2026-11-20T01:00:00Z',message:''}],messages:[data.messages[0]]});
  assert.equal(removed.sections[2].chatSessions[0].messages.length,1,'deleted announcement content is never recreated');
  if(process.argv.includes('--fixtures')) {
    fs.mkdirSync('outputs/broadcast-export-qa',{recursive:true});
    fs.writeFileSync('outputs/broadcast-export-qa/report.html',html);fs.writeFileSync('outputs/broadcast-export-qa/report.xlsx',bytes);
    fs.writeFileSync('outputs/broadcast-export-qa/data.json',JSON.stringify(data,null,2));
  }
  console.log('Broadcast export checks passed: scope, filters, recipient/delivery counts, raw conversations, HTML escaping, IST dates and Excel round-trip.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
