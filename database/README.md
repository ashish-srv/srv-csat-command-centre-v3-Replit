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

The application has evolved after the original v2 schema was created. Before
running migrations against Replit production, export the exact current
Supabase schema and reconcile later additions such as prediction fields,
observations, appreciations, session-closing fields and automation metadata.

Keep schema migrations in this directory under version control. Keep real
client/POC rows and database dumps outside Git because they contain production
and personal data.
