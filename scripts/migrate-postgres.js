const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { loadEnvFile } = require("../src/lib/env");

loadEnvFile(path.join(__dirname, "..", ".env"));

async function main() {
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is not configured");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      create table if not exists public.csat_schema_migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const directory = path.join(__dirname, "..", "database", "migrations");
    const filenames = fs.readdirSync(directory)
      .filter((filename) => /^\d+.*\.sql$/i.test(filename))
      .sort((left, right) => left.localeCompare(right));
    const result = await client.query("select filename, checksum from public.csat_schema_migrations");
    const applied = new Map(result.rows.map((row) => [row.filename, row.checksum]));

    for (const filename of filenames) {
      const sql = fs.readFileSync(path.join(directory, filename), "utf8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      if (applied.has(filename)) {
        if (applied.get(filename) !== checksum) {
          throw new Error(`Applied migration ${filename} has changed; add a new migration instead`);
        }
        console.log(`SKIP  ${filename}`);
        continue;
      }
      console.log(`APPLY ${filename}`);
      await client.query(sql);
      await client.query(
        "insert into public.csat_schema_migrations (filename, checksum) values ($1, $2)",
        [filename, checksum]
      );
    }
    console.log(`PostgreSQL migrations complete (${filenames.length} files).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
