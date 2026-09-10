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
| Direct Replit PostgreSQL store | Implemented with parameterized queries |
| Existing Supabase production data import | **Not performed yet** |

Do not switch the live WhatsApp webhook or publish this as the production CSAT
application yet. First apply the tracked migrations to the Replit development
database, configure development secrets, and complete end-to-end testing.

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
- Database migration: `npm run db:migrate`
- Supabase import preflight (read-only): `npm run db:import:check`
- Supabase import (replaces Replit app data): `npm run db:import:supabase`

The production server listens on Replit's `PORT` and binds to `0.0.0.0`. It
serves `/api/*` through the existing API handler and all other routes through
the built React single-page application.

## Remaining work before production

1. Push this PostgreSQL adapter and the current migrations to the Replit GitHub
   repository, then pull/sync them into the imported Replit App.
2. Run `npm ci`, `npm run db:migrate`, `npm run check`, and `npm test` in Replit.
3. Configure development secrets and validate the preview with test data.
4. Import a final, consistent copy of existing Supabase data into Replit's
   production database during a short write freeze.
5. Set production secrets in Replit. Never commit `.env`.
6. Replace the placeholder Replit application URL in n8n, run WhatsApp sandbox
   tests, and activate workflows only after the end-to-end checks pass.

See `MIGRATION-STATUS.md` for the repository decision and cutover sequence.
See `docs/supabase-to-replit-data-migration.md` for the guarded production-data
copy procedure.
