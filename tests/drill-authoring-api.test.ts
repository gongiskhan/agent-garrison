import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Authoring surface server endpoints (Phase 3): open/reuse a tab per
// (pageId, viewport), pick an element, resolve stored anchors. Drives both
// the real Drill server AND a real browser-default.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7189;
const DRILL_PORT = 7196;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-auth-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-auth-target-"));

let browserSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15000)).toBe(true);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target, DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1" }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);

  // Point the Drill Book's app at a fixture page served as a data: URL is not
  // possible via new URL(path, base) with a data: base, so point at a real
  // fixture served by browser-default's own devtools-agnostic static host —
  // simplest: use about:blank as base and rely on the page's own path being a
  // full data: URL when needed. Here we set app.url to a data: page directly.
  await fetch(`${DRILL_BASE}/api/drillbook`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: { name: "fixture", url: "http://127.0.0.1:65535" } })
  });
}, 25000);

afterAll(() => {
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  browserSrv = null;
  drillSrv = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("POST /api/authoring/tab", () => {
  it("400s without pageId, 400s on an unknown viewport", async () => {
    const noPage = await fetch(`${DRILL_BASE}/api/authoring/tab`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewport: "desktop" })
    });
    expect(noPage.status).toBe(400);
    await fetch(`${DRILL_BASE}/api/pages/chat`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/chat" }) });
    const badVp = await fetch(`${DRILL_BASE}/api/authoring/tab`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "chat", viewport: "watch" })
    });
    expect(badVp.status).toBe(400);
  });

  it("opens a tab at the page's resolved URL and viewport, and reuses it on a second call", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: { name: "fixture", url: "data:text/html,<h1>root</h1>" } })
    });
    await fetch(`${DRILL_BASE}/api/pages/root`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "" }) });
    const r1 = await (
      await fetch(`${DRILL_BASE}/api/authoring/tab`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "root", viewport: "mobile" })
      })
    ).json();
    expect(r1.tabId).toBeTruthy();
    expect(r1.viewport).toMatchObject({ id: "mobile", width: 390, height: 844 });
    expect(r1.canvasUrl).toContain(`${BROWSER_BASE}/canvas/`);

    const r2 = await (
      await fetch(`${DRILL_BASE}/api/authoring/tab`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "root", viewport: "mobile" })
      })
    ).json();
    expect(r2.tabId).toBe(r1.tabId); // reused, not re-opened
  }, 20000);
});

describe("POST /api/authoring/pick + /api/authoring/resolve", () => {
  it("picks an element through the Drill server and resolves it back", async () => {
    const html = 'data:text/html,' + encodeURIComponent('<button data-testid="go" style="position:absolute;top:10px;left:10px;width:80px;height:30px">Go</button>');
    await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: html } })
    });
    await fetch(`${DRILL_BASE}/api/pages/btnpage`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "" }) });
    const tabRes = await (
      await fetch(`${DRILL_BASE}/api/authoring/tab`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "btnpage", viewport: "desktop" })
      })
    ).json();
    const tabId = tabRes.tabId;

    let picked: any = null;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${DRILL_BASE}/api/authoring/pick`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabId, x: 50, y: 25 })
      });
      const body = await r.json();
      if (body.anchors) { picked = body.anchors; break; }
      await new Promise((r2) => setTimeout(r2, 250));
    }
    expect(picked?.testId).toBe("go");

    const resolveRes = await (
      await fetch(`${DRILL_BASE}/api/authoring/resolve`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabId, anchors: picked })
      })
    ).json();
    expect(resolveRes.resolved.matched).toBe("testId");
  }, 30000);
});
