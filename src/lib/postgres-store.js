const { Pool } = require("pg");
const { SupabaseStore } = require("./supabase-store");

const TABLES = new Set([
  "automation_events", "client_pocs", "clients", "clusters", "departments",
  "feedback_cycles", "feedback_sessions", "internal_pocs", "issue_events",
  "issues", "messages", "observations", "poc_levels", "project_services",
  "projects", "service_feedback", "sub_departments"
]);

const JSON_COLUMNS = {
  automation_events: new Set(["payload"]),
  feedback_sessions: new Set(["conversation_state", "predicted_signals"]),
  messages: new Set(["metadata"])
};

// Many-to-one relationships embedded by the existing store's PostgREST
// selects. Returning the same row shape lets the tested domain methods run
// unchanged on direct PostgreSQL.
const RELATIONS = {
  clients: {
    clusters: { table: "clusters", localKey: "cluster_id", foreignKey: "id" }
  },
  projects: {
    clients: { table: "clients", localKey: "client_id", foreignKey: "id" }
  },
  client_pocs: {
    projects: { table: "projects", localKey: "project_id", foreignKey: "id" }
  },
  feedback_sessions: {
    client_pocs: { table: "client_pocs", localKey: "client_poc_id", foreignKey: "id" },
    feedback_cycles: { table: "feedback_cycles", localKey: "cycle_id", foreignKey: "id" },
    projects: { table: "projects", localKey: "project_id", foreignKey: "id" }
  },
  service_feedback: {
    feedback_sessions: { table: "feedback_sessions", localKey: "session_id", foreignKey: "id" }
  },
  issues: {
    client_pocs: { table: "client_pocs", localKey: "client_poc_id", foreignKey: "id" }
  }
};

const CONTROL_PARAMETERS = new Set(["limit", "offset", "on_conflict", "order", "select"]);
let sharedPool = null;

function databaseUrl() {
  const value = String(process.env.DATABASE_URL || "").trim();
  if (!value) throw new Error("DATABASE_URL is required when DATA_PROVIDER=postgres");
  return value;
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(String(value || ""))) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function assertTable(table) {
  if (!TABLES.has(table)) throw new Error(`Unsupported PostgreSQL table: ${table}`);
  return table;
}

