const assert = require("node:assert/strict");
const { SupabaseStore, quickCheckinScheduleKey, nextQuickCheckinAt } = require("../src/lib/supabase-store");

assert.equal(quickCheckinScheduleKey("2026-10-10T18:30:00.000Z"), "2026-10-11");
assert.equal(quickCheckinScheduleKey("2026-10-21T04:30:00.000Z"), "2026-10-21");
assert.equal(quickCheckinScheduleKey("2026-10-20T12:00:00.000Z"), null);
assert.equal(quickCheckinScheduleKey("not-a-date"), null);
assert.equal(nextQuickCheckinAt("2026-10-11T03:30:00.000Z"), "2026-10-11T04:30:00.000Z");
assert.equal(nextQuickCheckinAt("2026-10-11T05:30:00.000Z"), "2026-10-21T04:30:00.000Z");
assert.equal(nextQuickCheckinAt("2026-10-22T05:30:00.000Z"), "2026-11-11T04:30:00.000Z");

async function run() {
  const scheduler = new SupabaseStore({ skipEnv: true });
  scheduler.listProjects = async () => [
    { id: "p1", key: "active", activeStatus: "active", clientActiveStatus: "active" },
    { id: "p2", key: "already-sent", activeStatus: "active", clientActiveStatus: "active" },
    { id: "p3", key: "paused", activeStatus: "paused", clientActiveStatus: "active" },
    { id: "p4", key: "inactive-client", activeStatus: "active", clientActiveStatus: "inactive" },
    {
      id: "p5", key: "manual-project-end", activeStatus: "active", clientActiveStatus: "active",
      endDate: "2026-10-31", endFeedbackRequestedAt: "2026-09-29T12:00:00.000Z"
    },
    { id: "p6", key: "historic-project-end", activeStatus: "active", clientActiveStatus: "active", endDate: "2026-10-31" },
    { id: "p7", key: "date-ended", activeStatus: "active", clientActiveStatus: "active", endDate: "2026-10-10" },
    { id: "p8", key: "quick-automatic-off", activeStatus: "active", clientActiveStatus: "active", automaticQuickCheckinEnabled: false },
    {
      id: "p9", key: "quick-resumes-later", activeStatus: "active", clientActiveStatus: "active",
      automaticQuickCheckinEnabled: true, automaticQuickCheckinResumeAt: "2026-10-21T04:30:00.000Z"
    }
  ];
  scheduler.projectIdsWithCycleType = async () => new Set(["p6"]);
  scheduler.hasScheduledQuickCheckin = async (projectId) => projectId === "p2";
  const due = await scheduler.getDueQuickCheckinTargets("2026-10-11T04:30:00.000Z");
  assert.equal(due.scheduleKey, "2026-10-11");
  assert.deepEqual(due.targets, [{ projectKey: "active", cycleType: "quick_checkin", scheduleKey: "2026-10-11" }]);

  const monthlyScheduler = new SupabaseStore({ skipEnv: true });
  monthlyScheduler.listProjects = async () => [
    {
      id: "p1", key: "normal-monthly", activeStatus: "active", endDate: "2026-10-31",
      nextCycleDueAt: "2026-09-30T00:00:00.000Z"
    },
    {
      id: "p5", key: "manual-project-end", activeStatus: "active", endDate: "2026-10-31",
      nextCycleDueAt: "2026-09-30T00:00:00.000Z", endFeedbackRequestedAt: "2026-09-29T12:00:00.000Z"
    },
    {
      id: "p6", key: "historic-project-end", activeStatus: "active", endDate: "2026-10-31",
      nextCycleDueAt: "2026-09-30T00:00:00.000Z"
    },
    {
      id: "p8", key: "monthly-automatic-off", activeStatus: "active", endDate: "2026-10-31",
      nextCycleDueAt: "2026-09-30T00:00:00.000Z", automaticFeedbackEnabled: false
    }
  ];
  monthlyScheduler.projectIdsWithCycleType = async () => new Set(["p5", "p6"]);
  monthlyScheduler.hasOpenCycle = async () => false;
  assert.deepEqual(
    await monthlyScheduler.getDueFeedbackTargets("2026-10-01T00:00:00.000Z"),
    [{ projectKey: "normal-monthly", cycleType: "pulse" }],
    "manual or historic project-end feedback must permanently suppress recurring monthly feedback"
  );

  const guardedStore = new SupabaseStore({ skipEnv: true });
  guardedStore.getProject = async () => ({
    id: "p5", key: "manual-project-end", endDate: "2026-10-31",
    endFeedbackRequestedAt: "2026-09-29T12:00:00.000Z", pocs: []
  });
  guardedStore.hasAnyCycle = async () => true;
  await assert.rejects(
    guardedStore.createCycle("manual-project-end", { cycleType: "pulse" }),
    /project-end feedback has already been sent/i
  );
  await assert.rejects(
    guardedStore.createCycle("manual-project-end", { cycleType: "quick_checkin" }),
    /project-end feedback has already been sent/i
  );

  const automaticGuardStore = new SupabaseStore({ skipEnv: true });
  automaticGuardStore.getProject = async () => ({
    id: "p8",
    key: "automatic-off",
    feedbackIntervalDays: 30,
    automaticFeedbackEnabled: false,
    automaticQuickCheckinEnabled: false,
    pocs: []
  });
  automaticGuardStore.hasAnyCycle = async () => false;
  await assert.rejects(
    automaticGuardStore.createCycle("automatic-off", { cycleType: "pulse", automatic: true }),
    /automatic 30-day feedback is turned off/i
  );
  await assert.rejects(
    automaticGuardStore.createCycle("automatic-off", { cycleType: "quick_checkin", automatic: true }),
    /automatic quick check-ins are turned off/i
  );
  await assert.rejects(
    automaticGuardStore.createCycle("automatic-off", { cycleType: "pulse" }),
    /no active POC/i,
    "manual sends must pass the automatic-setting guard and fail only for the independently missing POC"
  );

  const store = new SupabaseStore({ skipEnv: true });
  let currentSession = {
    id: "s1", cycleId: "c1", clientPocId: "poc1", projectId: "project1",
    sessionType: "quick_checkin", status: "started", reminderDueAt: "2026-10-13T04:30:00.000Z",
    conversationState: { state: "quick_checkin_choice", quickCheckinOutcome: "awaiting_response" }
  };
  store.getSession = async () => currentSession;
  store.servicesForProject = async () => [];
  store.recomputeCycle = async () => null;
  const writes = [];
  store.request = async (table, options = {}) => {
    writes.push({ table, options });
    if (table === "feedback_sessions") {
      const row = {
        id: "s1", cycle_id: "c1", client_poc_id: "poc1", project_id: "project1",
        status: options.body.status, completion_status: options.body.completion_status,
        conversation_state: options.body.conversation_state, reminder_due_at: options.body.reminder_due_at,
        last_client_response_at: options.body.last_client_response_at, completed_at: options.body.completed_at
      };
      currentSession = {
        ...currentSession,
        status: row.status,
        completionStatus: row.completion_status,
        conversationState: row.conversation_state,
        reminderDueAt: row.reminder_due_at,
        lastClientResponseAt: row.last_client_response_at,
        completedAt: row.completed_at
      };
      return [row];
    }
    if (table === "observations") return [{ id: "ob1" }];
    if (table === "issues") {
      const bodies = Array.isArray(options.body) ? options.body : [options.body];
      return bodies.map((body, index) => ({ id: `issue${index + 1}`, ...body }));
    }
    if (table === "issue_events") return [{ id: `event${writes.filter((write) => write.table === "issue_events").length}` }];
    return [];
  };

  const allGood = await store.applyQuickCheckinResponse("s1", { outcome: "all_good" });
  assert.equal(allGood.session.status, "partial");
  assert.equal(allGood.session.conversationState.state, "quick_checkin_window");
  assert.equal(allGood.session.conversationState.quickCheckinOutcome, "all_good");
  assert.ok(Date.parse(allGood.session.conversationState.quickCheckinWindowExpiresAt) > Date.now());
  const originalWindowExpiry = allGood.session.conversationState.quickCheckinWindowExpiresAt;
  assert.equal(writes.some((write) => write.table === "issues"), false);

  writes.length = 0;
  const detailedFeedback = "The campaign is not attracting attention, the data has no applicant profiles, and we need more proactive ownership and course correction.";
  const shared = await store.applyQuickCheckinResponse("s1", {
    outcome: "feedback_shared",
    detail: detailedFeedback,
    interpretation: {
      sentiment: "negative",
      observations: [],
      captured: [],
      concerns: [
        {
          title: "Campaign traction below expectations",
          summary: "The campaign has attracted little attention and applicant numbers do not justify the additional spend.",
          sentiment: "negative", severity: "high", serviceKey: null, needsFollowUp: false
        },
        {
          title: "Applicant-profile reporting is missing",
          summary: "The shared data does not explain the profile of applicants who are signing on.",
          sentiment: "negative", severity: "watch", serviceKey: null, needsFollowUp: false
        },
        {
          title: "More proactive ownership is needed",
          summary: "The client expects SRV to analyse performance and change course when required.",
          sentiment: "negative", severity: "watch", serviceKey: null, needsFollowUp: false
        }
      ]
    }
  });
  assert.equal(shared.session.conversationState.quickCheckinOutcome, "feedback_shared");
  assert.equal(shared.session.status, "partial");
  assert.equal(shared.session.conversationState.state, "quick_checkin_window");
  assert.equal(shared.session.conversationState.quickCheckinWindowExpiresAt, originalWindowExpiry);
  assert.equal(writes.some((write) => write.table === "observations"), true);
  assert.equal(writes.some((write) => write.table === "issues"), true);
  const issueWrite = writes.find((write) => write.table === "issues");
  assert.equal(issueWrite.options.body.length, 3);
  assert.deepEqual(
    issueWrite.options.body.map((issue) => issue.title),
    [
      "Campaign traction below expectations",
      "Applicant-profile reporting is missing",
      "More proactive ownership is needed"
    ]
  );
  assert.equal(issueWrite.options.body.every((issue) => issue.root_cause.includes(detailedFeedback)), true);
  assert.equal(writes.filter((write) => write.table === "issue_events").length, 3);
  assert.equal(shared.issues.length, 3);

  console.log("Quick check-in scheduling and persistence smoke tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
