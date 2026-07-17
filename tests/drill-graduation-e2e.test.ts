import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Phase 5 acceptance bar: a vision run graduates to a committed spec, and the
// EMITTED SPEC actually re-runs green with ZERO model calls (self-test item
// 3). Drives the real engine end to end, then executes the real emitted spec
// file through `playwright test` (not just inspects its source), with a trap
// stub that would fail loudly if anything tried to reach the Model Router.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7223;
const AUTOMATIONS_PORT = 7224;
const DRILL_PORT = 7225;
const STUB_PORT = 7226;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-grad-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-grad-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-grad-target-"));
// The Playwright config used to RUN the emitted spec must live inside the
// repo so its own `@playwright/test` import resolves via the repo's
// node_modules — testDir then points at the external target's spec dir.
const pwConfigPath = path.join(REPO, `.tmp-drill-graduation-pw-config-${process.pid}.mjs`);

let browserSrv: ChildProcess | null = null;
let automationsSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let visionStub: http.Server | null = null;
let visionCallCount = 0;
let trapStub: http.Server | null = null;
let trapHit = false;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Undici keep-alive race, seen only under full-suite CPU starvation: the
// drill server's idle keep-alive timeout slams a pooled socket shut exactly
// as the next request reuses it ("other side closed"), and undici refuses to
// retry non-idempotent methods on its own. The long spawnSync playwright runs
// in this file create exactly those idle gaps. One retry on a fresh
// connection is safe here - every body in this file is idempotent.
async function fetchRetry(url: string, init?: RequestInit) {
  try {
    return await fetch(url, init);
  } catch {
    return await fetch(url, init);
  }
}

// Deterministically resolves the vision "verify" call to a `visible` assertion
// on the CURRENT expected testId (mutable, so the healer test can simulate a
// rename mid-suite) — enough for the automations engine to write the cache
// AND (per the browser-orchestrator fix) surface it on the step result for
// graduation to pick up.
let visionTargetTestId = "answer";
function startVisionStub(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        visionCallCount += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: { passed: true, reasoning: "visible in a11y tree", assertion: { kind: "visible", testId: visionTargetTestId } } }));
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve(srv));
  });
}

// A trap the EMITTED SPEC must never reach — if the "zero model calls"
// promise is broken, this records it.
function startTrapStub(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      trapHit = true;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the emitted spec called the Model Router — it must not" }));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const FIXTURE_URL = "data:text/html," + encodeURIComponent('<div data-testid="answer">The answer.</div>');

beforeAll(async () => {
  visionStub = await startVisionStub();
  trapStub = await startTrapStub();

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

  await fetchRetry(`${DRILL_BASE}/api/drillbook`, {
    // These tests exercise graduation, not the A5/R7 gate — run immediately.
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: FIXTURE_URL }, autonomy: "auto" })
  });
  await fetchRetry(`${DRILL_BASE}/api/pages/answer`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Answer", path: "",
      steps: [{ id: "s-vision", area: 0, mode: "vision", enabled: true, state: "default", viewports: ["desktop"], description: "answer is visible", tags: [] }]
    })
  });
}, 30000);

afterAll(async () => {
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  if (automationsSrv && !automationsSrv.killed) automationsSrv.kill("SIGKILL");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  await new Promise((r) => visionStub?.close(() => r(undefined)));
  await new Promise((r) => trapStub?.close(() => r(undefined)));
  browserSrv = null; automationsSrv = null; drillSrv = null; visionStub = null; trapStub = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
  rmSync(pwConfigPath, { force: true });
});

