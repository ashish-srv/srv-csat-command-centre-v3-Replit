# Manage and messaging controls

Run `npm run db:migrate` after pulling this release. Migration `010-admin-controls.sql` adds the persistent WhatsApp switch and project-ID aliases. It does not delete or replace application data.

## WhatsApp master switch

The Dashboard shows **WhatsApp ON** or **WhatsApp PAUSED** beside Refresh. Changing it requires a fresh Manage admin PIN.

While paused:

- no feedback-start templates, quick check-ins, reminders, partial-session closing templates, manual WhatsApp messages, or automated WhatsApp replies are sent;
- incoming WhatsApp messages associated with a feedback session are stored without a bot reply and sent to the human-handoff email workflow;
- email alerts, summaries, and handoff notifications remain active;
- scheduled work remains pending and is checked again by its normal workflow after WhatsApp is resumed.

The switch applies to messages initiated by this application. Manually executing a Meta-send node directly inside n8n is outside the application's control.

## POC Control Centre

Manage > POC Control Centre lists every project POC assignment. It supports search and filters, displayed-row selection, bulk activate/deactivate, tag updates, manual percentages, and equal redistribution by affected project. A project may have no active POC; if it has active POCs, their influence must total exactly 100%.

## Bulk feedback sends

Manage > Bulk Feedback Sends supports 30-day feedback and quick check-ins. Preview is mandatory. The preview lets the administrator select or deselect projects and blocks inactive projects/clients, open cycles, missing or inactive POCs, and any WhatsApp number that already has an active conversation or is duplicated elsewhere in the preview.

The existing approved Meta templates are unchanged in this release.

## Project IDs

Project IDs can be edited. Each former ID is retained as an alias, so existing application links continue to resolve to the same project.
