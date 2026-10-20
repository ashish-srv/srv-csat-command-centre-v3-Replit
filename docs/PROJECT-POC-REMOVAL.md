# Project POC Removal and Dropdown Fixes

## Deploy

Run `npm run db:migrate` on the published application's database before
republishing this update. Migration `020-project-poc-removal.sql` adds a nullable
`removed_at` marker and adjusts the project/WhatsApp uniqueness index. It does
not delete existing records or treat inactive POCs as removed. No new secret or
n8n workflow is needed.

## Inactive versus Remove

- **Active: No** retains the POC in the current project's list, ready for a
  later reactivation.
- **Remove**, followed by **Save all POCs**, removes that assignment from the
  current project's Manage, Directory, Workspace configuration, POC Control
  Centre, current exports and Project Performance POC lists. Open sessions for
  that assignment are stopped without sending a client message. Existing chats,
  issues, ratings and historical respondent weights remain available in history.
- Other assignments for the same person/WhatsApp number, under the same or a
  different client, are not changed. The contact can be added again as a new
  assignment; past feedback stays attached to the old historical record.
- Removal is a history-preserving deletion of the live assignment, not a
  cascading deletion of the historical database record. Permanent history
  deletion remains a separate, explicitly confirmed Data Cleanup action.
- Existing entries removed by the old code were only made inactive. We cannot
  distinguish them from intentionally inactive POCs. Review those entries and
  remove the intended ones again after deploying; no automatic cleanup guesses
  are made.
- Remaining active POCs must still total 100%. Use Distribute equally or edit
  their percentages before saving. Other projects' influence settings are not
  redistributed.

Replit/PostgreSQL full-list POC saves use a transaction and project row lock.
Write failures roll back instead of leaving only some changes applied. The
legacy Supabase REST provider retains sequential writes.

## Shared dropdowns

Upward-opening portalled menus explicitly reset the inherited CSS `top` edge.
Search focus does not scroll the form; ancestor scroll/resize repositions the
menu instead of closing it before a selection. This applies to all consumers
of the shared picker: repeated POC tags/statuses, services, owners, team fields
and other searchable single selectors. Required fields remain non-clearable;
optional fields keep their Clear/Backspace behaviour.

## Tests

`npm run test:poc-management` covers upper/lower menu positions, repeated POC
rows, scroll/resize, assignment scope, inactive versus removed lists, re-adding
contacts, historical scores/weights, open-session stopping and transaction
commit/rollback. API regressions cover invalid/cross-project removals and stale
attempts to reactivate or move historical assignments. These controlled tests
do not modify production data or send real messages.
