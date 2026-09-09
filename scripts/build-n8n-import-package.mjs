import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(scriptDir, "..");
const downloadsDir = path.resolve(workspaceDir, "..", "..");
const outputDir = path.join(workspaceDir, "outputs", "n8n-monthly-feedback-import-ready-2026-08-31");

const sources = {
  1: "1. CSAT v2 - WhatsApp Inbound Message Router (1).json",
  2: "2. CSAT v2 - Feedback Started Send WhatsApp Template.json",
  3: "3. CSAT v2 - Human Handoff Handler.json",
  4: "4. CSAT v2 - Bad Feedback Manager Alert.json",
  5: "5. CSAT v2 - No or Partial Response WhatsApp Reminder (1).json",
  6: "6. CSAT v2 - Feedback Started Send Client Link.json",
  8: "8. CSAT v2 - Create Due Pulse and Project-End Cycles.json",
  9: "9. CSAT v2 - Process Due Reminders.json",
  10: "10. CSAT v3 - Cycle Summary (one email per project).json"
};

const csatCredential = {
  httpHeaderAuth: {
    id: "s7cNGrFKA4y4Hy88",
    name: "CSAT Webhook Secret"
  }
};

const smtpCredential = {
  smtp: {
    id: "NDpf2LfKVWN5zViN",
    name: "SMTP (Ashish)"
  }
};

const metaCredential = {
  httpHeaderAuth: {
    id: "DvIltBVRDLmTogMZ",
    name: "Meta WhatsApp Token"
  }
};

const clone = (value) => JSON.parse(JSON.stringify(value));

async function load(number) {
  const raw = await readFile(path.join(downloadsDir, sources[number]), "utf8");
  return JSON.parse(raw);
}

function cleanWorkflow(source, name) {
  return {
    name,
    nodes: clone(source.nodes || []),
    pinData: {},
    connections: clone(source.connections || {}),
    active: false,
    settings: {
      executionOrder: "v1",
      saveDataErrorExecution: "all",
      saveDataSuccessExecution: "none",
      saveManualExecutions: true
    }
  };
}

function node(workflow, name) {
  const found = workflow.nodes.find((item) => item.name === name);
  if (!found) throw new Error(`Node not found: ${name} in ${workflow.name}`);
  return found;
}

function removeNodes(workflow, names) {
  const remove = new Set(names);
  workflow.nodes = workflow.nodes.filter((item) => !remove.has(item.name));
  for (const name of names) delete workflow.connections[name];
  for (const connection of Object.values(workflow.connections)) {
    for (const outputType of Object.values(connection)) {
      for (const branch of outputType) {
        for (let index = branch.length - 1; index >= 0; index -= 1) {
          if (remove.has(branch[index].node)) branch.splice(index, 1);
        }
      }
    }
  }
}

function addNode(workflow, definition) {
  workflow.nodes.push({
    id: randomUUID(),
    ...definition
  });
}

function connect(workflow, from, outputs) {
  workflow.connections[from] = {
    main: outputs.map((branch) => branch.map((target) => ({
      node: target,
      type: "main",
      index: 0
    })))
  };
}

function configureWebhookAuth(webhook, pathValue) {
  webhook.parameters.httpMethod = "POST";
  webhook.parameters.path = pathValue;
  webhook.parameters.authentication = "headerAuth";
  webhook.parameters.responseMode = "onReceived";
  webhook.parameters.options = {
    responseCode: {
      values: {
        responseCode: 200
      }
    },
    responseData: "{\"ok\":true,\"accepted\":true}"
  };
  webhook.credentials = clone(csatCredential);
}

function addRetry(target, waitBetweenTries = 3000) {
  target.retryOnFail = true;
  target.maxTries = 3;
  target.waitBetweenTries = waitBetweenTries;
}

function setHttpTimeout(target, milliseconds) {
  target.parameters.options = {
    ...(target.parameters.options || {}),
    timeout: milliseconds
  };
}

function setConfigValues(configNode, values) {
  const current = configNode.parameters.assignments?.assignments || [];
  configNode.parameters.assignments = {
    assignments: Object.entries(values).map(([name, value]) => ({
      id: current.find((item) => item.name === name)?.id || randomUUID(),
      name,
      value,
      type: "string"
    }))
  };
  configNode.parameters.includeOtherFields = true;
  configNode.parameters.options = {};
}

