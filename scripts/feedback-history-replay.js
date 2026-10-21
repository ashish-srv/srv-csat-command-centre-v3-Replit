const assert = require("node:assert/strict");
const sm = require("../src/lib/whatsapp-state-machine");
const flow = require("../src/server/api-handler").conversationFlow;
const { normaliseReplyInterpretation } = require("../src/lib/gemini");

// Historical WhatsApp regressions: use controlled latest-reply extractions,
// never live Gemini/Meta/n8n or a production database. Assertions concern saved
// facts, score ownership, progress and question counts rather than exact prose.
const project = {
  id: "history-project", key: "history-project", name: "Historical Replay",
  services: [
    { serviceKey: "account", name: "Account Management" },
    { serviceKey: "campaign", name: "Campaign Management" },
    { serviceKey: "creatives", name: "Creatives" },
    { serviceKey: "landing", name: "Landing Page" },
    { serviceKey: "influencer", name: "Influencer Marketing" }
  ]
};
const poc = { id: "history-poc", name: "Test Client", salutation: "Sir" };
const fact = (serviceKey, summary, sentiment = "negative", needsFollowUp = false) => ({ serviceKey, summary, sentiment, needsFollowUp });
function read(options = {}) {
  return {
    intent: "feedback", sentiment: "negative", source: "gemini", error: null,
    deferRequested: false, rating: null, serviceKeys: [], explainsProblem: true,
    captured: [], observations: [], concerns: [], appreciations: [], ...options
  };
}
function review(type = "project_end", customProject = project) {
  let session = { id: "history-session", sessionType: type, conversationState: {} };
  const turns = [];
  return {
    get state() { return session.conversationState; }, turns,
    turn(text, extraction = null, writing = {}) {
      const before = JSON.parse(JSON.stringify(session.conversationState));
      const interpretation = extraction ? flow.groundLatestReplyInterpretation(extraction, text, customProject) : null;
      const turn = sm.processWhatsAppReply({
        session: { ...session, conversationState: JSON.parse(JSON.stringify(before)) },
        project: customProject, poc, text, interpretation, geminiUnavailable: !interpretation
      });
      if (turn.control.skipAnalysisWrite || turn.control.deferred || turn.control.handoff
        || turn.control.allowAiRephrase === false) {
        session = { ...session, conversationState: turn.conversationState };
        const result = { state: turn.conversationState, message: turn.nextMessage.body, control: turn.control };
        turns.push({ text, ...result });
        return result;
      }
      const context = { text: "", ...writing, captured: [], observations: [], appreciations: [] };
      flow.enrichConductedWithDeterministicFacts(context, text, customProject, interpretation, {
        protectSubstantiveConcern: true,
        allowLanguageOnly: before.pendingQuestionType === "final_sweep"
      });
      flow.ensureClientAppreciations(context, before, text, customProject);
      flow.separateAppreciations(context);
      sm.applyCaptured(turn.conversationState, customProject, context.captured);
      flow.openAppreciationFollowUp(turn.conversationState, before, context, text);
      flow.applyTurnServiceScope(turn.conversationState, customProject, text, interpretation, context, before);
      flow.applyPendingIssueInterpretation(turn.conversationState, before, interpretation);
      flow.applyConversationInterruption(turn.conversationState, before, interpretation, context, text);
      flow.settleActionableFinalSweepFacts(turn.conversationState, before, context, text, interpretation, customProject);
      const completion = sm.detectors.completionScopeFor(text, interpretation);
      if (!before.closingGraceExpiresAt && ["feedback", "conversation"].includes(completion)) {
        sm.finishFeedbackQuestions(turn.conversationState, customProject, completion === "conversation");
      }
      sm.applyTurnProgress(turn.conversationState, customProject,
        flow.validatedAnswerMarkers(before, context, text, interpretation), { recordAsked: false });
      flow.normalizeLegacyServiceFollowups(turn.conversationState);
      const action = flow.requiredConversationAction(sm.buildChecklist(turn.conversationState, customProject), turn.conversationState);
      const markers = flow.recordRequiredQuestion(turn.conversationState, customProject, action);
      flow.setStateForRequiredAction(turn.conversationState, action, markers);
      const message = action.type === "close"
        ? flow.closingGraceMessage(poc, turn.conversationState, context, customProject)
        : flow.fallbackForAction(action, turn.conversationState, customProject, context);
      flow.rememberAcknowledgedConcerns(turn.conversationState, context);
      turn.conversationState.lastQuestionAsked = message;
      if (action.type === "close") {
        turn.conversationState.state = sm.STATES.CLOSING_GRACE;
        turn.conversationState.closingGraceExpiresAt ||= new Date(Date.now() + sm.CLOSING_GRACE_MS).toISOString();
      }
      session = { ...session, conversationState: turn.conversationState };
      const result = { action, message, facts: context, state: turn.conversationState, control: turn.control };
      turns.push({ text, ...result });
      return result;
    }
  };
}

const results = [];
function scenario(name, fn) {
  try { fn(); results.push(["PASS", name]); }
  catch (error) { results.push(["FAIL", name, error.stack]); }
}

