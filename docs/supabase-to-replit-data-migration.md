# Supabase to Replit data migration

This process copies only the CSAT application's tables in Supabase's `public`
schema. It does not copy Supabase Auth, Storage, extensions, system schemas, or
database roles. The Replit application uses its own password/session settings,
so those Supabase-managed objects are not needed.

## Safety built into the importer

- The source is read through a repeatable-read, read-only transaction.
- A preflight verifies every application table, column, and PostgreSQL type.
- `--check` never changes either database.
- Import requires the exact temporary confirmation secret
  `CONFIRM_REPLIT_DATA_REPLACE=YES`.
- Destination replacement and inserts occur in one transaction. Any error rolls
  the entire Replit change back.
- UUIDs, timestamps, JSON, arrays, and relationships are preserved.
- Foreign keys remain enabled, and every table's row count is verified before
  commit.
- `csat_schema_migrations` is neither cleared nor copied.

## One-time preparation

1. In Supabase, open **Project Settings > Database** (or **Connect**) and copy the
   **Shared Pooler / Session mode** PostgreSQL URI on port `5432`. This works
   from IPv4-only hosts. Do not use transaction mode on port `6543` for this
   migration.
2. In the Replit App, open **Tools > Secrets** and add:
   - `SOURCE_DATABASE_URL` = the Supabase session-mode URI
   - `CONFIRM_REPLIT_DATA_REPLACE` = leave absent for the first check
3. Keep Replit's existing `DATABASE_URL` unchanged. Never paste either database
   URL into chat, source code, Git, logs, or a screenshot.
4. In Replit Shell, make sure the latest code is present, then run:

   ```sh
   npm ci
   npm run db:migrate
   npm run db:import:check
   ```

The check prints Supabase and Replit row counts. If it reports a missing or
mismatched column, stop. Add a new tracked database migration, apply it, and run
the check again. Do not bypass the compatibility check.

## Final copy

Choose a quiet cutover window so no new WhatsApp replies are written while the
snapshot is being copied.

1. Pause the n8n workflows that start sessions, receive WhatsApp replies, close
   sessions, or otherwise write CSAT data.
2. Stop testing or editing data in both the old application and Replit preview.
3. Run `npm run db:import:check` again and save the displayed counts.
4. Add the Replit secret `CONFIRM_REPLIT_DATA_REPLACE` with the exact value
   `YES`.
5. Run:

   ```sh
   npm run db:import:supabase
   ```

   This deliberately clears the listed CSAT tables in Replit and replaces them
   with the Supabase snapshot. Existing Replit-only test rows will be removed.
6. Confirm the command ends with `IMPORT COMPLETE` and that every displayed row
   count matches.
7. Remove `SOURCE_DATABASE_URL` and `CONFIRM_REPLIT_DATA_REPLACE` from Replit
   Secrets immediately.
8. Restart the Replit App, open the dashboard/project workspace, and verify a
   few known clients, projects, POCs, historic sessions, messages, issues, and
   observations.
9. Point the duplicated/test n8n workflows to the Replit production URL and run
   one controlled WhatsApp end-to-end test before enabling live schedules and
   webhooks.

Keep the old Supabase project unchanged for a rollback period. Do not delete it
until the Replit deployment and n8n flows have been stable and reconciled.
