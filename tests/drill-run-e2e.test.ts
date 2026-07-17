import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Run path (Phase 4): compile each enabled step to its own inline ephemeral
// automation run, run it for real through automations + browser-default,
// verify tier badges/evidence come back on the assembled Drill run view, and
// that a failing step auto-pools as a finding.
//
// A local stub stands in for the Garrison backend's Model Router
// (/api/automations/vision) so a deterministic-assertion FAILURE's vision
// fallback is hermetic — it must never depend on (or bill) whatever real
// Garrison instance happens to be running on the dev machine's port 7777.

const REPO = path.resolve(__dirname, "..");
const BROWSER_START = path.join(REPO, "fittings", "seed", "browser-default", "scripts", "start.mjs");
const AUTOMATIONS_START = path.join(REPO, "fittings", "seed", "automations", "scripts", "start.mjs");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const BROWSER_PORT = 7194;
const AUTOMATIONS_PORT = 7222; // unique across the suite — 7195 is file-browser.test.ts's
const DRILL_PORT = 7201;
const STUB_PORT = 7202;
const BROWSER_BASE = `http://127.0.0.1:${BROWSER_PORT}`;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-run-home-"));
const adir = mkdtempSync(path.join(tmpdir(), "garrison-run-autos-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-run-target-"));

let browserSrv: ChildProcess | null = null;
let automationsSrv: ChildProcess | null = null;
let drillSrv: ChildProcess | null = null;
let stubSrv: http.Server | null = null;

