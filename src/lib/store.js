const { SupabaseStore } = require("./supabase-store");

// v2 runs against the project/POC/cycle schema. The old in-memory LocalStore
// spoke the v1 "client" model and was never migrated, so rather than let it
// half-work and produce wrong data, it fails loudly.
function createStore() {
  const provider = (process.env.DATA_PROVIDER || "supabase").toLowerCase();
  if (provider === "supabase") return new SupabaseStore();
  throw new Error(
    `DATA_PROVIDER=${provider} is not supported in v2. The local/in-memory store was retired with the v1 client schema. Set DATA_PROVIDER=supabase.`
  );
}

module.exports = { createStore };
