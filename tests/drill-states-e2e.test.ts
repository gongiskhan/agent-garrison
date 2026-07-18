import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 6 (States) — snapshot capture/promote through the real server + a
// real browser tab, and the reach-path-before-scoped-step run mechanism
// (self-test item 6's core): the reach path executes first and its action
// gets cached on the second run (C5's "action cache makes reaching cheap
// after the first time").

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7228;
const AUTOMATIONS_PORT = 7229;
const DRILL_PORT = 7230;
const STUB_PORT = 7231;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-states-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-states-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-states-target-"));

let browserSrv: ChildProcess | null = null;
let automationsSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let stub: http.Server | null = null;
let actionCalls = 0;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startStub(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        if (body.mode === "action") {
          actionCalls += 1;
          res.end(JSON.stringify({ result: { kind: "click", testId: "start-build-btn" } }));
        } else {
          res.end(JSON.stringify({ result: { passed: false, reasoning: "stub" } }));
        }
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve(srv));
  });
}

const FIXTURE_URL =
  "data:text/html," +
  encodeURIComponent(
    '<h1>Idle</h1>' +
      '<button data-testid="start-build-btn" onclick="document.getElementById(\'p\').style.display=\'block\'">Start</button>' +
      '<div id="p" data-testid="progress-bar" style="display:none">Building…</div>'
  );

beforeAll(async () => {
  stub = await startStub();

  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore", env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15000)).toBe(true);

  automationsSrv = spawn("node", [AUTOMATIONS_START], {
    stdio: "ignore",
    env: {
      ...process.env, GARRISON_HOME: ghome, GARRISON_AUTOMATIONS_DIR: adir, GARRISON_BROWSER_URL: BROWSER_BASE,
      GARRISON_BASE_URL: STUB_BASE, AUTOMATIONS_UI_PORT: String(AUTOMATIONS_PORT), AUTOMATIONS_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(AUTOMATIONS_BASE, 8000)).toBe(true);

  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target, DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1" }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);

  await fetch(`${DRILL_BASE}/api/drillbook`, {
    // These tests exercise reach paths, not the A5/R7 gate — run immediately.
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: FIXTURE_URL }, autonomy: "auto" })
  });
}, 30000);

afterAll(async () => {
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  if (automationsSrv && !automationsSrv.killed) automationsSrv.kill("SIGKILL");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  await new Promise((r) => stub?.close(() => r(undefined)));
  browserSrv = null; automationsSrv = null; drillSrv = null; stub = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("snapshot capture + promote, real tab", () => {
  it("captures a snapshot from the live authoring tab, lists it, promotes it, and serves its screenshot", async () => {
    await fetch(`${DRILL_BASE}/api/pages/build`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Builder", path: "" }) });

    const authoring = await (await fetch(`${DRILL_BASE}/api/authoring/tab`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: "build", viewport: "desktop" })
    })).json();
    const changed = await (await fetch(`${BROWSER_BASE}/tabs/${authoring.tabId}/eval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ js: "document.querySelector('h1').textContent = 'Live authoring state'" })
    })).json();
    expect(changed.ok).toBe(true);

    const snapRes = await fetch(`${DRILL_BASE}/api/states/build/snapshot`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ viewport: "desktop" })
    });
    expect(snapRes.status, await snapRes.clone().text()).toBe(200);
    const { snapshot } = await snapRes.json();
    expect(snapshot.pageId).toBe("build");
    expect(snapshot.headingText).toBe("Live authoring state");
    expect(snapshot.screenshotPath).toBeTruthy();

    const listRes = await (await fetch(`${DRILL_BASE}/api/states/build/snapshots`)).json();
    expect(listRes.snapshots.map((s: any) => s.id)).toContain(snapshot.id);

    const promoteRes = await fetch(`${DRILL_BASE}/api/states/build/promote`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: snapshot.id, label: "idle", reachPath: [] })
    });
    expect(promoteRes.status).toBe(200);
    const { state } = await promoteRes.json();
    expect(state.id).toBe("idle");
    expect(state.screenshotPath).toBe(snapshot.screenshotPath);

    const shotRes = await fetch(`${DRILL_BASE}/api/states/build/idle/screenshot`);
    expect(shotRes.status).toBe(200);
    expect(shotRes.headers.get("content-type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await shotRes.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(await (await fetch(`${DRILL_BASE}/api/states/build/idle/screenshot-status`)).json()).toEqual({ available: true });
  }, 20000);

  it("404s a screenshot request for an unknown state", async () => {
    const res = await fetch(`${DRILL_BASE}/api/states/build/nonexistent/screenshot`);
    expect(res.status).toBe(404);
    const status = await fetch(`${DRILL_BASE}/api/states/build/nonexistent/screenshot-status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ available: false });
  });
});

describe("reach path (C5): executes before the scoped step, caches on the second run", () => {
  it("run 1: the reach action resolves via vision (miss) and the state-scoped assertion then passes; run 2: the reach action is cached (no new vision call)", async () => {
    await fetch(`${DRILL_BASE}/api/pages/build2`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Builder2", path: "",
        states: [{ id: "building", label: "building", reachPath: [{ id: "reach-start", description: "click the start build button" }] }],
        steps: [{ id: "s-progress", area: 0, mode: "e2e", enabled: true, state: "building", viewports: ["desktop"], description: "progress bar visible", assertion: { kind: "visible", testId: "progress-bar" }, tags: [] }]
      })
    });

    const callsBefore = actionCalls;
    const run1 = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["build2"], viewports: ["desktop"], state: "building" })
    });
    const { run: run1Body } = await run1.json();
    const entry1 = run1Body.pages.find((p: any) => p.stepId === "s-progress");
    expect(entry1.status, JSON.stringify(entry1)).toBe("completed"); // reach path ran, progress bar became visible, assertion passed
    expect(actionCalls).toBe(callsBefore + 1); // the reach action DID need vision the first time
    const pageAfterRun1 = await (await fetch(`${DRILL_BASE}/api/pages/build2`)).json();
    const seededState = pageAfterRun1.page.states.find((state: any) => state.id === "building");
    expect(seededState.screenshotPath).toBeTruthy();
    expect(seededState.referenceSource).toMatchObject({
      runId: run1Body.id,
      stepId: "s-progress",
      viewportId: "desktop"
    });
    expect(seededState.matcher).toEqual({
      assertion: { kind: "visible", testId: "progress-bar" }
    });

    const run2 = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["build2"], viewports: ["desktop"], state: "building" })
    });
    const { run: run2Body } = await run2.json();
    const entry2 = run2Body.pages.find((p: any) => p.stepId === "s-progress");
    expect(entry2.status).toBe("completed");
    expect(actionCalls).toBe(callsBefore + 1); // NOT +2 — the reach action was cached, no new vision call
    const pageAfterRun2 = await (await fetch(`${DRILL_BASE}/api/pages/build2`)).json();
    expect(pageAfterRun2.page.states.find((state: any) => state.id === "building").referenceSource.runId).toBe(run1Body.id);
  }, 30000);
});