scenario("Arun: detailed review, third-party busy complaint, further concerns, then sufficient feedback", () => {
  const chat = review();
  const first = "This year experience is worst with SRV. There was no professional approach right from day one. You had put some interns to manage who never understood what needs to be done. Cost of acquisition for admission was 1.9 lacs; we got only 32 admissions. It was never optimized.";
  const opening = chat.turn(first, read({ captured: [
    fact("account", "There was no professional approach right from day one. You had put some interns to manage who never understood what needs to be done."),
    fact("campaign", "Cost of acquisition for admission was 1.9 lacs; we got only 32 admissions. It was never optimized.")
  ], serviceScope: "overall_feedback" }));
  assert.equal(opening.action.type, "rating_feedback");
  assert.equal(opening.action.offerChoice, true);
  assert.match(opening.message, /add anything else.*overall rating/);
  assert.doesNotMatch(opening.message, /on a scale|out of 10|I have recorded:/i);
  assert.match(chat.state.mentionedServices.campaign.reasonText, /1.9|32/);
  const added = [
    "This kind of activities Inver had seen",
    "I know your all big accounts. but that does not mean that whatever do is accepted",
    "Our words stand in the market. others look at me for the ffed back and opinion of the agency",
    "It was to the notice to the of leadership as well. nothing happenned.",
    "Such a big firm on whom I have faith and confidence miserably failed in our campaign because of some account managers were busy with their work. very sorry to get associated with the camapaign.",
    "They were never available for the review",
    "Never did what we want",
    "keep on doing what they want without any result",
    "The leadership failed to set it right throughout the season. I have lost complete faith and trust and will never look to work again and will not recommend to others."
  ];
  for (const text of added) {
    const next = chat.turn(text, read({ captured: [fact("account", text)] }));
    assert.equal(next.action.type, "rating_feedback", text);
    assert.equal(next.action.offerChoice, false);
    assert.doesNotMatch(next.message, /take your time|anything else about Account Management/i);
    assert.doesNotMatch(next.message, /I have recorded:|the client|on a scale|out of 10/i);
    assert.equal(chat.state.npsScore, null, "unwillingness to recommend is not a stated numeric NPS");
    assert.match(chat.state.mentionedServices.account.reasonText, new RegExp(text.slice(0, 15)));
  }
  const done = "Hope this feedback is sufficient";
  assert.equal(chat.turn(done, read({ intent: "negative", completionScope: "feedback", completionEvidence: done })).action.type, "overall_rating");
  chat.turn("5");
  assert.equal(chat.state.overallRating, 5);
  assert.equal(chat.state.state, sm.STATES.WAITING_FOR_NPS);
});

scenario("30-day: additional service detail is retained and the optional question is not repeated", () => {
  const chat = review("pulse", { ...project, services: project.services.slice(0, 2) });
  assert.equal(chat.turn("The account manager never replies", read({ captured: [fact("account", "The account manager never replies")] })).action.type, "service_followup");
  const second = chat.turn("Our requirements are also ignored", read({ captured: [fact("account", "Our requirements are also ignored")] }));
  assert.equal(second.action.type, "service");
  assert.equal(second.action.serviceKey, "campaign");
  assert.match(chat.state.mentionedServices.account.reasonText, /never replies/);
  assert.match(chat.state.mentionedServices.account.reasonText, /requirements are also ignored/);
  assert.equal(chat.state.mentionedServices.account.serviceFollowUpAskCount, 1);
});

scenario("a genuine clarification is asked once; switching topic preserves the old concern and follows the client", () => {
  const chat = review("pulse", { ...project, services: project.services.slice(0, 2) });
  assert.equal(chat.turn("Campaign management is poor", read({ captured: [fact("campaign", "Campaign management is poor", "negative", true)] })).action.type, "issue_reason");
  const next = chat.turn("The account managers never reply to our emails", read({ captured: [fact("account", "The account managers never reply to our emails")] }));
  assert.notEqual(next.action.serviceKey, "campaign");
  assert.match(chat.state.mentionedServices.campaign.reasonText, /Campaign management is poor/);
  assert.match(chat.state.mentionedServices.account.reasonText, /never reply/);
});

scenario("Shravya/Aashish: 9 CSAT, 10 NPS, detailed creative-process concern and named POC appreciation", () => {
  const chat = review();
  const opening = "It has been a great year working with SRV, and I have had a great experience with the team so far. Looking forward to another fruitful and successful year ahead!";
  assert.equal(chat.turn(opening, read({ sentiment: "positive", serviceScope: "overall_feedback" })).action.type, "rating_feedback");
  chat.turn("9"); chat.turn("10");
  assert.equal(chat.state.overallRating, 9);
  assert.equal(chat.state.npsScore, 10);
  const long = "My only feedback would be regarding the creative process. The team and I had aligned on common feedback across multiple creatives, but there was back and forth because changes were not consistently implemented by the designer. While working on landing pages I had to reiterate a change across all creatives. Better internal alignment and communication could make the process smoother. The POCs, Sammar initially and now Moulik, have always been approachable and responsive making coordination smooth throughout.";
  const next = chat.turn(long, read({
    observations: [{ topic: "Creative Process", detail: "The team and I had aligned on common feedback across multiple creatives, but there was back and forth because changes were not consistently implemented by the designer.", sentiment: "negative", needsFollowUp: false }],
    appreciations: [{ subject: "Sammar and Moulik", detail: "Sammar initially and now Moulik, have always been approachable and responsive making coordination smooth throughout.", serviceKey: "account" }]
  }), { acknowledgement: "I am sorry the agreed creative changes were not applied consistently." });
  assert.equal(next.action.type, "final_sweep", JSON.stringify({ action: next.action, state: chat.state }));
  assert.match(next.message, /Sammar.*Moulik/);
  assert.match(next.message, /creative|changes|designer/i);
  assert.doesNotMatch(next.message, /anything else (?:about|regarding) (?:Creatives|Landing|Account)/i);
  chat.turn("no", read({ intent: "negative" }));
  assert.equal(chat.state.state, sm.STATES.CLOSING_GRACE);
  assert.equal(chat.state.overallRating, 9);
  assert.equal(chat.state.npsScore, 10);
});

scenario("Yuvraj: 5 CSAT, 0 NPS and a staffing concern are acknowledged without replacing either score", () => {
  const chat = review();
  chat.turn("No", read({ intent: "negative", serviceScope: "overall_feedback" }));
  chat.turn("5"); chat.turn("0");
  const next = chat.turn("Don't hire interns", read({ observations: [{ topic: "Staffing", detail: "Don't hire interns", sentiment: "negative", needsFollowUp: false }] }), { acknowledgement: "I am sorry the use of interns did not meet your expectations." });
  assert.equal(next.action.type, "final_sweep");
  assert.match(next.message, /interns/i);
  assert.equal(chat.state.overallRating, 5);
  assert.equal(chat.state.npsScore, 0);
});

