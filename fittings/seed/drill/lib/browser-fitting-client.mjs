// Thin client to the Browser Fitting (browser-default) for Drill's screencast
// embed + picker. Mirrors automations/lib/browser-client.mjs's conventions
// (status-file discovery, fetch-based) — kept local per-fitting rather than
// shared, matching house convention (each own-port fitting installs
// independently; there is no cross-fitting lib import path).

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

async function json(res) {
  if (!res.ok) throw new Error(`browser ${res.status}: ${await res.text()}`);
  return res.json();
}

function requireBase() {
  const base = browserBaseUrl();
  if (!base) throw new Error("browser fitting not running (no GARRISON_BROWSER_URL / status file)");
  return base;
}

export async function openTab(url, { viewport, fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  const created = await json(await fetchImpl(`${base}/tabs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: url ?? "about:blank", viewport })
  }));
  return created.id || created.tabId;
}

export async function evalJs(tabId, js, { fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  const r = await json(await fetchImpl(`${base}/tabs/${encodeURIComponent(tabId)}/eval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ js })
  }));
  if (!r.ok) throw new Error(r.error || "eval failed");
  return r.value;
}

export async function observeTab(tabId, { screenshot = false, fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  const q = `a11y=1${screenshot ? "&screenshot=1" : ""}`;
  return json(await fetchImpl(`${base}/tabs/${encodeURIComponent(tabId)}/observe?${q}`));
}

export async function setViewport(tabId, vp, { fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  return json(await fetchImpl(`${base}/tabs/${encodeURIComponent(tabId)}/viewport`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(vp)
  }));
}

// Manual-testing controls for the authoring toolbar: navigate, history
// actions, close (restart), live tab info, and the console buffer - all thin
// wrappers over browser-default's existing tab endpoints.
export async function navigateTab(tabId, url, { fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  return json(await fetchImpl(`${base}/tabs/${encodeURIComponent(tabId)}/nav`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  }));
}

export async function tabAction(tabId, action, { fetchImpl = globalThis.fetch } = {}) {
  if (!["back", "forward", "reload"].includes(action)) throw new Error(`invalid tab action: ${action}`);
  const base = requireBase();
  return json(await fetchImpl(`${base}/tabs/${encodeURIComponent(tabId)}/${action}`, { method: "POST" }));
}

export async function closeTab(tabId, { fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  return json(await fetchImpl(`${base}/tabs/${encodeURIComponent(tabId)}`, { method: "DELETE" }));
}

// One tab's {tabId, url, title} from the tab listing, or null if it's gone
// (browser-default has no per-tab GET; the listing is the cheap read).
export async function tabInfo(tabId, { fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  const r = await json(await fetchImpl(`${base}/tabs`));
  return (r.tabs ?? []).find((t) => t.tabId === tabId || t.id === tabId) ?? null;
}

export async function readConsole(tabId, { limit = 120, fetchImpl = globalThis.fetch } = {}) {
  const base = requireBase();
  return json(await fetchImpl(`${base}/tabs/${encodeURIComponent(tabId)}/console?limit=${limit}`));
}

// The absolute URL of browser-default's iframeable canvas for a tab (B1: Drill
// embeds this directly rather than reimplementing the screencast WS client).
// embed=1 renders the bare screencast (no urlbar chrome): the iframe's full
// box IS the page viewport, which is what makes Drill's overlay math exact -
// the canvas page resizes the live tab viewport to its own wrapper size, so
// any chrome strip inside the iframe would skew every pick and badge.
export function canvasUrl(tabId) {
  const base = browserBaseUrl();
  if (!base) return null;
  return `${base}/canvas/${encodeURIComponent(tabId)}?embed=1`;
}