function noOp(name, position) {
  return {
    name,
    type: "n8n-nodes-base.noOp",
    typeVersion: 1,
    position,
    parameters: {}
  };
}

function respond(name, position, responseCode, responseBody) {
  return {
    name,
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.4,
    position,
    parameters: {
      respondWith: "json",
      responseBody,
      options: {
        responseCode
      }
    }
  };
}

async function buildWorkflow1() {
  const workflow = cleanWorkflow(
    await load(1),
    "1. CSAT v4 - WhatsApp Inbound Message Router (Hardened)"
  );

  const postWebhook = node(workflow, "WhatsApp Provider Webhook");
  postWebhook.parameters = {
    httpMethod: "POST",
    path: "csat-whatsapp-inbound",
    responseMode: "responseNode",
    options: {
      rawBody: true
    }
  };

  const getWebhook = node(workflow, "WhatsApp Verify Webhook");
  getWebhook.parameters = {
    httpMethod: "GET",
    path: "csat-whatsapp-inbound",
    responseMode: "responseNode",
    options: {}
  };

  setConfigValues(node(workflow, "Config"), {
    CSAT_APP_URL: "https://cool-pixie-743e01.netlify.app",
    WHATSAPP_GRAPH_URL: "https://graph.facebook.com/v23.0/1143136358892896/messages",
    CSAT_HANDOFF_EMAIL: "ashish.kate@srvmedia.com"
  });

  const challenge = node(workflow, "Respond With Challenge");
  challenge.typeVersion = 1.4;
  challenge.parameters.options = { responseCode: 200 };

  const engine = node(workflow, "Call CSAT Engine");
  engine.credentials = clone(csatCredential);
  addRetry(engine, 3000);
  // Meta has already received its immediate 200 acknowledgement before this
  // branch runs. Keep enough headroom for the bounded Gemini interpretation,
  // conductor and parallel terminal read without turning a valid final rating
  // into an n8n "Bad gateway" and suppressing the WhatsApp closing message.
  setHttpTimeout(engine, 45000);

  const metaSend = node(workflow, "Send WhatsApp Reply");
  metaSend.credentials = clone(metaCredential);
  addRetry(metaSend, 5000);
  setHttpTimeout(metaSend, 20000);

  removeNodes(workflow, ["Respond Ignored", "Respond Duplicate", "Respond OK"]);

  addNode(workflow, {
    name: "Meta POST Security Config",
    type: "n8n-nodes-base.set",
    typeVersion: 3.4,
    position: [304, 112],
    parameters: {
      assignments: {
        assignments: [
          {
            id: randomUUID(),
            name: "META_APP_SECRET",
            value: "REPLACE_WITH_META_APP_SECRET",
            type: "string"
          }
        ]
      },
      includeOtherFields: true,
      options: {}
    }
  });

  addNode(workflow, {
    name: "Calculate Meta Signature",
    type: "n8n-nodes-base.crypto",
    typeVersion: 1,
    position: [560, 112],
    parameters: {
      action: "hmac",
      binaryData: true,
      binaryPropertyName: "data",
      type: "SHA256",
      dataPropertyName: "calculatedSignature",
      secret: "={{ $('Meta POST Security Config').first().json.META_APP_SECRET }}",
      encoding: "hex"
    }
  });

  addNode(workflow, {
    name: "Valid Meta Signature?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [816, 112],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: "",
          typeValidation: "strict",
          version: 2
        },
        conditions: [
          {
            id: randomUUID(),
            leftValue: "={{ $('WhatsApp Provider Webhook').item.json.headers['x-hub-signature-256'] }}",
            rightValue: "={{ 'sha256=' + $json.calculatedSignature }}",
            operator: {
              type: "string",
              operation: "equals"
            }
          }
        ],
        combinator: "and"
      },
      options: {}
    }
  });

  addNode(workflow, respond(
    "Accept Meta Webhook",
    [1072, 32],
    200,
    "={{ { ok: true, accepted: true } }}"
  ));

  addNode(workflow, respond(
    "Reject Invalid Signature",
    [1072, 208],
    403,
    "={{ { ok: false, error: 'invalid_meta_signature' } }}"
  ));

  addNode(workflow, {
    name: "Meta GET Security Config",
    type: "n8n-nodes-base.set",
    typeVersion: 3.4,
    position: [304, -208],
    parameters: {
      assignments: {
        assignments: [
          {
            id: randomUUID(),
            name: "META_VERIFY_TOKEN",
            value: "REPLACE_WITH_META_VERIFY_TOKEN",
            type: "string"
          }
        ]
      },
      includeOtherFields: true,
      options: {}
    }
  });

  addNode(workflow, {
    name: "Valid Meta Verify Token?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [560, -208],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: "",
          typeValidation: "strict",
          version: 2
        },
        conditions: [
          {
            id: randomUUID(),
            leftValue: "={{ $json.query['hub.mode'] }}",
            rightValue: "subscribe",
            operator: {
              type: "string",
              operation: "equals"
            }
          },
          {
            id: randomUUID(),
            leftValue: "={{ $json.query['hub.verify_token'] }}",
            rightValue: "={{ $json.META_VERIFY_TOKEN }}",
            operator: {
              type: "string",
              operation: "equals"
            }
          }
        ],
        combinator: "and"
      },
      options: {}
    }
  });

  addNode(workflow, respond(
    "Reject Invalid Verify Token",
    [816, -96],
    403,
    "={{ { ok: false, error: 'invalid_meta_verify_token' } }}"
  ));

  addNode(workflow, noOp("Ignore Non-text Event", [1920, 256]));
  addNode(workflow, noOp("No Reply Needed", [2704, 256]));
  addNode(workflow, {
    name: "SET META SECRETS BEFORE ACTIVATING",
    type: "n8n-nodes-base.stickyNote",
    typeVersion: 1,
    position: [240, -400],
    parameters: {
      width: 592,
      height: 176,
      content: "## Required before activation\nSet `META_APP_SECRET` in **Meta POST Security Config** and the same Meta verify token in **Meta GET Security Config** that you use in Meta Developers. The workflow intentionally rejects traffic while placeholders remain."
    }
  });

  connect(workflow, "WhatsApp Provider Webhook", [["Meta POST Security Config"]]);
  connect(workflow, "Meta POST Security Config", [["Calculate Meta Signature"]]);
  connect(workflow, "Calculate Meta Signature", [["Valid Meta Signature?"]]);
  connect(workflow, "Valid Meta Signature?", [["Accept Meta Webhook"], ["Reject Invalid Signature"]]);
  connect(workflow, "Accept Meta Webhook", [["Config"]]);
  connect(workflow, "Config", [["Is Client Text Message?"]]);
  connect(workflow, "Is Client Text Message?", [["Call CSAT Engine"], ["Ignore Non-text Event"]]);
  connect(workflow, "Call CSAT Engine", [["Should Reply?"]]);
  connect(workflow, "Should Reply?", [["Send WhatsApp Reply"], ["No Reply Needed"]]);
  delete workflow.connections["Send WhatsApp Reply"];

  connect(workflow, "WhatsApp Verify Webhook", [["Meta GET Security Config"]]);
  connect(workflow, "Meta GET Security Config", [["Valid Meta Verify Token?"]]);
  connect(workflow, "Valid Meta Verify Token?", [["Respond With Challenge"], ["Reject Invalid Verify Token"]]);

  return workflow;
}

