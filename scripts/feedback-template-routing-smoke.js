const assert = require('node:assert/strict');
const { quickCheckinClosed, newerSurveyForClosedQuickCheckin, preferredResumedFeedback } = require('../src/lib/feedback-template-routing');
const now=Date.now();
const source={id:'old',clientPocId:'p1',sessionType:'quick_checkin',status:'completed',startedAt:new Date(now-86400000*3).toISOString(),conversationState:{state:'completed'}};
const current={id:'new',clientPocId:'p2',sessionType:'pulse',status:'started',startedAt:new Date(now-86400000).toISOString(),conversationState:{}};
const poc={id:'p2',active:true,contactWhatsapp:'919876543210'};
const body={from:'+91 98765 43210',providerTimestamp:String(Math.floor(now/1000))};
const route=(session=current,person=poc,status='active',input=body,old=source)=>newerSurveyForClosedQuickCheckin(old,{status,session,poc:person},input,now);
for(const type of ['pulse','project_end','quick_checkin']) assert.equal(route({...current,sessionType:type}).session.id,'new');
assert.equal(route({...current,id:'old'}),null);
assert.equal(route({...current,startedAt:source.startedAt}),null);
assert.equal(route({...current,startedAt:'invalid'}),null);
assert.equal(route({...current,channel:'web_test'}),null);
assert.equal(route({...current,sessionType:'quick_checkin',reminderDueAt:new Date(now-1000).toISOString()}),null);
for(const status of ['ambiguous','latest','not_found','no_session']) assert.equal(route(current,poc,status),null);
assert.equal(route(current,{...poc,id:'wrong'}),null);
assert.equal(route(current,{...poc,active:false}),null);
assert.equal(route(current,{...poc,contactWhatsapp:'447700900123'}),null);
assert.equal(route({...current,status:'completed',conversationState:{state:'completed'}}),null);
assert.equal(route({...current,status:'needs_attention',conversationState:{state:'handed_off'}}),null);
assert.equal(route({...current,status:'partial',conversationState:{state:'closing_grace',closingGraceExpiresAt:new Date(now-1000).toISOString()}}),null);
assert.ok(route({...current,status:'completed',conversationState:{state:'closing_grace',closingGraceExpiresAt:new Date(now+60000).toISOString()}}));
assert.equal(route(current,poc,'active',{...body,providerTimestamp:String(Math.floor((now-86400000*2)/1000))}),null,'delayed old taps cannot resume a survey that had not started');
const open={...source,status:'started',conversationState:{state:'quick_checkin_choice'},reminderDueAt:new Date(now+60000).toISOString()};
assert.equal(quickCheckinClosed(open,now),false);assert.equal(route(current,poc,'active',body,open),null);
assert.equal(quickCheckinClosed({...open,reminderDueAt:new Date(now-60000).toISOString()},now),true);
assert.equal(quickCheckinClosed({...open,conversationState:{state:'quick_checkin_window',quickCheckinWindowExpiresAt:new Date(now+60000).toISOString()},reminderDueAt:new Date(now-60000).toISOString()},now),false);
assert.equal(quickCheckinClosed({...open,status:'completed',conversationState:{state:'quick_checkin_window',quickCheckinWindowExpiresAt:new Date(now+60000).toISOString()}},now),false,'an open correction window is preserved even if a legacy status says completed');
console.log('Template routing checks passed: newer surveys, sender binding, response windows, late webhooks, ambiguous projects and current quick-check-ins.');

for (const type of ['pulse','project_end','quick_checkin']) {
  const same = {...current,sessionType:type,projectId:'project-a'};
  const another = {...current,id:'other',projectId:'project-b'};
  const candidates=[{session:same,poc},{session:another,poc}];
  assert.equal(newerSurveyForClosedQuickCheckin({...source,projectId:'project-a'}, {status:'ambiguous',candidates},body,now).session.id,'new');
  assert.equal(newerSurveyForClosedQuickCheckin({...source,projectId:'project-c'}, {status:'ambiguous',candidates},body,now),null);
  assert.equal(newerSurveyForClosedQuickCheckin({...source,projectId:'project-a'}, {status:'ambiguous',candidates:[...candidates,{session:{...same,id:'third'},poc}]},body,now),null);
  same.conversationState={resumptionPromptedAt:new Date(now-1000).toISOString()};
  assert.equal(preferredResumedFeedback(candidates,body,now),null,'ordinary survey resumption cannot select between projects');
  same.conversationState.templateResumedAt=new Date(now-1000).toISOString();
  assert.equal(preferredResumedFeedback(candidates,body,now).session.id,'new');
  assert.equal(preferredResumedFeedback(candidates,{...body,providerTimestamp:String(Math.floor((now-5000)/1000))},now),null);
  another.startedAt=new Date(now).toISOString();
  assert.equal(preferredResumedFeedback(candidates,body,now),null,'a later feedback invitation supersedes the selection');
  for (const flag of ['stoppedByAdmin','optedOut','reminderExhausted']) {
    assert.equal(route({...same,conversationState:{[flag]:true}}),null);
  }
}
console.log('All three feedback types: project disambiguation, subsequent reply binding, newer invitations and stop/opt-out guards passed.');
