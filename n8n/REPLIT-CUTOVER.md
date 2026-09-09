# n8n changes for the Replit cutover

The active n8n instance remains the automation and WhatsApp transport layer.
Replit replaces the Netlify application and Supabase database; it does not
replace these workflows.

Before activation:

1. Import workflows 01–12 from `n8n/workflows/` into a test n8n project.
2. Replace `https://YOUR-REPLIT-APP.replit.app` with the actual Replit custom or
   deployment domain in every CSAT application HTTP node.
3. Keep the `CSAT Webhook Secret`, Meta WhatsApp token, Meta app secret, verify
   token and SMTP credentials inside n8n credentials/environment settings.
4. Confirm the app and n8n use the same `N8N_WEBHOOK_SECRET` value.
5. Leave scheduled and inbound workflows inactive until the database import and
   controlled WhatsApp tests pass.
6. Test duplicate Meta delivery, consecutive WhatsApp bubbles, reminders,
   partial-session closing, manual messages, manager alerts and cycle summary.

The Meta webhook can continue pointing at n8n. Only n8n's downstream CSAT
application URL changes during cutover.

