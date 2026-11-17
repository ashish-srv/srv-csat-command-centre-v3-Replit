const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { ComponentHarness, elements } = require('./workspace-navigation-smoke');

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const permissions = { hasPermission: (user, key) => user.role === 'super_admin' || user.permissions?.[key] === true, canOpenManage: () => false };
const people = [
  { id:id(11), name:'Zoe', salutation:"Zoe Ma'am", active:true, contactWhatsapp:'919876543210', clientId:id(31), clientName:'A Client', projectId:id(21), projectName:'First Project', clusterId:id(1) },
  { id:id(12), name:'Anna', active:true, contactWhatsapp:'447700900124', clientId:id(32), clientName:'B Client', projectId:id(22), projectName:'Second Project', clusterId:id(1) },
  { id:id(13), name:'Zoe', active:true, contactWhatsapp:'919876543210', clientId:id(32), clientName:'B Client', projectId:id(22), projectName:'Second Project', clusterId:id(1) }
];
const template = {id:id(41),name:'approved_announcement',language:'en',body:'Hi {{1}}. {{2}}',active:true};
const recipient = {id:id(61),broadcast_id:id(51),title:'Announcement',phone:'919876543210',associations:[people[0]],status:'delivered',sent_at:'2026-11-17T04:00:00Z',latest_reply_at:'2026-11-17T04:10:00Z',latest_reply:'Can you share the details?',template,parameters:[{source:'poc_name',text:''},{source:'text',text:'General announcement'}]};
const data = {directory:{clusters:[{id:id(1),name:'Cluster A'}],clients:[{id:id(31),name:'A Client',clusterId:id(1)},{id:id(32),name:'B Client',clusterId:id(1)}],projects:[{id:id(21),name:'First Project',clientId:id(31)},{id:id(22),name:'Second Project',clientId:id(32)}],clientPocs:people},templates:[template],campaigns:[{id:id(51),title:'Announcement',created_at:'2026-11-17T04:00:00Z',created_by:'super@example.com',total:2,accepted:2,replied:1,skipped:0,failed:0}],hasMore:false,messaging:{enabled:true},senderConfigured:true};
const message = {id:id(71),side:'client',body:recipient.latest_reply,created_at:recipient.latest_reply_at};
let feedbackOwnsReplies=false;
const read = async url => {
  if(url.includes('/messages')) return {recipient,messages:[message],replyWindowOpen:true,feedbackOwnsReplies};
  if(url.startsWith('/api/broadcasts/inbox')) return {recipients:[recipient],hasMore:false};
  if(url===`/api/broadcasts/${id(51)}`) return {recipients:[recipient]};
  return data;
};
const labelInput = (h,label) => elements(h.find(node=>node.type==='label' && node.props.children?.[0]===label),node=>node.type==='input')[0];

