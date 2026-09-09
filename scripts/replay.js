/**
 * Conversation replay.
 *
 * Feeds a real WhatsApp transcript through the live prompt and the live state
 * machine, then reports what the bot ACTUALLY says and captures — before any
 * of it reaches a client.
 *
 * This exists because prompt changes were being shipped untested. The scenario
 * suite runs the state machine with no model at all, so it proves the
 * guardrails hold and says nothing about how a conversation reads. "The model
 * will now come back to Account Management" was a paragraph added to a prompt
 * and reported as fixed; it failed twice.
 *
 *   node scripts/replay.js fixtures/manager-demo.txt
 *
 * Needs GEMINI_API_KEY in .env. Without it, the run tells you that and stops
 * rather than silently exercising the fallback path.
 */
const fs = require("fs");
const path = require("path");

require("../src/lib/env").loadEnvFile(path.join(__dirname, "..", ".env"));

const { processWhatsAppReply, buildChecklist, applyCaptured, applyTurnProgress, isEverythingCovered,
  soundsLikeFarewell, overallRatingQuestion, STATES } = require("../src/lib/whatsapp-state-machine");
const { conductTurn, interpretReply, predictSatisfaction, isGeminiConfigured,
  offScriptReply } = require("../src/lib/gemini");
const { conversationFlow } = require("../src/server/api-handler");

const project = {
  id: "prj_replay",
  key: "brand-campaign-2026",
  name: "Brand Campaign 2026",
  clientName: "Test Client Pvt Ltd",
  feedbackIntervalDays: 30,
  services: [
    { serviceKey: "account", name: "Account Management" },
    { serviceKey: "design", name: "Design" },
    { serviceKey: "ppc", name: "PPC / Media" },
    { serviceKey: "seo", name: "SEO" },
    { serviceKey: "website", name: "Website" }
  ]
};
const poc = { id: "poc_replay", name: "Ashish Kate", salutation: "Ashish Sir", weight: 2 };

/** Pull just the client's lines out of a pasted WhatsApp export. */
function clientLines(raw) {
  return raw.split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\[[^\]]+\]\s*([^:]+):\s*(.*)$/);
      if (!match) return null;
      const [, speaker, body] = match;
      if (/test number srv|srv media/i.test(speaker)) return null;
      return body.trim();
    })
    .filter((line) => line && line.length);
}

