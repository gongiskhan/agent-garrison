import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http, { type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitExit } from "./helpers/wait-exit";

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
let fixtureSrv: Server | null = null;
let assertionSrv: Server | null = null;
let fixtureBase = "";
let assertionBase = "";
let mutateDuringNextAssertion = false;
const persistentResponses = new Set<ServerResponse>();

async function listenEphemeral(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function requestJson(req: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function fixtureServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/old") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Old scope</title><h1>Old scope</h1>
        <script>
          fetch('/old-bad?legacyToken=OLD_SCOPE_SECRET').catch(() => {});
          console.error('old console password=OLD_CONSOLE_SECRET');
        </script>`);
      return;
    }
    if (url.pathname === "/evidence") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Evidence</title><h1>Evidence window</h1>
        <a href="/next"><span aria-hidden="true">decorative only</span></a>
        <button onclick="fetch('/after-action?actionToken=ACTION_SECRET').catch(() => {})">Load after action</button>
        <button onclick="location.href='/action-destination?code=ACTION_NAV_SECRET#private'">Navigate after action</button>
        <script>
          fetch('/ok?accessToken=SUCCESS_SECRET').catch(() => {});
          fetch('/bad?apiKey=HTTP_SECRET').catch(() => {});
          window.planStream = new EventSource('/hang?bearer=STREAM_SECRET');
          console.error('request failed /console?token=CONSOLE_SECRET#private password=CONSOLE_PASSWORD Bearer CONSOLE_BEARER');
        </script>`);
      return;
    }
    if (url.pathname === "/delayed") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Delayed</title><h1>Delayed assertion fixture</h1>");
      return;
    }
    if (url.pathname === "/redirect-start") {
      res.writeHead(302, { location: "/redirect-final?code=FINAL_URL_SECRET#private" });
      res.end();
      return;
    }
    if (url.pathname === "/redirect-final") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Redirected</title><h1>Redirect destination</h1>");
      return;
    }
    if (url.pathname === "/action-destination") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Action destination</title><h1>Action destination</h1>");
      return;
    }
    if (url.pathname === "/pending-page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Pending</title><h1>Pending fetch</h1><script>fetch('/ordinary-hang?token=PENDING_SECRET')</script>");
      return;
    }
    if (url.pathname === "/stream-fetch-page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>Stream</title><h1>Streaming fetch</h1><script>fetch('/stream-fetch?token=FETCH_STREAM_SECRET')</script>");
      return;
    }
    if (url.pathname === "/hang") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write("data: connected\n\n");
      persistentResponses.add(res);
      req.on("close", () => persistentResponses.delete(res));
      return;
    }
    if (url.pathname === "/ordinary-hang") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"still":"pending"');
      persistentResponses.add(res);
      req.on("close", () => persistentResponses.delete(res));
      return;
    }
    if (url.pathname === "/stream-fetch") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write("data: connected\n\n");
      persistentResponses.add(res);
      req.on("close", () => persistentResponses.delete(res));
      return;
    }
    if (url.pathname === "/bad" || url.pathname === "/old-bad") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"fixture unavailable"}');
      return;
    }
    if (url.pathname === "/ok" || url.pathname === "/after-action") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
}

