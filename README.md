# SRV CSAT Command Centre — Replit migration

This folder is a standalone snapshot of the current CSAT application prepared
to become the root of a separate GitHub repository for Replit.

## Migration status

| Area | Status |
|---|---|
| Current React UI and API | Copied from the latest local working tree |
| Replit preview and production server | Added |
| Replit build/start configuration | Added |
| Current n8n workflows 01–12 | Copied into `n8n/workflows/` |
| PostgreSQL schema baseline | Added under `database/migrations/` |
| Direct Replit PostgreSQL store | **Not implemented yet** |
| Existing Supabase production data import | **Not performed yet** |

Do not switch the live WhatsApp webhook or publish this as the production CSAT
application yet. The copied application still uses `SupabaseStore`, which talks
to Supabase through PostgREST. The next migration phase must implement the same
store contract with direct PostgreSQL queries using Replit's `DATABASE_URL`.

## Repository layout

```text
src/                    React application, API handler and business rules
public/                 Static assets and import workbook
server.js               Replit production server (API + built React app)
server.local.js         Replit-compatible development server
.replit                 Preview and deployment commands
database/migrations/    PostgreSQL schema baseline and later migrations
n8n/workflows/          Current import-ready n8n workflows
scripts/                Tests, replays and maintenance utilities
docs/                   Existing architecture and operational documentation
```

## Replit commands

- Preview: `npm run dev`
- Production build: `npm run build`
- Production server: `npm start`
- Validation: `npm run check && npm test`

The production server listens on Replit's `PORT` and binds to `0.0.0.0`. It
serves `/api/*` through the existing API handler and all other routes through
the built React single-page application.

## Remaining work before production

1. Export and version the exact live Supabase schema. The local baseline does
   not include every field/table added during later development.
2. Add the PostgreSQL driver and implement `PostgresStore` for the full store
   contract used by `src/server/api-handler.js`.
3. Run the schema and seed/import scripts against the Replit development
   database and pass the complete automated test suite.
4. Import a final, consistent copy of existing Supabase data into Replit's
   production database during a short write freeze.
5. Set production secrets in Replit. Never commit `.env`.
6. Replace the placeholder Replit application URL in n8n, run WhatsApp sandbox
   tests, and activate workflows only after the end-to-end checks pass.

See `MIGRATION-STATUS.md` for the repository decision and cutover sequence.

