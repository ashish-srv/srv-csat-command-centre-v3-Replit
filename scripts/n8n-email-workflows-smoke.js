const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { files, codeFor, receiptCode } = require('./build-cluster-email-workflows');
const { smtpAcceptance } = require('./lib/n8n-email-contract');
const { prepareCsatEmail } = require('../src/lib/csat-email-policy');
const clone = value => JSON.parse(JSON.stringify(value));
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const workflows = Object.fromEntries(Object.entries(files).map(([id, file]) => [id,
  JSON.parse(fs.readFileSync(path.join(__dirname, '../n8n/workflows', file), 'utf8'))]));
const runCode = (code, json, previous) => new Function('$input', '$', code)(
  { first: () => ({ json }) }, () => ({ first: () => ({ json: previous }) }))[0].json;
const build = (id, body) => runCode(workflows[id].nodes.find(node => node.name === 'Validate Application Email').parameters.jsCode, { body });
const targets = (workflow, name, output = 0) => (workflow.connections[name]?.main?.[output] || []).map(edge => edge.node);

async function main() {
  for (const [id, workflow] of Object.entries(workflows)) {
    const names = new Set(workflow.nodes.map(node => node.name));
    check(names.size, workflow.nodes.length);
    check(workflow.active, false);
    check(workflow.pinData, {});
    check(Boolean(workflow.staticData || workflow.id || workflow.versionId), false);
    for (const [source, connections] of Object.entries(workflow.connections)) {
      check(names.has(source), true);
      for (const edge of connections.main.flat()) check(names.has(edge.node), true);
    }
    const webhook = workflow.nodes.find(node => node.type === 'n8n-nodes-base.webhook');
    check(webhook.parameters.authentication, 'headerAuth');
    check(webhook.parameters.responseMode, 'responseNode');
    check(webhook.credentials.httpHeaderAuth.name, 'CSAT Webhook Secret');
    check(webhook.parameters.path, { 3: 'csat-human-handoff', 4: 'csat-manager-alert', 10: 'csat-cycle-completed' }[id]);
    check(workflow.nodes.some(node => node.name === 'Config'), false);
    if (id === '4') {
      check(workflow.nodes.filter(node => node.type === 'n8n-nodes-base.emailSend').length, 0);
      check(targets(workflow, webhook.name), ['Respond - Included in Completed Summary']);
      const response = workflow.nodes.find(node => node.type === 'n8n-nodes-base.respondToWebhook');
      check(response.parameters.responseBody.includes('sent: false'), true);
      continue;
    }
    const code = workflow.nodes.find(node => node.name === 'Validate Application Email');
    check(code.parameters.jsCode, codeFor(id === '3' ? 'handoff' : 'summary'));
    const receipt = workflow.nodes.find(node => node.name === 'Verify SMTP Acceptance');
    check(receipt.parameters.jsCode, receiptCode);
    const sender = workflow.nodes.find(node => node.type === 'n8n-nodes-base.emailSend');
    check(sender.parameters.emailFormat, 'both');
    check(sender.parameters.toEmail, '={{ $json.to }}');
    check(sender.parameters.html, '={{ $json.html }}');
    check(sender.parameters.text, '={{ $json.text }}');
    check(Boolean(sender.parameters.options.ccEmail || sender.parameters.options.bccEmail), false);
    check(Boolean(sender.credentials.smtp.id), true);
    check(sender.retryOnFail, false);
    check(sender.onError, 'stopWorkflow');
    check(targets(workflow, webhook.name), ['Validate Application Email']);
    check(targets(workflow, 'Validate Application Email'), ['Allowed Email?']);
    check(targets(workflow, 'Allowed Email?', 0), [sender.name]);
    check(targets(workflow, 'Allowed Email?', 1), ['Respond Not Sent']);
    check(targets(workflow, sender.name), ['Verify SMTP Acceptance']);
    check(targets(workflow, 'Verify SMTP Acceptance'), ['Respond SMTP Result']);
  }
  const users = [
    { role: 'super_admin', active: true, email: 'super@example.test' },
    { role: 'super_admin', active: true, email: 'second@example.test' },
    { role: 'super_admin', active: false, email: 'inactive-super@example.test' },
    { role: 'admin', active: true, email: 'cluster@example.test', clusterAccess: [{ clusterId: 'a', emailEnabled: true }] },
    { role: 'admin', active: true, email: 'muted@example.test', clusterAccess: [{ clusterId: 'a', emailEnabled: false }] },
    { role: 'admin', active: false, email: 'inactive@example.test', clusterAccess: [{ clusterId: 'a', emailEnabled: true }] },
    { role: 'admin', active: true, email: 'other@example.test', clusterAccess: [{ clusterId: 'b', emailEnabled: true }] },
    { role: 'project_user', active: true, email: 'project-user@gmail.com', clusterAccess: [{ clusterId: 'a', emailEnabled: true }] }
  ];
  const store = { listAppUsers: async () => users, getMessagesForSession: async () => [{ body: 'Need human help <&>', side: 'client' }] };
  const summary = { project: { id: 'project', name: 'Project <&>', clusterId: 'a', clusterName: 'Cluster A', clientName: 'Client' },
    poc: { id: 'poc', name: 'Test POC' }, summaryType: 'feedback_poc',
    cycle: { id: 'cycle', cycleType: 'project_end', csatScore: 3 }, csatScore: 9, npsScore: 0,
    sessions: [{ id: 'session', clientPocId: 'poc', projectId: 'project', completionStatus: 'completed',
      csatScore: 9, csatSource: 'stated', npsScore: 0, conversationState: { closingGraceExpiresAt: new Date(Date.now() - 1000).toISOString() } }],
    messages: [{ sessionId: 'session', side: 'client', body: 'Weekly reports, please <&>', metadata: { interpretation: 'DO NOT EXPORT THIS LABEL' } },
      { sessionId: 'session', side: 'client', body: 'Correction: every fortnight, not weekly.' }],
    issues: [{ title: 'Campaign reach', rootCause: 'Reach is below target', owner: { email: 'owner@example.test' }, manager: { email: 'manager@example.test' } }],
    observations: [{ detail: 'Industry visit request' }], appreciations: [{ detail: 'Responsive team' }],
    recipients: ['old-fixed@example.test', 'owner@example.test', 'manager@example.test'] };
  const payload = async (eventType, input) => ({ eventType, ...(await prepareCsatEmail(store, eventType, input)).payload });
  const body = await payload('cycle_completed', summary);
  const built = build(10, body);
  check(built.allowed, true);
  check(built.recipients, ['super@example.test', 'second@example.test', 'cluster@example.test']);
  check(built.to, built.recipients.join(','));
  check(built.html, body.email.html);
  check(built.text, body.email.text);
  check(built.text.includes('CSAT: 9/10\nNPS: 0/10'), true);
  check(built.text.includes('Correction: every fortnight, not weekly.'), true);
  check(built.html.includes('&lt;&amp;&gt;'), true);
  check(built.html.includes('Verdana'), true);
  check(built.html.includes('DO NOT EXPORT THIS LABEL'), false);
  const quick = await payload('cycle_completed', { ...summary, summaryType: 'quick_checkin_poc', cycle: { cycleType: 'quick_checkin' } });
  check(build(10, quick).allowed, true);
  check(build(10, quick).to, built.to);
  check(build(10, quick).text.includes('CSAT: Not collected'), true);
  const monthly = await payload('cycle_completed', { ...summary, cycle: { cycleType: 'pulse' } });
  check(build(10, monthly).allowed, true);
  const handoff = await payload('handoff', { project: summary.project, session: summary.sessions[0], poc: summary.poc, clientText: 'Need help' });
  check(build(3, handoff).allowed, true);
  check(build(3, handoff).recipients, ['super@example.test', 'second@example.test']);
  check(build(3, handoff).text.includes('Need human help <&>'), true);
  check(build(3, { ...handoff, eventType: 'post_completion_message' }).allowed, true);
  for (const eventType of ['client_question', 'manager_alert', 'escalation', 'wrong_person', 'opt_out', 'feedback_received', 'gemini_timeout', 'cycle_completed', undefined]) {
    check(build(3, { ...handoff, eventType }).allowed, false);
  }
  for (const mutate of [
    value => { delete value.emailPolicyVersion; }, value => { value.recipientPolicy = 'old'; },
    value => { value.eventType = 'manager_alert'; }, value => { value.summaryType = 'feedback_cycle'; },
    value => { value.email.to.push('extra@example.test'); }, value => { value.mandatoryRecipients = []; },
    value => { value.recipients = ['cluster@example.test']; value.email.to = [...value.recipients]; },
    value => { value.recipients = 'super@example.test'; }, value => { value.email.to = ['bad\r\nbcc@example.test']; },
    value => { value.email.subject = 'Header\r\nBcc: other@example.test'; }, value => { delete value.email.html; },
    value => { value.sessions.push(clone(value.sessions[0])); }, value => { value.sessions = []; },
    value => { value.sessions[0].projectId = 'other'; }, value => { value.sessions[0].clientPocId = 'other'; },
    value => { value.messages = {}; }, value => { value.messages[0].sessionId = 'other'; },
    value => { value.sessions[0].conversationState.closingGraceExpiresAt = new Date(Date.now() + 600000).toISOString(); },
    value => { value.sessions[0].conversationState.quickCheckinWindowExpiresAt = new Date(Date.now() + 600000).toISOString(); },
    value => { value.sessions[0].conversationState.closingGraceExpiresAt = 'invalid'; }
  ]) { const changed = clone(body); mutate(changed); check(build(10, changed).allowed, false); }
  check(build(10, null).allowed, false);
  const extraHandoff = clone(handoff);
  extraHandoff.recipients.push('cluster@example.test'); extraHandoff.email.to = [...extraHandoff.recipients];
  check(build(3, extraHandoff).allowed, false);
  const duplicate = clone(body);
  duplicate.recipients.push('SUPER@example.test'); duplicate.email.to.push('SUPER@example.test');
  check(build(10, duplicate).to, built.to);
  for (const response of [ {}, { error: 'failure', accepted: built.recipients },
    { accepted: ['super@example.test'] }, { accepted: built.recipients, rejected: ['cluster@example.test'] } ]) {
    check(smtpAcceptance(response, built).sent, false);
  }
  const accepted = runCode(receiptCode, { accepted: built.recipients, rejected: [], messageId: 'test-only' }, built);
  check(accepted.sent, true);
  check(accepted.inboxDeliveryVerified, false);
  check(accepted.reason, 'smtp_accepted');
  console.log(`${checks} n8n workflow contract, routing, timing, transcript and SMTP-result checks passed. No real email sent.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
