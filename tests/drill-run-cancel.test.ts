// A multi-hour Drill run had no safe stop: the only way to halt one was
// restarting the fitting, which circuit-breaks the record as
// `drill-restarted-mid-run` and reads as an infra fault in every incident
// surface. POST /api/runs/:id/cancel is the safe stop, and the property that
// matters is that a user-requested stop is NOT a failure - it must never
// produce a circuit, an infra incident, or a finding.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const AUTOMATIONS_PORT = 7395;
const DRILL_PORT = 7396;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

// Enough steps that a cancel lands mid-run, slow enough that the poll below
// reliably catches the run in flight.
const STEP_IDS = ["one", "two", "three", "four", "five", "six"];
const STEP_DELAY_MS = 250;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-drill-cancel-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-drill-cancel-target-"));

let drill: ChildProcess | null = null;
let automations: http.Server | null = null;

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

// Every check passes, slowly. A cancel must be visible against a run that is
// otherwise perfectly healthy - if checks failed, a circuit could mask it.
function startAutomationsStub() {
  return new Promise<http.Server>((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/runs/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"run":{"id":"hydrate","status":"completed","steps":[]}}');
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
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const stepId = body.automation.steps.at(-1).id;
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            run: {
              id: `cancel-run-${stepId}`,
              status: "completed",
              steps: [{ stepId, status: "completed", tier: "vision", result: { passed: true } }]
            }
          }));
        }, STEP_DELAY_MS);
      });
    });
    server.listen(AUTOMATIONS_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function post(pathname: string, body: unknown) {
  const response = await fetch(`${DRILL_BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: await response.json().catch(() => ({} as any)) };
}

async function getRun(runId: string) {
  const response = await fetch(`${DRILL_BASE}/api/runs/${encodeURIComponent(runId)}`);
  return (await response.json()).run;
}

// background:true returns the in-flight record immediately, which is what the
// UI does and the only way to hold a run open long enough to cancel it.
async function startBackgroundRun() {
  const { status, json } = await post("/api/runs", {
    pageIds: ["checkout"],
    viewports: ["desktop"],
    background: true
  });
  expect(status, JSON.stringify(json)).toBe(200);
  return json.run.id as string;
}

async function waitFor<T>(probe: () => Promise<T | null>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for condition");
}

const waitForEnded = (runId: string, ms = 20000) =>
  waitFor(async () => {
    const run = await getRun(runId);
    return run?.endedAt ? run : null;
  }, ms);

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
    body: JSON.stringify({ autonomy: "auto", app: { name: "fixture", url: "http://example.test" } })
  });
  await fetch(`${DRILL_BASE}/api/pages/checkout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Checkout",
      path: "/checkout",
      steps: STEP_IDS.map((id) => ({
        id,
        area: 0,
        mode: "vision",
        enabled: true,
        state: "default",
        viewports: ["desktop"],
        description: `${id} is correct`,
        tags: []
      }))
    })
  });
}, 20000);

afterAll(async () => {
  if (drill && !drill.killed) drill.kill("SIGTERM");
  await new Promise((resolve) => automations?.close(() => resolve(undefined)));
  drill = null;
  automations = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("Drill run cancel", () => {
  it("stops a running run without recording it as a failure", async () => {
    const runId = await startBackgroundRun();
    // Cancel only once a check has actually executed, so the assertion below
    // proves work was kept rather than the run never having started.
    await waitFor(async () => ((await getRun(runId))?.executedChecks ?? 0) >= 1, 15000);

    const cancel = await post(`/api/runs/${runId}/cancel`, {});
    expect(cancel.status, JSON.stringify(cancel.json)).toBe(200);
    expect(cancel.json).toMatchObject({ canceled: true, runId, already: false });

    const run = await waitForEnded(runId);

    // The point of the feature: a stop is a distinct terminal shape.
    expect(run.canceled).toBeTruthy();
    expect(run.canceled.afterCheck).toBeGreaterThanOrEqual(1);
    expect(run.canceled.skippedChecks).toBeGreaterThan(0);
    // Every planned check is accounted for as either executed or skipped.
    expect(run.canceled.afterCheck + run.canceled.skippedChecks).toBe(STEP_IDS.length);
    expect(run.executedChecks).toBe(run.canceled.afterCheck);
    expect(run.executedChecks).toBeLessThan(STEP_IDS.length);

    // ...and is NOT a fault: no circuit, no incident, no finding. This is the
    // regression that matters - routing a cancel through the circuit path
    // would light up every incident surface for an intended action.
    expect(run.circuit ?? null).toBeNull();
    expect(run.infraErrors ?? []).toHaveLength(0);
    expect(run.findings ?? []).toHaveLength(0);
    // Executed checks keep their real verdicts.
    expect(run.pages).toHaveLength(run.executedChecks);
    expect(run.pages.every((p: any) => p.terminal?.kind === "passed")).toBe(true);
  }, 40000);

  it("is idempotent - a second cancel is not an error", async () => {
    const runId = await startBackgroundRun();
    await waitFor(async () => ((await getRun(runId))?.executedChecks ?? 0) >= 1, 15000);

    const first = await post(`/api/runs/${runId}/cancel`, {});
    const second = await post(`/api/runs/${runId}/cancel`, {});
    expect(first.status).toBe(200);
    expect(first.json.already).toBe(false);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ canceled: true, already: true });
    // The repeat must not move the stop point.
    expect(second.json.at).toBe(first.json.at);

    await waitForEnded(runId);
  }, 40000);

  it("409s on a finished run and on an unknown id", async () => {
    const runId = await startBackgroundRun();
    await waitForEnded(runId);

    const finished = await post(`/api/runs/${runId}/cancel`, {});
    expect(finished.status).toBe(409);
    expect(finished.json).toMatchObject({ canceled: false });
    expect(finished.json.error).toMatch(/already finished/);

    const unknown = await post("/api/runs/01NOTAREALRUNID0000000000/cancel", {});
    expect(unknown.status).toBe(409);
    expect(unknown.json).toMatchObject({ canceled: false });
    expect(unknown.json.error).toMatch(/no run is executing/);
  }, 40000);

  it("a run left alone still completes every check", async () => {
    // Guards the cancel arm itself: an always-true check at the top of the
    // loop would silently truncate every run, and the tests above would still
    // pass because they only assert a partial run.
    const runId = await startBackgroundRun();
    const run = await waitForEnded(runId);
    expect(run.canceled ?? null).toBeNull();
    expect(run.circuit ?? null).toBeNull();
    expect(run.executedChecks).toBe(STEP_IDS.length);
    expect(run.pages).toHaveLength(STEP_IDS.length);
  }, 40000);
});
