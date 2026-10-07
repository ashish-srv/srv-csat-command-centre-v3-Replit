import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { BrandLogo } from "./Ui.jsx";

export default function LoginPage({
  checking = false,
  configured = true,
  googleConfigured = false,
  passwordConfigured = false,
  error = "",
  busy = false,
  onLogin
}) {
  const [password, setPassword] = useState("");

  function submit(event) {
    event.preventDefault();
    if (!password || busy || checking || !configured) return;
    onLogin(password);
  }

  return (
    <main className="login-page">
      <div className="login-glow login-glow-one" aria-hidden="true" />
      <div className="login-glow login-glow-two" aria-hidden="true" />

      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <BrandLogo />
          <div>
            <p className="eyebrow">SRV Media · MD Office</p>
            <strong>CSAT Command Centre</strong>
          </div>
        </div>

        <div className="login-copy">
          <span className="login-security-mark"><ShieldCheck size={18} aria-hidden="true" /></span>
          <p className="eyebrow">Private workspace</p>
          <h1 id="login-title">Sign in to continue</h1>
          <p>Client feedback, service issues and satisfaction scores are restricted to the SRV team.</p>
        </div>

        {checking ? (
          <div className="login-status" role="status">
            <span className="login-spinner" aria-hidden="true" />
            Checking your session…
          </div>
        ) : configured ? (
          <div className="login-options">
            {error ? <p className="login-error" role="alert">{error}</p> : null}
            {googleConfigured ? (
              <button
                type="button"
                className="google-login-button"
                onClick={() => window.location.assign("/api/auth/google/start")}
              >
                <span className="google-login-mark" aria-hidden="true">G</span>
                <span>Continue with Google</span>
                <ArrowRight size={18} aria-hidden="true" />
              </button>
            ) : null}
            {googleConfigured && passwordConfigured ? <div className="login-divider"><span>or use the existing app password</span></div> : null}
            {passwordConfigured ? (
              <form className="login-form" onSubmit={submit}>
                <label htmlFor="app-password">Application Password</label>
                <div className="login-input-wrap">
                  <KeyRound size={18} aria-hidden="true" />
                  <input
                    id="app-password"
                    name="password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Enter application password"
                    autoComplete="current-password"
                    autoFocus={!googleConfigured}
                    disabled={busy}
                    required
                  />
                </div>
                <button type="submit" className="login-submit" disabled={!password || busy}>
                  <span>{busy ? "Signing in…" : "Sign in with password"}</span>
                  {!busy ? <ArrowRight size={18} aria-hidden="true" /> : null}
                </button>
              </form>
            ) : null}
          </div>
        ) : (
          <div className="login-setup" role="alert">
            <strong>Login is not configured yet</strong>
            <p>Configure Google Workspace login or add <code>APP_LOGIN_PASSWORD</code> in Replit production Secrets, then redeploy.</p>
          </div>
        )}

        <p className="login-footnote">Your session is stored in a secure, HttpOnly cookie and expires automatically.</p>
      </section>
    </main>
  );
}
