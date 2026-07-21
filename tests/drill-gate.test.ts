import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitExit } from "./helpers/wait-exit";

// A5/R7/S22/self-test-item-10 — the configurable autonomy gate: "gated"
// pauses with a plan diff before running (no automation run happens at all);
// "auto" proceeds and reports; the caller resumes a held gate by re-POSTing
// the returned `resume` object with confirmed:true.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7239;
const AUTOMATIONS_PORT = 7240;
const DRILL_PORT = 7241;
const STUB_PORT = 7242;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-gate-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-gate-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-gate-target-"));

let browserSrv: ChildProcess | null = null;
let automationsSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let stub: http.Server | null = null;
let visionCalls = 0;

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
        visionCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: { passed: true, reasoning: "ok", assertion: { kind: "visible", testId: "answer" } } }));
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve(srv));
  });
}

const FIXTURE_URL = "data:text/html," + encodeURIComponent('<div data-testid="answer">The answer.</div>');

beforeAll(async () => {
  stub = await startStub();
  browserSrv = spawn("node", [BROWSER_START, "--port", String(BROWSER_PORT), "--host", "127.0.0.1"], {
    stdio: "ignore", env: { ...process.env, GARRISON_HOME: ghome }
  });
  expect(await waitHealthy(BROWSER_BASE, 15000)).toBe(true);
  automationsSrv = spawn("node", [AUTOMATIONS_START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_AUTOMATIONS_DIR: adir, GARRISON_BROWSER_URL: BROWSER_BASE, GARRISON_BASE_URL: STUB_BASE, AUTOMATIONS_UI_PORT: String(AUTOMATIONS_PORT), AUTOMATIONS_UI_HOST: "127.0.0.1" }
  });
  expect(await waitHealthy(AUTOMATIONS_BASE, 8000)).toBe(true);
  drillSrv = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: { ...process.env, GARRISON_HOME: ghome, GARRISON_DRILL_TARGET_REPO: target, DRILL_UI_PORT: String(DRILL_PORT), DRILL_UI_HOST: "127.0.0.1" }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);

  await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: FIXTURE_URL } }) });
  await fetch(`${DRILL_BASE}/api/pages/answer`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Answer", path: "", steps: [{ id: "s1", area: 0, mode: "vision", enabled: true, state: "default", viewports: ["desktop"], description: "answer visible", tags: [] }] })
  });
}, 30000);

afterAll(async () => {
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  await waitExit(browserSrv);
  if (automationsSrv && !automationsSrv.killed) automationsSrv.kill("SIGKILL");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  await new Promise((r) => stub?.close(() => r(undefined)));
  browserSrv = null; automationsSrv = null; drillSrv = null; stub = null;
    rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("gated autonomy", () => {
  it("holds with a plan diff and runs NOTHING — zero vision calls, no drill run record created", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomy: "gated" }) });
    visionCalls = 0;
    const before = await (await fetch(`${DRILL_BASE}/api/runs`)).json();

    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"] })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.held).toBe(true);
    expect(body.reason).toBe("gated");
    expect(body.plan).toEqual([{ pageId: "answer", viewportId: "desktop", steps: [{ id: "s1", description: "answer visible", mode: "vision" }] }]);
    expect(body.resume).toMatchObject({ pageIds: ["answer"], viewports: ["desktop"], confirmed: true });
    expect(visionCalls).toBe(0); // NOTHING ran

    const after = await (await fetch(`${DRILL_BASE}/api/runs`)).json();
    expect(after.runs.length).toBe(before.runs.length); // no run record was created by the hold
  });

  it("resuming (confirmed:true) with the returned resume object actually runs it", async () => {
    const held = await (
      await fetch(`${DRILL_BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"] }) })
    ).json();
    expect(held.held).toBe(true);

    const resumed = await fetch(`${DRILL_BASE}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(held.resume) });
    expect(resumed.status).toBe(200);
    const resumedBody = await resumed.json();
    expect(resumedBody.held).toBeUndefined();
    expect(resumedBody.run.pages[0].status).toBe("completed");
    expect(visionCalls).toBeGreaterThan(0); // it actually ran this time
  }, 20000);
});

describe("autonomous mode proceeds and reports", () => {
  it("runs immediately, no hold, when autonomy is auto", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomy: "auto" }) });
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"] })
    });
    const body = await res.json();
    expect(body.held).toBeUndefined();
    expect(body.run.pages[0].status).toBe("completed");
  }, 20000);
});

describe("the blind adversarial pass is never gated, even when autonomy is gated", () => {
  it("runs immediately with blind:true regardless of book.autonomy", async () => {
    await fetch(`${DRILL_BASE}/api/drillbook`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ autonomy: "gated" }) });
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"], blind: true })
    });
    const body = await res.json();
    expect(body.held).toBeUndefined();
    expect(body.run.contextTag).toBe("drill-adversarial");
  }, 20000);
});
