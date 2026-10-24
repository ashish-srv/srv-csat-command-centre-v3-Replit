const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/lib/birthday-domain');
const { BirthdayRepository } = require('../src/lib/birthday-repository');

// Isolated fixtures: never read .env, connect to PostgreSQL, or send real mail.
const sent = [];
const emailPath = require.resolve('../src/lib/email');
const realEmail = require(emailPath);
require.cache[emailPath].exports = { ...realEmail, smtpConfigured: () => false, sendEmail: async email => { sent.push(email); return { sent: true, messageId: crypto.randomUUID() }; } };
const S = require('../src/lib/birthday-service');
process.env.APP_SESSION_SECRET = 'isolated-birthday-session-secret-123456';
process.env.N8N_WEBHOOK_SECRET = 'isolated-birthday-webhook-secret-123456';
process.env.ADMIN_PIN = 'isolated-manage-password';
const id = digit => `00000000-0000-4000-8000-${String(digit).padStart(12, '0')}`;
const directory = { clusters: [{ id: id(1), name: 'Orion' }, { id: id(2), name: 'Other' }],
  internalPocs: [{ id: id(11), name: 'Owner One', email: 'one@example.com', clusterIds: [id(1)], active: true }, { id: id(12), name: 'Owner Two', email: 'two@example.com', clusterIds: [id(1)], active: true }], clientPocs: [] };
