const path = require("node:path");
const { Client } = require("pg");
const { loadEnvFile } = require("../src/lib/env");

loadEnvFile(path.join(__dirname, "..", ".env"));

const APP_TABLES = [
  "clusters",
  "departments",
  "poc_levels",
  "sub_departments",
  "internal_pocs",
  "clients",
  "projects",
  "client_pocs",
  "project_services",
  "feedback_cycles",
  "feedback_sessions",
  "messages",
  "service_feedback",
  "observations",
  "issues",
  "issue_events",
  "automation_events"
];

const JSON_TYPES = new Set(["json", "jsonb"]);
const BATCH_SIZE = 200;

function quoteIdentifier(value) {
  if (typeof value !== "string" || !value) throw new Error("Invalid PostgreSQL identifier");
  return `"${value.replaceAll('"', '""')}"`;
}

function makeSchemaMap(rows) {
  const tables = new Map();
  for (const row of rows) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, []);
    tables.get(row.table_name).push({
      name: row.column_name,
      position: Number(row.ordinal_position),
      dataType: row.data_type,
      udtName: row.udt_name,
      nullable: row.is_nullable === "YES",
      defaultValue: row.column_default,
      generated: row.is_generated !== "NEVER",
      identity: row.is_identity === "YES"
    });
  }
  for (const columns of tables.values()) {
    columns.sort((left, right) => left.position - right.position);
  }
  return tables;
}

function typesCompatible(sourceType, destinationType) {
  if (sourceType === destinationType) return true;
  const safeWidenings = {
    int2: new Set(["int4", "int8", "numeric"]),
    int4: new Set(["int8", "numeric"]),
    int8: new Set(["numeric"]),
    float4: new Set(["float8"]),
    varchar: new Set(["text"]),
    bpchar: new Set(["text"])
  };
  return safeWidenings[sourceType]?.has(destinationType) || false;
}

function validateCompatibility(sourceSchema, destinationSchema) {
  const errors = [];

  for (const table of APP_TABLES) {
    const sourceColumns = sourceSchema.get(table);
    const destinationColumns = destinationSchema.get(table);
    if (!sourceColumns) {
      errors.push(`Source is missing public.${table}`);
      continue;
    }
    if (!destinationColumns) {
      errors.push(`Destination is missing public.${table}; run npm run db:migrate first`);
      continue;
    }

    const destinationByName = new Map(destinationColumns.map((column) => [column.name, column]));
    for (const sourceColumn of sourceColumns.filter((column) => !column.generated && !column.identity)) {
      const destinationColumn = destinationByName.get(sourceColumn.name);
      if (!destinationColumn) {
        const nullable = sourceColumn.nullable ? "nullable" : "not null";
        errors.push(
          `Destination is missing public.${table}.${sourceColumn.name} ` +
          `(source type ${sourceColumn.udtName}, ${nullable})`
        );
        continue;
      }
      if (destinationColumn.generated || destinationColumn.identity) {
        errors.push(`Destination cannot preserve public.${table}.${sourceColumn.name} because it is generated`);
        continue;
      }
      if (!typesCompatible(sourceColumn.udtName, destinationColumn.udtName)) {
        errors.push(
          `Type mismatch for public.${table}.${sourceColumn.name}: ` +
          `source ${sourceColumn.udtName}, destination ${destinationColumn.udtName}`
        );
      }
    }

    const sourceNames = new Set(sourceColumns.map((column) => column.name));
    for (const destinationColumn of destinationColumns) {
      const canUseDefault = destinationColumn.defaultValue !== null || destinationColumn.identity || destinationColumn.generated;
      if (!sourceNames.has(destinationColumn.name) && !destinationColumn.nullable && !canUseDefault) {
        errors.push(
          `Source has no value for required destination column public.${table}.${destinationColumn.name}`
        );
      }
    }
  }

  return errors;
}

function normalizeValue(value, column) {
  if (value === undefined || value === null) return null;
  if (JSON_TYPES.has(column.udtName) && typeof value !== "string") return JSON.stringify(value);
  return value;
}