async function waitHealthy(base: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/health`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function startVisionStub(): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body: any = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* ignore */ }
        res.writeHead(200, { "content-type": "application/json" });
        if (body.mode === "verify") {
          // The deterministic assertion already told us the truth; the stub
          // just confirms it (mirrors what a real vision check would do for
          // an assertion that is genuinely false) so the run behaves exactly
          // like a real, working vision fallback would, deterministically.
          res.end(JSON.stringify({ result: { passed: false, reasoning: "stub: element not found" } }));
        } else if (body.mode === "fix") {
          res.end(JSON.stringify({ result: { kind: "abort", reasoning: "stub: no fix available" } }));
        } else {
          res.end(JSON.stringify({ result: { passed: false, reasoning: "stub" } }));
        }
      });
    });
    srv.listen(STUB_PORT, "127.0.0.1", () => resolve(srv));
  });
}

// A page with one passing element (visible) and one intentionally-failing
// assertion target (no such testid).
const FIXTURE_URL =
  "data:text/html," +
  encodeURIComponent(
    '<div data-testid="answer" role="article">The answer, with a citation.</div>'
  );

beforeAll(async () => {
  stubSrv = await startVisionStub();

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
    method: "PATCH", headers: { "content-type": "application/json" },
    // These tests exercise the run path, not the A5/R7 gate — run immediately.
    body: JSON.stringify({ app: { name: "fixture", url: FIXTURE_URL }, autonomy: "auto" })
  });
  await fetch(`${DRILL_BASE}/api/pages/answer`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Answer",
      path: "",
      areas: [{ n: 1, id: "answer#1", label: "Answer", anchors: { testId: "answer" }, pct: null }],
      steps: [
        { id: "s-pass", area: 1, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "answer is visible", assertion: { kind: "visible", testId: "answer" }, tags: [] },
        { id: "s-fail", area: 0, mode: "e2e", enabled: true, state: "default", viewports: ["desktop"], description: "nonexistent element is visible", assertion: { kind: "visible", testId: "does-not-exist" }, tags: [] },
        { id: "s-disabled", area: 0, mode: "vision", enabled: false, state: "default", viewports: ["desktop"], description: "should never run", tags: [] }
      ]
    })
  });
}, 30000);

afterAll(async () => {
  if (browserSrv && !browserSrv.killed) browserSrv.kill("SIGTERM");
  if (automationsSrv && !automationsSrv.killed) automationsSrv.kill("SIGKILL");
  if (drillSrv && !drillSrv.killed) drillSrv.kill("SIGKILL");
  await new Promise((r) => stubSrv?.close(() => r(undefined)));
  browserSrv = null; automationsSrv = null; drillSrv = null; stubSrv = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(adir, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("POST /api/runs (compile + run through the real engine)", () => {
  it("runs each enabled step as its own automation, returns tier/evidence per step, and auto-pools the failing step as a finding", async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"], contextTag: "drill" })
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { run } = await res.json();

    const stepIds = run.pages.map((p: any) => p.stepId);
    expect(stepIds).toContain("s-pass");
    expect(stepIds).toContain("s-fail");
    expect(stepIds).not.toContain("s-disabled"); // never compiled — it was disabled

    const passEntry = run.pages.find((p: any) => p.stepId === "s-pass");
    expect(passEntry.status).toBe("completed");
    expect(["cached", "vision", "recovered"]).toContain(passEntry.result.tier);
    expect(passEntry.result.evidencePath).toBeTruthy();

    const failEntry = run.pages.find((p: any) => p.stepId === "s-fail");
    // the run that CONTAINS s-fail ends "failed" (engine halts on an aborted
    // fixer) — the Drill-level record still captures its automationRunId
    // and reference so the finding below can be traced back to it.
    expect(failEntry.automationRunId).toBeTruthy();

    const findings = run.findings.filter((f: any) => f.kind === "step-fail");
    expect(findings.some((f: any) => f.stepId === "s-fail")).toBe(true);
    expect(findings.find((f: any) => f.stepId === "s-fail").status).toBe("proposed");
    // s-pass must NOT have been swept up as a failure by s-fail's run.
    expect(findings.some((f: any) => f.stepId === "s-pass")).toBe(false);
  }, 30000);
});

describe("feedback / override / observation / triage", () => {
  let runId: string;
  beforeAll(async () => {
    const res = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"] })
    });
    runId = (await res.json()).run.id;
  }, 20000);

  it("feedback attaches a note without re-running", async () => {
    const r = await fetch(`${DRILL_BASE}/api/runs/${runId}/feedback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: "answer", stepId: "s-pass", note: "renders a bit slow" })
    });
    const j = await r.json();
    expect(j.run.feedback["answer:s-pass"][0].note).toBe("renders a bit slow");
  });

  it("override flips a pass to failed and pools a verdict-flip finding", async () => {
    const r = await fetch(`${DRILL_BASE}/api/runs/${runId}/override`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageId: "answer", stepId: "s-pass", verdict: "failed", note: "actually wrong on inspection" })
    });
    const j = await r.json();
    expect(j.run.overrides["answer:s-pass"]).toMatchObject({ verdict: "failed" });
    expect(j.run.findings.some((f: any) => f.kind === "verdict-flip" && f.stepId === "s-pass")).toBe(true);
  });

  it("observation records, then converts to a draft step and a finding", async () => {
    const addRes = await fetch(`${DRILL_BASE}/api/runs/${runId}/observation`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Sources panel flickered during streaming." })
    });
    const { observation } = await addRes.json();

    const stepRes = await fetch(`${DRILL_BASE}/api/runs/${runId}/observation/${observation.id}/convert-step`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "answer" })
    });
    const stepJson = await stepRes.json();
    expect(stepJson.step.description).toBe("Sources panel flickered during streaming.");
    const pageDoc = await (await fetch(`${DRILL_BASE}/api/pages/answer`)).json();
    expect(pageDoc.page.steps.some((s: any) => s.id === stepJson.step.id)).toBe(true);

    const findingRes = await fetch(`${DRILL_BASE}/api/runs/${runId}/observation/${observation.id}/convert-finding`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId: "answer" })
    });
    const { finding, run } = await findingRes.json();
    expect(finding.kind).toBe("observation");
    expect(run.observations.find((o: any) => o.id === observation.id)).toMatchObject({ convertedToStep: stepJson.step.id, convertedToFinding: finding.id });
  });

  it("triage: confirm one finding, dismiss another", async () => {
    const before = await (await fetch(`${DRILL_BASE}/api/runs/${runId}`)).json();
    const [f1, f2] = before.run.findings;
    const c1 = await fetch(`${DRILL_BASE}/api/runs/${runId}/findings/${f1.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" })
    });
    expect((await c1.json()).run.findings.find((f: any) => f.id === f1.id).status).toBe("confirmed");
    if (f2) {
      const c2 = await fetch(`${DRILL_BASE}/api/runs/${runId}/findings/${f2.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "dismissed" })
      });
      expect((await c2.json()).run.findings.find((f: any) => f.id === f2.id).status).toBe("dismissed");
    }
  });

  it("dispatch: 400s with nothing confirmed; 502s clearly when kanban-loop is not running", async () => {
    const freshRes = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["answer"], viewports: ["desktop"] })
    });
    const freshId = (await freshRes.json()).run.id;
    const noConfirmed = await fetch(`${DRILL_BASE}/api/runs/${freshId}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual" })
    });
    expect(noConfirmed.status).toBe(400);

    // now confirm the run's finding and dispatch with no kanban-loop running
    const doc = await (await fetch(`${DRILL_BASE}/api/runs/${freshId}`)).json();
    const f = doc.run.findings[0];
    expect(f).toBeTruthy();
    await fetch(`${DRILL_BASE}/api/runs/${freshId}/findings/${f.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" })
    });
    const dispatchRes = await fetch(`${DRILL_BASE}/api/runs/${freshId}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "manual" })
    });
    expect(dispatchRes.status).toBe(502);

    // heartbeat mode records intent without requiring kanban-loop at all
    const heartbeatRes = await fetch(`${DRILL_BASE}/api/runs/${freshId}/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "heartbeat" })
    });
    expect(heartbeatRes.status).toBe(200);
    expect((await heartbeatRes.json())).toMatchObject({ dispatched: false, mode: "heartbeat" });
  }, 20000);
});
