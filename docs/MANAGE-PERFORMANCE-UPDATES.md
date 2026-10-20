# Manage and Project Performance Updates

## Deployment

1. Upload the application changes to GitHub and merge them into Replit.
2. Run `npm run db:migrate` against the database used by the published app.
   Migration `019-performance-kpi-comments-and-zoho.sql` adds three nullable
   columns; it does not remove or overwrite existing records or CSAT settings.
3. Generate an encryption key locally or in your own Replit shell:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. Save the output as `CREDENTIALS_ENCRYPTION_KEY` in Replit's production
   deployment secrets. Use the same key in development only if development is
   intentionally accessing the same encrypted records. Never commit the value.
   Keep a protected backup: replacing or losing it prevents existing passwords
   from being decrypted. Key rotation requires re-encrypting stored credentials.
5. Run `npm run check`, `npm test`, and `npm run build`, then republish.

No new n8n workflow is needed. Service-change request emails use the application's
existing SMTP configuration. A request may be saved even if its email fails;
its notification status remains visible for review. Only Super Admin approval
changes the project's CSAT services, and open feedback cycles remain protected.

## Behaviour

- Manage project editing scrolls to the actual editor. Service saves retain the
  selected project, filters, editor and scroll position.
- Record pickers are searchable. Backspace/Delete clears optional selections;
  required selections without a blank option cannot be accidentally cleared.
- Current KPI Performance shows `Actual − Target`. CPL/CPA and other cost or
  lower-is-better KPIs do not display a misleading achievement percentage.
  For CPL target 1,200 and actual 1,647 the difference is 447 over target.
- KPI names may repeat, including identical numbers. Comment / Program labels
  distinguish rows such as Leads for MBA IT and Technology Management. Only one
  row may be Primary. Excel exports/imports retain comments; older templates
  without comment columns preserve each existing row slot's comment.
- Read-only Client POC details appear below Client Context in expanded projects.
- Unsaved performance drafts survive browser-tab returns, project switching and
  navigating away within the app. Drafts are scoped to the signed-in user and
  project in this browser tab's session storage. They are not server saves and
  are not intended to survive closing the browser tab or clearing storage.
  Background refresh does not change the draft's original conflict-check version.
- Zoho Dashboard Link and Password are separate. Passwords are encrypted at
  rest using AES-256-GCM with project-bound authentication. Portfolio responses,
  audit snapshots, audit changes, Excel exports and browser draft storage never
  contain passwords or ciphertext. Revealing a password is a separate signed-in,
  project-scoped, non-cacheable request; the display hides on tab leave or after
  one minute. Anyone with permitted Project Performance access to that project
  can reveal its password. Normal saves and Excel uploads preserve passwords
  unless an explicit replacement/removal is supplied.

## Verification

`npm run test:manage-performance` exercises calculations, credential encryption,
component draft preservation, user/project isolation, searchable clearing and
Manage edit/save navigation. `npm run test:performance-workbook` checks repeated
KPI/comment round trips and compatibility with older templates. API tests cover
credential access scope, audit redaction and service approval restrictions.

Tests use controlled browser events and mocked persistence; they do not send
live emails, modify a production database, or certify the published browser UI.
