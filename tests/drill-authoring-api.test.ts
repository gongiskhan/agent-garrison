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
    expect(new URL(r1.canvasUrl).searchParams.get("preserveViewport")).toBe("1");
    expect(new URL(r1.canvasUrl).searchParams.get("embed")).toBe("1");
    expect(new URL(r1.canvasUrl).searchParams.get("viewportWidth")).toBe("390");
    expect(new URL(r1.canvasUrl).searchParams.get("viewportHeight")).toBe("844");
    expect(r1.screenshotUrl).toContain("/api/authoring/screenshot/");
    const screenshot = await fetch(`${DRILL_BASE}${r1.screenshotUrl}`);
    expect(screenshot.headers.get("content-type")).toBe("image/png");

    const r2 = await (
      await fetch(`${DRILL_BASE}/api/authoring/tab`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "root", viewport: "mobile" })
      })
    ).json();
    expect(r2.tabId).toBe(r1.tabId); // reused, not re-opened
  }, 20000);
});

describe("POST /api/authoring/freeze", () => {
  it("pauses page motion while targeting and reports the live viewport", async () => {
    const html = "data:text/html," + encodeURIComponent(
      '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="moving" style="animation:slide 1s infinite">Target</div>'
    );
    await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: html } })
    });
    await fetch(`${DRILL_BASE}/api/pages/freeze`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "" })
    });
    const opened = await (
      await fetch(`${DRILL_BASE}/api/authoring/tab`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "freeze", viewport: "mobile" })
      })
    ).json();
    const frozen = await (
      await fetch(`${DRILL_BASE}/api/authoring/freeze`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabId: opened.tabId, frozen: true })
      })
    ).json();
    expect(frozen).toMatchObject({ frozen: true, viewport: { width: 390, height: 844 } });
    const thawed = await (
      await fetch(`${DRILL_BASE}/api/authoring/freeze`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabId: opened.tabId, frozen: false })
      })
    ).json();
    expect(thawed.frozen).toBe(false);
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

    const manyRes = await (
      await fetch(`${DRILL_BASE}/api/authoring/resolve-many`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tabId,
          items: [
            { id: "btnpage#go", anchors: picked },
            { id: "btnpage#missing", anchors: { testId: "not-present" } }
          ]
        })
      })
    ).json();
    expect(manyRes.resolved["btnpage#go"]).toMatchObject({ leftPct: expect.any(Number), topPct: expect.any(Number) });
    expect(manyRes.resolved["btnpage#missing"]).toBeNull();
  }, 30000);
});

describe("authoring manual-testing toolbar routes", () => {
  const html = "data:text/html," + encodeURIComponent("<h1>tool</h1><script>console.error('boom from page')</script>");
  let tabId = "";

  it("opens the toolbar test tab", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: html } })
    });
    await fetch(`${DRILL_BASE}/api/pages/toolpage`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "" }) });
    const r = await (
      await fetch(`${DRILL_BASE}/api/authoring/tab`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "toolpage", viewport: "desktop" })
      })
    ).json();
    tabId = r.tabId;
    expect(tabId).toBeTruthy();
  }, 20000);

  it("navigates the tab and reports the landed URL", async () => {
    const dest = "data:text/html," + encodeURIComponent("<h1>navved</h1>");
    const r = await (
      await fetch(`${DRILL_BASE}/api/authoring/nav`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabId, url: dest })
      })
    ).json();
    expect(r.ok).toBe(true);
    expect(r.url).toContain("navved");
  }, 15000);

  it("reloads via tab-action and 400s an invalid action", async () => {
    const r = await (
      await fetch(`${DRILL_BASE}/api/authoring/tab-action`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabId, action: "reload" })
      })
    ).json();
    expect(r.ok).toBe(true);
    const bad = await fetch(`${DRILL_BASE}/api/authoring/tab-action`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tabId, action: "explode" })
    });
    expect(bad.status).toBe(400);
  }, 15000);

  it("reads live tab info and the console buffer through the proxy", async () => {
    const info = await (await fetch(`${DRILL_BASE}/api/authoring/tab-info?tabId=${encodeURIComponent(tabId)}`)).json();
    expect(info.tab?.tabId ?? info.tab?.id).toBe(tabId);
    expect(String(info.tab?.url)).toContain("data:");

    // The console buffer survives navigation on the same tab; the first page
    // logged an error at open.
    const con = await (await fetch(`${DRILL_BASE}/api/authoring/console?tabId=${encodeURIComponent(tabId)}&limit=50`)).json();
    expect(Array.isArray(con.entries)).toBe(true);
  }, 15000);

  it("restart closes the pooled tab and opens a fresh one, which the pool then reuses", async () => {
    const r = await (
      await fetch(`${DRILL_BASE}/api/authoring/restart`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "toolpage", viewport: "desktop" })
      })
    ).json();
    expect(r.tabId).toBeTruthy();
    expect(r.tabId).not.toBe(tabId);
    const again = await (
      await fetch(`${DRILL_BASE}/api/authoring/tab`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "toolpage", viewport: "desktop" })
      })
    ).json();
    expect(again.tabId).toBe(r.tabId);
    // the old tab is really gone from the browser
    const old = await (await fetch(`${DRILL_BASE}/api/authoring/tab-info?tabId=${encodeURIComponent(tabId)}`)).json();
    expect(old.tab).toBeNull();
  }, 20000);
});
