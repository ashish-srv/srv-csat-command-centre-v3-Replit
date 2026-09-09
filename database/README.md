# Database migration

These files are a PostgreSQL starting point, not yet a certified export of the
live CSAT database.

## Included migrations

1. `001-schema-v2.sql` — original v2 schema recovered from the local Downloads
   folder.
2. `002-guardrail-hardening.sql` — unique Meta message IDs, automation-event
   deduplication and one issue per session/service.
3. `003-allow-poc-phone-on-multiple-projects.sql` — permits one client contact
   number across several projects belonging to the same client.
4. `004-client-poc-individual-weights.sql` — adds direct per-POC percentage
   weighting and safely backfills existing active POCs.
5. `005-client-poc-birthdate.sql` — adds the optional birthday field used by
   current POC management and workbook imports.
6. `006-current-application-schema.sql` — adds analysis/prediction fields, the
   observations table and the two required POC tags.

Run all tracked migrations in order with `npm run db:migrate`. The runner records
checksums in `csat_schema_migrations` and refuses to accept an edited migration
that was already applied.

Before importing historical production data, compare the exported Supabase
schema and row counts with this schema. Do not run a production cutover until
that reconciliation is complete.

Keep schema migrations in this directory under version control. Keep real
client/POC rows and database dumps outside Git because they contain production
and personal data.