async function main() {
  const writes=[];
  const h=new ComponentHarness('src/components/WhatsAppBroadcasts.jsx',{currentUser:{role:'super_admin'}},'/broadcasts',read,null,{modules:{'../permissions':permissions},write:async(url,body)=>{
    writes.push({url,body});
    if(url.endsWith('/preview')) return {uniqueRecipients:1,recipients:[{phone:'919876543210',associations:[people[0]],reason:'',message:'Hi Zoe. General announcement'}]};
    if(url.endsWith('/send')) return {campaign:{id:id(51)},queued:1,skipped:0,senderTriggered:true};
    return {queued:true,senderTriggered:true};
  }});
  h.window.setInterval=()=>1;h.window.clearInterval=()=>{};h.window.crypto=crypto;h.window.confirm=()=>true;
  await h.settle();
  assert.ok(h.calls.some(url=>url.startsWith('/api/broadcasts/inbox')), 'reply inbox loads across broadcasts by default');
  const recipientTable=h.find(node=>node.props['aria-label']==='Recipients grouped by client and project');
  assert.deepEqual(elements(recipientTable,node=>node.type==='th').map(node=>node.props.children),['Select','POC','WhatsApp Number','Salutation','Contact Status']);
  assert.ok(h.find(node=>node.props.id==='broadcast-conversation'),'the conversation window is visible before choosing a recipient');
  h.find(node=>node.props.children==='Conversation Window').props.onClick();await h.settle();
  assert.ok(h.scrolls.includes('broadcast-conversation'));
  const group=new ComponentHarness('src/components/WhatsAppBroadcasts.jsx',{group:{clientName:'A Client',projectName:'First Project',pocs:people.slice(0,2)},selected:[],onChange:()=>{}},'/broadcasts',read,'ReactGroup');
  await group.settle();
  assert.ok(group.find(node=>node.type==='td' && node.props.children===people[0].salutation));
  assert.ok(group.find(node=>node.type==='td' && node.props.children==='—'),'a missing salutation does not invent an honorific');
  const groups=elements(h.tree,node=>typeof node.type==='function' && node.type.name==='ReactGroup');
  assert.deepEqual(groups.map(node=>node.props.group.clientName),['A Client','B Client'],'grouping follows clients/projects, not global POC name order');
  labelInput(h,'Broadcast Title').props.onChange({target:{value:'Client announcement'}});await h.settle();
  h.find(node=>node.props.label==='Approved Announcement Template').props.onChange(template.id);await h.settle();
  h.find(node=>node.props.label==='Template Field 1').props.onChange('poc_name');await h.settle();
  labelInput(h,'Field Value').props.onChange({target:{value:'General announcement'}});await h.settle();
  h.find(node=>node.props.children==='Select All Matching POCs').props.onClick();await h.settle();
  h.find(node=>node.props.label==='Clients').props.onChange([id(31)]);await h.settle();
  await h.find(node=>node.props.children==='Preview Broadcast').props.onClick();await h.settle();
  assert.deepEqual(Array.from(writes[0].body.clientPocIds),[id(11)],'hidden selections cannot escape the current filters');
  const consent=h.find(node=>node.type==='label' && node.props.className==='broadcast-check' && node.props.children?.some?.(value=>typeof value==='string' && value.includes('selected recipients')));
  elements(consent,node=>node.type==='input')[0].props.onChange({target:{checked:true}});await h.settle();
  await h.find(node=>node.props.children==='Send Broadcast').props.onClick();await h.settle();
  assert.equal(writes[1].url,'/api/broadcasts/send');assert.equal(writes[1].body.consentConfirmed,true);assert.match(writes[1].body.requestId,/^[0-9a-f-]{36}$/);
  h.find(node=>node.props.children==='Open Conversation').props.onClick();await h.settle();
  assert.ok(h.scrolls.includes('broadcast-conversation'),'opening a conversation scrolls to the labelled chat window');
  assert.ok(h.find(node=>node.props.className==='broadcast-chat'));
  assert.ok(h.find(node=>node.type==='p' && node.props.children===recipient.latest_reply),'latest client reply appears in chat');
  const textarea=h.find(node=>node.type==='textarea' && node.props.maxLength===4096);
  textarea.props.onChange({target:{value:'Thank you. Here are the details.'}});await h.settle();
  await h.find(node=>node.props.children==='Send WhatsApp Reply').props.onClick();await h.settle();
  assert.equal(writes.at(-1).url,`/api/broadcasts/recipients/${id(61)}/reply`);
  feedbackOwnsReplies=true;
  await h.find(node=>node.props.children==='Refresh Status').props.onClick();await h.settle();
  assert.equal(h.find(node=>node.props.children==='Send WhatsApp Reply').props.disabled,true,'a newer feedback session prevents replying through the old broadcast composer');

  const viewer=new ComponentHarness('src/components/WhatsAppBroadcasts.jsx',{currentUser:{role:'admin',permissions:{broadcast_view:true}}},'/broadcasts',read,null,{modules:{'../permissions':permissions}});
  viewer.window.setInterval=()=>1;viewer.window.clearInterval=()=>{};await viewer.settle();
  assert.ok(!viewer.find(node=>node.props.children==='Create Broadcast'));
  assert.ok(!viewer.find(node=>node.props.id==='broadcast-templates'));

  // Exercise actual API authentication, role checks and saved permissions.
  process.env.APP_LOGIN_PASSWORD='broadcast-fixture';
  process.env.APP_SESSION_SECRET='broadcast-fixture-session-secret-at-least-32';
  process.env.GOOGLE_CLIENT_ID='fixture.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET='fixture-google-secret';
  process.env.GOOGLE_ALLOWED_DOMAINS='srvmedia.com';
  const users=[{email:'super@srvmedia.com',role:'super_admin',active:true},{email:'admin@srvmedia.com',role:'admin',active:true,clusterAccess:[{clusterId:id(1)}],permissions:{}},{email:'user@srvmedia.com',role:'project_user',active:true,permissions:{broadcast_view:true,broadcast_send:true}}];
  const fixtureStore={getAppUserByEmail:async email=>users.find(user=>user.email===email),getDirectory:async()=>data.directory,getMessagingStatus:async()=>({enabled:true})};
  const storePath=require.resolve('../src/lib/store');
  require.cache[storePath]={id:storePath,filename:storePath,loaded:true,exports:{createStore:()=>fixtureStore}};
  const repoPath=require.resolve('../src/lib/broadcast-repository');
  require.cache[repoPath]={id:repoPath,filename:repoPath,loaded:true,exports:{BroadcastRepository:class{
    async templates(){return [template];}
    async campaigns(){return {campaigns:[],hasMore:false};}
    async inbox(){return {recipients:[],hasMore:false};}
  }}};
  delete require.cache[require.resolve('../src/lib/broadcast-service')];
  const file=require.resolve('../src/server/api-handler');
  const api=new Module(file,module);api.filename=file;api.paths=Module._nodeModulePaths(path.dirname(file));
  api._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.authForTest={createAppSessionToken,APP_SESSION_COOKIE};',file);
  const http=async(user,body,path='/api/broadcasts',method='GET')=>{
    const auth=api.exports.authForTest;
    const cookie=user?`${auth.APP_SESSION_COOKIE}=${auth.createAppSessionToken(Date.now(),{provider:'google',sub:user.email,email:user.email,hostedDomain:'srvmedia.com'})}`:'';
    return api.exports.handleApiRequest({method,path,headers:{cookie},body:body||{},searchParams:new URLSearchParams(),baseUrl:'https://fixture.invalid'});
  };
  assert.equal((await http(null)).statusCode,401);
  assert.equal((await http(users[0])).statusCode,200);
  assert.equal((await http(users[1])).statusCode,403,'existing Admins require an explicit broadcast grant');
  users[1].permissions={broadcast_view:true};
  const granted=await http(users[1]);assert.equal(granted.statusCode,200,granted.body);
  assert.equal(JSON.parse(granted.body).directory.clientPocs.find(poc=>poc.id===people[0].id).salutation,people[0].salutation,'the scoped API supplies the configured salutation');
  assert.equal((await http(users[1],{},'/api/broadcasts/send','POST')).statusCode,403);
  assert.equal((await http(users[2])).statusCode,403,'Project Users cannot enable broadcasts through a crafted permission');
  users[1].permissions={};assert.equal((await http(users[1])).statusCode,403,'revocation takes effect for an existing login');
  console.log('Broadcast UI and HTTP checks passed: grouped selection, filtered recipients, preview/consent, queueing, inbox chat, feedback priority, role gates, cluster grants and permission revocation.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
