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
// box IS the page viewport, which is what makes Drill's overlay math exact.
// The optional preserved viewport keeps Browser from replacing Drill's named
// desktop/mobile viewport with the iframe's rendered display size.
export function canvasUrl(tabId, viewport = null) {
  const base = browserBaseUrl();
  if (!base) return null;
  const url = new URL(`${base}/canvas/${encodeURIComponent(tabId)}`);
  url.searchParams.set("embed", "1");
  if (viewport?.width && viewport?.height) {
    url.searchParams.set("preserveViewport", "1");
    url.searchParams.set("viewportWidth", String(viewport.width));
    url.searchParams.set("viewportHeight", String(viewport.height));
  }
  return url.toString();
}

// A viewport-exact PNG. Drill uses this for element targeting: the Browser
// canvas includes its own toolbar and scaling chrome, so mapping a click on
// that iframe directly to page CSS pixels is incorrect in real use.
export function screenshotUrl(tabId) {
  const base = browserBaseUrl();
  if (!base) return null;
  return `${base}/tabs/${encodeURIComponent(tabId)}/screenshot`;
}

export async function fetchScreenshot(tabId, { fetchImpl = globalThis.fetch } = {}) {
  const url = screenshotUrl(tabId);
  if (!url) throw new Error("browser fitting not running (no GARRISON_BROWSER_URL / status file)");
  const res = await fetchImpl(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`browser ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
