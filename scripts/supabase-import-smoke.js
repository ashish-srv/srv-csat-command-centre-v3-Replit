const assert = require("node:assert/strict");
const {
  APP_TABLES,
  buildInsert,
  makeSchemaMap,
  normalizeValue,
  orderInternalPocs,
  parseMode,
  quoteIdentifier,
  sameDatabase,
  typesCompatible,
  validateCompatibility
} = require("./import-supabase-postgres");

function column(overrides = {}) {
  return {
    name: "id",
    position: 1,
    dataType: "uuid",
    udtName: "uuid",
    nullable: false,
    defaultValue: null,
    generated: false,
    identity: false,
    ...overrides
  };
}

assert.equal(quoteIdentifier('odd"name'), '"odd""name"');
assert.throws(() => quoteIdentifier(""), /Invalid PostgreSQL identifier/);
assert.equal(parseMode(["--check"]), "check");
assert.equal(parseMode(["--replace"]), "replace");
assert.throws(() => parseMode([]), /exactly one mode/);
assert.throws(() => parseMode(["--check", "--replace"]), /exactly one mode/);
assert.equal(typesCompatible("int4", "numeric"), true);
assert.equal(typesCompatible("numeric", "int4"), false);
assert.equal(typesCompatible("varchar", "text"), true);

assert.equal(normalizeValue(["one", "two"], column({ udtName: "jsonb" })), '["one","two"]');
assert.deepEqual(normalizeValue(["one", "two"], column({ udtName: "_text" })), ["one", "two"]);

const insert = buildInsert(
  "messages",
  [column(), column({ name: "metadata", position: 2, dataType: "jsonb", udtName: "jsonb" })],
  [
    { id: "first", metadata: { tone: "positive" } },
    { id: "second", metadata: [1, 2] }
  ]
);
assert.match(insert.text, /^insert into public\."messages"/);
assert.match(insert.text, /\(\$1, \$2\), \(\$3, \$4\)$/);
assert.deepEqual(insert.values, ["first", '{"tone":"positive"}', "second", "[1,2]"]);

assert.deepEqual(
  orderInternalPocs([
    { id: "employee", reporting_manager_id: "manager" },
    { id: "manager", reporting_manager_id: null }
  ]).map((row) => row.id),
  ["manager", "employee"]
);
assert.throws(
  () => orderInternalPocs([
    { id: "one", reporting_manager_id: "two" },
    { id: "two", reporting_manager_id: "one" }
  ]),
  /reporting-manager cycle/
);
assert.throws(
  () => orderInternalPocs([{ id: "one", reporting_manager_id: "missing" }]),
  /references missing manager/
);

const metadataRows = APP_TABLES.flatMap((table) => [
  {
    table_name: table,
    column_name: "id",
    ordinal_position: 1,
    data_type: "uuid",
    udt_name: "uuid",
    is_nullable: "NO",
    column_default: null,
    is_generated: "NEVER",
    is_identity: "NO"
  }
]);
const compatibleSource = makeSchemaMap(metadataRows);
const compatibleDestination = makeSchemaMap(metadataRows);
assert.deepEqual(validateCompatibility(compatibleSource, compatibleDestination), []);

const missingColumnDestination = makeSchemaMap(
  metadataRows.filter((row) => row.table_name !== "messages")
);
assert.match(
  validateCompatibility(compatibleSource, missingColumnDestination).join("\n"),
  /Destination is missing public\.messages/
);

const incompatibleRows = metadataRows.map((row) =>
  row.table_name === "clients" ? { ...row, udt_name: "text", data_type: "text" } : row
);
assert.match(
  validateCompatibility(compatibleSource, makeSchemaMap(incompatibleRows)).join("\n"),
  /Type mismatch for public\.clients\.id/
);

assert.equal(
  sameDatabase(
    { database_name: "postgres", server_address: "10.0.0.1", server_port: 5432 },
    { database_name: "postgres", server_address: "10.0.0.1", server_port: "5432" }
  ),
  true
);
assert.equal(
  sameDatabase(
    { database_name: "postgres", server_address: "10.0.0.1", server_port: 5432 },
    { database_name: "postgres", server_address: "10.0.0.2", server_port: 5432 }
  ),
  false
);

console.log("Supabase import guardrail smoke tests passed.");
