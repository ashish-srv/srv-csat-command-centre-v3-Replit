const assert = require('node:assert/strict');
const { SupabaseStore } = require('../src/lib/supabase-store');
const { pendingFeedbackRoutingReviews, recordFeedbackRoutingReview, canReviewFeedbackRouting } = require('../src/lib/feedback-routing-review');
const { ComponentHarness } = require('./workspace-navigation-smoke');

async function main() {
  const now=Date.now(), future=new Date(now+60000).toISOString();
  const initial = () => ({id:'session',project_id:'project',client_poc_id:'poc',status:'partial',updated_at:new Date(now-1000).toISOString(),
    csat_score:8,nps_score:9,reminder_due_at:future,conversation_state:{state:'quick_checkin_choice',quickCheckinDetail:'Existing detail'}});
  const store = new SupabaseStore({skipEnv:true});let row, race, patches;
  store.request=async(table,options)=>{
    assert.equal(table,'feedback_sessions');
    if(options.method!=='PATCH')return [structuredClone(row)];
    patches++;
    assert.equal(new URLSearchParams(options.query).get('updated_at'),`eq.${row.updated_at}`);
    if(race){race=false;row.status='completed';row.conversation_state={...row.conversation_state,state:'completed',stoppedByAdmin:true};row.updated_at=new Date().toISOString();return [];}
    Object.assign(row,options.body,{updated_at:new Date().toISOString()});return [structuredClone(row)];
  };
  for(const type of ['quick_checkin','pulse','project_end'])for(const window of [false,true]){
    row=initial();race=false;patches=0;
    row.conversation_state.state=window?(type==='quick_checkin'?'quick_checkin_window':'closing_grace'):(type==='quick_checkin'?'quick_checkin_choice':'waiting_for_overall_rating');
    if(window){row.status='completed';row.conversation_state[type==='quick_checkin'?'quickCheckinWindowExpiresAt':'closingGraceExpiresAt']=future;}
    const before=structuredClone(row);
    const result=await store.resumeFeedbackTemplate(row.id,type);
    assert.ok(result);assert.equal(patches,1);assert.equal(row.reminder_due_at,before.reminder_due_at);
    assert.equal(row.csat_score,8);assert.equal(row.nps_score,9);assert.equal(row.status,before.status);
    assert.equal(row.conversation_state.quickCheckinDetail,'Existing detail');
    assert.ok(row.conversation_state.templateResumedAt);
    assert.equal(row.conversation_state.state,!window&&type==='quick_checkin'?'quick_checkin_detail':before.conversation_state.state);
    for(const key of ['quickCheckinWindowExpiresAt','closingGraceExpiresAt'])assert.equal(row.conversation_state[key],before.conversation_state[key]);
  }
  row=initial();race=true;patches=0;
  assert.equal(await store.resumeFeedbackTemplate(row.id),null);assert.equal(patches,1);assert.equal(row.conversation_state.stoppedByAdmin,true);
  row=initial();row.reminder_due_at=new Date(now-1000).toISOString();patches=0;
  assert.equal(await store.resumeFeedbackTemplate(row.id),null);assert.equal(patches,0);

  const reviews=new Map(), inboxStore={claimAutomationEvent:async(type,payload,key)=>{
    if(reviews.has(key))return null;const event={id:key,event_type:type,payload,status:'pending'};reviews.set(key,event);return event;
  }};
  const body={from:'+91 98765 43210',text:'Share feedback',providerMessageId:'wamid.review'};
  const pocs=[{name:'Contact',projectId:'a'},{name:'Contact',projectId:'b'}];
  const answers=await Promise.all([1,2].map(()=>recordFeedbackRoutingReview(inboxStore,body,'ambiguous_projects',pocs,true)));
  assert.equal(answers.filter(item=>item.sendToWhatsapp).length,1);assert.equal(reviews.size,1);
  const review=[...reviews.values()][0];
  assert.equal(canReviewFeedbackRouting(review,{role:'admin'},[{id:'a'}]),false);
  assert.equal(canReviewFeedbackRouting(review,{role:'admin'},[{id:'a'},{id:'b'}]),true);
  assert.equal(canReviewFeedbackRouting(review,{role:'project_user'},[{id:'a'},{id:'b'}]),false);
  assert.equal(canReviewFeedbackRouting({...review,payload:{projectIds:[]}},{role:'admin'},[]),false);
  assert.equal(canReviewFeedbackRouting({...review,payload:{projectIds:[]}},{role:'super_admin'},[]),true);
  assert.equal((await recordFeedbackRoutingReview(inboxStore,{...body,providerMessageId:'wamid.paused'},'unavailable_button',pocs,false)).sendToWhatsapp,false);
  let reads=0;
  const pages=Array.from({length:205},(_,i)=>({...review,id:`review-${i}`}));
  const all=await pendingFeedbackRoutingReviews({request:async(table,options)=>{
    assert.equal(table,'automation_events');const params=new URLSearchParams(options.query);assert.equal(params.get('status'),'eq.pending');
    reads++;return pages.slice(Number(params.get('offset')),Number(params.get('offset'))+Number(params.get('limit')));
  }});
  assert.equal(all.length,205);assert.equal(reads,2);

  let reloaded=0, opened=null;const writes=[];
  const props={reviews:[{id:'review-id',pocName:'POC',from:'919876543210',reason:'Ambiguous projects',clientText:'Share feedback',projects:[{id:'a',key:'project-a',name:'Project A'}]}],onReload:()=>{reloaded++;},onOpenProject:key=>{opened=key;}};
  const h=new ComponentHarness('src/components/FeedbackRoutingReviews.jsx',props,'/dashboard',async()=>({}),null,{write:async(url)=>{writes.push(url);return {reviewed:true};}});
  await h.settle();assert.ok(h.find(node=>node.props.id==='dashboard-routing-reviews'));
  assert.equal(h.find(node=>node.props['aria-label']==='Feedback routing reviews').props.style.maxHeight,400);
  h.find(node=>Array.isArray(node.props.children)&&node.props.children[0]==='Open ').props.onClick();assert.equal(opened,'project-a');
  await h.find(node=>node.props.children==='Mark reviewed').props.onClick();await h.settle();
  assert.deepEqual(writes,['/api/feedback-routing-reviews/review-id/resolve']);assert.equal(reloaded,1);
  h.props={...props,reviews:[]};h.dirty=true;await h.settle();assert.equal(h.tree,null);
  console.log('Routing review and persistence checks passed: all three feedback types, unchanged scores/deadlines, concurrent stop, deduplication, cluster privacy, pagination and review UI.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