scenario("rating interruption: weekly spend reports stay reporting feedback and the pending rating resumes", () => {
  const chat = review();
  chat.turn("Overall the project went well", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  chat.turn("That's all", read({ intent: "negative", completionScope: "feedback", completionEvidence: "That's all" }));
  for (const [index, text] of ["There should be a weekly report sent to us about spend", "I would like to add that the team should share spend reports with us"].entries()) {
    const next = chat.turn(text, read({ observations: [{ topic: "Spend Reporting", detail: text, sentiment: "neutral", kind: "request", needsFollowUp: false }] }));
    assert.equal(next.action.type, "rating_feedback");
    assert.equal(next.action.offerChoice, index === 0);
    assert.equal(chat.state.overallRating, null);
    assert.ok(next.facts.observations.some((item) => /spend reports?|weekly report/i.test(item.detail)));
    assert.doesNotMatch(next.message, /Senior Involvement|meeting request/i);
  }
});

scenario("completion can accompany real concerns and does not require any particular completion phrase", () => {
  for (const done of ["I trust that conveys my experience", "I have explained everything I wanted to share", "That is the complete picture from my side", "Hope this feedback is sufficient"]) {
    const chat = review("pulse");
    const text = `The reports still arrive late. ${done}`;
    const next = chat.turn(text, read({ captured: [fact("campaign", "The reports still arrive late")], completionScope: "feedback", completionEvidence: done }));
    assert.equal(next.action.type, "overall_rating", done);
    assert.match(chat.state.mentionedServices.campaign.reasonText, /reports still arrive late/);
    assert.equal(chat.state.anythingElseAnswered, true);
    assert.equal(chat.state.overallRating, null);
  }
});

scenario("an explicit refusal of further questions closes politely with no invented rating", () => {
  const chat = review();
  const text = "Please do not ask me any further questions";
  const next = chat.turn(text, read({ intent: "negative", completionScope: "conversation", completionEvidence: text }));
  assert.equal(next.action.type, "close");
  assert.equal(chat.state.overallRating, null);
  assert.equal(chat.state.npsScore, null);
  assert.doesNotMatch(next.message, /null|undefined|rating of 0|notified/i);
});

scenario("a client may decline a requested score without being trapped at the numeric question", () => {
  const chat = review();
  chat.turn("Overall the project went well", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  const decline = "I prefer not to give a number";
  const next = chat.turn(decline, read({ intent: "negative", completionScope: "rating", completionEvidence: decline }));
  assert.equal(next.action.type, "nps");
  assert.equal(chat.state.overallRating, null);
  chat.turn("no", read({ intent: "negative" }));
  assert.equal(chat.state.npsScore, null);
  assert.equal(chat.state.npsDeclined, true);
});

scenario("additional concerns on the same topic are acknowledged without another apology", () => {
  const chat = review();
  const first = chat.turn("The account manager ignores our emails", read({ captured: [fact("account", "The account manager ignores our emails")] }));
  assert.match(first.message, /sorry/i);
  const second = chat.turn("The account manager also misses agreed reviews", read({ captured: [fact("account", "The account manager also misses agreed reviews")] }));
  assert.doesNotMatch(second.message, /sorry/i);
  assert.match(chat.state.mentionedServices.account.reasonText, /misses agreed reviews/i);
  assert.equal(second.action.type, "rating_feedback");
  assert.equal(second.action.offerChoice, false);
});

scenario("a completion flag without current-message evidence cannot discard a concern", () => {
  const chat = review("pulse");
  const next = chat.turn("Account management ignores our messages", read({ captured: [fact("account", "Account management ignores our messages")], completionScope: "conversation", completionEvidence: "I am done" }));
  assert.notEqual(next.action.type, "close");
  assert.match(chat.state.mentionedServices.account.reasonText, /ignores our messages/);
});

scenario("Vinay: revise/typo corrections preserve decimals and do not inherit fabricated leadership facts", () => {
  const state = { sessionType: "pulse", state: sm.STATES.CLOSING_GRACE, overallRating: 8, mentionedServices: {}, closingGraceExpiresAt: new Date(Date.now() + 600000).toISOString() };
  for (const text of ["Revise the raiting to 10", "I said 10", "Give 10/10 score to your team"]) {
    const turn = sm.processWhatsAppReply({ session: { sessionType: "pulse", conversationState: state }, project, poc, text });
    assert.equal(turn.conversationState.overallRating, 10);
    assert.doesNotMatch(turn.nextMessage.body, /Senior Involvement|Account Management/);
  }
  const grounded = flow.groundLatestReplyInterpretation(read({ observations: [{ topic: "Senior Involvement", detail: "The leadership was absent at meetings", sentiment: "negative" }] }), "10", project);
  assert.equal(grounded.observations.length, 0);
});

scenario("recommendation corrections including spoken 3.5 never overwrite overall CSAT", () => {
  const state = { sessionType: "project_end", state: sm.STATES.WAITING_FOR_NPS, pendingQuestionType: "nps", overallRatingAsked: true, overallRating: 4, npsScore: null, projectEndReviewCaptured: true, serviceScopeStatus: "project_end_overall", mentionedServices: {} };
  const turn = sm.processWhatsAppReply({ session: { sessionType: "project_end", conversationState: state }, project, poc, text: "no take three point five", geminiUnavailable: true });
  assert.equal(turn.conversationState.overallRating, 4);
  assert.equal(turn.conversationState.npsScore, 3.5);
});

scenario("past or third-party availability never postpones feedback, including a mistaken model pause flag", () => {
  for (const text of ["The account managers were busy with their work", "They were in a meeting whenever I called", "The designers were on leave", "I was busy chasing the team because they did not reply"]) {
    assert.equal(sm.detectors.isDeferral(text), false, text);
    assert.equal(sm.detectors.clientRequestedDeferral(text, read({ deferRequested: true })), false, text);
  }
  for (const text of ["I am busy now", "We're in a meeting", "I will share the remaining feedback tomorrow"]) {
    assert.equal(sm.detectors.clientRequestedDeferral(text), true, text);
  }
});

scenario("new service names such as Influencer Marketing use configured identities", () => {
  const chat = review("pulse", { ...project, services: [project.services.at(-1)] });
  const next = chat.turn("The influencers delivered the approved videos late", read({ captured: [fact("influencer", "The influencers delivered the approved videos late")] }));
  assert.equal(next.action.serviceKey, "influencer");
  assert.match(next.message, /Influencer Marketing/);
});

scenario("unrelated concerns and requests during rating questions preserve their own topics across both full-feedback flows", () => {
  const examples = [
    { text: "The account manager ignores our approval emails", captured: [fact("account", "The account manager ignores our approval emails")] },
    { text: "The influencers delivered the approved videos late", captured: [fact("influencer", "The influencers delivered the approved videos late")] },
    { text: "The invoice contains the wrong tax registration number", observations: [{ topic: "Billing", detail: "The invoice contains the wrong tax registration number", sentiment: "negative", needsFollowUp: false }] },
    { text: "Please give us the account access credentials", observations: [{ topic: "Account Access", detail: "Please give us the account access credentials", kind: "request", sentiment: "neutral", needsFollowUp: false }] },
    { text: "Please send us a weekly spend report", observations: [{ topic: "Spend Reporting", detail: "Please send us a weekly spend report", kind: "request", sentiment: "neutral", needsFollowUp: false }] }
  ];
  for (const type of ["pulse", "project_end"]) {
    for (const example of examples) {
      const chat = review(type);
      const done = "That is everything I wanted to say about the project";
      chat.turn(done, read({ completionScope: "feedback", completionEvidence: done }));
      const next = chat.turn(example.text, read(example));
      assert.equal(next.action.type, "rating_feedback", `${type}: ${example.text}`);
      assert.equal(next.action.offerChoice, true);
      assert.equal(chat.state.overallRating, null);
      assert.equal(chat.state.npsScore, null);
      assert.doesNotMatch(next.message, /Senior Involvement|meeting request|anything else about/i);
      assert.ok(next.facts.captured.length || next.facts.observations.length, "new feedback must survive");
      chat.turn("6");
      assert.equal(chat.state.overallRating, 6);
      assert.equal(chat.state.npsScore, null, "30-day feedback must not request or capture NPS");
      assert.equal(chat.state.state === sm.STATES.WAITING_FOR_NPS, type === "project_end");
    }
  }
});

scenario("feedback additions after natural completion remain unlimited while the same optional service question stays closed", () => {
  for (const finished of ["Nothing else comes to mind", "I have nothing further to share", "That covers it from my end"]) {
    const chat = review("pulse");
    chat.turn("The account manager misses our approvals", read({ captured: [fact("account", "The account manager misses our approvals")] }));
    chat.turn(finished, read({ intent: "negative", completionScope: "feedback", completionEvidence: finished }));
    for (const [index, text] of ["Our emails also go unanswered", "The promised review was missed again", "Nobody sent the agreed action plan"].entries()) {
      const next = chat.turn(text, read({ captured: [fact("account", text)] }));
      assert.equal(next.action.type, "rating_feedback");
      assert.equal(next.action.offerChoice, index === 0);
      assert.match(chat.state.mentionedServices.account.reasonText, new RegExp(text));
      assert.doesNotMatch(next.message, /anything else about Account Management/i);
    }
    assert.equal(chat.state.mentionedServices.account.serviceFollowUpAskCount, 1);
  }
});

scenario("closing-window spend reporting and five unrelated improvement points preserve the original clock and scores", () => {
  const chat = review();
  chat.turn("Overall the project went well", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  chat.turn("7"); chat.turn("9");
  chat.turn("no", read({ intent: "negative" }));
  const originalDeadline = chat.state.closingGraceExpiresAt;
  const request = "would like to add- there should be weekly report to be sent about spend";
  const spend = chat.turn(request, read({ observations: [{ topic: "Spend Reporting", detail: request, kind: "request", sentiment: "neutral", needsFollowUp: false }] }));
  assert.ok(spend.facts.observations.some((item) => /weekly report/.test(item.detail)));
  assert.doesNotMatch(spend.message, /Senior Involvement|meeting request|send the correct number/i);
  const points = [
    ["Proactivity", "Team needs to be more proactive in terms sharing performance improvement recommendations, rather than client highlighting things"],
    ["Timelines", "Sometimes delivery timeliness are missed with sharing the update on work in progress"],
    ["Dashboard Accuracy", "Even though there is a performance dashboard shared but couple of times data is incorrect leads a lack of trust as it happened couple of times"],
    ["Quality Control", "QC needs to be improved as sometimes wrong creatives went live"],
    ["Review Meetings", "There should be regular meetings on weekly updates, it doesnt happen until client request for the same"]
  ];
  const praise = "so far the performance has improved YOY so good work done by the team";
  const next = chat.turn(`See these points: ${points.map(([, detail], index) => `${index + 1}. ${detail}`).join("; ")}. ${praise}`, read({
    observations: points.map(([topic, detail]) => ({ topic, detail, sentiment: "negative", needsFollowUp: false })),
    appreciations: [{ subject: "SRV Team", detail: praise }]
  }));
  assert.equal(next.action.type, "close");
  assert.equal(next.facts.observations.length, 5);
  assert.match(next.message, /appreciat|kind words/i);
  assert.equal(chat.state.overallRating, 7);
  assert.equal(chat.state.npsScore, 9);
  assert.equal(chat.state.closingGraceExpiresAt, originalDeadline);
});

scenario("overall praise is acknowledged and goes to CSAT without a missed-department question", () => {
  for (const text of ["India's Best agency. Keep it up.", "Working together has been a pleasure and we value the partnership", "The experience has been excellent across the year"]) {
    const chat = review();
    const next = chat.turn(text, read({ sentiment: "positive", serviceScope: "overall_feedback", appreciations: [{ subject: "SRV Team", detail: text }] }));
    assert.equal(next.action.type, "rating_feedback");
    assert.equal(next.action.offerChoice, true);
    assert.match(next.message, /thank you|kind words/i);
    assert.doesNotMatch(next.message, /missed.*department|department.*missed|anything else about/i);
  }
});

scenario("semantic completion fields survive extraction normalization without borrowing transcript words", () => {
  const text = "I believe I have covered everything";
  const parsed = normaliseReplyInterpretation({ intent: "negative", completionScope: "feedback", completionEvidence: text }, project, text);
  assert.equal(sm.detectors.completionScopeFor(text, parsed), "feedback");
  assert.equal(sm.detectors.completionScopeFor("The report is wrong", parsed), "none");
});

scenario("finish then rating then new feedback can repeat without trapping, discarding details or repeating every question", () => {
  for (const type of ["pulse", "project_end"]) {
    for (const done of ["That's it", "I believe that is sufficient", "Nothing further from my side"]) {
      const chat = review(type);
      chat.turn(done, read({ intent: "negative", completionScope: "feedback", completionEvidence: done }));
      for (let round = 0; round < 2; round += 1) {
        const text = round ? "The account manager missed another scheduled review" : "The account manager never replies to our approval emails";
        const next = chat.turn(text, read({ captured: [fact("account", text)] }));
        assert.equal(next.action.type, "rating_feedback");
        assert.equal(next.action.offerChoice, true);
        assert.match(next.message, /Would you like to add anything else, or shall we move to the overall rating\?$/);
        const detail = `The account manager also missed the agreed action plan in review ${round + 1}`;
        const more = chat.turn(detail, read({ captured: [fact("account", detail)] }));
        assert.equal(more.action.type, "rating_feedback");
        assert.equal(more.action.offerChoice, false);
        assert.doesNotMatch(more.message, /\?|out of 10|anything else about/i);
        const resumed = chat.turn(done, read({ intent: "negative", completionScope: "feedback", completionEvidence: done }));
        assert.equal(resumed.action.type, "overall_rating");
        assert.match(resumed.message, /out of 10/i);
        assert.equal(chat.state.overallRating, null);
        assert.notEqual(chat.state.overallRatingDeclined, true);
        assert.match(chat.state.mentionedServices.account.reasonText, new RegExp(text));
      }
      chat.turn("8");
      assert.equal(chat.state.overallRating, 8);
      assert.equal(chat.state.ratingFeedbackPause, null);
      assert.equal(chat.state.state === sm.STATES.WAITING_FOR_NPS, type === "project_end");
    }
  }
});

scenario("a short no to the add-feedback choice resumes rather than declines the unanswered rating", () => {
  for (const done of ["no", "nope", "nothing more", "let's move on"]) {
    const chat = review();
    chat.turn("Overall the project was good", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
    chat.turn("The reports arrive late", read({ observations: [{ topic: "Reporting", detail: "The reports arrive late", sentiment: "negative", needsFollowUp: false }] }));
    const next = chat.turn(done, read({ intent: "negative" }));
    assert.equal(next.action.type, "overall_rating", done);
    assert.notEqual(chat.state.overallRatingDeclined, true, done);
  }
});

scenario("feedback during NPS keeps CSAT, ignores quantities, and can accept the volunteered recommendation score", () => {
  const chat = review();
  chat.turn("Overall the project was good", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  chat.turn("9");
  const text = "We sent 3 approval emails but nobody replied";
  const next = chat.turn(text, read({ captured: [fact("account", text)] }));
  assert.equal(next.action.type, "rating_feedback");
  assert.equal(next.action.ratingType, "nps");
  assert.match(next.message, /recommendation rating\?$/);
  assert.equal(chat.state.overallRating, 9);
  assert.equal(chat.state.npsScore, null);
  const more = "The account manager also missed 2 scheduled reviews";
  assert.equal(chat.turn(more, read({ captured: [fact("account", more)] })).action.offerChoice, false);
  assert.equal(chat.state.npsScore, null);
  chat.turn("3.5");
  assert.equal(chat.state.npsScore, 3.5);
  assert.equal(chat.state.overallRating, 9);
  assert.equal(chat.state.ratingFeedbackPause, null);
});

scenario("essential clarification remains bounded before the optional move-to-rating choice", () => {
  const chat = review();
  chat.turn("Overall the project was good", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  assert.equal(chat.turn("Campaign management is poor", read({ captured: [fact("campaign", "Campaign management is poor", "negative", true)] })).action.type, "issue_reason");
  const detail = "The campaign never reached the approved audience";
  const next = chat.turn(detail, read({ captured: [fact("campaign", detail)] }));
  assert.equal(next.action.type, "rating_feedback");
  assert.equal(chat.state.mentionedServices.campaign.issueReasonAskCount, 1);
  assert.equal(chat.turn("no", read({ intent: "negative" })).action.type, "overall_rating");
});

scenario("a genuine score refusal during feedback pause remains a refusal, not a request for another numeric answer", () => {
  for (const target of ["overall_rating", "nps"]) {
    const chat = review();
    chat.turn("Overall the project was good", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
    if (target === "nps") chat.turn("9");
    const text = "The invoice has the wrong registered address";
    chat.turn(text, read({ observations: [{ topic: "Billing", detail: text, sentiment: "negative", needsFollowUp: false }] }));
    const decline = "I would rather not assign a number";
    const next = chat.turn(decline, read({ intent: "negative", completionScope: "rating", completionEvidence: decline }));
    assert.notEqual(next.action.type, target);
    assert.equal(target === "nps" ? chat.state.npsScore : chat.state.overallRating, null);
    assert.equal(target === "nps" ? chat.state.npsDeclined : chat.state.overallRatingDeclined, true);
    assert.equal(chat.state.ratingFeedbackPause, null);
  }
});

scenario("negative availability and responsiveness never become fallback praise", () => {
  for (const text of [
    "Some account managers were busy with their work. They were never available for the review.",
    "The account manager was not responsive or helpful",
    "The POCs were hardly ever available"
  ]) {
    const facts = { captured: [], observations: [], appreciations: [] };
    flow.enrichConductedWithDeterministicFacts(facts, text, project, read({ captured: [fact("account", text)] }));
    assert.equal(facts.appreciations.length, 0, text);
    assert.ok(facts.captured.some((item) => item.sentiment === "negative"));
  }
  const text = "The account manager has always been patient and understanding";
  const facts = { captured: [], observations: [], appreciations: [] };
  flow.enrichConductedWithDeterministicFacts(facts, text, project, null);
  assert.equal(facts.appreciations.length, 1, "genuine role praise remains available during an outage");
});

scenario("postponing and resuming while adding feedback preserves the missing score and existing facts", () => {
  const chat = review();
  chat.turn("Overall the project was good", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  const concern = "The invoice has the wrong tax number";
  chat.turn(concern, read({ observations: [{ topic: "Billing", detail: concern, sentiment: "negative", needsFollowUp: false }] }));
  const paused = chat.turn("I will share the rest tomorrow", read({ intent: "defer", deferRequested: true }));
  assert.equal(paused.control.deferred, true);
  assert.equal(chat.state.ratingFeedbackPause.ratingType, "overall_rating");
  assert.equal(chat.state.overallRating, null);
  assert.equal(chat.state.closingGraceExpiresAt, null);
  chat.turn("Ready", read({ intent: "affirmative", sentiment: "neutral", explainsProblem: false }));
  const next = chat.turn("no", read({ intent: "negative" }));
  assert.equal(next.action.type, "overall_rating");
  assert.notEqual(chat.state.overallRatingDeclined, true);
  assert.equal(chat.state.ratingFeedbackPause, null);
});

scenario("positive or neutral additions before rating receive an acknowledgement as well as the choice", () => {
  const chat = review();
  chat.turn("Overall the project was good", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  const text = "The campaign reports are clear now";
  const next = chat.turn(text, read({ sentiment: "positive", captured: [fact("campaign", text, "positive")] }));
  assert.equal(next.action.type, "rating_feedback");
  assert.match(chat.state.mentionedServices.campaign.reasonText, /reports are clear/);
  assert.doesNotMatch(next.message, /I have recorded:|the client|on a scale|out of 10/i);
});

scenario("short emotional continuation without extracted service facts still pauses an unanswered score", () => {
  const chat = review();
  chat.turn("Overall the project failed to meet our expectations", read({ serviceScope: "overall_feedback" }));
  const added = chat.turn("This kind of activities I never had seen", read({ explainsProblem: false }));
  assert.equal(added.action.type, "rating_feedback");
  assert.equal(added.action.offerChoice, false);
  assert.doesNotMatch(added.message, /rate|rating|out of 10|on a scale|I have recorded:|the client/i);
  assert.equal(chat.state.overallRating, null);
  assert.equal(chat.turn("That is everything", read({ intent: "negative", completionScope: "feedback", completionEvidence: "That is everything" })).action.type, "overall_rating");
});

scenario("rating transition accepts natural alternatives but not direct numeric or wrong-score questions", () => {
  const action = { type: "rating_feedback", ratingType: "overall_rating", offerChoice: true };
  for (const text of [
    "Is there anything else you would like to share before we move to an overall rating?",
    "Would you like to share more feedback, or proceed to the overall score?",
    "You can add anything further, or we can move to the rating when you are ready."
  ]) assert.equal(flow.messageMatchesRequiredAction(action, text), true, text);
  for (const text of ["How would you rate us out of 10?", "Anything else about Account Management?", "Anything else, or shall we move to the recommendation rating?"]) {
    assert.equal(flow.messageMatchesRequiredAction(action, text), false, text);
  }
});

scenario("a bare acknowledgement after a note-only reply is not treated as finished feedback", () => {
  const chat = review();
  chat.turn("Overall our campaign experience was disappointing", read({ serviceScope: "overall_feedback" }));
  chat.turn("Our requests were also ignored", read({ captured: [fact("account", "Our requests were also ignored")] }));
  const acknowledgement = chat.turn("okay", read({ intent: "affirmative", sentiment: "neutral", explainsProblem: false }));
  assert.equal(acknowledgement.action.type, "rating_feedback");
  assert.equal(acknowledgement.action.offerChoice, false);
  assert.doesNotMatch(acknowledgement.message, /out of 10|on a scale/);
  const finished = "That covers everything I wanted to say";
  assert.equal(chat.turn(finished, read({ intent: "negative", completionScope: "feedback", completionEvidence: finished })).action.type, "overall_rating");
  const direct = review();
  direct.turn("Overall our campaign experience was disappointing", read({ serviceScope: "overall_feedback" }));
  assert.equal(direct.turn("okay", read({ intent: "affirmative", sentiment: "neutral", explainsProblem: false })).action.type, "overall_rating", "the same acknowledgement can accept an immediately preceding transition choice");
});

scenario("retrospective complaints are not manufactured into neutral requests across message bubbles", () => {
  for (const text of [
    "They were never available for the review\nNever did what we want",
    "They were never available for the review Never did what we want",
    "They never did what we wanted in the review",
    "We asked for weekly reports but they never sent them",
    "Please note that nobody attended the review",
    "The review should have happened last week"
  ]) {
    assert.equal(flow.isExplicitActionRequest(text), false, text);
    const observation = flow.observationFromInterpretation(read({ isObservation: true }), text);
    if (observation) {
      assert.equal(observation.kind, "feedback", text);
      assert.equal(observation.sentiment, "negative", text);
    }
  }
  for (const text of ["We want a weekly spend report", "Could you arrange a review meeting?", "There should be weekly reports about spend", "Please send us the invoice"]) {
    assert.equal(flow.isExplicitActionRequest(text), true, text);
  }
});

scenario("safe reply-writing acknowledgement survives a corrected next action without importing its facts", () => {
  const chat = review();
  const text = "Our words stand in the market. Others look at me for the feedback and opinion of the agency";
  const acknowledgement = "We recognise that your experience with SRV affects the confidence with which you can recommend us to others.";
  const next = chat.turn(text, read({ serviceScope: "overall_feedback", observations: [{ topic: "Management Feedback", detail: "The client emphasizes that their opinion and feedback about the agency carry weight in the market and influence others", sentiment: "negative", needsFollowUp: false }] }), { acknowledgement });
  assert.ok(next.message.startsWith(acknowledgement));
  assert.doesNotMatch(next.message, /the client|I have recorded:/i);
  assert.equal(next.action.type, "rating_feedback");
});

scenario("internal summaries and unsupported acknowledgement claims never reach clients via a fallback", () => {
  const text = "Leadership ignored our requests for reviews";
  const context = { latestClientText: text, captured: [], observations: [{ topic: "Senior Involvement", detail: "The client says leadership ignored reviews", sentiment: "negative" }], appreciations: [] };
  for (const acknowledgement of [
    "The client emphasizes their dissatisfaction.",
    "I have recorded: Leadership ignored reviews.",
    "The Directors have been notified.",
    "Your invoice issue has been recorded.",
    "I have fixed the problem."
  ]) {
    const message = flow.fallbackForAction({ type: "rating_feedback", ratingType: "overall_rating", offerChoice: false }, {}, project, { ...context, acknowledgement });
    assert.doesNotMatch(message, /the client|I have recorded:|have been notified|invoice|fixed the problem/i);
  }
});

scenario("monthly broad relationship praise offers room before CSAT rather than inferring finished feedback", () => {
  const chat = review("pulse", { ...project, services: project.services.slice(0, 2) });
  chat.turn("okay");
  const text = "Hi thanks a lot for your message. We were all working to make things better. I appreciate your taking the feedback positively and the support your team has extended. We hope to carry on a mutually beneficial relationship and learn from your expertise.";
  const next = chat.turn(text, read({ sentiment: "positive", serviceScope: "overall_feedback", acknowledgement: "Thank you for valuing the partnership and the team’s support.", appreciations: [{ subject: "SRV Team", detail: "I appreciate your taking the feedback positively and the support your team has extended." }] }));
  assert.equal(next.action.type, "rating_feedback");
  assert.equal(next.action.offerChoice, true);
  assert.match(next.message, /partnership|support/);
  assert.doesNotMatch(next.message, /on a scale|out of 10|missed.*department/i);
  chat.turn("Let’s move to the score", read({ completionScope: "feedback", completionEvidence: "Let’s move to the score", intent: "negative" }));
  const rating = chat.turn("7");
  assert.equal(chat.state.overallRating, 7);
  assert.equal(chat.state.npsScore, null);
  assert.equal(rating.action.type, "close");
});

scenario("volunteering a monthly rating after a broad review preserves the final management invitation", () => {
  const chat = review("pulse");
  chat.turn("The partnership has been constructive and the team has supported us throughout", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  const next = chat.turn("8");
  assert.equal(chat.state.overallRating, 8);
  assert.equal(next.action.type, "final_sweep");
  assert.equal(chat.state.npsScore, null);
});

scenario("closing-window requests, concerns and praise stay specific across monthly and project-end flows", () => {
  for (const type of ["pulse", "project_end"]) {
    const chat = review(type);
    chat.turn("Overall the partnership has been helpful", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
    chat.turn("That is all for now", read({ completionScope: "feedback", completionEvidence: "That is all for now", intent: "negative" }));
    chat.turn("7"); if (type === "project_end") chat.turn("9");
    const deadline = chat.state.closingGraceExpiresAt;
    assert.ok(deadline);
    const requests = [
      ["there should be weekly meeting with team", "Weekly Team Meetings", "I have noted your request for weekly meetings with the team."],
      ["Could you enable access to our shared dashboard?", "Dashboard Access", "I have noted your request for access to the shared dashboard."],
      ["Please send the tax invoice as a PDF", "Billing", "I have noted your request for the tax invoice in PDF format."],
      ["We would appreciate receiving a monthly ledger", "Billing", "I have noted your request for a monthly ledger."]
    ];
    for (const [text, topic, acknowledgement] of requests) {
      const next = chat.turn(text, read({ acknowledgement, observations: [{ topic, detail: text, kind: "request", sentiment: "negative", needsFollowUp: false }] }), { acknowledgement: "I am sorry your whole experience has been disappointing." });
      assert.equal(next.action.type, "close", text);
      assert.ok(next.message.includes(acknowledgement), next.message);
      assert.doesNotMatch(next.message, /sorry|disappoint|anything else about|out of 10.*correct number/i);
      assert.equal(chat.state.closingGraceExpiresAt, deadline);
    }
    for (const [text, key, title, acknowledgement] of [
      ["Design looks like 1990s", "creatives", "Outdated Design Style", "I’m sorry the designs felt dated. I have noted your concern about their visual style."],
      ["The landing page freezes after I submit the form", "landing", "Form Submission Freezes", "I’m sorry the landing page freezes after form submission. I have noted this concern for review."]
    ]) {
      const next = chat.turn(text, read({ acknowledgement, captured: [fact(key, text)], concerns: [{ serviceKey: key, title, summary: text, sentiment: "negative" }] }));
      assert.equal(next.action.type, "close"); assert.ok(next.message.includes(acknowledgement), next.message);
      assert.doesNotMatch(next.message, /experience has been disappointing|anything else about/i);
    }
    // A stale earlier follow-up must not win over this unrelated appreciation.
    chat.state.mentionedServices.account = { serviceKey: "account", serviceName: "Account Management", status: "needs_service_followup", sentiment: "negative", reasonText: "Historical point", serviceFollowUpAnswered: false };
    const praise = "Campaign management was good";
    const next = chat.turn(praise, read({ sentiment: "positive", captured: [fact("campaign", praise, "positive")], appreciations: [{ subject: "Campaign Management Team", detail: praise, serviceKey: "campaign" }], acknowledgement: "Thank you for appreciating the Campaign Management team. We will share your kind words with them." }));
    assert.equal(next.action.type, "close");
    assert.doesNotMatch(next.message, /Account Management|anything else about|sorry/i);
    assert.match(next.message, /Campaign Management/);
    assert.equal(chat.state.overallRating, 7);
    assert.equal(chat.state.npsScore, type === "project_end" ? 9 : null);
    assert.equal(chat.state.closingGraceExpiresAt, deadline);
  }
});

scenario("closing-window clarification is about a new unclear point, bounded and never a restarted interview", () => {
  const chat = review();
  chat.turn("The overall work has been good", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  chat.turn("Nothing more", read({ intent: "negative", completionScope: "feedback", completionEvidence: "Nothing more" }));
  chat.turn("8"); chat.turn("9");
  const expiry = chat.state.closingGraceExpiresAt;
  const vague = "The creative quality is poor";
  const next = chat.turn(vague, read({ captured: [fact("creatives", vague, "negative", true)] }));
  assert.equal(next.action.type, "issue_reason"); assert.equal(next.action.serviceKey, "creatives");
  const praise = "The influencer work was excellent";
  const changed = chat.turn(praise, read({ sentiment: "positive", captured: [fact("influencer", praise, "positive")], appreciations: [{ subject: "Influencer Marketing Team", detail: praise, serviceKey: "influencer" }] }));
  assert.equal(changed.action.type, "close");
  assert.doesNotMatch(changed.message, /anything else about|what happened with Creatives/i);
  assert.equal(chat.state.closingGraceExpiresAt, expiry);
});

scenario("rating option labels advance once even after an acknowledgement-only stalled turn", () => {
  for (const type of ["pulse", "project_end"]) for (const text of ["rating", "overall rating", "score", "then ask rating"]) {
    const chat = review(type);
    chat.turn("The partnership and support have been good overall", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
    chat.state.lastQuestionAsked = "Thank you for letting us know.";
    const interpretation = text === "then ask rating" ? { ratingChoice: "proceed", ratingChoiceEvidence: text } : {};
    const next = chat.turn(text, read({ intent: "feedback", sentiment: "neutral", ...interpretation }));
    assert.equal(next.action?.type, "overall_rating", `${type}: ${text}: ${next.message}`);
    assert.match(next.message, /overall.*out of 10/i);
    assert.equal(chat.state.overallRating, null);
    assert.equal(chat.state.npsScore, null);
  }
});

scenario("semantic rating choices respect current evidence, continued feedback and explicit refusal", () => {
  for (const text of ["Let us get to the number now", "The second option please", "I am ready for the scoring question", "Ab rating poochiye"]) {
    const chat = review();
    chat.turn("Our overall experience was positive", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
    chat.state.lastQuestionAsked = "Thank you for confirming.";
    const next = chat.turn(text, read({ ratingChoice: "proceed", ratingChoiceEvidence: text, sentiment: "neutral" }));
    assert.equal(next.action.type, "overall_rating", text);
  }
  const chat = review();
  chat.turn("Our overall experience was positive", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
  const text = "The rating can wait; there are no project updates";
  const next = chat.turn(text, read({ ratingChoice: "proceed", ratingChoiceEvidence: "Let us get to the number now",
    captured: [fact("account", "There are no project updates")] }));
  assert.equal(next.action.type, "rating_feedback");
  assert.equal(chat.state.overallRating, null);
  assert.match(chat.state.mentionedServices.account.reasonText, /no project updates/i);
  const refused = "I do not wish to give a score";
  chat.turn(refused, read({ intent: "negative", completionScope: "rating", completionEvidence: refused }));
  assert.equal(chat.state.overallRatingDeclined, true);
  assert.equal(chat.state.overallRating, null);
});

scenario("closing a score avoids duplicate acknowledgements and completion is not new feedback", () => {
  for (const type of ["pulse", "project_end"]) {
    const chat = review(type);
    chat.turn("Our overall experience was positive", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
    chat.turn("That covers everything", read({ intent: "negative", completionScope: "feedback", completionEvidence: "That covers everything" }));
    chat.turn("6", null, { acknowledgement: "Thank you for providing your overall rating of 6." });
    if (type === "project_end") chat.turn("9", null, { acknowledgement: "Thank you for your recommendation rating of 9." });
    const close = chat.turns.at(-1);
    assert.doesNotMatch(close.message, /Thank you for (?:providing|your recommendation)/i);
    const expiry = chat.state.closingGraceExpiresAt;
    for (const text of ["That is it", "Nothing further from my side", "I have shared everything I wanted to"]) {
      const done = chat.turn(text, read({ intent: "negative", completionScope: "feedback", completionEvidence: text }), { acknowledgement: "Thank you for confirming that you have shared all your feedback." });
      assert.equal(done.state.state, sm.STATES.CLOSING_GRACE);
      assert.doesNotMatch(done.message, /added|additional|out of 10|next 10 minutes/i);
      assert.match(done.message, /original 10-minute window|close automatically/i);
      assert.equal(chat.state.closingGraceExpiresAt, expiry);
      assert.equal(chat.state.overallRating, 6);
      assert.equal(chat.state.npsScore, type === "project_end" ? 9 : null);
    }
  }
});

scenario("rating choices do not swallow additional feedback, invent a score or apply outside their context", () => {
  for (const type of ["pulse", "project_end"]) {
    const chat = review(type);
    chat.turn("Our overall experience was positive", read({ sentiment: "positive", serviceScope: "overall_feedback" }));
    const text = "The rating can wait; we are not receiving project updates";
    const added = chat.turn(text, read({ ratingChoice: "continue_feedback", ratingChoiceEvidence: "The rating can wait",
      captured: [fact("account", "We are not receiving project updates")] }));
    assert.equal(added.action.type, "rating_feedback");
    assert.match(chat.state.mentionedServices.account.reasonText, /not receiving project updates/i);
    assert.equal(chat.state.overallRating, null);
    const last = "The form freezes when submitted. Let us proceed to the score";
    const moved = chat.turn(last, read({ ratingChoice: "proceed", ratingChoiceEvidence: "Let us proceed to the score",
      captured: [fact("landing", "The form freezes when submitted")] }));
    assert.equal(moved.action.type, "overall_rating");
    assert.match(chat.state.mentionedServices.landing.reasonText, /form freezes/i);
    assert.equal(chat.state.overallRating, null);
  }
  const chat = review("pulse");
  const text = "The website form freezes";
  const next = chat.turn(text, read({ ratingChoice: "proceed", ratingChoiceEvidence: text, captured: [fact("landing", text)] }));
  assert.notEqual(next.action.type, "overall_rating", "choice metadata cannot skip the normal service flow without a pending rating choice");
});

for (const [status, name, error] of results) console.log(`${status}  ${name}${error ? `\n${error}` : ""}`);
const failures = results.filter(([status]) => status === "FAIL").length;
console.log(`\n${results.length - failures}/${results.length} historical conversation replays passed`);
if (failures) process.exitCode = 1;
