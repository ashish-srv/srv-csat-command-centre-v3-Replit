const { SupabaseStore } = require("./supabase-store");
const { PostgresStore } = require("./postgres-store");

// v2 runs against the project/POC/cycle schema. The old in-memory LocalStore
// spoke the v1 "client" model and was never migrated, so rather than let it
// half-work and produce wrong data, it fails loudly.
function createStore() {
  const provider = (process.env.DATA_PROVIDER || "postgres").toLowerCase();
  if (provider === "postgres" || provider === "postgresql" || provider === "replit") {
    return new PostgresStore();
  }
  if (provider === "supabase") return new SupabaseStore();
  throw new Error(
    `DATA_PROVIDER=${provider} is not supported. Set DATA_PROVIDER=postgres for Replit.`
  );
}

module.exports = { createStore };