async function buildWorkflow2() {
  const workflow = cleanWorkflow(
    await load(2),
    "2. CSAT v4 - Monthly Feedback Started (WhatsApp Only)"
  );

  configureWebhookAuth(node(workflow, "Feedback Started Webhook"), "csat-feedback-started");
  setConfigValues(node(workflow, "Config"), {
    WHATSAPP_GRAPH_URL: "https://graph.facebook.com/v23.0/1143136358892896/messages"
  });

  const whatsapp = node(workflow, "Send WhatsApp Template");
  whatsapp.credentials = clone(metaCredential);
  addRetry(whatsapp, 5000);
  setHttpTimeout(whatsapp, 20000);

  removeNodes(workflow, ["Respond No Number", "Respond OK"]);

  addNode(workflow, noOp("No WhatsApp Number", [1376, -16]));
  addNode(workflow, {
    name: "MONTHLY WORDING NOTE",
    type: "n8n-nodes-base.stickyNote",
    typeVersion: 1,
    position: [1264, -432],
    parameters: {
      width: 496,
      height: 176,
      content: "## Monthly feedback\nThe internal Meta template name remains `srv_30_day_pulse` because Meta only sends approved template names. Ensure that approved template's visible text says **monthly feedback**."
    }
  });

  connect(workflow, "Feedback Started Webhook", [["Config"]]);
  connect(workflow, "Config", [["POC Has WhatsApp?"]]);
  connect(workflow, "POC Has WhatsApp?", [["Send WhatsApp Template"], ["No WhatsApp Number"]]);
  delete workflow.connections["Send WhatsApp Template"];

  return workflow;
}

