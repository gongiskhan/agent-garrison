// Thin client to the Browser Fitting (browser-default). The orchestration layer
// (browser-orchestrator) decides WHAT to do (cache/vision); this client performs
// the browser I/O: open/navigate a tab, observe the page (the fingerprint inputs
// + a11y + screenshot), and execute a resolved action via the locator ladder.
// The Browser fitting stays a pure service (decision F2).

import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

export function browserBaseUrl() {
  if (process.env.GARRISON_BROWSER_URL) return process.env.GARRISON_BROWSER_URL;
  try {
    const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
    const status = JSON.parse(readFileSync(path.join(home, "ui-fittings", "browser-default.json"), "utf8"));
    return status.url || null;
  } catch {
    return null;
  }
}

function infrastructureError(message, code, cause = null) {
  const error = cause instanceof Error ? cause : new Error(message);
  if (cause instanceof Error && message && cause.message !== message) error.message = message;
  error.failure = {
    class: "infrastructure",
    component: "browser",
    code,
    retryable: true
  };
  error.recoverable = false;
  return error;
}

function recoverablePageError(message) {
  const error = new Error(message);
  // A 400 from /execute means the Browser service is reachable but could not
  // resolve or validate the proposed interaction. Let the rehearsal fixer
  // observe the current page and repair the action; do not report an outage or
  // open Drill's infrastructure circuit.
  error.recoverable = true;
  return error;
}

// `viewport` (engine delta 3, e.g. { width, height, isMobile?, deviceScaleFactor? })
// is applied at tab-creation time so responsive CSS sees the right size from
// first paint — a run matrix (delta 6) gets a fresh client (fresh tab) per
// viewport, so there is no mid-run re-emulation ordering hazard to handle here.
export function makeBrowserClient({ fetchImpl = globalThis.fetch, viewport = null } = {}) {
  const base = browserBaseUrl();
  if (!base) {
    throw infrastructureError(
      "browser fitting not running (no GARRISON_BROWSER_URL / status file)",
      "browser-unavailable"
    );
  }
  let tabId = null;
  let currentUrl = null;

  const json = async (res, { recoverableExecute = false } = {}) => {
    if (!res.ok) {
      const detail = await res.text();
      if (recoverableExecute && res.status === 400) {
        throw recoverablePageError(`browser ${res.status}: ${detail}`);
      }
      throw infrastructureError(
        `browser ${res.status}: ${detail}`,
        `browser-http-${res.status}`
      );
    }
    try {
      return await res.json();
    } catch (cause) {
      throw infrastructureError(
        `browser invalid response: ${cause instanceof Error ? cause.message : String(cause)}`,
        "browser-invalid-response",
        cause instanceof Error ? cause : null
      );
    }
  };
  const request = async (url, init) => {
    try {
      return await fetchImpl(url, init);
    } catch (cause) {
      throw infrastructureError(
        `browser connection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        "browser-transport",
        cause instanceof Error ? cause : null
      );
    }
  };

  async function openTab(url) {
    const created = await json(await request(`${base}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: url ?? "about:blank", viewport: viewport ?? undefined })
    }));
    tabId = created.id || created.tabId;
    currentUrl = created.url || url || currentUrl;
    return tabId;
  }

  function navigationTarget(url) {
    if (typeof url !== "string" || !url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    if (!currentUrl || currentUrl === "about:blank") return url;
    try {
      return new URL(url, currentUrl).toString();
    } catch {
      return url;
    }
  }

  return {
    get tabId() { return tabId; },
    async close() {
      if (!tabId) return;
      const closingTabId = tabId;
      tabId = null;
      currentUrl = null;
      await json(await request(`${base}/tabs/${closingTabId}`, {
        method: "DELETE"
      }));
    },
    async navigate(url) {
      const target = navigationTarget(url);
      if (!tabId) return openTab(target);
      const navigated = await json(await request(`${base}/tabs/${tabId}/nav`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: target })
      }));
      currentUrl = navigated.url || target || currentUrl;
      return tabId;
    },
    async observe({ screenshot = false } = {}) {
      if (!tabId) await openTab();
      const q = `a11y=1${screenshot ? "&screenshot=1" : ""}`;
      const observation = await json(await request(`${base}/tabs/${tabId}/observe?${q}`));
      currentUrl = observation.url || currentUrl;
      return observation;
    },
    async execute(action) {
      if (!tabId) await openTab();
      const r = await json(await request(`${base}/tabs/${tabId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      }), { recoverableExecute: true });
      if (!r.ok) throw new Error(r.error || "execute failed");
      return r;
    },
    // Deterministic assertion kinds needing live locator access (count/visible/
    // attribute-equals) — text-contains/url-matches are resolved locally from
    // observe() and never reach this call (see assertions.mjs).
    async assert(assertion) {
      if (!tabId) await openTab();
      const r = await json(await request(`${base}/tabs/${tabId}/assert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assertion })
      }));
      if (!r.ok) throw new Error(r.error || "assert failed");
      return r;
    },
    // Re-emulate an already-open tab's viewport (the picker/authoring surface
    // uses this; a run's own viewport is set at tab-creation time above).
    async setViewport(vp) {
      if (!tabId) return openTab();
      return json(await request(`${base}/tabs/${tabId}/viewport`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(vp)
      }));
    },
    async evalJs(js) {
      if (!tabId) await openTab();
      const r = await json(await request(`${base}/tabs/${tabId}/eval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ js })
      }));
      if (!r.ok) throw new Error(r.error || "eval failed");
      return r;
    }
  };
}
