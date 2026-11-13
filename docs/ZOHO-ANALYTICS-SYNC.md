# Zoho Analytics Project Performance push

## Setup

Add the new table's `ZOHO_ORG_ID`, `ZOHO_WORKSPACE_ID`, `ZOHO_VIEW_ID`, plus
`ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_REFRESH_TOKEN` to Replit's
production secrets. India is the default data centre, matching the supplied
n8n examples. Optional `ZOHO_DATA_CENTER` supports `in`, `us`, or `eu`.

The refresh token's existing grant must permit `ZohoAnalytics.metadata.read`,
`ZohoAnalytics.data.read`, and `ZohoAnalytics.data.create`. Refreshing a token
does not add permissions to the grant. Use the application's PostgreSQL provider.

No database migration or n8n change is needed. The existing `app_settings` table
has a primary key on `setting_key`. The first explicit operation creates or
updates the one `zoho_analytics_access_token` record. No startup job, hourly
refresh, scheduler, token history or automatic push is installed.

## Buttons

Project Performance → Excel Upload places **Push to Zoho Analytics** beside
Download current data. **Check Zoho Connection** is a separate action.

Manage → Application Users → Edit users and roles together provides separate
**Push to Zoho Analytics** (`zoho_push`) and **Check Zoho Connection**
(`zoho_connection_check`) permissions for each Admin or Project User. Both start
off for existing/new non-Super-Admin accounts until explicitly enabled. Save the
user changes once. Super Admins retain full access, following the existing role
policy. The flags use the existing permissions JSON, so no migration is required.
Revocation is checked against the saved user on each request, including already
signed-in sessions. Unauthorized controls are hidden and direct API requests fail.

Check Connection reads table metadata without modifying Zoho rows. It reports
missing columns, but does not prove the token has write permission. Push reads
saved application data on the server, regardless of page filters or unsaved
browser drafts. Super Admins push all projects; Admins push their permitted
clusters; Project Users push their assigned projects. Each action requires its
dedicated permission plus Project Performance page access; it can be granted
independently of application editing. Browsers cannot supply replacement rows,
target IDs, credentials, or token values to either operation.

## Matching and data

Match all four exact values: **Client Name + Project Name + Project Type +
Financial Year**. Update matches and add missing projects. No Client ID or
Project ID is required or written; existing ID columns and additional Zoho-only
columns stay untouched. Send the 26 agreed fields, including Currency and FX
Rate to INR. Empty application fields are deliberately sent as empty CSV values
to clear the corresponding fields on matching rows, as requested.

Missing matching values, invalid source dates/numbers, duplicate keys across
application projects (including other clusters), duplicate target matches, and conflicting case or
whitespace variants are skipped with a reason. Names are not guessed or fuzzy
matched. Different project types/financial years remain different rows.
For example, a manual Zoho financial year of `2026` does not match an application
financial year of `2026-2027`; that application project is added as a new row.
All source IDs and passwords, client POC data, KPIs and CSAT data are excluded.
Dates are `yyyy-MM-dd`; zero numeric values remain zero. The table must contain
the agreed column names, with Start Date and End Date defined as Date columns.

Push first validates metadata and reads only the target's four matching columns.
It uses the documented `updateadd` import with those matching columns and the
explicit field whitelist; it never truncates the table or deletes missing rows.
The application serializes its pushes with a PostgreSQL advisory lock. Separate
manual edits or other external writers in Zoho are outside this lock.

The import response must explicitly confirm all submitted rows with no warnings
before successful update/add counts are shown. Transport failures and uncertain
responses do not trigger a blind import retry; inspect Zoho before retrying.

## Token storage

All authorized users share the same server-side cache. A valid access token is
reused; the next explicit operation after expiry refreshes and overwrites it.
The expiry is based on Zoho's returned `expires_in`. Row locking coordinates
concurrent workers. Failed refreshes roll back without overwriting an existing
token. A confirmed HTTP 401 permits one refresh/retry, while a newer token from
another worker is reused instead of generating another one.

Only an AES-256-GCM encrypted access token, timestamps, version and credential
fingerprint are stored. A domain-separated HKDF key is derived from the OAuth
client secret; no extra encryption secret is needed. Client secret and refresh
token remain in Replit Secrets. Rotating OAuth credentials invalidates the cache.
Tokens and raw upstream error bodies never appear in browser responses or logs.

## Verification

`npm run test:zoho` covers cache reuse/expiry/concurrency, transactional failure,
safe errors, exact/duplicate matching, quoted CSV, date/number/blank handling,
import confirmation, overlapping pushes, role/cluster/team scope, forged request
rows and component clicks. Fixtures replace PostgreSQL, OAuth and Zoho; no real
account is contacted. After deployment, use Check Zoho Connection and verify a
controlled push against the actual table before relying on production results.

Official API references:

- https://www.zoho.com/analytics/api/v2/authentication/refresh-token.html
- https://www.zoho.com/analytics/api/v2/metadata-api/get-table-metadata.html
- https://www.zoho.com/analytics/api/v2/bulk-api/export-data.html
- https://www.zoho.com/analytics/api/v2/bulk-api/import-data/existing-table.html