async function buildWorkflow3() {
  const workflow = cleanWorkflow(await load(3), "3. CSAT v4 - Human Handoff Handler");
  configureWebhookAuth(node(workflow, "Human Handoff Webhook"), "csat-human-handoff");
  setConfigValues(node(workflow, "Config"), {
    CSAT_HANDOFF_EMAIL: "ashish.kate@srvmedia.com"
  });
  const email = node(workflow, "Notify Team");
  email.credentials = clone(smtpCredential);
  addRetry(email, 5000);
  removeNodes(workflow, ["Respond OK"]);
  delete workflow.connections["Notify Team"];
  return workflow;
}

async function buildWorkflow4() {
  const workflow = cleanWorkflow(await load(4), "4. CSAT v4 - Bad Feedback Manager Alert");
  configureWebhookAuth(node(workflow, "Manager Alert Webhook"), "csat-manager-alert");
  setConfigValues(node(workflow, "Config"), {
    CSAT_HANDOFF_EMAIL: "directoroffice@srvmedia.com"
  });
  const email = node(workflow, "Send Manager Email");
  email.credentials = clone(smtpCredential);
  addRetry(email, 5000);
  removeNodes(workflow, ["Respond OK", "Respond Skipped"]);
  addNode(workflow, noOp("No Manager Alert Required", [0, 224]));
  connect(workflow, "Needs Manager Alert?", [["Send Manager Email"], ["No Manager Alert Required"]]);
  delete workflow.connections["Send Manager Email"];
  return workflow;
}

