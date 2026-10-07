import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { apiGet, apiPost } from "./api";
import LoginPage from "./components/LoginPage.jsx";
import "./styles.css";

function AuthenticatedApplication() {
  const [auth, setAuth] = useState({
    checking: true,
    configured: true,
    authenticated: false,
    passwordConfigured: false,
    googleConfigured: false,
    user: null
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const authError = new URLSearchParams(window.location.search).get("auth_error");
    const authErrors = {
      google_cancelled: "Google sign-in was cancelled.",
      invalid_google_state: "Google sign-in expired or could not be verified. Please try again.",
      google_identity_missing: "Google did not return a verified identity.",
      google_identity_unverified: "The selected Google account could not be verified.",
      google_domain_not_allowed: "Use your approved SRV Google Workspace account.",
      google_login_failed: "Google sign-in could not be completed. Please try again.",
      google_not_configured: "Google sign-in is not configured yet."
    };
    if (authError) {
      setError(authErrors[authError] || "Google sign-in could not be completed.");
      window.history.replaceState({}, "", window.location.pathname || "/");
    }
    apiGet("/api/auth/status")
      .then((status) => {
        if (active) setAuth({ checking: false, ...status });
      })
      .catch((statusError) => {
        if (active) {
          setAuth((current) => ({ ...current, checking: false, configured: true, authenticated: false, user: null }));
          setError(statusError.message);
        }
      });

    const signedOut = () => {
      setAuth((current) => ({ ...current, checking: false, authenticated: false, user: null }));
      setError("Your session expired. Please sign in again.");
    };
    window.addEventListener("csat:unauthorized", signedOut);
    return () => {
      active = false;
      window.removeEventListener("csat:unauthorized", signedOut);
    };
  }, []);

  async function login(password) {
    setBusy(true);
    setError("");
    try {
      const status = await apiPost("/api/auth/login", { password });
      setAuth((current) => ({ ...current, checking: false, authenticated: true, user: status.user || null }));
    } catch (loginError) {
      setError(loginError.status === 401 ? "That password is not correct." : loginError.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await apiPost("/api/auth/logout");
      setError("");
      setAuth((current) => ({ ...current, authenticated: false, user: null }));
    } catch (logoutError) {
      setError(logoutError.message);
    }
  }

  if (!auth.authenticated) {
    return (
      <LoginPage
        checking={auth.checking}
        configured={auth.configured}
        googleConfigured={auth.googleConfigured}
        passwordConfigured={auth.passwordConfigured}
        error={error}
        busy={busy}
        onLogin={login}
      />
    );
  }
  return <App onLogout={logout} currentUser={auth.user} />;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthenticatedApplication />
  </React.StrictMode>
);
