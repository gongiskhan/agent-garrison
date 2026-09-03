// Thin client for the Garrison app. The address is TOLD to us by the runner
// (GARRISON_APP_URL, projected with the instance-correct port) — never guessed
// from a port literal, which would name one instance and silently send another
// instance's traffic there (instance-isolation.test.ts). No env means no app:
// standalone runs outside the runner set GARRISON_APP_URL themselves or get
// degraded mode. Every method returns {ok, data|error} and never throws —
// app-down is a first-class, expected state (it is exactly when a doctor is
// needed).

const APP_URL = (process.env.GARRISON_APP_URL || process.env.GARRISON_BASE_URL || "").replace(/\/$/, "") || null;

async function request(pathname, { method = "GET", body, timeoutMs = 2000 } = {}) {
  if (!APP_URL) return { ok: false, error: "GARRISON_APP_URL not set" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${APP_URL}${pathname}`, {
      method,
      signal: ctrl.signal,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => null);
    return res.ok ? { ok: true, data } : { ok: false, error: `HTTP ${res.status}`, data };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "timeout" : (err?.message || String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

export function appUrl() {
  return APP_URL || "(GARRISON_APP_URL not set)";
}

export async function isAppUp() {
  const res = await request("/api/fittings/views", { timeoutMs: 2000 });
  return res.ok;
}

export async function fetchViews() {
  const res = await request("/api/fittings/views", { timeoutMs: 5000 });
  if (!res.ok) return null;
  return res.data?.views ?? res.data ?? null;
}

// The heavy, mutating call — the app's own verify path (same code up() runs).
// Only ever invoked from the explicit sweep action; 10 min budget.
export async function runVerifySweep(compositionId) {
  const res = await request(`/api/runner/${encodeURIComponent(compositionId)}/verify`, {
    method: "POST",
    timeoutMs: 10 * 60 * 1000
  });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, results: res.data?.results ?? [] };
}
