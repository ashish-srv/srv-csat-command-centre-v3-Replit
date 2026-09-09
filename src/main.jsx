import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { apiGet, apiPost } from "./api";
import LoginPage from "./components/LoginPage.jsx";
import "./styles.css";

function AuthenticatedApplication() {
  const [auth, setAuth] = useState({ checking: true, configured: true, authenticated: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiGet("/api/auth/status")
      .then((status) => {
        if (active) setAuth({ checking: false, ...status });
      })
      .catch((statusError) => {
        if (active) {
          setAuth({ checking: false, configured: true, authenticated: false });
          setError(statusError.message);
        }
      });

    const signedOut = () => {
      setAuth((current) => ({ ...current, checking: false, authenticated: false }));
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
      await apiPost("/api/auth/login", { password });
      setAuth((current) => ({ ...current, checking: false, authenticated: true }));
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
      setAuth((current) => ({ ...current, authenticated: false }));
    } catch (logoutError) {
      setError(logoutError.message);
    }
  }

  if (!auth.authenticated) {
    return (
      <LoginPage
        checking={auth.checking}
        configured={auth.configured}
        error={error}
        busy={busy}
        onLogin={login}
      />
    );
  }
  return <App onLogout={logout} />;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthenticatedApplication />
  </React.StrictMode>
);
