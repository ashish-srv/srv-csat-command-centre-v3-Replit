// Simple terminal chat tester for the CSAT WhatsApp conversation flow.
// Usage: node test-chat.js <sessionId>
// Then just type replies as if you were the client. Type "exit" to quit.

const readline = require("readline");

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Usage: node test-chat.js <sessionId>");
  process.exit(1);
}

const BASE_URL = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const SECRET = process.env.TEST_WEBHOOK_SECRET || "srv-csat-secret-2026";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(`\nConnected to session ${sessionId}`);
console.log(`Talking to ${BASE_URL}`);
console.log(`Type your reply as the client. Type "exit" to quit.\n`);

async function sendMessage(text) {
  const response = await fetch(`${BASE_URL}/api/whatsapp/sessions/${sessionId}/reply`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csat-webhook-secret": SECRET
    },
    body: JSON.stringify({
      from: "919999999902",
      fromName: "Test Client",
      providerMessageId: `test_${Date.now()}`,
      text
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.log(`\n[Error ${response.status}]`, data.error || data);
    return;
  }

  const provider = data.nextMessage?.metadata?.provider || data.nextMessage?.metadata?.understoodBy || "state_machine";
  const model = data.nextMessage?.metadata?.model ? `, model: ${data.nextMessage.metadata.model}` : "";
  console.log(`\nSRV Bot (provider: ${provider}${model}):`);
  console.log(data.whatsappReplyText);
  console.log(`\n[state: ${data.analysis?.completionStatus}, sentiment: ${data.analysis?.sentiment}, risk: ${data.analysis?.riskLevel}]\n`);
}

function ask() {
  rl.question("You: ", async (text) => {
    if (text.trim().toLowerCase() === "exit") {
      rl.close();
      return;
    }
    try {
      await sendMessage(text);
    } catch (err) {
      console.log("\n[Request failed]", err.message);
    }
    ask();
  });
}

ask();
