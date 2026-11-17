const fs = require('node:fs');
const crypto = require('node:crypto');

function upgradeVisitor(workflow) {
  const result = structuredClone(workflow);
  const node = result.nodes.find(node => node.name === 'Split verified messages');
  if (!node) throw new Error('Shared router splitter not found. No workflow was written.');
  if (node.parameters.jsCode.includes('// Forward delivery receipts separately')) return result;
  const anchor = '    for (const message of Array.isArray(value.messages)?value.messages:[]) {';
  if (!node.parameters.jsCode.includes(anchor)) throw new Error('Unexpected splitter version. Review before modifying.');
  node.parameters.jsCode = node.parameters.jsCode.replace(anchor, `    // Forward delivery receipts separately; never invoke the CSAT conversation for them.
    const statuses = Array.isArray(value.statuses) ? value.statuses.filter(status => status && typeof status.id === 'string' && ['sent','delivered','read','failed'].includes(status.status)) : [];
    for (let offset = 0; offset < statuses.length; offset += 100) {
      const receiptValue = { ...value, statuses: statuses.slice(offset, offset + 100) };
      delete receiptValue.messages;
      jobs.push({ route:'csat', targetUrl:csatUrl, body:{ ...envelope, entry:[{ ...entry, changes:[{ ...change, value:receiptValue }] }] } });
    }
${anchor}`).replace('const isolatedValue = { ...value, messages:[message] };', 'const isolatedValue = { ...value, messages:[message] };\n        delete isolatedValue.statuses;')
    .replace('// Status receipts have no message to process. Never treat them as approvals or CSAT text.', '// Ignore events without a supported message or delivery receipt.');
  result.name = 'SRV Visitor 03 - Shared WhatsApp incoming router (Delivery Receipts)';
  return result;
}

function upgradeCsat(workflow) {
  const result = structuredClone(workflow);
  if (!result.nodes.some(node => node.name === 'Record Broadcast Delivery Status')) throw new Error('Delivery receiver node missing.');
  const edge = name => [{ node: name, type: 'main', index: 0 }];
  // Record first. A failed receipt write must fail the webhook, allowing the shared
  // router/Meta to retry. The previous parallel branch acknowledged too early.
  result.connections.Config = { main: [edge('Is Delivery Status?')] };
  result.connections['Is Delivery Status?'] = { main: [edge('Record Broadcast Delivery Status'), edge('Is Client Text Message?')] };
  result.connections['Record Broadcast Delivery Status'] = { main: [edge('Restore Incoming Event')] };
  result.connections['Restore Incoming Event'] = { main: [edge('Is Client Text Message?')] };
  if (!result.nodes.some(node => node.name === 'Restore Incoming Event')) result.nodes.push({ id: crypto.randomUUID(), name: 'Restore Incoming Event', type: 'n8n-nodes-base.code', typeVersion: 2, position: [980, 368], parameters: { jsCode: "return [{ json: $('Config').first().json }];" } });
  // Preserve the existing workflow's name and identity when applying the fix.
  return result;
}

if (require.main === module) {
  const [kind, input, output] = process.argv.slice(2);
  if (!['visitor','csat'].includes(kind) || !input || !output) throw new Error('Usage: node scripts/upgrade-broadcast-workflows.js visitor|csat input.json output.json');
  const value = (kind === 'visitor' ? upgradeVisitor : upgradeCsat)(JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,'')));
  fs.writeFileSync(output, JSON.stringify(value,null,2) + '\n');
  console.log('Updated workflow written. Config and credential references retained.');
}
module.exports = { upgradeVisitor, upgradeCsat };
