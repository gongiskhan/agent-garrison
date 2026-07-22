import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// A-auth — authenticated Drill runs. A login-gated app answers every check's
// fresh navigate with its login screen, so without auth a whole run reads as N
// product failures for one auth problem. The Book's `auth` block makes Drill
// log in ONCE before the checks (the full flow on first run / config change /
// TTL refresh; a cheap probe reuses the cached session otherwise), and a login
// REJECTION collapses into ONE grouped incident + circuit with the checks
// skipped — never N red checks. An engine/app outage during login keeps its
// own component and is NOT blamed on the auth block.

const REPO = path.resolve(__dirname, "..");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
// Unique ports — 7315 collided with drill-evidence-feedback-e2e's AUTOMATIONS_PORT
// and 404'd under the full-suite concurrency. 7318/7319 are unused across tests.
const AUTOMATIONS_PORT = 7318;
const DRILL_PORT = 7319;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-drill-auth-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-drill-auth-target-"));

let drill: ChildProcess | null = null;
let automations: http.Server | null = null;
let inlineCalls = 0;
let seenIds: string[] = [];
// flow-pass: probe fails, flow passes | cached: probe passes | auth-fail: probe
// fails, flow rejects (product) | auth-infra: probe fails, flow hits an engine outage
let mode: "flow-pass" | "cached" | "auth-fail" | "auth-infra" = "flow-pass";

