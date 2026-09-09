# Netlify Deployment

Use this after local testing is done.

## 1. Push to Git

Create a GitHub repository and push this folder.

## 2. Create Netlify Site

In Netlify:

1. Add new site.
2. Import from Git.
3. Select the repository.
4. Confirm:

```text
Build command: npm run build
Publish directory: dist
Functions directory: netlify/functions
```

These are already defined in `netlify.toml`.

## 3. Add Environment Variables

In Netlify project settings, add:

```text
DATA_PROVIDER=supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PUBLIC_APP_URL=
APP_LOGIN_PASSWORD=
APP_SESSION_SECRET=
N8N_WEBHOOK_SECRET=
N8N_FEEDBACK_STARTED_WEBHOOK=
N8N_FEEDBACK_RECEIVED_WEBHOOK=
N8N_MANAGER_ALERT_WEBHOOK=
N8N_NO_RESPONSE_WEBHOOK=
N8N_FEEDBACK_SESSION_CLOSED_WEBHOOK=
N8N_MANUAL_MESSAGE_WEBHOOK=
```

Set `PUBLIC_APP_URL` to the final Netlify URL or your custom domain.

Set `APP_LOGIN_PASSWORD` to the password your team will use to open the dashboard (minimum 8 characters). Set `APP_SESSION_SECRET` to a different, long random value (at least 16 characters; 32 or more is recommended). Both values are server-only and must **not** use a `VITE_` prefix.

For a Git-connected Netlify site, add these under **Site configuration → Environment variables** and redeploy. Saving a value only as a GitHub Actions secret does not make it available to Netlify Functions unless a workflow explicitly forwards it; this repository does not do that.

## 4. Connect n8n

In n8n, set:

```text
CSAT_APP_URL=https://your-netlify-site.netlify.app
CSAT_WEBHOOK_SECRET=same-value-as-N8N_WEBHOOK_SECRET
```

Then import and activate the workflows in `n8n/workflows`.

## 5. WhatsApp Provider

Use provider-approved templates for:

```text
srv_45_day_pulse
srv_project_end_feedback
srv_feedback_reminder
srv_complete_feedback_reminder
srv_final_rating_reminder
srv_feedback_session_closed
```

After the client replies, n8n can send dynamic state-machine replies inside the WhatsApp service window.
