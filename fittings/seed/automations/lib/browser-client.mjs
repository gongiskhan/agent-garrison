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

export function makeBrowserClient({ fetchImpl = globalThis.fetch } = {}) {
  const base = browserBaseUrl();
  if (!base) throw new Error("browser fitting not running (no GARRISON_BROWSER_URL / status file)");
  let tabId = null;

  const json = async (res) => {
    if (!res.ok) throw new Error(`browser ${res.status}: ${await res.text()}`);
    return res.json();
  };

  async function openTab(url) {
    const created = await json(await fetchImpl(`${base}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: url ?? "about:blank" })
    }));
    tabId = created.id || created.tabId;
    return tabId;
  }

  return {
    get tabId() { return tabId; },
    async navigate(url) {
      if (!tabId) return openTab(url);
      await json(await fetchImpl(`${base}/tabs/${tabId}/nav`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url })
      }));
      return tabId;
    },
    async observe({ screenshot = false } = {}) {
      if (!tabId) await openTab();
      const q = `a11y=1${screenshot ? "&screenshot=1" : ""}`;
      return json(await fetchImpl(`${base}/tabs/${tabId}/observe?${q}`));
    },
    async execute(action) {
      if (!tabId) await openTab();
      const r = await json(await fetchImpl(`${base}/tabs/${tabId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action })
      }));
      if (!r.ok) throw new Error(r.error || "execute failed");
      return r;
    }
  };
}
