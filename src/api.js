async function parseResponse(response) {
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const base = payload.error || `Request failed with ${response.status}`;
    // The API puts the actionable reason in `details` (e.g. which env var is
    // missing). Losing it turns every failure into a generic message.
    const details = typeof payload.details === "string"
      ? payload.details
      : payload.details
        ? JSON.stringify(payload.details)
        : "";
    const requestError = new Error(details ? `${base}: ${details}` : base);
    requestError.status = response.status;
    requestError.details = payload.details;
    if (response.status === 401 && payload.error === "Authentication required") {
      window.dispatchEvent(new CustomEvent("csat:unauthorized"));
    }
    throw requestError;
  }
  return payload;
}

export async function apiGet(path) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json" }
  });
  return parseResponse(response);
}

export async function apiPost(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

export async function apiPut(path, body = {}) {
  const response = await fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

// The admin PIN is kept in memory for the tab's lifetime only - never stored.
let adminPin = "";

export function setAdminPin(value) {
  adminPin = String(value || "");
}

export function hasAdminPin() {
  return Boolean(adminPin);
}

export async function apiAdminGet(path) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "x-admin-pin": adminPin
    }
  });
  return parseResponse(response);
}

export async function apiWrite(path, body = {}, method = "POST") {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-admin-pin": adminPin
    },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}

/**
 * Use a freshly entered PIN for a sensitive write without replacing the PIN
 * already held by the unlocked Manage tab.
 */
export async function apiWriteWithAdminPin(path, body = {}, method = "POST", pin = "") {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-admin-pin": String(pin || "")
    },
    body: JSON.stringify(body)
  });
  return parseResponse(response);
}
