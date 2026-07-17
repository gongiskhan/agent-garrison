import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 7 / R12 / F8 — the blind adversarial pass: a second drill run,
// contextTag "drill-adversarial", bypassCache true, and BLIND compilation
// (no cachedAssertion/areaHint reaches the engine or the vision prompt even
// for an already-graduated step) — plus proof the vision call carries the
// contextTag so a composition's routing config CAN target it at a different
// model (R12 "a different model set in the composition").

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7232;
const AUTOMATIONS_PORT = 7233;
const DRILL_PORT = 7234;
const STUB_PORT = 7235;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-adv-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-adv-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-adv-target-"));

let browserSrv: ChildProcess | null = null;
let automationsSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let stub: http.Server | null = null;
const visionRequests: any[] = [];

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
        visionRequests.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        // The fixture's real testId is "answer" — the blind pass never
        // receives it (no areaHint/cachedAssertion), so it must reason from
        // the description alone; the stub still resolves it correctly here
        // to prove the RUN reaches a real verdict, not that it guesses right.
        res.end(JSON.stringify({ result: { passed: true, reasoning: "found via description", assertion: { kind: "visible", testId: "answer" } } }));
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
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: FIXTURE_URL } })
  });
  await fetch(`${DRILL_BASE}/api/pages/answer`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Answer", path: "",
      areas: [{ n: 1, id: "answer#1", label: "Answer", anchors: { testId: "answer" }, pct: null }],
      // Already graduated (as a normal pass would leave it) — the blind
      // pass must ignore this entirely.
      steps: [{ id: "s1", area: 1, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "answer is visible", assertion: { kind: "visible", testId: "SHOULD-NEVER-BE-SEEN-BY-BLIND-PASS" }, tags: [] }]
    })
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

describe("blind adversarial pass (R12/F8)", () => {
  it("is blind to the graduated assertion/cache, vision-forced, tagged drill-adversarial, and never graduates", async () => {
    visionRequests.length = 0;
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"], blind: true })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { run } = await res.json();
    expect(run.contextTag).toBe("drill-adversarial");

    const entry = run.pages.find((p: any) => p.stepId === "s1");
    expect(entry.status).toBe("completed");
    expect(entry.graduated).toBeUndefined(); // never graduates during a blind pass

    // The vision call it DID make never saw the planted stale assertion —
    // proof the compile step really was blind, not just "happened to work."
    expect(visionRequests.length).toBeGreaterThan(0);
    for (const r of visionRequests) {
      expect(JSON.stringify(r.step)).not.toContain("SHOULD-NEVER-BE-SEEN-BY-BLIND-PASS");
      expect(r.step.areaHint).toBeUndefined();
    }
    // contextTag reached the Model Router call — the routing hook R12 needs.
    expect(visionRequests[0].contextTag).toBe("drill-adversarial");

    // The page itself is untouched — no graduation side effect.
    const pageDoc = await (await fetch(`${DRILL_BASE}/api/pages/answer`)).json();
    expect(pageDoc.page.steps[0].assertion).toEqual({ kind: "visible", testId: "SHOULD-NEVER-BE-SEEN-BY-BLIND-PASS" });
  }, 30000);

  it("bypassCache is forced even if the caller tries to turn it off", async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"], blind: true, bypassCache: false })
    });
    const { run } = await res.json();
    expect(run.contextTag).toBe("drill-adversarial"); // still forced regardless of caller intent
  }, 20000);
});
