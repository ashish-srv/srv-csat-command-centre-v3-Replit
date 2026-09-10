# Replit repository and cutover plan

## Repository decision

Use a new GitHub repository for this folder, for example
`srv-csat-command-centre-replit`.

The existing repository should remain the rollback source for the current
Netlify/Supabase deployment until the Replit version has passed production-like
testing. This avoids mixing two hosting adapters and two database providers in
one deployment branch while the database layer is being rewritten.

After cutover, choose one repository as the canonical development source. Do
not maintain two independent copies indefinitely; feature fixes would otherwise
drift between them.

## What was copied

The snapshot was made from the local working tree, so it includes the latest
uncommitted application changes rather than only the older GitHub commit. It
intentionally excludes:

- `.git/`
- `.env` and all secret values
- `node_modules/`
- `dist/`
- old generated `outputs/`
- Netlify Functions and `netlify.toml`

The latest import-ready n8n workflow bundle was copied from the generated
2026-08-31 output into the tracked `n8n/workflows/` directory.

## Safe cutover sequence

1. Finish `PostgresStore` and database migrations. **Completed locally.**
2. Create the new private GitHub repository and push this folder as its root.
3. Import that repository into Replit.
4. Provision the Replit development database and run migrations. **Completed.**
5. Add development secrets and validate Preview.
6. Publish a private Reserved VM deployment with a production database.
7. Import the existing CSAT data and reconcile row counts and relationships.
8. Update the n8n app URL and run controlled WhatsApp tests.
9. Pause scheduled workflows briefly, take the final data export/import, switch
   the inbound route, and reactivate the workflows.
10. Keep the old deployment and Supabase database read-only for a defined
    rollback period before retiring them.

The guarded database-to-database importer is now available through
`npm run db:import:check` and `npm run db:import:supabase`. The actual production
data copy remains pending until the final write-freeze window.