async function replay(texts) {
  let conversationState = {};
  const messages = [];
  const emails = [];
  let turnNumber = 0;

  for (const text of texts) {
    turnNumber += 1;
    messages.push({ side: "client", body: text });
    const stateBefore = JSON.parse(JSON.stringify(conversationState));

    let turn = processWhatsAppReply({
      session: { id: "s", projectId: project.id, clientPocId: poc.id, sessionType: "pulse",
        conversationState: JSON.parse(JSON.stringify(stateBefore)) },
      project, poc, text
    });
    let interpretation = null;

    // Mirror the API handler: interpret, then re-run from the ORIGINAL state.
    if (turn.needsInterpretation) {
      const lastQuestion = [...messages].reverse().find((m) => m.side === "srv");
      const read = await interpretReply({ project, question: lastQuestion ? lastQuestion.body : "", text });
      interpretation = read.source === "gemini" ? read : null;
      turn = processWhatsAppReply({
        session: { id: "s", projectId: project.id, clientPocId: poc.id, sessionType: "pulse",
          conversationState: JSON.parse(JSON.stringify(stateBefore)) },
        project, poc, text,
        interpretation,
        geminiUnavailable: Boolean(read.error) && read.source === "fallback"
      });
    }

    conversationState = turn.conversationState;
    const control = turn.control || {};
    let reply = turn.nextMessage.body;
    let via = "state_machine";

    if (control.allowAiRephrase) {
      const conducted = await conductTurn({
        project, poc,
        checklist: buildChecklist(conversationState, project),
        messages
      });

      if (conducted.text) {
        conducted.captured = conversationFlow.scopeCapturedToPendingQuestion(
          stateBefore, conducted.captured, interpretation, text
        );
        conversationFlow.separateAppreciations(conducted);
        conversationFlow.reconcilePendingServiceArtifacts(
          conversationState, stateBefore, conducted.captured
        );
        applyCaptured(
          conversationState, project, conducted.captured,
          conversationFlow.acceptedOverallRating(stateBefore, conducted),
          conducted.corrects
        );
        conversationFlow.applyPendingIssueInterpretation(conversationState, stateBefore, interpretation);
        conversationFlow.applyConversationInterruption(
          conversationState, stateBefore, interpretation, conducted, text
        );
        const answerMarkers = conversationFlow.validatedAnswerMarkers(stateBefore, conducted, text);
        applyTurnProgress(conversationState, project, answerMarkers, { recordAsked: false });
        const checklistAfterCapture = buildChecklist(conversationState, project);
        const requiredAction = conversationFlow.requiredConversationAction(checklistAfterCapture, conversationState);
        const actualAction = conversationFlow.conductedAction(conducted);
        const actionRejected = !conversationFlow.actionMatches(requiredAction, actualAction);
        if (actionRejected) {
          conducted.text = conversationFlow.fallbackForAction(
            requiredAction, conversationState, project, conducted
          );
          conducted.readyToClose = requiredAction.type === "close";
        }
        const recordedQuestion = conversationFlow.recordRequiredQuestion(conversationState, project, requiredAction);
        const covered = isEverythingCovered(conversationState, project);
        const stillAsking = /\?\s*$/.test(conducted.text.trim());

        if (covered && !stillAsking) {
          conversationState.state = STATES.COMPLETED;
        } else if (conversationState.state === STATES.COMPLETED) {
          conversationState.state = STATES.WAITING_FOR_MORE_SERVICES;
        }

        conversationFlow.setStateForRequiredAction(
          conversationState, requiredAction, recordedQuestion
        );

        reply = conducted.text;
        via = actionRejected ? `state-machine action (${requiredAction.type})` : "model";

        const wantsToLeave = soundsLikeFarewell(conducted.text) || conducted.readyToClose;
        if (!covered && wantsToLeave) {
          const services = Object.values(conversationState.mentionedServices || {});
          const uncovered = project.services.filter(
            (svc) => !services.some((item) => item.serviceKey === svc.serviceKey)
          );
          reply = uncovered.length
            ? `Before we finish — how has ${uncovered[0].name} been for you?`
            : overallRatingQuestion(conversationState, project);
          via = "blocked early close";
        }

      } else {
        via = `FALLBACK — model turn rejected: ${conducted.error}`;
      }
    } else if (control.offScript) {
      const clause = await offScriptReply({ project, poc, text, reason: control.offScript });
      const checklist = buildChecklist(conversationState, project);
      const requiredAction = conversationFlow.requiredConversationAction(checklist, conversationState);
      const pendingQuestion = conversationFlow.fallbackForAction(
        requiredAction, conversationState, project
      );
      const recordedQuestion = conversationFlow.recordRequiredQuestion(
        conversationState, project, requiredAction
      );
      reply = requiredAction.type === "close" ? clause.text : `${clause.text} ${pendingQuestion}`;
      conversationFlow.setStateForRequiredAction(
        conversationState, requiredAction, recordedQuestion
      );
      via = `off-script + state-machine action (${requiredAction.type})`;
    } else if (control.guardrail) {
      via = `guardrail ${control.guardrail}`;
    }

    if (control.notify) emails.push({ turn: turnNumber, topic: control.notify });

    messages.push({ side: "srv", body: reply });
    console.log(`\n${turnNumber}. CLIENT: ${text}`);
    console.log(`   BOT:    ${reply}`);
    console.log(`   via:    ${via}   state: ${conversationState.state || "-"}`);
  }

  return { conversationState, messages, emails };
}