describe("vision -> e2e graduation, real engine, real emitted spec", () => {
  it("a vision-mode step run graduates: mode flips to e2e, spec is written, and re-running it is green with ZERO model calls", async () => {
    const runRes = await fetchRetry(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"], contextTag: "drill" })
    });
    expect(runRes.status, await runRes.clone().text()).toBe(200);
    const { run } = await runRes.json();
    const entry = run.pages.find((p: any) => p.stepId === "s-vision");
    expect(entry.result.tier).toBe("vision");
    expect(entry.graduated).toBeTruthy();
    expect(visionCallCount).toBeGreaterThan(0); // the ORIGINAL vision resolution did call the router — expected

    const pageDoc = await (await fetchRetry(`${DRILL_BASE}/api/pages/answer`)).json();
    const step = pageDoc.page.steps.find((s: any) => s.id === "s-vision");
    expect(step.mode).toBe("e2e");
    expect(step.assertion).toEqual({ kind: "visible", testId: "answer" });
    expect(step.spec).toBe("tests/drills/answer.spec.ts#s-vision");

    const specFile = path.join(target, "tests", "drills", "answer.spec.ts");
    expect(existsSync(specFile)).toBe(true);
    const specSrc = readFileSync(specFile, "utf8");
    expect(specSrc).toContain('await expect(page.getByTestId("answer")).toBeVisible();');
    expect(specSrc).not.toContain("drillJudge"); // no judgment steps on this page

    // Execute the REAL emitted spec via the real Playwright test runner.
    // Node's module resolution walks up from the SPEC FILE's own disk
    // location (a /tmp target repo, in this test) — symlink node_modules so
    // `import ... from "@playwright/test"` resolves without installing a
    // second copy of Playwright into a throwaway directory.
    symlinkSync(path.join(REPO, "node_modules"), path.join(target, "node_modules"), "dir");
    // GARRISON_BASE_URL points at the TRAP — a deterministic Playwright
    // expect() call never touches it; only a drillJudge() call would.
    writeFileSync(
      pwConfigPath,
      `import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ${JSON.stringify(path.join(target, "tests", "drills"))},
  outputDir: ${JSON.stringify(path.join(target, "test-results"))},
  timeout: 30000,
  reporter: [["line"]],
  use: { headless: true }
});
`
    );
    const trapBase = `http://127.0.0.1:${(trapStub!.address() as any).port}`;
    const run1 = spawnSync("npx", ["playwright", "test", "--config", pwConfigPath], {
      cwd: REPO,
      env: { ...process.env, GARRISON_BASE_URL: trapBase },
      encoding: "utf8"
    });
    expect(run1.status, `stdout:\n${run1.stdout}\nstderr:\n${run1.stderr}`).toBe(0);
    expect(trapHit, "the emitted spec made a call that reached the Model Router trap — it must make ZERO model calls").toBe(false);

    // Run it again for good measure (genuinely re-runnable, not a one-shot).
    trapHit = false;
    const run2 = spawnSync("npx", ["playwright", "test", "--config", pwConfigPath], {
      cwd: REPO,
      env: { ...process.env, GARRISON_BASE_URL: trapBase },
      encoding: "utf8"
    });
    expect(run2.status, `stdout:\n${run2.stdout}\nstderr:\n${run2.stderr}`).toBe(0);
    expect(trapHit).toBe(false);
  }, 60000);

  it("healer (B7): a renamed testid breaks the graduated assertion, heals via vision (tier recovered), and re-emits", async () => {
    // Simulate "renaming a testid in the fixture" by pointing the SAME page
    // at a new fixture whose element carries a different testId, and telling
    // the vision stub the new truth — the OLD cached/graduated assertion
    // (testId "answer") will no longer resolve, forcing a vision fallback.
    const RENAMED_FIXTURE = "data:text/html," + encodeURIComponent('<div data-testid="answer-v2">The answer.</div>');
    visionTargetTestId = "answer-v2";
    await fetchRetry(`${DRILL_BASE}/api/drillbook`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ app: { name: "f", url: RENAMED_FIXTURE } })
    });

    const callsBefore = visionCallCount;
    const runRes = await fetchRetry(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"], contextTag: "drill" })
    });
    const { run } = await runRes.json();
    const entry = run.pages.find((p: any) => p.stepId === "s-vision");
    expect(entry.result.tier).toBe("recovered"); // healed, not a fresh vision resolve
    expect(visionCallCount).toBeGreaterThan(callsBefore); // vision WAS consulted to heal it
    expect(entry.graduated).toBeTruthy();

    const pageDoc = await (await fetchRetry(`${DRILL_BASE}/api/pages/answer`)).json();
    const step = pageDoc.page.steps.find((s: any) => s.id === "s-vision");
    expect(step.assertion).toEqual({ kind: "visible", testId: "answer-v2" });

    const specSrc = readFileSync(path.join(target, "tests", "drills", "answer.spec.ts"), "utf8");
    expect(specSrc).toContain("answer-v2");
    expect(specSrc).not.toContain('"answer"'); // the stale anchor is gone, not just appended

    // Re-running the (already-updated) spec file is green again, still zero
    // model calls — the healed assertion is now itself fully deterministic.
    const trapBase = `http://127.0.0.1:${(trapStub!.address() as any).port}`;
    trapHit = false;
    const run3 = spawnSync("npx", ["playwright", "test", "--config", pwConfigPath], {
      cwd: REPO,
      env: { ...process.env, GARRISON_BASE_URL: trapBase },
      encoding: "utf8"
    });
    expect(run3.status, `stdout:\n${run3.stdout}\nstderr:\n${run3.stderr}`).toBe(0);
    expect(trapHit).toBe(false);
  }, 30000);
});