const superAdmin = { role: 'super_admin', email: 'super@example.com' };
const admin = { role: 'admin', email: 'admin@example.com', clusterAccess: [{ clusterId: id(1) }], permissions: { birthday_centre: true, birthday_manage: true, birthday_reminders: true, birthday_cleanup: true } };
const input = { name: 'Sample Person', organization: 'Organisation Without CSAT', birthday: '10-24', email: 'client@example.com', whatsapp: '919876543210', clusterId: id(1), internalPocIds: [id(11),id(12)], giftEligible: true };
const contact = { ...D.normalizeContact(input, directory, superAdmin), id: id(21), version: 1 };
const settings = { ...D.DEFAULT_SETTINGS, enabled: true, deskEmails: ['desk@example.com'], notificationEmails: ['notices@example.com'], whatsappTemplate: 'approved_birthday_template' };
const clone = value => JSON.parse(JSON.stringify(value));
class MemoryRepo {
  constructor() { this.people = [clone(contact)]; this.occasionsMap = new Map(); this.queue = []; this.audit = []; this.blockers = []; this.config = clone(settings); this.tail = Promise.resolve(); }
  async contacts(includeRemoved = false) { return this.people.filter(c => includeRemoved || !c.removedAt); }
  async contact(contactId, includeRemoved = false) { return this.people.find(c => c.id === contactId && (includeRemoved || !c.removedAt)); }
  async settings() { return this.config; }
  async saveSettings(value) { this.config = value; }
  async ensure(c, year) { const key = `${c.id}:${year}`; if (!this.occasionsMap.has(key)) this.occasionsMap.set(key, { ...D.initialOccasion(c), id: crypto.randomUUID(), contactId: c.id, year, version: 1 }); return clone(this.occasionsMap.get(key)); }
  async occasions(year) { return [...this.occasionsMap.values()].filter(o => o.year === year); }
  async unfinished() { return [...this.occasionsMap.values()].filter(o => o.followupsStarted && !o.gift); }
  async change(c, year, category, action, actor, transform) {
    const previous = this.tail; let release; this.tail = new Promise(resolve => { release = resolve; }); await previous;
    try { const before = await this.ensure(c, year), changed = transform(before); if (changed.duplicate) return { ...before, duplicate: true };
      const after = { ...(changed.data || changed), version: before.version + 1 }; this.occasionsMap.set(`${c.id}:${year}`, after);
      this.audit.push({ id: crypto.randomUUID(), contact_id: c.id, birthday_year: year, category, action, actor, details: {}, created_at: new Date().toISOString() }); return clone(after);
    } finally { release(); }
  }
  async enqueue(c, year, key, kind, channel, payload) { if (this.queue.some(j => j.dedupe_key === key)) return null; const job = { id: crypto.randomUUID(), contact_id: c.id, birthday_year: year, dedupe_key: key, kind, channel, payload, status: 'pending', result: {}, created_at: new Date().toISOString() }; this.queue.push(job); return job; }
  async claim(channel,contactIds=null) { return this.queue.filter(j => j.status === 'pending' && j.channel === channel && (!contactIds || contactIds.includes(j.contact_id))).slice(0, 20).map(j => { j.status = 'processing'; return clone(j); }); }
  async finish(jobId, status, result) { const job = this.queue.find(j => j.id === jobId && j.status === 'processing'); if (job) Object.assign(job, { status, result }); return job; }
  async stale() {}
  async prepareWhatsappRoute(job,c,hash) { this.preparedRoute={job,c,hash}; }
  async confirmWhatsappRoute(jobId,status,providerId) { this.confirmedRoute={jobId,status,providerId}; }
  async activeFeedback() { return this.blockers; }
  async events(ids, year) { return this.audit.filter(e => ids.includes(e.contact_id) && e.birthday_year === year); }
  async jobs(ids, year) { return this.queue.filter(j => ids.includes(j.contact_id) && j.birthday_year === year); }
  async cleanup(ids, year, kind, actor) { this.cleanupRequest = { ids, year, kind, actor }; return 1; }
  async saveContacts(rows) { this.savedRows = rows; return rows; }
}
const store = { getDirectory: async () => directory, listAppUsers: async () => [{ role: 'super_admin', active: true, email: 'super@example.com' }, { role: 'project_user', active: true, email: 'never-csat@example.com' }], getMessagingStatus: async () => ({ enabled: true }) };
const baseUrl = 'https://fixture.invalid';
const response = async (repo, method, pathname, body = {}, access = superAdmin, headers = {}, search = '') => S.handleBirthdayRequest({ repository: repo, store, method, pathname, body, access, request: { headers }, searchParams: new URLSearchParams(search), baseUrl });
let checks = 0;
function check(actual, expected) { assert.deepEqual(actual, expected); checks++; }
function throws(fn, status) { assert.throws(fn, e => e.status === status); checks++; }
async function main() {
  check(contact.emailEnabled, false); check(contact.whatsappEnabled, false); check(contact.internalPocIds.length, 2);
  check(D.normalizeContact({...input,email:'changed@example.com',whatsapp:'919876540000'},directory,superAdmin,contact).identityKey,contact.identityKey);
  for (const birthday of ['13-01','02-30','00-00','word']) throws(() => D.normalizeContact({ ...input, birthday }, directory, superAdmin), 400);
  throws(() => D.normalizeContact({ ...input, internalPocIds: [] }, directory, superAdmin), 400);
  throws(() => D.normalizeContact({ ...input, internalPocIds: [null, ''] }, directory, superAdmin), 400);
  throws(() => D.normalizeContact({ ...input, emailEnabled: true, email: '' }, directory, superAdmin), 400);
  throws(() => D.normalizeContact({ ...input, whatsappEnabled: true }, directory, superAdmin), 400);
  throws(() => D.normalizeContact({ ...input, clusterId: id(2) }, directory, admin), 403);
  check(D.birthdayDate('02-29', 2027), '2027-02-28'); check(D.birthdayDate('02-29', 2028), '2028-02-29');
  check(D.daysUntil('01-03', 2027, '2026-12-24'), 10);
  for (let days = 0; days <= 12; days++) {
    const today = new Date(Date.UTC(2026,9,24-days)).toISOString().slice(0,10);
    check(D.reminderKinds(contact, D.initialOccasion(contact), 2026, today).includes('decision'), days === 10 || days <= 7);
  }
  check(D.reminderKinds(contact, { ...D.initialOccasion(contact), followupsStarted: true }, 2026, '2026-10-25'), ['decision']);
  check(D.reminderKinds(contact, { ...D.initialOccasion(contact), gift: 'No Gift' }, 2026, '2026-10-23'), []);
  check(D.reminderKinds(contact, { ...D.initialOccasion(contact), gift: 'Plant', stage: 'Delivered' }, 2026, '2026-10-24'), []);
  const token = D.actionToken({ contactId: contact.id, year: 2026, purpose: 'decision', ownerId: id(11), email: 'one@example.com' });
  check(D.readActionToken(token).year, 2026);
  throws(() => D.readActionToken(token + 'x'), 403);
  throws(() => D.readActionToken(token, Date.now() + 46 * 86400000), 403);

  let repo = new MemoryRepo();
  const args = { repo, store, baseUrl, now: new Date('2026-10-14T04:00:00Z') };
  await S.runBirthdaySchedule(args);
  check(repo.queue.filter(j => j.kind === 'decision').length, 2);
  check(new Set(repo.queue.map(j => j.payload.to[0])).size, 2);
  check(repo.queue[0].payload.html.includes('&amp;gift=Cake'),true);
  const auditCount = repo.audit.length;
  await S.runBirthdaySchedule(args);
  check(repo.queue.length, 2); check(repo.audit.length, auditCount);
  check(repo.queue.some(j => j.channel === 'whatsapp'), false);
  await S.runBirthdaySchedule({ ...args, now: new Date('2026-10-17T04:00:00Z') });
  await S.runBirthdaySchedule({ ...args, now: new Date('2026-10-18T04:00:00Z') });
  check(repo.queue.filter(j => j.kind === 'decision').length, 6);
  await S.runBirthdaySchedule({ ...args, now: new Date('2026-10-21T04:00:00Z') });
  check((await repo.ensure(contact,2026)).escalated, true);
  check(repo.queue.some(j => j.kind === 'escalation' && j.payload.to.includes('super@example.com')), true);

  repo = new MemoryRepo();
  const publicLink = '/api/automation/birthdays/action';
  const page = await response(repo, 'GET', publicLink, {}, null, {}, `token=${encodeURIComponent(token)}`);
  check(page.statusCode, 200); check((await repo.ensure(contact,2026)).gift, ''); check(repo.audit.length,0);
  const choices = await Promise.all(['Cake','Plant'].map((gift, i) => S.applyOccasionAction({ repo, store, directory, settings, contact, year:2026, body:{action:'select',gift}, actor:`Owner ${i}`, baseUrl })));
  check(choices.filter(r => r.occasion.duplicate).length, 1);
  check((await repo.ensure(contact,2026)).gift,'Cake');
  const nextToken = D.actionToken({ contactId:contact.id,year:2026,purpose:'decision',ownerId:id(12),email:'two@example.com' });
  const otherPage = await response(repo,'GET',publicLink,{},null,{},`token=${encodeURIComponent(nextToken)}`);
  check(otherPage.body.includes('Cake'),true); check(otherPage.body.includes('Owner 0'),true);
  check((await response(repo,'POST',publicLink,{token:nextToken,action:'approve',requestId:'forged'},null)).statusCode,403);
  check((await response(repo,'POST',publicLink,{token:nextToken,action:'request_change',gift:'Plant',reason:'A different arrangement is requested.'},null)).statusCode,200);
  const request = (await repo.ensure(contact,2026)).changeRequests[0];
  check(request.status,'pending'); check((await repo.ensure(contact,2026)).gift,'Cake');
  const changeMails = repo.queue.filter(j => j.kind === 'change_request');
  check(changeMails.length,1);check(changeMails[0].payload.to,['super@example.com']);
  check(changeMails[0].payload.text.includes('Requested Gift: Plant'),true);
  check(changeMails[0].payload.text.includes('A different arrangement is requested.'),true);
  check((await response(repo,'POST',`/api/birthdays/contacts/${contact.id}/action`,{year:2026,action:'approve',requestId:request.id},admin)).statusCode,200);
  check((await repo.ensure(contact,2026)).gift,'Plant');
  const deskToken = D.actionToken({contactId:contact.id,year:2026,purpose:'delivery',email:'desk@example.com'});
  check((await response(repo,'POST',publicLink,{token:deskToken,action:'delivery_no'},null)).statusCode,400);
  check((await response(repo,'POST',publicLink,{token:deskToken,action:'delivery_no',reason:'Courier could not reach the address.'},null)).statusCode,200);
  check((await repo.ensure(contact,2026)).deliveryReason,'Courier could not reach the address.');
  check((await response(repo,'POST',publicLink,{token:deskToken,action:'delivered'},null)).statusCode,200);
  check((await repo.ensure(contact,2026)).stage,'Delivered');
  const afterDelivery = repo.audit.length;
  await response(repo,'POST',publicLink,{token:deskToken,action:'delivered'},null);
  check(repo.audit.length,afterDelivery);
  const viewer = { ...admin, permissions:{birthday_centre:true} };
  check((await response(repo,'POST',`/api/birthdays/contacts/${contact.id}/action`,{year:2026,action:'arranged'},viewer)).statusCode,403);
  check((await response(repo,'GET','/api/birthdays',{}, {...admin,clusterAccess:[{clusterId:id(2)}]})).statusCode,200);
  const outside = await response(repo,'POST',`/api/birthdays/contacts/${contact.id}/action`,{year:2026,action:'arranged'}, {...admin,clusterAccess:[{clusterId:id(2)}]});
  check(outside.statusCode,403);
  check((await response(repo,'GET','/api/birthdays',{}, {role:'project_user',permissions:{birthday_centre:true}})).statusCode,403);
  const visible = await response(repo,'GET','/api/birthdays',{},viewer,{},'year=2026');
  check(visible.statusCode,200);check(visible.body.includes('token='),false);
  const history = await response(repo,'GET',`/api/birthdays/contacts/${contact.id}/history`,{},viewer,{},'year=2026');
  check(history.statusCode,200);check(history.body.includes('token='),false);
  check((await response(repo,'GET',`/api/birthdays/contacts/${contact.id}/history`,{}, {...admin,clusterAccess:[{clusterId:id(2)}]}, {},'year=2026')).statusCode,403);
  check((await response(repo,'DELETE','/api/birthdays/history',{year:2026,kind:'gift',contactIds:[contact.id],confirmation:'DELETE'},superAdmin,{'x-admin-pin':'wrong'})).statusCode,403);
  check(repo.cleanupRequest,undefined);
  check((await response(repo,'DELETE','/api/birthdays/history',{year:2026,kind:'gift',contactIds:[contact.id],confirmation:'DELETE'},superAdmin,{'x-admin-pin':process.env.ADMIN_PIN})).statusCode,200);
  check(repo.cleanupRequest.ids,[contact.id]);check(repo.cleanupRequest.year,2026);

  repo = new MemoryRepo();repo.people[0].whatsappEnabled = true;repo.people[0].whatsappOptIn = true;
  const today = D.localDate();repo.people[0].birthday = today.date.slice(5);
  await repo.enqueue(repo.people[0],today.year,'wa-once','wish','whatsapp',{});
  repo.blockers = [{ project_name:'Another Project',cycle_id:id(100),cycle_type:'project_end' }];
  check(await S.claimWhatsappJobs({repo,store,baseUrl}),[]);
  check(repo.queue[0].status,'skipped');check(repo.queue[0].result.reason,'Active Feedback Cycle');
  check(repo.queue.some(j => j.kind==='missed_wish' && j.payload.to.includes('super@example.com')),true);
  repo.blockers=[];
  check(await S.claimWhatsappJobs({repo,store,baseUrl}),[]);
  repo = new MemoryRepo();Object.assign(repo.people[0],{birthday:today.date.slice(5),whatsappEnabled:true,whatsappOptIn:true});
  await repo.enqueue(repo.people[0],today.year,'ready-wa','wish','whatsapp',{});
  const ready=await S.claimWhatsappJobs({repo,store,baseUrl});check(ready.length,1);
  check(repo.preparedRoute.c.id,contact.id);check(repo.preparedRoute.hash,require('../src/lib/birthday-inbound').phoneHash(contact.whatsapp));
  const callbackPath=`/api/automation/birthdays/jobs/${ready[0].jobId}/result`,headers={'x-csat-webhook-secret':process.env.N8N_WEBHOOK_SECRET};
  check((await response(repo,'POST',callbackPath,{status:'accepted'},null,headers)).statusCode,400);
  check((await response(repo,'POST',callbackPath,{status:'accepted',providerMessageId:'wamid.birthday-fixture'},null,headers)).statusCode,200);
  check(repo.confirmedRoute.providerId,'wamid.birthday-fixture');
  repo = new MemoryRepo();repo.config.enabled = false;
  let staleChecks=0;repo.stale=async()=>{staleChecks++;};
  await repo.enqueue(contact,2026,'manual-pending','decision','email',{to:['one@example.com'],subject:'Fixture',...require('../src/lib/email-theme').brandEmail({title:'Birthday Centre',text:'Manual reminder'})});
  await S.runBirthdaySchedule({repo,store,baseUrl});check(repo.queue[0].status,'accepted');check(staleChecks,1);
  repo = new MemoryRepo();
  const other={...contact,id:id(22)};repo.people.push(other);
  await repo.enqueue(other,2026,'other-cluster-pending','decision','email',{to:['other@example.com'],subject:'Fixture',...require('../src/lib/email-theme').brandEmail({text:'Outside selected contacts'})});
  await repo.enqueue(contact,2026,'selected-only','decision','email',{to:['one@example.com'],subject:'Fixture',...require('../src/lib/email-theme').brandEmail({text:'Selected contact'})});
  await S.processEmailJobs(repo,undefined,[contact.id]);
  check(repo.queue[0].status,'pending');check(repo.queue[1].status,'accepted');

  // Annual eligibility, not the contact's next-year default, controls queued logistics.
  repo = new MemoryRepo();repo.people[0].giftEligible = false;
  await repo.change(repo.people[0],2026,'gift','eligibility','Fixture',o=>({...o,giftEligible:true}));
  await repo.enqueue(repo.people[0],2026,'annual-enabled','decision','email',{to:['one@example.com'],...require('../src/lib/email-theme').brandEmail({text:'Year-specific reminder'})});
  await S.processEmailJobs(repo);check(repo.queue[0].status,'accepted');
  await repo.change(repo.people[0],2026,'gift','eligibility','Fixture',o=>({...o,giftEligible:false}));
  await repo.enqueue(repo.people[0],2026,'annual-disabled','decision','email',{to:['one@example.com']});
  await S.processEmailJobs(repo);check(repo.queue[1].status,'cancelled');
  await repo.change(repo.people[0],2026,'gift','delivered','Fixture',o=>({...o,giftEligible:true,gift:'Plant',stage:'Delivered'}));
  await repo.enqueue(repo.people[0],2026,'already-delivered','delivery','email',{to:['desk@example.com']});
  await S.processEmailJobs(repo);check(repo.queue[2].status,'cancelled');

  const statements=[];
  const connection={query:async sql=>{statements.push(sql);return {rows:sql.includes('select status')?[{status:'processing'}]:[],rowCount:0};},release:()=>{}};
  const sqlRepo=new BirthdayRepository({pool:{connect:async()=>connection}});
  await assert.rejects(()=>sqlRepo.cleanup([contact.id],2026,'all','Fixture'),e=>e.status===409);checks++;
  check(statements.some(sql=>/^delete/i.test(sql)),false);check(statements.includes('rollback'),true);
  for (const filename of fs.readdirSync(path.join(__dirname,'../n8n/workflows')).filter(name=>/^Birthday [ABC] v2/.test(name))) {
    const workflow=JSON.parse(fs.readFileSync(path.join(__dirname,'../n8n/workflows',filename),'utf8'));
    check(workflow.active,false);check(workflow.settings.timezone,'Asia/Kolkata');
    check(workflow.nodes.some(n=>n.type.includes('googleSheets')),false);
  }
  for(const email of sent) { check(email.html.includes('Verdana'),true);check(email.text.includes('Best Regards,\nAshish Kate'),true); }
  console.log(`${checks} isolated Birthday Centre checks passed.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
