# Google Workspace login setup

The CSAT application uses Google's server-side OAuth flow. Google verifies the
user, the server verifies the signed ID token and hosted-domain (`hd`) claim,
and the application then issues its own secure 12-hour HttpOnly session cookie.

## Replit production secrets

Add these in **Deployments → Settings → Secrets** (production secrets):

```text
SESSION_SECRET=<at least 32 random characters>
GOOGLE_CLIENT_ID=<OAuth web client ID>
GOOGLE_CLIENT_SECRET=<OAuth web client secret>
GOOGLE_ALLOWED_DOMAINS=srvmedia.com
PUBLIC_APP_URL=https://YOUR-PUBLISHED-DOMAIN
```

Use the actual Google Workspace domain if it is different from
`srvmedia.com`. Multiple domains can be comma-separated.

`GOOGLE_SA_JSON_CONTENT` is not used for login. Keep it only in applications
that need a service account to call Google APIs.

`APP_LOGIN_PASSWORD` may remain configured as a fallback application login.
`ADMIN_PIN` remains the independent password for the Manage tab and is not
changed by Google login.

## Google Cloud OAuth client

The OAuth client must be a **Web application**. Add this exact Authorized
redirect URI:

```text
https://YOUR-PUBLISHED-DOMAIN/api/auth/google/callback
```

The redirect URI must match the published URL exactly, including `https` and
without an extra trailing slash. If the existing Timesheet OAuth client is
reused, add this CSAT callback URI to that client. A dedicated OAuth client is
cleaner, but not required.

For a company-only application, configure the Google Auth Platform audience as
**Internal** for the Workspace organization. The application still enforces
`GOOGLE_ALLOWED_DOMAINS` on the server; the login-page domain hint alone is not
treated as authorization.

After changing secrets or OAuth configuration, rebuild/redeploy the Replit
application. Test the published application rather than relying only on a
temporary preview hostname.
