# Manage and Consolidated Export Update

## Deployment

Apply `npm run db:migrate` against the intended deployment database before using multiple-cluster Internal POCs. Migration `023-internal-poc-clusters.sql` is additive: it retains existing primary clusters, backfills membership arrays and synchronises legacy single-cluster imports. Deleting a cluster removes only that membership; the other memberships remain. No n8n workflow or new secret is required.

Internal POC memberships are organisational data. They do **not** grant sign-in, project access or email access. Configure those separately in Application Users. Admin email switches remain per assigned cluster; Project Users do not receive CSAT email by being placed in a cluster. A shared Internal POC can be changed only by an Admin assigned to all their clusters or by a Super Admin.

## Manage

- Searchable multi-select and single-select menus open outside clipped panels. Their options scroll independently of search and Clear/OK controls.
- Internal POCs support multiple clusters in individual and bulk editors, with existing assignments displayed below their names.
- Application User saves compare editable values against the last saved version. Only changed users are submitted and counted. A repeated unchanged save makes no requests. Clients, Internal POCs, performance standards and POC Control similarly skip unchanged rows.
- Role headings and individual user cards use separate colour treatments.
- Section shortcuts open the target section and account for the actual height of the sticky navigation bar.

## Reports

- Filters include clusters, clients, project status, projects, feedback type and cycle-start dates. Reset All also clears partially entered date segments.
- Reports group Client → Project → Cycle → POC Session. IDs distinguish repeated names.
- Each POC includes stated CSAT, NPS, separately labelled estimates, response status, saved issues, appreciations, other/service feedback and original messages. Records are matched by session ID, never attributed from mixed-POC cycle aggregates.
- HTML provides individual scrollable chat windows. Print / Save as PDF expands every conversation; no hidden scroll content is omitted.
- Excel has a summary, linked project index and a grouped worksheet per project. Long messages continue on additional rows without losing characters; scores stay numeric.
- These changes do not modify feedback conversation progression, rating capture, email routing or send timing.

## Local Verification

`npm run check`, `npm test`, `npm run build` and `node scripts/manage-clusters-smoke.js` cover the implementation. `node scripts/consolidated-export-smoke.js --fixtures` generates synthetic sample reports under ignored `.local/report-qa`.

Optional real-browser checks: run `node scripts/manage-export-browser-smoke.js` with Playwright available. `CSAT_BROWSER_TEST_MODULE` and `CSAT_BROWSER_TEST_EXECUTABLE` can point to a local Playwright package and Chromium executable. Tests use isolated sample data, not the live database or messaging services.
