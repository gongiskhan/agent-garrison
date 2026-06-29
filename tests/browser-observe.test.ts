import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeBrowserClient } from "../fittings/seed/automations/lib/browser-client.mjs";

// F1 — the Browser Fitting's new observation endpoint: the fingerprint inputs
// (url/title/heading + DOM-shape counts + viewport) + a CDP a11y tree that the
// Automations orchestration layer keys its action cache on. Launches the real
// headless chromium the fitting drives.

const REPO = path.resolve(__dirname, "..");
const START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const PORT = 7186;
const BASE = `http://127.0.0.1:${PORT}`;

let srv: ChildProcess | null = null;

async function waitHealthy(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${BASE}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  srv = spawn("node", [START, "--port", String(PORT), "--host", "127.0.0.1"], { stdio: "ignore" });
  process.env.GARRISON_BROWSER_URL = BASE;
  await waitHealthy(15000);
});

afterAll(() => {
  if (srv && !srv.killed) srv.kill("SIGTERM");
  srv = null;
  delete process.env.GARRISON_BROWSER_URL;
});

describe("browser fitting observation (F1)", () => {
  it("returns the fingerprint inputs + a11y for a page", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "data:text/html,<h1>Q3 Report</h1><button>Export</button><main></main>" })
      })
    ).json();
    const tabId = created.id || created.tabId;
    expect(tabId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 600));

    const obs = await (await fetch(`${BASE}/tabs/${tabId}/observe?a11y=1`)).json();
    expect(obs.url).toContain("Q3 Report");
    expect(obs.headingText).toBe("Q3 Report");
    expect(obs.shapeSketch).toContain("button:1");
    expect(obs.shapeSketch).toContain("h1:1");
    expect(obs.viewport).toBeTruthy();
    expect(Array.isArray(obs.a11y)).toBe(true);
    expect(obs.a11y.length).toBeGreaterThan(0);
  }, 30000);

  it("executes a resolved action via the locator ladder", async () => {
    const created = await (
      await fetch(`${BASE}/tabs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "data:text/html,<button onclick=\"document.title='clicked'\">Go</button>" })
      })
    ).json();
    const tabId = created.id || created.tabId;
    await new Promise((r) => setTimeout(r, 600));

    const exec = await (
      await fetch(`${BASE}/tabs/${tabId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: { kind: "click", text: "Go" } })
      })
    ).json();
    expect(exec.ok, JSON.stringify(exec)).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    const obs = await (await fetch(`${BASE}/tabs/${tabId}/observe`)).json();
    expect(obs.title).toBe("clicked");
  }, 30000);

  it("blocks navigation to a non-web scheme (no file: pivot)", async () => {
    const res = await fetch(`${BASE}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" })
    });
    expect(res.status).toBe(400);
  });

  it("rejects a cross-origin request (CSRF guard)", async () => {
    const res = await fetch(`${BASE}/tabs`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    // a loopback origin (the same-origin canvas) is allowed
    const ok = await fetch(`${BASE}/health`, { headers: { origin: `http://127.0.0.1:${PORT}` } });
    expect(ok.status).toBe(200);
  });

  // F2 live wiring — the Automations browser-client drives this real fitting
  // (the integration the cache->vision->execute orchestrator uses).
  it("automations browser-client navigates, observes, and executes (F2 live)", async () => {
    const client = makeBrowserClient();
    await client.navigate("data:text/html,<h1>Report</h1><button onclick=\"document.title='sent'\">Send</button>");
    await new Promise((r) => setTimeout(r, 500));
    const obs = await client.observe();
    expect(obs.headingText).toBe("Report");
    expect(obs.shapeSketch).toContain("button:1");
    await client.execute({ kind: "click", text: "Send" });
    await new Promise((r) => setTimeout(r, 300));
    expect((await client.observe()).title).toBe("sent");
  }, 30000);
});
