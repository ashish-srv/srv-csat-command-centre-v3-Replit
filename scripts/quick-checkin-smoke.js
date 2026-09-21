const assert = require("node:assert/strict");
const { SupabaseStore, quickCheckinScheduleKey } = require("../src/lib/supabase-store");

assert.equal(quickCheckinScheduleKey("2026-10-10T18:30:00.000Z"), "2026-10-11");
assert.equal(quickCheckinScheduleKey("2026-10-21T04:30:00.000Z"), "2026-10-21");
assert.equal(quickCheckinScheduleKey("2026-10-20T12:00:00.000Z"), null);
assert.equal(quickCheckinScheduleKey("not-a-date"), null);

async function run() {
  const scheduler = new SupabaseStore({ skipEnv: true });
  scheduler.listProjects = async () => [
    { id: "p1", key: "active", activeStatus: "active", clientActiveStatus: "active" },
    { id: "p2", key: "already-sent", activeStatus: "active", clientActiveStatus: "active" },
    { id: "p3", key: "paused", activeStatus: "paused", clientActiveStatus: "active" },
    { id: "p4", key: "inactive-client", activeStatus: "active", clientActiveStatus: "inactive" }
  ];
  scheduler.hasScheduledQuickCheckin = async (projectId) => projectId === "p2";
  const due = await scheduler.getDueQuickCheckinTargets("2026-10-11T04:30:00.000Z");
  assert.equal(due.scheduleKey, "2026-10-11");
  assert.deepEqual(due.targets, [{ projectKey: "active", cycleType: "quick_checkin", scheduleKey: "2026-10-11" }]);

  const store = new SupabaseStore({ skipEnv: true });
  store.getSession = async () => ({
    id: "s1", cycleId: "c1", clientPocId: "poc1", projectId: "project1",
    sessionType: "quick_checkin", status: "started", reminderDueAt: "2026-10-13T04:30:00.000Z",
    conversationState: { state: "quick_checkin_choice", quickCheckinOutcome: "awaiting_response" }
  });
  store.servicesForProject = async () => [];
  store.recomputeCycle = async () => null;
  const writes = [];
  store.request = async (table, options = {}) => {
    writes.push({ table, options });
    if (table === "feedback_sessions") {
      return [{
        id: "s1", cycle_id: "c1", client_poc_id: "poc1", project_id: "project1",
        status: options.body.status, completion_status: options.body.completion_status,
        conversation_state: options.body.conversation_state, reminder_due_at: options.body.reminder_due_at,
        last_client_response_at: options.body.last_client_response_at, completed_at: options.body.completed_at
      }];
    }
    if (table === "observations") return [{ id: "ob1" }];
    if (table === "issues") return [{ id: "issue1" }];
    if (table === "issue_events") return [{ id: "event1" }];
    return [];
  };

  const allGood = await store.applyQuickCheckinResponse("s1", { outcome: "all_good" });
  assert.equal(allGood.session.status, "completed");
  assert.equal(allGood.session.conversationState.quickCheckinOutcome, "all_good");
  assert.equal(writes.some((write) => write.table === "issues"), false);

  writes.length = 0;
  const shared = await store.applyQuickCheckinResponse("s1", {
    outcome: "feedback_shared",
    detail: "The weekly report is delayed.",
    interpretation: { sentiment: "negative", observations: [], captured: [] }
  });
  assert.equal(shared.session.conversationState.quickCheckinOutcome, "feedback_shared");
  assert.equal(writes.some((write) => write.table === "observations"), true);
  assert.equal(writes.some((write) => write.table === "issues"), true);

  console.log("Quick check-in scheduling and persistence smoke tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