function report(conversationState, messages, emails) {
  console.log(`\n${"=".repeat(70)}\nWHAT HAPPENED\n${"=".repeat(70)}`);

  const services = Object.values(conversationState.mentionedServices || {});
  console.log("\nServices:");
  for (const svc of project.services) {
    const captured = services.find((item) => item.serviceKey === svc.serviceKey);
    if (!captured) {
      console.log(`  MISSED   ${svc.name} — never captured`);
    } else if (captured.status === "needs_reason") {
      console.log(`  PARTIAL  ${svc.name} — named but we do not know what is wrong`);
    } else {
      const reason = captured.reasonText || "no detail";
      const points = (captured.points || []).length;
      console.log(`  ok       ${svc.name} (${captured.sentiment})${points ? ` [${points} point${points === 1 ? "" : "s"}]` : ""}`);
      console.log(`           ${reason.length > 160 ? `${reason.slice(0, 160)}...` : reason}`);
    }
  }

  console.log(`\nOverall rating: ${conversationState.overallRating ?? "NOT GIVEN"}`);
  console.log(`Appreciation:   ${conversationState.appreciationAnswered ? "covered" : "NOT COVERED"}${conversationState.appreciationVolunteered ? " (volunteered)" : ""}`);
  console.log(`Final state:    ${conversationState.state || "-"}`);
  console.log(`Closed:         ${conversationState.state === STATES.COMPLETED ? "yes" : "NO"}`);

  // Problems a person would notice, stated plainly.
  const botMessages = messages.filter((m) => m.side === "srv").map((m) => m.body);
  const problems = [];

  const counts = new Map();
  for (const body of botMessages) counts.set(body, (counts.get(body) || 0) + 1);
  for (const [body, count] of counts) {
    if (count > 1) problems.push(`Said the same thing ${count} times: "${body.slice(0, 60)}..."`);
  }

  const ratingAsks = botMessages.filter((body) => /scale of 0 to 10|out of 10/i.test(body)).length;
  if (ratingAsks > 1) problems.push(`Asked for the overall rating ${ratingAsks} times`);

  const named = botMessages.filter((body) => body.includes(poc.salutation)).length;
  if (named > 2) problems.push(`Used the client's name in ${named} of ${botMessages.length} messages`);

  for (const svc of project.services) {
    if (!services.some((item) => item.serviceKey === svc.serviceKey)) {
      problems.push(`Never captured ${svc.name}`);
    }
  }

  if (conversationState.state !== STATES.COMPLETED) {
    problems.push("Conversation did not close");
  }

  for (const svc of services) {
    const reason = svc.reasonText || "";
    if (reason.length > 240) {
      problems.push(`${svc.serviceName}'s reason is ${reason.length} chars — it has accumulated rather than been summarised`);
    }
  }

  if (emails.length) {
    problems.push(`Sent ${emails.length} email(s) mid-conversation: ${emails.map((e) => `turn ${e.turn} ${e.topic}`).join(", ")}`);
  }

  console.log(`\n${problems.length ? "PROBLEMS" : "No problems found"}`);
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log("");
  return problems.length;
}

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/replay.js <transcript file>");
    process.exit(1);
  }
  if (!isGeminiConfigured()) {
    console.error("GEMINI_API_KEY is not set — this would only exercise the fallback path.");
    process.exit(1);
  }

  const texts = clientLines(fs.readFileSync(file, "utf8"));
  console.log(`Replaying ${texts.length} client messages from ${path.basename(file)}\n`);

  const { conversationState, messages, emails } = await replay(texts);
  const problemCount = report(conversationState, messages, emails);

  const predicted = await predictSatisfaction({ project, conversationState, messages });
  if (predicted.overall) {
    console.log(`Predicted CSAT: ${predicted.overall.score}/10 (${predicted.overall.confidence}% confident)`);
    console.log(`  ${predicted.overall.reasoning}`);
    if (predicted.observations.length) {
      console.log(`  Observations: ${predicted.observations.map((o) => o.topic).join(", ")}`);
    }
  }

  process.exit(problemCount ? 1 : 0);
})();
