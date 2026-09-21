# Quick Check-in setup (11th and 21st)

## Meta template

Create one English WhatsApp template in Meta WhatsApp Manager.

- Template name: `srv_project_quick_checkin`
- Recommended category: Utility
- Body variable: `{{1}}` = POC salutation
- Quick-reply button 1: `All good`
- Quick-reply button 2: `Share feedback`

Body:

> Hello {{1}}, greetings from the Directors' Office at SRV Media.
>
> This is a brief check-in regarding your ongoing work with SRV Media. We would like to know how things are going at present.
>
> If everything is going well, please select All good. If anything needs improvement, if you are facing an issue, or if there is something you would like to bring to management's attention, please select Share feedback.
>
> Your response will be reviewed directly and confidentially by the Directors and used constructively to improve your experience with SRV Media.
>
> This quick check-in should take less than a minute.

Only this one Meta template is required. The acknowledgement and request for details are free-text replies inside WhatsApp's customer-service window.

## n8n workflows

Import these files:

1. `01 - CSAT v2 - WhatsApp Inbound Message Router (Quick Check-in Updated).json` (import this update of your existing working Workflow 1; its Meta webhook path and configuration are unchanged)
2. `13 - CSAT v1 - Quick Check-in Template Sender.json`
3. `14 - CSAT v1 - Schedule 11th and 21st Quick Check-ins.json`

Configure workflow 13 with the same WhatsApp Graph API header credential used by workflow 2 and the same header-auth credential used by the CSAT webhooks. Copy its production webhook URL into the Replit deployment secret `N8N_QUICK_CHECKIN_WEBHOOK`.

Configure workflow 14 with the published Replit app URL and the same CSAT header-auth credential. It runs daily at 10:00 AM Asia/Kolkata, while the application creates check-ins only on the 11th and 21st and prevents duplicates for the same project/date.

Activate workflows 1, 13, and 14 after the Meta template is approved. Workflow 1 keeps the existing Meta callback URL and verification configuration.

## Application behavior

- Sends only to active clients, active projects, and active POCs with a WhatsApp number.
- Does not ask for CSAT, NPS, or service-by-service ratings.
- Does not alter the normal feedback schedule or project score.
- `All good` records the response and closes that POC's quick check-in.
- `Share feedback` asks for one free-text explanation, records it, and closes after the explanation.
- Unanswered quick check-ins expire after 48 hours without reminders.
