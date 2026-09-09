# Local Testing

## Start App

```powershell
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:8787/dashboard
```

## Create a Feedback Session

Use the client workspace button:

```text
Manual 45-Day Send
```

This creates a feedback session and records the automation event locally.

## Simulate WhatsApp Reply

Use PowerShell after a session exists:

```powershell
$sessionId = "paste-session-id-here"
Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8787/api/whatsapp/sessions/$sessionId/reply" `
  -ContentType "application/json" `
  -Body '{"from":"919999999999","fromName":"Client","text":"PPC is good but search engine visibility is bad and website changes are slow."}'
```

Refresh the client workspace to see:

- captured service feedback
- partial/completed status
- next WhatsApp reply
- manager issue if risk is high

## Reset Local Data

Stop the server and delete:

```text
storage/local-db.json
```

The app will reload from `src/data/seed.json`.