async function buildWorkflow5() {
  const workflow = cleanWorkflow(await load(5), "5. CSAT v4 - Monthly Feedback Reminder");
  configureWebhookAuth(node(workflow, "Reminder Webhook"), "csat-whatsapp-reminder");
  setConfigValues(node(workflow, "Config"), {
    WHATSAPP_GRAPH_URL: "https://graph.facebook.com/v23.0/1143136358892896/messages"
  });

  const describe = node(workflow, "Describe What Is Missing");
  describe.parameters.jsCode = describe.parameters.jsCode
    .replace("your overall thoughts on our services", "your monthly feedback on our services")
    .replace("service_rating: 'a rating for the service you mentioned'", "service_rating: 'anything else about the service you mentioned',\n  service_followup: 'anything else about the service you mentioned'")
    .replace("your overall SRV rating out of 5", "your overall SRV rating out of 10");

  for (const name of ["Send Complete-Feedback Reminder", "Send First-Response Reminder"]) {
    const send = node(workflow, name);
    send.credentials = clone(metaCredential);
    addRetry(send, 5000);
    setHttpTimeout(send, 20000);
  }

  addNode(workflow, {
    name: "Final Rating Reminder?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [-288, 64],
    parameters: {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: "",
          typeValidation: "loose",
          version: 2
        },
        conditions: [{
          id: randomUUID(),
          leftValue: "={{ String($json.body.finalRatingReminder) }}",
          rightValue: "true",
          operator: { type: "string", operation: "equals" }
        }],
        combinator: "and"
      },
      options: {}
    }
  });
  addNode(workflow, {
    name: "Send Final Rating Reminder",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [0, -144],
    parameters: {
      method: "POST",
      url: "={{ $('Config').first().json.WHATSAPP_GRAPH_URL }}",
      authentication: "genericCredentialType",
      genericAuthType: "httpHeaderAuth",
      sendHeaders: true,
      headerParameters: {
        parameters: [{ name: "content-type", value: "application/json" }]
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ { messaging_product: \"whatsapp\", to: $json.body.poc.contactWhatsapp, type: \"template\", template: { name: \"srv_final_rating_reminder\", language: { code: \"en\" }, components: [ { type: \"body\", parameters: [ { type: \"text\", text: $json.body.poc.salutation || $json.body.poc.name } ] } ] } } }}",
      options: { timeout: 20000 }
    },
    credentials: clone(metaCredential),
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000
  });

  removeNodes(workflow, ["Respond No Number", "Respond OK"]);
  addNode(workflow, noOp("No WhatsApp Number", [1376, 240]));
  connect(workflow, "POC Has WhatsApp?", [["Final Rating Reminder?"], ["No WhatsApp Number"]]);
  connect(workflow, "Final Rating Reminder?", [["Send Final Rating Reminder"], ["Partial Feedback?"]]);
  delete workflow.connections["Send Complete-Feedback Reminder"];
  delete workflow.connections["Send First-Response Reminder"];
  delete workflow.connections["Send Final Rating Reminder"];
  return workflow;
}

async function buildWorkflow6() {
  const workflow = cleanWorkflow(
    await load(6),
    "6. CSAT v4 - Monthly Feedback Email Only (Optional - Keep Inactive)"
  );
  configureWebhookAuth(node(workflow, "Feedback Started Webhook"), "csat-feedback-started-email-only");
  setConfigValues(node(workflow, "Config"), {});
  const email = node(workflow, "Send Client Link");
  email.parameters.subject = "={{ $json.body.session.sessionType === 'project_end' ? 'Overall project feedback for SRV' : 'SRV monthly feedback' }}";
  email.parameters.text = "={{ 'Hi ' + ($json.body.poc.salutation || $json.body.poc.name) + ',\\n\\n' + ($json.body.session.sessionType === 'project_end' ? 'As ' + $json.body.project.name + ' reaches completion, please share your overall feedback for SRV here:' : 'It is time for your monthly SRV feedback for ' + $json.body.project.name + '. Please share your quick feedback here:') + '\\n' + $json.body.resumeUrl }}";
  email.credentials = clone(smtpCredential);
  addRetry(email, 5000);
  removeNodes(workflow, ["Respond No Email", "Respond OK"]);
  addNode(workflow, noOp("No Email Address", [1376, 32]));
  connect(workflow, "POC Has Email?", [["Send Client Link"], ["No Email Address"]]);
  delete workflow.connections["Send Client Link"];
  return workflow;
}

function buildWorkflow7() {
  return {
    name: "7. CSAT v4 - Workflow Error Alert",
    nodes: [
      {
        id: randomUUID(),
        name: "Error Trigger",
        type: "n8n-nodes-base.errorTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {}
      },
      {
        id: randomUUID(),
        name: "Send Error Alert",
        type: "n8n-nodes-base.emailSend",
        typeVersion: 2,
        position: [288, 0],
        parameters: {
          fromEmail: "directoroffice@srvmedia.com",
          toEmail: "directoroffice@srvmedia.com",
          subject: "={{ 'n8n CSAT workflow failed: ' + ($json.workflow?.name || 'Unknown workflow') }}",
          text: "={{ 'Workflow: ' + ($json.workflow?.name || '-') + '\\nWorkflow ID: ' + ($json.workflow?.id || '-') + '\\nFailed node: ' + ($json.execution?.lastNodeExecuted || $json.trigger?.error?.node?.name || '-') + '\\nError: ' + ($json.execution?.error?.message || $json.trigger?.error?.message || 'Unknown error') + '\\nExecution: ' + ($json.execution?.url || 'Open n8n Executions to inspect the trigger failure.') }}",
          options: {}
        },
        credentials: clone(smtpCredential),
        retryOnFail: true,
        maxTries: 3,
        waitBetweenTries: 5000
      },
      {
        id: randomUUID(),
        name: "ASSIGN THIS AS ERROR WORKFLOW",
        type: "n8n-nodes-base.stickyNote",
        typeVersion: 1,
        position: [-64, -256],
        parameters: {
          width: 640,
          height: 176,
          content: "## After import\nFor workflows 1-5 and 8-10, open **Workflow settings → Error workflow** and select this workflow. Workflow 6 is optional and can remain inactive."
        }
      }
    ],
    pinData: {},
    connections: {
      "Error Trigger": {
        main: [[{
          node: "Send Error Alert",
          type: "main",
          index: 0
        }]]
      }
    },
    active: false,
    settings: {
      executionOrder: "v1",
      saveDataErrorExecution: "all",
      saveDataSuccessExecution: "none",
      saveManualExecutions: true
    }
  };
}

async function buildWorkflow8() {
  const workflow = cleanWorkflow(
    await load(8),
    "8. CSAT v4 - Create Due Monthly and Project-End Cycles"
  );
  setConfigValues(node(workflow, "Config"), {
    CSAT_APP_URL: "https://cool-pixie-743e01.netlify.app"
  });
  const request = node(workflow, "Create Due Sessions");
  request.credentials = clone(csatCredential);
  request.parameters.sendBody = true;
  request.parameters.specifyBody = "json";
  request.parameters.jsonBody = "={{ { now: $now.toISO() } }}";
  delete request.parameters.bodyParameters;
  addRetry(request, 3000);
  setHttpTimeout(request, 30000);
  return workflow;
}

async function buildWorkflow9() {
  const workflow = cleanWorkflow(await load(9), "9. CSAT v4 - Process Due Reminders");
  setConfigValues(node(workflow, "Config"), {
    CSAT_APP_URL: "https://cool-pixie-743e01.netlify.app"
  });
  const request = node(workflow, "Process Due Reminders");
  request.credentials = clone(csatCredential);
  request.parameters.sendBody = true;
  request.parameters.specifyBody = "json";
  request.parameters.jsonBody = "={{ { now: $now.toISO() } }}";
  delete request.parameters.bodyParameters;
  addRetry(request, 3000);
  setHttpTimeout(request, 30000);
  return workflow;
}

async function buildWorkflow10() {
  const workflow = cleanWorkflow(await load(10), "10. CSAT v4 - Monthly Cycle Summary");
  configureWebhookAuth(node(workflow, "Cycle Completed Webhook"), "csat-cycle-completed");
  setConfigValues(node(workflow, "Config"), {
    CSAT_HANDOFF_EMAIL: "ashish.kate@srvmedia.com"
  });

  const build = node(workflow, "Build Summary");
  build.parameters.jsCode = `const body = $input.first().json.body || {};

const project = body.project || {};
const cycle = body.cycle || {};
const issues = body.issues || [];
const appreciations = body.appreciations || [];
const observations = body.observations || [];
const clientQuestions = body.clientQuestions || [];

const line = (value) => value == null ? '' : String(value);
const score = cycle.csatScore == null ? 'not rated' : \`${'${cycle.csatScore}'}/10\`;

const byOwner = new Map();
for (const issue of issues) {
  const key = issue.owner ? issue.owner.name : 'Unassigned';
  if (!byOwner.has(key)) byOwner.set(key, []);
  byOwner.get(key).push(issue);
}

const parts = [];
parts.push(\`${'${project.name || \'Project\'}'} — feedback cycle complete\`);
parts.push('');
parts.push(\`Client:      ${'${project.clientName || \'-\'}'}\`);
parts.push(\`Cycle:       ${"${cycle.cycleType === 'project_end' ? 'Project-end' : 'Monthly'}"} feedback\`);
parts.push(\`Overall:     ${'${score}'}\`);
parts.push('');

if (issues.length) {
  parts.push(\`WHAT NEEDS ATTENTION (${'${issues.length}'})\`);
  parts.push('');
  for (const [owner, list] of byOwner) {
    parts.push(\`  ${'${owner}'}${"${list[0].manager ? ` (manager: ${list[0].manager.name})` : ''}"}\`);
    for (const issue of list) {
      parts.push(\`   - [${'${line(issue.severity).toUpperCase()}'}] ${'${issue.serviceName}'}: ${'${issue.title}'}\`);
      if (issue.rootCause) parts.push(\`     ${'${issue.rootCause}'}\`);
      if (issue.raisedBy) parts.push(\`     raised by ${'${issue.raisedBy}'}\`);
    }
    parts.push('');
  }
} else {
  parts.push('WHAT NEEDS ATTENTION');
  parts.push('  Nothing was raised this cycle.');
  parts.push('');
}

if (appreciations.length) {
  parts.push(\`WHAT THE CLIENT PRAISED (${'${appreciations.length}'})\`);
  for (const item of appreciations) {
    parts.push(\`   - ${'${item.subject}'}${"${item.owner ? ` (${item.owner.name})` : ''}"}: ${'${item.detail}'}\`);
  }
  parts.push('');
}

if (observations.length) {
  parts.push(\`OTHER POINTS RAISED (${'${observations.length}'})\`);
  for (const item of observations) {
    parts.push(\`   - ${'${item.topic}'}: ${'${item.detail}'}\`);
  }
  parts.push('');
}

if (clientQuestions.length) {
  parts.push(\`CLIENT QUESTIONS / FOLLOW-UP NEEDED (${'${clientQuestions.length}'})\`);
  for (const item of clientQuestions) {
    parts.push(\`   - ${'${line(item.text || item)}'}\`);
  }
  parts.push('');
}

parts.push(\`Open the conversation: ${'${line(body.resumeUrl)}'}\`);
parts.push('');
parts.push('This is the single summary for the cycle.');

const recipients = [...new Set([
  ...(body.recipients || []),
  $('Config').first().json.CSAT_HANDOFF_EMAIL
].filter(Boolean))];

return [{
  json: {
    to: recipients.join(','),
    subject: \`CSAT: ${'${project.name || \'Project\'}'} — ${'${issues.length}'} to action, ${'${appreciations.length}'} appreciation${"${appreciations.length === 1 ? '' : 's'}"}, ${'${clientQuestions.length}'} question${"${clientQuestions.length === 1 ? '' : 's'}"}\`,
    text: parts.join('\\n'),
    issueCount: issues.length,
    appreciationCount: appreciations.length,
    questionCount: clientQuestions.length,
    recipientCount: recipients.length
  }
}];`;

  const email = node(workflow, "Send Cycle Summary");
  email.credentials = clone(smtpCredential);
  addRetry(email, 5000);
  removeNodes(workflow, ["Respond No Recipients", "Respond OK"]);
  addNode(workflow, noOp("No Summary Recipients", [0, 224]));
  connect(workflow, "Anyone To Tell?", [["Send Cycle Summary"], ["No Summary Recipients"]]);
  delete workflow.connections["Send Cycle Summary"];
  return workflow;
}

async function buildWorkflow11() {
  const raw = await readFile(
    path.join(workspaceDir, "n8n", "workflows", "11 - CSAT v4 - Manual WhatsApp Message.json"),
    "utf8"
  );
  return JSON.parse(raw);
}

async function buildWorkflow12() {
  const raw = await readFile(
    path.join(workspaceDir, "n8n", "workflows", "12 - CSAT v4 - Partial Feedback Session Closing.json"),
    "utf8"
  );
  return JSON.parse(raw);
}

function validateWorkflow(workflow) {
  const nodeNames = new Set(workflow.nodes.map((item) => item.name));
  if (nodeNames.size !== workflow.nodes.length) {
    throw new Error(`Duplicate node name in ${workflow.name}`);
  }
  for (const [source, connection] of Object.entries(workflow.connections)) {
    if (!nodeNames.has(source)) throw new Error(`Missing source node ${source} in ${workflow.name}`);
    for (const outputType of Object.values(connection)) {
      for (const branch of outputType) {
        for (const target of branch) {
          if (!nodeNames.has(target.node)) {
            throw new Error(`Missing target node ${target.node} in ${workflow.name}`);
          }
        }
      }
    }
  }
}

const workflows = [
  await buildWorkflow1(),
  await buildWorkflow2(),
  await buildWorkflow3(),
  await buildWorkflow4(),
  await buildWorkflow5(),
  await buildWorkflow6(),
  buildWorkflow7(),
  await buildWorkflow8(),
  await buildWorkflow9(),
  await buildWorkflow10(),
  await buildWorkflow11(),
  await buildWorkflow12()
];

for (const workflow of workflows) validateWorkflow(workflow);

await mkdir(outputDir, { recursive: true });

for (const [index, workflow] of workflows.entries()) {
  const number = index < 6 ? index + 1 : index === 6 ? 7 : index + 1;
  const safeName = workflow.name.replace(/[<>:"/\\|?*]/g, "-");
  const fileName = `${String(number).padStart(2, "0")} - ${safeName.replace(/^\d+\.\s*/, "")}.json`;
  await writeFile(
    path.join(outputDir, fileName),
    `${JSON.stringify(workflow, null, 2)}\n`,
    "utf8"
  );
}

const readme = `SRV CSAT n8n import package — 31 August 2026
====================================================

This package uses MONTHLY feedback wording. The app's internal cycle key can
still be "pulse"; that is only a technical key and does not change client text.

IMPORT ORDER
------------
1. Deactivate the old CSAT workflows first.
2. Import files 01 through 12 individually in n8n.
3. In workflow 01, replace both placeholders before activation:
   - Meta POST Security Config -> META_APP_SECRET
   - Meta GET Security Config  -> META_VERIFY_TOKEN
   These are local Set nodes, not HTTP requests. The GET branch runs only for
   Meta's webhook handshake; the POST branch verifies x-hub-signature-256
   locally before the workflow acknowledges the webhook.
4. Confirm these existing n8n credentials are selected on imported nodes:
   - CSAT Webhook Secret: Header name x-csat-webhook-secret and the same value
     as Netlify N8N_WEBHOOK_SECRET.
   - Meta WhatsApp Token: Authorization header for Meta Graph API.
   - SMTP (Ashish): email credential.
5. In workflows 01-05 and 08-12, open Workflow Settings and choose workflow 07
   as the Error workflow. Workflow 06 is optional and should remain inactive.
6. Activate workflows 01-05 and 08-12. Workflow 07 does not need normal trigger
   activation; it is selected as the Error workflow.

NETLIFY ENVIRONMENT VARIABLES
-----------------------------
N8N_FEEDBACK_STARTED_WEBHOOK = <n8n base>/webhook/csat-feedback-started
N8N_MANAGER_ALERT_WEBHOOK    = <n8n base>/webhook/csat-manager-alert
N8N_NO_RESPONSE_WEBHOOK      = <n8n base>/webhook/csat-whatsapp-reminder
N8N_CYCLE_COMPLETED_WEBHOOK  = <n8n base>/webhook/csat-cycle-completed
N8N_HUMAN_HANDOFF_WEBHOOK    = <n8n base>/webhook/csat-human-handoff
N8N_MANUAL_MESSAGE_WEBHOOK   = <n8n base>/webhook/csat-manual-whatsapp-message
N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK = <n8n base>/webhook/csat-feedback-session-closed
N8N_WEBHOOK_SECRET           = same secret used by the CSAT Webhook Secret credential

WHATSAPP / META
---------------
Callback URL: <n8n base>/webhook/csat-whatsapp-inbound
Verify token: use the same value in Meta Developers and workflow 01.

The approved Meta template name srv_30_day_pulse is intentionally retained.
Meta rejects unapproved template names. Check the visible text of that approved
template in WhatsApp Manager and make sure it says "monthly feedback". If you
create and approve a new template name, update Send WhatsApp Template afterward.

WHAT WAS FIXED
--------------
- Correct CSAT credential in scheduler workflows 08 and 09.
- Header authentication on all app-to-n8n webhooks.
- Meta verify-token and x-hub-signature-256 checks in workflow 01.
- Fast webhook acknowledgement before slower Gemini/Meta work in workflow 01.
- Three-attempt retries on CSAT, Meta, and SMTP nodes.
- The main feedback-started workflow sends WhatsApp only. Workflow 06 remains
  an optional email-only fallback and should stay inactive unless required.
- Monthly wording preserved in client emails and cycle summaries.
- Client questions included in workflow 10 summary.
- Workflow 07 sends an email when a CSAT workflow exhausts retries.
- Old tunnel URLs removed from the package.
- Workflow 11 sends dashboard-written free-text replies through the existing
  Meta WhatsApp credential and returns only after Meta accepts the message.
- Workflow 05 uses \`srv_final_rating_reminder\` for the third reminder when a
  partial respondent has not provided an overall rating.
- Workflow 12 sends \`srv_feedback_session_closed\` and waits for Meta to accept
  it before the application closes an exhausted partial session.

WORKFLOW 06
-----------
Workflow 06 is an optional email-only fallback. Do not point
N8N_FEEDBACK_STARTED_WEBHOOK to it when workflow 02 is active, because workflow
02 already sends the monthly feedback request on WhatsApp.
`;

await writeFile(path.join(outputDir, "README - IMPORT STEPS.txt"), readme, "utf8");

console.log(outputDir);
