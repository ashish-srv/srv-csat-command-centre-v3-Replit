// Outputs an import-file manifest to stdout; the caller saves/reviews the files.
// No network calls, SMTP sends, or modifications to the supplied originals.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { buildPolicyEmail, smtpAcceptance } = require('./lib/n8n-email-contract');

const files = {
  3: '03 - CSAT v6 - Super Admin Human Handoff.json',
  4: '04 - CSAT v6 - Concern Emails Disabled.json',
  10: '10 - CSAT v6 - Cluster POC Feedback Summary.json'
};
const sources = {
  3: '3. CSAT v2 - Human Handoff Handler (2).json',
  4: '4. CSAT v2 - Bad Feedback Manager Alert.json',
  10: '10. CSAT v5 - Cycle and Quick Check-in Summary (1).json'
};
const clone = value => JSON.parse(JSON.stringify(value));
const codeFor = kind => `${buildPolicyEmail.toString()}\nreturn [{ json: buildPolicyEmail($input.first().json.body, '${kind}') }];`;
const receiptCode = `${smtpAcceptance.toString()}\nreturn [{ json: smtpAcceptance($input.first().json, $('Validate Application Email').first().json) }];`;

function buildWorkflow(source, number, headerCredential) {
  const sourceWebhook = source.nodes.find(node => node.type === 'n8n-nodes-base.webhook');
  if (!sourceWebhook || !headerCredential) throw new Error('Webhook and Header Auth credential reference required');
  const webhook = clone(sourceWebhook);
  webhook.position = [0, 0];
  webhook.parameters = { httpMethod: 'POST', path: sourceWebhook.parameters.path,
    authentication: 'headerAuth', responseMode: 'responseNode', options: {} };
  webhook.credentials = { httpHeaderAuth: clone(headerCredential) };
  delete webhook.disabled;
  const workflow = {
    name: files[number].replace(/^0?([0-9]+) - /, '$1. ').replace(/\.json$/, ''),
    nodes: [webhook], connections: {}, pinData: {}, active: false,
    settings: { ...source.settings, executionOrder: 'v1' }
  };
  // Do not carry source test executions, fixed recipients or owner/manager routing.
  const add = (name, type, parameters, position, version = 2) => {
    const node = { id: randomUUID(), name, type: `n8n-nodes-base.${type}`, typeVersion: version, parameters, position };
    workflow.nodes.push(node);
    return node;
  };
  const connect = (from, ...branches) => {
    workflow.connections[from] = { main: branches.map(names => names.map(node => ({ node, type: 'main', index: 0 }))) };
  };
  if (number === 4) {
    add('Respond - Included in Completed Summary', 'respondToWebhook', {
      respondWith: 'json', responseBody: '={{ { ok: true, sent: false, handled: true, reason: "included_in_completed_poc_summary" } }}', options: {}
    }, [320, 0], 1);
    connect(webhook.name, ['Respond - Included in Completed Summary']);
    add('Email Policy', 'stickyNote', { width: 680, height: 190,
      content: '## No separate manager/owner email\nRoutine concerns are saved by the application and included in Workflow 10 after the POC response window closes. This compatibility endpoint intentionally has NO email sender. Keep the old manager-alert workflow inactive. Genuine human handoffs use Workflow 3.'
    }, [0, -250], 1);
    return workflow;
  }
  const kind = number === 3 ? 'handoff' : 'summary';
  add('Validate Application Email', 'code', { mode: 'runOnceForAllItems', jsCode: codeFor(kind) }, [260, 0]);
  add('Allowed Email?', 'if', {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: randomUUID(), leftValue: '={{ $json.allowed }}', rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {}
  }, [520, 0], 2.2);
  const sourceMail = source.nodes.find(node => node.type === 'n8n-nodes-base.emailSend');
  if (!sourceMail?.credentials?.smtp || !sourceMail.parameters.fromEmail) throw new Error('Source SMTP credential/from address missing');
  const sender = add(number === 3 ? 'Send Super Admin Handoff' : 'Send POC Summary', 'emailSend', {
    fromEmail: sourceMail.parameters.fromEmail, toEmail: '={{ $json.to }}', subject: '={{ $json.subject }}',
    emailFormat: 'both', text: '={{ $json.text }}', html: '={{ $json.html }}', options: { appendAttribution: false }
  }, [800, -100], sourceMail.typeVersion);
  sender.credentials = clone(sourceMail.credentials);
  sender.retryOnFail = false;
  sender.onError = 'stopWorkflow';
  sender.notes = 'No automatic SMTP retry: an ambiguous timeout may already have delivered. Check the provider before retrying. Do not add CC, BCC, service owners or fixed fallback recipients.';
  add('Verify SMTP Acceptance', 'code', { mode: 'runOnceForAllItems', jsCode: receiptCode }, [1060, -100]);
  add('Respond SMTP Result', 'respondToWebhook', { respondWith: 'json', responseBody: '={{ $json }}', options: {} }, [1320, -100], 1);
  add('Respond Not Sent', 'respondToWebhook', { respondWith: 'json',
    responseBody: '={{ { ok: false, sent: false, reason: $json.reason } }}', options: {} }, [800, 140], 1);
  connect(webhook.name, ['Validate Application Email']);
  connect('Validate Application Email', ['Allowed Email?']);
  connect('Allowed Email?', [sender.name], ['Respond Not Sent']);
  connect(sender.name, ['Verify SMTP Acceptance']);
  connect('Verify SMTP Acceptance', ['Respond SMTP Result']);
  add('Setup and Policy', 'stickyNote', { width: 960, height: 240,
    content: `## Cluster email policy — application update required\nSelect Header Auth: x-csat-webhook-secret = Replit production N8N_WEBHOOK_SECRET. Confirm the preserved SMTP credential.\n${number === 3 ? 'Only explicit handoff / post-completion handoff events; Super Admins only.' : 'One completed POC summary: Super Admins + opted-in cluster Admins. The application owns the 10-minute close and durable send-once claim.'}\nUse the application template and exact recipient lists. No old Config address, manager/owner additions, automatic SMTP retries or stale execution replays.\nSuccess means all recipients were accepted by SMTP, NOT verified inbox delivery. Import inactive; replace the old workflow on the same webhook path when the application is ready.`
  }, [0, -330], 1);
  return workflow;
}

if (require.main === module) {
  const sourceDir = process.argv[2];
  if (!sourceDir) throw new Error('Usage: node scripts/build-cluster-email-workflows.js <directory-containing-user-exports>');
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '../n8n/workflows/03 - CSAT v4 - Human Handoff Handler.json'), 'utf8'));
  const auth = reference.nodes.find(node => node.type === 'n8n-nodes-base.webhook').credentials.httpHeaderAuth;
  const manifest = [3, 4, 10].map(number => ({ file: files[number], workflow: buildWorkflow(
    JSON.parse(fs.readFileSync(path.join(sourceDir, sources[number]), 'utf8')), number, auth) }));
  process.stdout.write(JSON.stringify(manifest));
}

module.exports = { files, sources, codeFor, receiptCode, buildWorkflow };