const AUTH_LOGIN_ID = "drill-__auth";
const AUTH_PROBE_ID = "drill-__auth-probe";

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true;
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function startAutomationsStub() {
  return new Promise<http.Server>((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.method !== "POST" || !req.url?.startsWith("/api/automations/run-inline")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end('{"error":"not found"}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        inlineCalls += 1;
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const auto = body.automation;
        seenIds.push(auto.id);
        const lastId = auto.steps.at(-1).id; // "__auth_verify" for auth; the drill step id for a check

        // A login-flow outage: the engine returns a structured infrastructure
        // failure (e.g. the vision router is overloaded) — NOT an auth problem.
        if (auto.id === AUTH_LOGIN_ID && mode === "auth-infra") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            run: {
              id: `run-${inlineCalls}`, status: "failed", error: "vision 503",
              steps: [{ stepId: lastId, status: "failed", error: "vision 503", failure: { class: "infrastructure", component: "vision", code: "vision-overloaded", retryable: true } }]
            }
          }));
          return;
        }

        let passed = true;
        if (auto.id === AUTH_PROBE_ID) passed = mode === "cached";          // cached session still valid?
        else if (auto.id === AUTH_LOGIN_ID) passed = mode !== "auth-fail";  // did the login flow work?
        // else: a product check — always passes here (we only exercise the auth gate)

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          run: {
            id: `run-${inlineCalls}`,
            status: "completed",
            steps: [{ stepId: lastId, status: "completed", tier: "vision", result: { passed, reasoning: passed ? "ok" : "still on the login form" } }]
          }
        }));
      });
    });
    server.listen(AUTOMATIONS_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function runBook() {
  const response = await fetch(`${DRILL_BASE}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageIds: ["home"], viewports: ["desktop"] })
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).run;
}

// Establish a fresh cached-session record (a full flow login) so the next run
// takes the cheap probe path. Resets the call counters afterward.
async function warmUpLogin() {
  const saved = mode;
  mode = "flow-pass";
  await runBook();
  mode = saved;
  inlineCalls = 0;
  seenIds = [];
}

beforeAll(async () => {
  automations = await startAutomationsStub();
  drill = spawn("node", [DRILL_START], {
    stdio: "ignore",
    env: {
      ...process.env,
      GARRISON_HOME: ghome,
      GARRISON_DRILL_TARGET_REPO: target,
      GARRISON_AUTOMATIONS_URL: AUTOMATIONS_BASE,
      DRILL_UI_PORT: String(DRILL_PORT),
      DRILL_UI_HOST: "127.0.0.1"
    }
  });
  expect(await waitHealthy(DRILL_BASE, 8000)).toBe(true);
  await fetch(`${DRILL_BASE}/api/drillbook`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      autonomy: "auto",
      app: { name: "gated", url: "http://example.test" },
      auth: {
        loginPath: "/login",
        steps: ["fill the email field with test@example.test", "fill the password field with correct-horse", "click Sign in"],
        success: "the app shell is visible and no login form remains"
      }
    })
  });
  await fetch(`${DRILL_BASE}/api/pages/home`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Home",
      path: "/home",
      steps: ["hero", "composer"].map((id) => ({
        id, area: 0, mode: "vision", enabled: true, state: "default", viewports: ["desktop"], description: `${id} is correct`, tags: []
      }))
    })
  });
}, 15000);

beforeEach(() => {
  inlineCalls = 0;
  seenIds = [];
  mode = "flow-pass";
  // No cached-session record between tests: each test controls whether a prior
  // login exists (via warmUpLogin) so the probe-vs-flow decision is deterministic.
  rmSync(path.join(ghome, "drill", "auth"), { recursive: true, force: true });
});

afterAll(async () => {
  if (drill && !drill.killed) drill.kill("SIGTERM");
  await new Promise((resolve) => automations?.close(() => resolve(undefined)));
  drill = null;
  automations = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("Drill authenticated runs", () => {
  it("first run (no cached session) runs the full login BEFORE any check, then the checks", async () => {
    mode = "flow-pass";
    const run = await runBook();
    // No prior record -> the probe is skipped (nothing to reuse); the login flow
    // runs, THEN the two checks. Auth strictly precedes the checks.
    expect(seenIds).toEqual([AUTH_LOGIN_ID, "drill-home-hero", "drill-home-composer"]);
    expect(inlineCalls).toBe(3);
    expect(run.circuit).toBeUndefined();
    expect(run.pages).toHaveLength(2);
    expect(run.pages.every((p: any) => p.terminal.kind === "passed")).toBe(true);
    expect(run.infraErrors ?? []).toHaveLength(0);
    expect(run.findings ?? []).toHaveLength(0);
    expect(run.summary).toMatchObject({ failed: 0 });

    // The successful login is recorded per project (drives the cacheMinutes TTL
    // + UI "last authenticated"); it holds no credentials, no cookies.
    const authDir = path.join(ghome, "drill", "auth");
    const recorded = JSON.parse(readFileSync(path.join(authDir, readdirSync(authDir)[0]), "utf8"));
    expect(recorded).toMatchObject({ via: "flow" });
    expect(recorded.loggedInAt).toBeTruthy();
    expect(JSON.stringify(recorded)).not.toContain("correct-horse"); // never persist credentials
  });

  it("reuses a still-valid cached session: the probe passes and the full flow is skipped", async () => {
    await warmUpLogin();
    mode = "cached";
    const run = await runBook();
    expect(seenIds).toEqual([AUTH_PROBE_ID, "drill-home-hero", "drill-home-composer"]);
    expect(seenIds).not.toContain(AUTH_LOGIN_ID);
    expect(inlineCalls).toBe(3);
    expect(run.circuit).toBeUndefined();
    expect(run.pages).toHaveLength(2);
  });

  it("a probe miss (the cached session died) re-runs the full login, then the checks", async () => {
    await warmUpLogin();
    mode = "flow-pass"; // prior record exists -> probe runs, misses, flow re-runs
    const run = await runBook();
    expect(seenIds).toEqual([AUTH_PROBE_ID, AUTH_LOGIN_ID, "drill-home-hero", "drill-home-composer"]);
    expect(inlineCalls).toBe(4);
    expect(run.circuit).toBeUndefined();
    expect(run.pages).toHaveLength(2);
  });

  it("collapses a login rejection into ONE incident and skips every check (no N red failures)", async () => {
    mode = "auth-fail";
    const run = await runBook();
    // No prior record -> flow only (no probe); the login is rejected -> NOTHING
    // else runs: the checks never execute.
    expect(seenIds).toEqual([AUTH_LOGIN_ID]);
    expect(inlineCalls).toBe(1);
    expect(run.pages).toHaveLength(0);
    expect(run.findings ?? []).toHaveLength(0); // a login problem is NOT a product finding
    expect(run).toMatchObject({
      plannedChecks: 2,
      executedChecks: 0,
      circuit: { kind: "blocked", component: "auth", code: "auth-failed", afterCheck: 0, skippedChecks: 2 }
    });
    // ONE grouped incident carrying every planned coordinate, not two.
    expect(run.infraErrors).toHaveLength(1);
    expect(run.infraErrors[0]).toMatchObject({ component: "auth", code: "auth-failed", count: 2 });

    const persisted = JSON.parse(readFileSync(path.join(ghome, "drill", "runs", `${run.id}.json`), "utf8"));
    expect(persisted.circuit).toMatchObject({ component: "auth", code: "auth-failed", skippedChecks: 2 });
    expect(persisted.pages).toHaveLength(0);
  });

  it("an engine/app outage DURING login keeps its real component — never blamed on the auth block", async () => {
    mode = "auth-infra";
    const run = await runBook();
    expect(seenIds).toEqual([AUTH_LOGIN_ID]);
    expect(run.pages).toHaveLength(0);
    // The circuit is attributed to the down component (vision), NOT to "auth",
    // so the user is not misdirected to fix drillbook.yml for an engine outage.
    expect(run.circuit).toMatchObject({ kind: "infra-failure", component: "vision", code: "vision-overloaded", skippedChecks: 2 });
    expect(run.circuit.component).not.toBe("auth");
    expect(run.infraErrors).toHaveLength(1);
    expect(run.infraErrors[0]).toMatchObject({ component: "vision", code: "vision-overloaded", count: 2 });
  });
});