// A narrow Automations stand-in for this integration: it preserves the real
// service boundary used by Drill, while delegating the assertion itself to the
// real Browser fitting's locator evaluator.
function assertionServer() {
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/assert") {
      res.writeHead(404); res.end(); return;
    }
    try {
      const body = await requestJson(req);
      if (mutateDuringNextAssertion) {
        mutateDuringNextAssertion = false;
        const changed = await fetch(`${BROWSER_BASE}/tabs/${encodeURIComponent(body.tabId)}/eval`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            js: "const b=document.createElement('button');b.id='race-during-assert';b.textContent='Raced target';document.body.appendChild(b);true"
          })
        });
        if (!changed.ok) throw new Error(`failed to mutate assertion fixture: ${changed.status}`);
      }
      const upstream = await fetch(`${BROWSER_BASE}/tabs/${encodeURIComponent(body.tabId)}/assert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assertion: body.assertion })
      });
      const result = await upstream.json();
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...result, kind: body.assertion?.kind }));
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
}

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

beforeAll(async () => {
  fixtureSrv = fixtureServer();
  fixtureBase = await listenEphemeral(fixtureSrv);

  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15000)).toBe(true);

  assertionSrv = assertionServer();
  assertionBase = await listenEphemeral(assertionSrv);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env,
      GARRISON_HOME: ghome,
      GARRISON_DRILL_TARGET_REPO: target,
      GARRISON_BROWSER_URL: BROWSER_BASE,
      GARRISON_AUTOMATIONS_URL: assertionBase,
      DRILL_UI_PORT: String(DRILL_PORT),
      DRILL_UI_HOST: "127.0.0.1"
    }
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

afterAll(async () => {
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  await waitExit(drillSrv);
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  await waitExit(browserSrv);
  browserSrv = null;
  drillSrv = null;
  for (const response of persistentResponses) response.end();
  persistentResponses.clear();
  await Promise.all([fixtureSrv, assertionSrv].filter(Boolean).map((server) =>
    new Promise<void>((resolve) => (server as Server).close(() => resolve()))
  ));
  fixtureSrv = null;
  assertionSrv = null;
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

describe("plan-time exploration evidence", () => {
  async function explore(endpoint: string, body: Record<string, unknown>) {
    const response = await fetch(`${DRILL_BASE}/api/explore/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: target, ...body })
    });
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(200);
    return json;
  }

  it("returns quiet, scoped, private network evidence and re-observes without a dummy action", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: { name: "explore fixture", url: fixtureBase } })
    });

    const old = await explore("open", { path: "/old", viewport: "desktop" });
    expect(old.source).toBe("open");
    expect(old.network.issues.httpErrors).toContainEqual(
      expect.objectContaining({ url: "/old-bad", status: 503 })
    );

    // A second explicit open creates a new request baseline on the same tab.
    const opened = await explore("open", { path: "/evidence", viewport: "desktop" });
    expect(opened.tabId).toBe(old.tabId);
    expect(opened.observationId).not.toBe(old.observationId);
    expect(opened.source).toBe("open");
    expect(opened.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(opened.quiet).toMatchObject({ outcome: "quiet", persistentRequests: 1 });
    expect(opened.browserContext).toEqual(expect.objectContaining({
      persistentProfile: expect.any(Boolean),
      tabAgeMs: expect.any(Number),
      navigationAgeMs: expect.any(Number)
    }));
    expect(opened.screenshot).toMatch(/\.jpg$/);
    expect(opened.elements).toContainEqual({ role: "link", accessibleNameMissing: true });
    expect(opened.network.summary).toEqual(expect.objectContaining({
      pending: 0,
      persistent: 1,
      non2xx: 1,
      completed2xx: expect.any(Number)
    }));
    expect(opened.network.issues.httpErrors).toContainEqual(
      expect.objectContaining({ resourceType: "Fetch", url: "/bad", status: 503, durationMs: expect.any(Number) })
    );
    expect(opened.network.issues.persistent).toContainEqual(
      expect.objectContaining({ resourceType: "EventSource", url: "/hang", status: 200, pending: true, persistent: true, ageMs: expect.any(Number) })
    );
    expect(opened.network.recent2xx).toContainEqual(
      expect.objectContaining({ resourceType: "Fetch", url: "/ok", status: 200 })
    );
    expect(opened.consoleErrors).toContainEqual(expect.stringContaining("/console"));
    expect(opened.consoleErrors.join("\n")).not.toContain("old console");
    expect(JSON.stringify(opened.network)).not.toContain("old-bad");
    for (const secret of [
      "OLD_SCOPE_SECRET", "SUCCESS_SECRET", "HTTP_SECRET", "STREAM_SECRET",
      "OLD_CONSOLE_SECRET", "CONSOLE_SECRET", "CONSOLE_PASSWORD", "CONSOLE_BEARER"
    ]) {
      expect(JSON.stringify(opened)).not.toContain(secret);
    }

    // Actions and explicit observe calls retain the current navigation's
    // baseline instead of silently starting a new evidence window.
    const acted = await explore("act", {
      action: { kind: "click", role: "button", name: "Load after action" }
    });
    expect(acted).toMatchObject({ source: "act", actionKind: "click", actionsSinceOpen: 1 });
    expect(acted.network.recent2xx).toContainEqual(
      expect.objectContaining({ resourceType: "Fetch", url: "/after-action", status: 200 })
    );
    expect(JSON.stringify(acted.network)).not.toContain("ACTION_SECRET");

    const observed = await explore("observe", {});
    expect(observed.tabId).toBe(opened.tabId);
    expect(observed.observationId).not.toBe(acted.observationId);
    expect(observed.source).toBe("observe");
    expect(observed.actionsSinceOpen).toBe(1);
    expect(observed.network.recent2xx).toContainEqual(
      expect.objectContaining({ url: "/after-action", status: 200 })
    );
    expect(observed.quiet.outcome).toBe("quiet");

    // A full-page navigation caused by an action keeps the visit evidence
    // window, but reports a sanitized current URL and only safe action kind.
    const navigated = await explore("act", {
      action: { kind: "click", role: "button", name: "Navigate after action" }
    });
    expect(navigated).toMatchObject({ source: "act", actionKind: "click", actionsSinceOpen: 2 });
    expect(navigated.url).toBe(`${fixtureBase}/action-destination`);
    expect(navigated.network.summary.windowStartedAt).toBe(opened.network.summary.windowStartedAt);
    expect(JSON.stringify(navigated)).not.toContain("ACTION_NAV_SECRET");

    const closed = await explore("close", {});
    expect(closed).toMatchObject({ closed: true, retainedEvidence: true });
  }, 60_000);

  it("separates expected redirects from HTTP errors and sanitizes the final URL", async () => {
    const redirected = await explore("open", { path: "/redirect-start", viewport: "desktop" });
    expect(redirected.source).toBe("open");
    expect(redirected.url).toBe(`${fixtureBase}/redirect-final`);
    expect(JSON.stringify(redirected)).not.toContain("FINAL_URL_SECRET");
    expect(redirected.network.summary).toEqual(expect.objectContaining({
      non2xx: 1,
      redirects: 1,
      httpErrors: 0
    }));
    expect(redirected.network.issues.httpErrors).toEqual([]);
    expect(redirected.network.otherResponses.redirects).toContainEqual(
      expect.objectContaining({ resourceType: "Document", url: "/redirect-start", status: 302 })
    );
    await explore("close", {});
  }, 30_000);

  it("reports an ordinary hanging Fetch as bounded pending and a streaming Fetch as persistent", async () => {
    const pending = await explore("open", { path: "/pending-page", viewport: "desktop" });
    expect(pending.quiet).toMatchObject({
      outcome: "budget-exhausted",
      networkQuiet: false,
      timedOut: true
    });
    expect(pending.network.summary).toEqual(expect.objectContaining({ pending: 1, persistent: 0 }));
    expect(pending.network.issues.pending).toContainEqual(
      expect.objectContaining({ resourceType: "Fetch", url: "/ordinary-hang", status: 200, pending: true, persistent: false })
    );
    expect(JSON.stringify(pending)).not.toContain("PENDING_SECRET");

    const streaming = await explore("open", { path: "/stream-fetch-page", viewport: "desktop" });
    expect(streaming.quiet).toMatchObject({
      outcome: "quiet",
      networkQuiet: true,
      timedOut: false,
      persistentRequests: 1
    });
    expect(streaming.network.summary).toEqual(expect.objectContaining({ pending: 0, persistent: 1 }));
    expect(streaming.network.issues.persistent).toContainEqual(
      expect.objectContaining({ resourceType: "Fetch", url: "/stream-fetch", status: 200, pending: true, persistent: true })
    );
    expect(JSON.stringify(streaming)).not.toContain("FETCH_STREAM_SECRET");
    await explore("close", {});
  }, 30_000);

  it("takes a bounded quiet receipt immediately before blessing an assertion", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: { name: "explore fixture", url: fixtureBase } })
    });
    const opened = await explore("open", { path: "/delayed", viewport: "desktop" });

    // Schedule a same-URL mutation after assertExplore begins observing. Without
    // its pre-assert quiet gate the real Browser locator probe sees no button.
    const scheduled = await fetch(`${BROWSER_BASE}/tabs/${encodeURIComponent(opened.tabId)}/eval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        js: "setTimeout(() => { const b = document.createElement('button'); b.textContent = 'Arrived'; document.body.appendChild(b); }, 250); true"
      })
    });
    expect(scheduled.status).toBe(200);

    const verdict = await explore("assert", {
      assertion: { kind: "visible", role: "button", name: "Arrived" }
    });
    expect(verdict).toMatchObject({
      passed: true,
      kind: "visible",
      observationId: expect.stringMatching(/^observation-[a-f0-9]{12}-\d{4}$/),
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      quiet: { outcome: "quiet", domStable: true }
    });
    expect(verdict.source).toBe("assert");
    expect(verdict.network.summary.windowStartedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(verdict.browserContext).toEqual(expect.objectContaining({ navigationAgeMs: expect.any(Number) }));

    const closed = await explore("close", {});
    expect(closed).toMatchObject({ closed: true, retainedEvidence: true });
    const reopened = await explore("open", { path: "/delayed", viewport: "desktop" });
    expect(reopened.tabId).not.toBe(opened.tabId);
    expect(reopened.actionsSinceOpen).toBe(0);
    await explore("close", {});
  }, 30_000);

  it("refuses an assertion verdict when the page changes between its receipt and evaluation", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app: { name: "explore fixture", url: fixtureBase } })
    });
    await explore("open", { path: "/delayed", viewport: "desktop" });
    mutateDuringNextAssertion = true;
    const response = await fetch(`${DRILL_BASE}/api/explore/assert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        root: target,
        assertion: { kind: "visible", selector: "#race-during-assert" }
      })
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("page changed while the assertion was evaluated")
    });
    await explore("close", {});
  }, 30_000);
});