function getSharedPool() {
  if (sharedPool) return sharedPool;
  sharedPool = new Pool({
    connectionString: databaseUrl(),
    max: Math.max(1, Number(process.env.POSTGRES_POOL_MAX) || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  sharedPool.on("error", (error) => {
    console.error("[postgres] idle client error:", error.message);
  });
  return sharedPool;
}

function splitTopLevel(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function relationSelections(select) {
  if (!select) return [];
  return splitTopLevel(select).flatMap((part) => {
    const open = part.indexOf("(");
    if (open < 1 || !part.endsWith(")")) return [];
    const head = part.slice(0, open).trim();
    const [alias, source] = head.includes(":") ? head.split(":", 2) : [head, head];
    identifier(alias);
    identifier(source);
    return [{ alias, source, select: part.slice(open + 1, -1) }];
  });
}

function storedValue(table, column, value) {
  if (value === undefined) return null;
  if (value !== null && JSON_COLUMNS[table]?.has(column)) return JSON.stringify(value);
  return value;
}

function filterSql(params, values, alias = "t") {
  const clauses = [];
  for (const [column, expression] of params.entries()) {
    if (CONTROL_PARAMETERS.has(column)) continue;
    identifier(column);
    const separator = expression.indexOf(".");
    if (separator < 1) throw new Error(`Unsupported PostgreSQL filter: ${column}=${expression}`);
    const operator = expression.slice(0, separator);
    const raw = expression.slice(separator + 1);
    const qualified = `${alias}.${identifier(column)}`;

    if (operator === "is") {
      if (raw === "null") clauses.push(`${qualified} IS NULL`);
      else if (raw === "true") clauses.push(`${qualified} IS TRUE`);
      else if (raw === "false") clauses.push(`${qualified} IS FALSE`);
      else throw new Error(`Unsupported PostgreSQL is filter: ${raw}`);
      continue;
    }

    if (operator === "in") {
      if (!raw.startsWith("(") || !raw.endsWith(")")) {
        throw new Error(`Unsupported PostgreSQL in filter: ${raw}`);
      }
      const items = splitTopLevel(raw.slice(1, -1));
      if (!items.length) {
        clauses.push("FALSE");
        continue;
      }
      const placeholders = items.map((item) => {
        values.push(item);
        return `$${values.length}`;
      });
      clauses.push(`${qualified} IN (${placeholders.join(", ")})`);
      continue;
    }

    const sqlOperators = {
      eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=",
      like: "LIKE", ilike: "ILIKE"
    };
    const sqlOperator = sqlOperators[operator];
    if (!sqlOperator) throw new Error(`Unsupported PostgreSQL filter operator: ${operator}`);
    values.push(["like", "ilike"].includes(operator) ? raw.replace(/\*/g, "%") : raw);
    clauses.push(`${qualified} ${sqlOperator} $${values.length}`);
  }
  return clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
}

function orderSql(value, alias = "t") {
  if (!value) return "";
  const orders = splitTopLevel(value).map((item) => {
    const [column, direction = "asc", nulls] = item.split(".");
    identifier(column);
    if (!/^(asc|desc)$/i.test(direction)) throw new Error(`Unsupported PostgreSQL order: ${item}`);
    let sql = `${alias}.${identifier(column)} ${direction.toUpperCase()}`;
    if (nulls) {
      if (!/^(nullsfirst|nullslast)$/i.test(nulls)) throw new Error(`Unsupported PostgreSQL order: ${item}`);
      sql += nulls.toLowerCase() === "nullsfirst" ? " NULLS FIRST" : " NULLS LAST";
    }
    return sql;
  });
  return orders.length ? ` ORDER BY ${orders.join(", ")}` : "";
}

function pageSql(params, values) {
  let sql = "";
  if (params.has("limit")) {
    const limit = Number(params.get("limit"));
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid PostgreSQL limit");
    values.push(limit);
    sql += ` LIMIT $${values.length}`;
  }
  if (params.has("offset")) {
    const offset = Number(params.get("offset"));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid PostgreSQL offset");
    values.push(offset);
    sql += ` OFFSET $${values.length}`;
  }
  return sql;
}

class PostgresStore extends SupabaseStore {
  constructor(options = {}) {
    super({ skipEnv: true });
    this.pool = options.pool || getSharedPool();
  }

  async hydrateRelations(table, rows, select) {
    const selections = relationSelections(select);
    if (!rows.length || !selections.length) return rows;

    for (const selection of selections) {
      const relation = RELATIONS[table]?.[selection.source];
      if (!relation) throw new Error(`Unsupported PostgreSQL relationship: ${table}.${selection.source}`);
      const keys = [...new Set(rows.map((row) => row[relation.localKey]).filter(Boolean))];
      if (!keys.length) {
        for (const row of rows) row[selection.alias] = null;
        continue;
      }
      const values = [...keys];
      const placeholders = values.map((_, index) => `$${index + 1}`);
      const result = await this.pool.query(
        `SELECT r.* FROM public.${identifier(relation.table)} AS r WHERE r.${identifier(relation.foreignKey)} IN (${placeholders.join(", ")})`,
        values
      );
      await this.hydrateRelations(relation.table, result.rows, selection.select);
      const byKey = new Map(result.rows.map((row) => [String(row[relation.foreignKey]), row]));
      for (const row of rows) row[selection.alias] = byKey.get(String(row[relation.localKey])) || null;
    }
    return rows;
  }

  async select(table, params) {
    const values = [];
    const sql = [
      `SELECT t.* FROM public.${identifier(table)} AS t`,
      filterSql(params, values),
      orderSql(params.get("order")),
      pageSql(params, values)
    ].join("");
    const result = await this.pool.query(sql, values);
    return this.hydrateRelations(table, result.rows, params.get("select"));
  }

  async insert(table, params, options) {
    const records = Array.isArray(options.body) ? options.body : [options.body];
    if (!records.length || !records[0]) return [];
    const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
    columns.forEach(identifier);
    if (!columns.length && records.length > 1) throw new Error("Bulk DEFAULT VALUES inserts are unsupported");

    const values = [];
    const groups = records.map((record) => {
      if (!columns.length) return "DEFAULT VALUES";
      const cells = columns.map((column) => {
        if (!Object.prototype.hasOwnProperty.call(record, column)) return "DEFAULT";
        values.push(storedValue(table, column, record[column]));
        return `$${values.length}`;
      });
      return `(${cells.join(", ")})`;
    });

    let sql = columns.length
      ? `INSERT INTO public.${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES ${groups.join(", ")}`
      : `INSERT INTO public.${identifier(table)} DEFAULT VALUES`;
    const ignoreDuplicates = String(options.prefer || "").includes("resolution=ignore-duplicates");
    if (ignoreDuplicates) {
      const conflictColumns = splitTopLevel(params.get("on_conflict") || "");
      if (!conflictColumns.length) throw new Error("PostgreSQL conflict columns are required");
      conflictColumns.forEach(identifier);
      sql += ` ON CONFLICT (${conflictColumns.map(identifier).join(", ")}) DO NOTHING`;
    }
    sql += " RETURNING *";
    const result = await this.pool.query(sql, values);
    return this.hydrateRelations(table, result.rows, params.get("select"));
  }

  async update(table, params, options) {
    const body = options.body || {};
    const columns = Object.keys(body);
    if (!columns.length) return [];
    const values = [];
    const assignments = columns.map((column) => {
      identifier(column);
      values.push(storedValue(table, column, body[column]));
      return `${identifier(column)} = $${values.length}`;
    });
    const where = filterSql(params, values);
    if (!where) throw new Error(`Refusing to update every row in ${table}`);
    const result = await this.pool.query(
      `UPDATE public.${identifier(table)} AS t SET ${assignments.join(", ")}${where} RETURNING t.*`,
      values
    );
    return this.hydrateRelations(table, result.rows, params.get("select"));
  }

  async delete(table, params) {
    const values = [];
    const where = filterSql(params, values);
    if (!where) throw new Error(`Refusing to delete every row in ${table}`);
    const result = await this.pool.query(
      `DELETE FROM public.${identifier(table)} AS t${where} RETURNING t.*`,
      values
    );
    return this.hydrateRelations(table, result.rows, params.get("select"));
  }

  async request(tableName, options = {}) {
    const table = assertTable(tableName);
    const params = new URLSearchParams(options.query || "");
    const method = String(options.method || "GET").toUpperCase();
    try {
      if (method === "GET") return await this.select(table, params);
      if (method === "POST") return await this.insert(table, params, options);
      if (method === "PATCH") return await this.update(table, params, options);
      if (method === "DELETE") return await this.delete(table, params);
      throw new Error(`Unsupported PostgreSQL request method: ${method}`);
    } catch (error) {
      const details = [error.code, error.constraint, error.detail].filter(Boolean).join(" ");
      throw new Error(`PostgreSQL ${method} ${table} failed: ${error.message}${details ? ` (${details})` : ""}`);
    }
  }
}

module.exports = { PostgresStore, relationSelections, splitTopLevel };
