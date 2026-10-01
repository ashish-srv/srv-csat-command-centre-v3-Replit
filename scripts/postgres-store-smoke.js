const assert = require("node:assert");
const { PostgresStore, relationSelections, splitTopLevel } = require("../src/lib/postgres-store");

class FakePool {
  constructor(results) {
    this.results = [...results];
    this.calls = [];
  }

  async query(sql, values = []) {
    this.calls.push({ sql, values });
    return { rows: this.results.shift() || [] };
  }
}

async function main() {
  assert.deepStrictEqual(splitTopLevel("*,clients(id,clusters(id,name)),status"), [
    "*", "clients(id,clusters(id,name))", "status"
  ]);
  assert.deepStrictEqual(relationSelections("*,clients(id,name)"), [
    { alias: "clients", source: "clients", select: "id,name" }
  ]);

  const pool = new FakePool([
    [{ id: "project-1", client_id: "client-1", name: "Project" }],
    [{ id: "client-1", cluster_id: "cluster-1", name: "Client" }],
    [{ id: "cluster-1", name: "Cluster" }]
  ]);
  const store = new PostgresStore({ pool });
  const rows = await store.request("projects", {
    query: "id=eq.project-1&active_status=neq.paused&select=*,clients(id,name,clusters(id,name))&order=name.desc&limit=1"
  });
  assert.strictEqual(rows[0].clients.name, "Client");
  assert.strictEqual(rows[0].clients.clusters.name, "Cluster");
  assert.match(pool.calls[0].sql, /WHERE t\."id" = \$1 AND t\."active_status" <> \$2/);
  assert.match(pool.calls[0].sql, /ORDER BY t\."name" DESC LIMIT \$3/);
  assert.deepStrictEqual(pool.calls[0].values, ["project-1", "paused", 1]);

  const insertPool = new FakePool([[]]);
  const insertStore = new PostgresStore({ pool: insertPool });
  await insertStore.request("messages", {
    method: "POST",
    query: "on_conflict=provider_message_id",
    prefer: "resolution=ignore-duplicates,return=representation",
    body: [{ session_id: "session-1", body: "Hello", metadata: { source: "test" } }]
  });
  assert.match(insertPool.calls[0].sql, /ON CONFLICT \("provider_message_id"\) DO NOTHING RETURNING \*/);
  assert.strictEqual(insertPool.calls[0].values[2], JSON.stringify({ source: "test" }));

  const updatePool = new FakePool([[{ id: "session-1" }]]);
  const updateStore = new PostgresStore({ pool: updatePool });
  await updateStore.request("feedback_sessions", {
    method: "PATCH",
    query: "id=eq.session-1",
    body: { conversation_state: { state: "completed" }, reminder_count: 2 }
  });
  assert.deepStrictEqual(updatePool.calls[0].values, [
    JSON.stringify({ state: "completed" }), 2, "session-1"
  ]);

  const deletePool = new FakePool([[{ id: "message-1" }]]);
  const deleteStore = new PostgresStore({ pool: deletePool });
  const deleted = await deleteStore.request("messages", {
    method: "DELETE", query: "session_id=in.(session-1,session-2)"
  });
  assert.strictEqual(deleted.length, 1);
  assert.match(deletePool.calls[0].sql, /IN \(\$1, \$2\) RETURNING t\.\*/);

  const finalSweepPool = new FakePool([
    [{
      id: "session-final", cycle_id: "cycle-final", project_id: "project-1",
      client_poc_id: "poc-1", status: "partial", completion_status: "partial",
      conversation_state: { pendingQuestionType: "final_sweep" },
      last_client_response_at: "2026-10-01T00:00:00.000Z"
    }],
    [{ id: "cycle-final", cycle_type: "pulse" }]
  ]);
  const finalSweepStore = new PostgresStore({ pool: finalSweepPool });
  const finalSweepSessions = await finalSweepStore.getInactiveFinalSweepCandidates(
    "2026-10-01T07:00:00.000Z"
  );
  assert.strictEqual(finalSweepSessions.length, 1);
  assert.strictEqual(finalSweepSessions[0].sessionType, "pulse");
  assert.match(finalSweepPool.calls[0].sql, /t\."status" IN \(\$1, \$2, \$3, \$4\)/);
  assert.match(finalSweepPool.calls[0].sql, /t\."last_client_response_at" <= \$5/);
  assert.deepStrictEqual(finalSweepPool.calls[0].values, [
    "started", "partial", "no_response", "needs_attention",
    "2026-10-01T01:00:00.000Z", 1000
  ]);

  console.log("PostgreSQL adapter smoke tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