function buildInsert(table, columns, rows) {
  if (!rows.length) return null;
  const parameters = [];
  let parameterIndex = 1;
  const valuesSql = rows.map((row) => {
    const placeholders = columns.map((column) => {
      parameters.push(normalizeValue(row[column.name], column));
      return `$${parameterIndex++}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const columnSql = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  return {
    text: `insert into public.${quoteIdentifier(table)} (${columnSql}) values ${valuesSql.join(", ")}`,
    values: parameters
  };
}

async function readSchema(client) {
  const result = await client.query(
    `select table_name, column_name, ordinal_position, data_type, udt_name,
            is_nullable, column_default, is_generated, is_identity
       from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name, ordinal_position`,
    [APP_TABLES]
  );
  return makeSchemaMap(result.rows);
}

async function readCounts(client) {
  const counts = new Map();
  for (const table of APP_TABLES) {
    const result = await client.query(`select count(*)::bigint as count from public.${quoteIdentifier(table)}`);
    counts.set(table, Number(result.rows[0].count));
  }
  return counts;
}

async function readDatabaseIdentity(client) {
  const result = await client.query(
    `select current_database() as database_name,
            coalesce(inet_server_addr()::text, 'local') as server_address,
            coalesce(inet_server_port(), 0) as server_port`
  );
  return result.rows[0];
}

function sameDatabase(left, right) {
  return left.database_name === right.database_name &&
    left.server_address === right.server_address &&
    Number(left.server_port) === Number(right.server_port);
}

function printCounts(sourceCounts, destinationCounts, label = "Before import") {
  console.log(`\n${label}:`);
  console.log("Table                         Supabase       Replit");
  console.log("---------------------------------------------------");
  for (const table of APP_TABLES) {
    console.log(
      `${table.padEnd(29)}${String(sourceCounts.get(table)).padStart(10)}${String(destinationCounts.get(table)).padStart(13)}`
    );
  }
}

async function readSourceRows(client, sourceSchema) {
  const data = new Map();
  for (const table of APP_TABLES) {
    const columns = sourceSchema.get(table).filter((column) => !column.generated && !column.identity);
    const columnSql = columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const orderColumn = columns.some((column) => column.name === "id") ? " order by id" : "";
    const result = await client.query(
      `select ${columnSql} from public.${quoteIdentifier(table)}${orderColumn}`
    );
    data.set(table, result.rows);
    console.log(`READ  public.${table}: ${result.rowCount} rows`);
  }
  return data;
}

async function insertRows(client, table, columns, rows) {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const query = buildInsert(table, columns, rows.slice(offset, offset + BATCH_SIZE));
    if (query) await client.query(query);
  }
}

function orderInternalPocs(rows) {
  const knownIds = new Set(rows.map((row) => row.id));
  const insertedIds = new Set();
  const remaining = [...rows];
  const ordered = [];

  while (remaining.length) {
    const ready = remaining.filter(
      (row) => !row.reporting_manager_id || insertedIds.has(row.reporting_manager_id)
    );
    if (!ready.length) {
      const brokenReference = remaining.find(
        (row) => row.reporting_manager_id && !knownIds.has(row.reporting_manager_id)
      );
      if (brokenReference) {
        throw new Error(
          `internal_pocs ${brokenReference.id} references missing manager ${brokenReference.reporting_manager_id}`
        );
      }
      throw new Error("internal_pocs contains a reporting-manager cycle that cannot be imported safely");
    }
    for (const row of ready) {
      ordered.push(row);
      insertedIds.add(row.id);
      remaining.splice(remaining.indexOf(row), 1);
    }
  }

  return ordered;
}

async function replaceDestination(client, destinationSchema, data) {
  const tableSql = APP_TABLES.map((table) => `public.${quoteIdentifier(table)}`).join(", ");
  await client.query(`truncate table ${tableSql} restart identity restrict`);

  for (const table of APP_TABLES) {
    const sourceRows = data.get(table);
    const destinationColumnsByName = new Map(
      destinationSchema.get(table).map((column) => [column.name, column])
    );
    const sourceColumnNames = sourceRows.length
      ? Object.keys(sourceRows[0])
      : [];
    const columns = sourceColumnNames.map((name) => destinationColumnsByName.get(name));
    const rows = table === "internal_pocs" ? orderInternalPocs(sourceRows) : sourceRows;
    await insertRows(client, table, columns, rows);
    console.log(`WRITE public.${table}: ${rows.length} rows`);
  }

  // service_catalog is a Replit-side reference table and therefore is not
  // copied from the old Supabase database. Rebuild/link it after every replace
  // import so project services remain selectable in Manage.
  if (destinationSchema.has("service_catalog")) {
    await client.query(
      `insert into public.service_catalog (service_key, name, active)
       select distinct on (service_key) service_key, name, true
         from public.project_services
        where nullif(trim(service_key), '') is not null
          and nullif(trim(name), '') is not null
        order by service_key, created_at asc
       on conflict do nothing`
    );
    await client.query(
      `update public.project_services ps
          set service_catalog_id = catalog.id
         from public.service_catalog catalog
        where ps.service_catalog_id is null
          and catalog.service_key = ps.service_key`
    );
  }
}

function parseMode(argv) {
  const hasCheck = argv.includes("--check");
  const hasReplace = argv.includes("--replace");
  if (hasCheck === hasReplace) {
    throw new Error("Choose exactly one mode: --check or --replace");
  }
  return hasReplace ? "replace" : "check";
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const sourceConnectionString = String(process.env.SOURCE_DATABASE_URL || "").trim();
  const destinationConnectionString = String(process.env.DATABASE_URL || "").trim();
  if (!sourceConnectionString) throw new Error("SOURCE_DATABASE_URL is not configured");
  if (!destinationConnectionString) throw new Error("DATABASE_URL is not configured");
  if (sourceConnectionString === destinationConnectionString) {
    throw new Error("SOURCE_DATABASE_URL and DATABASE_URL must be different databases");
  }
  if (mode === "replace" && process.env.CONFIRM_REPLIT_DATA_REPLACE !== "YES") {
    throw new Error("Set temporary secret CONFIRM_REPLIT_DATA_REPLACE=YES before using --replace");
  }

  const source = new Client({ connectionString: sourceConnectionString, application_name: "csat_supabase_export" });
  const destination = new Client({ connectionString: destinationConnectionString, application_name: "csat_replit_import" });
  let sourceTransaction = false;
  let destinationTransaction = false;

  try {
    await Promise.all([source.connect(), destination.connect()]);
    const [sourceIdentity, destinationIdentity] = await Promise.all([
      readDatabaseIdentity(source),
      readDatabaseIdentity(destination)
    ]);
    if (sameDatabase(sourceIdentity, destinationIdentity)) {
      throw new Error("Safety check failed: source and destination resolve to the same PostgreSQL database");
    }

    await source.query("begin transaction isolation level repeatable read read only");
    sourceTransaction = true;

    const [sourceSchema, destinationSchema] = await Promise.all([
      readSchema(source),
      readSchema(destination)
    ]);
    const compatibilityErrors = validateCompatibility(sourceSchema, destinationSchema);
    if (compatibilityErrors.length) {
      throw new Error(`Schema compatibility check failed:\n- ${compatibilityErrors.join("\n- ")}`);
    }

    const [sourceCounts, destinationCounts] = await Promise.all([
      readCounts(source),
      readCounts(destination)
    ]);
    printCounts(sourceCounts, destinationCounts);

    if (mode === "check") {
      await source.query("commit");
      sourceTransaction = false;
      console.log("\nCHECK PASSED. No data was changed.");
      return;
    }

    console.log("\nLoading a consistent Supabase snapshot...");
    const data = await readSourceRows(source, sourceSchema);

    await destination.query("begin");
    destinationTransaction = true;
    await replaceDestination(destination, destinationSchema, data);

    const importedCounts = await readCounts(destination);
    const countErrors = APP_TABLES
      .filter((table) => importedCounts.get(table) !== sourceCounts.get(table))
      .map(
        (table) => `${table}: source ${sourceCounts.get(table)}, destination ${importedCounts.get(table)}`
      );
    if (countErrors.length) {
      throw new Error(`Row-count verification failed:\n- ${countErrors.join("\n- ")}`);
    }

    await source.query("commit");
    sourceTransaction = false;
    await destination.query("commit");
    destinationTransaction = false;
    printCounts(sourceCounts, importedCounts, "Verified after import");
    console.log("\nIMPORT COMPLETE. Every application table matched its Supabase row count.");
  } catch (error) {
    if (destinationTransaction) await destination.query("rollback").catch(() => {});
    if (sourceTransaction) await source.query("rollback").catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled([source.end(), destination.end()]);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
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
};
