import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const DRILL_START = path.join(REPO, "fittings", "seed", "drill", "scripts", "start.mjs");
const AUTOMATIONS_PORT = 7310;
const DRILL_PORT = 7311;
const AUTOMATIONS_BASE = `http://127.0.0.1:${AUTOMATIONS_PORT}`;
const DRILL_BASE = `http://127.0.0.1:${DRILL_PORT}`;

const ghome = mkdtempSync(path.join(tmpdir(), "garrison-drill-circuit-home-"));
const target = mkdtempSync(path.join(tmpdir(), "garrison-drill-circuit-target-"));

let drill: ChildProcess | null = null;
let automations: http.Server | null = null;
let inlineCalls = 0;
let hydrationGets = 0;
let mode: "product-then-infra" | "product-with-recovery-infra" | "incomplete" | "blocked" | "transport" | "preflight" = "product-then-infra";

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
        res.writeHead(mode === "preflight" ? 503 : 200, { "content-type": "application/json" });
        res.end(mode === "preflight" ? '{"error":"unavailable"}' : '{"status":"ok"}');
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/runs/")) {
        hydrationGets += 1;
        const id = decodeURIComponent(req.url.split("/").at(-1) ?? "");
        const stepId = id === "product-run" ? "total" : id === "infra-run" ? "pay" : "unknown";
        // Deliberately contradictory enrichment: the immutable terminal
        // snapshot must retain the original verdict even if a later detail
        // lookup is stale or points at a differently-shaped record.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          run: {
            id,
            status: "completed",
            steps: [{ stepId, status: "completed", tier: "cached", result: { passed: true } }]
          }
        }));
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
        const stepId = body.automation.steps.at(-1).id;
        if (mode === "transport") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end('{"error":"fetch failed: upstream closed"}');
          return;
        }
        let run: any;
        if (mode === "product-with-recovery-infra") {
          run = {
            id: `layered-run-${inlineCalls}`,
            status: "failed",
            error: "The page control is still unusable",
            failure: {
              class: "product",
              component: "app",
              code: "verify-interaction-failed",
              retryable: false
            },
            recoveryFailure: {
              class: "infrastructure",
              component: "fixer",
              code: "fixer-http-503",
              retryable: true
            },
            steps: [{
              stepId,
              status: "failed",
              error: "The page control is still unusable",
              fixerNote: "fixer unusable: fixer 503",
              failure: {
                class: "product",
                component: "app",
                code: "verify-interaction-failed",
                retryable: false
              },
              recoveryFailure: {
                class: "infrastructure",
                component: "fixer",
                code: "fixer-http-503",
                retryable: true
              }
            }]
          };
        } else if (mode === "product-then-infra" && inlineCalls === 1) {
          run = {
            id: "product-run",
            status: "failed",
            error: "The total is visually wrong",
            steps: [{ stepId, status: "failed", error: "The total is visually wrong" }]
          };
        } else if (mode === "product-then-infra") {
          run = {
            id: "infra-run",
            status: "failed",
            error: "opaque localized dependency error",
            steps: [{
              stepId,
              status: "failed",
              error: "opaque localized dependency error",
              failure: { class: "infrastructure", component: "vision", code: "vision-overloaded", retryable: true }
            }]
          };
        } else if (mode === "blocked") {
          run = {
            id: "blocked-run",
            status: "paused_for_user",
            error: "MFA needs a user",
            steps: [{ stepId: "__drill_navigate", status: "completed" }]
          };
        } else {
          run = {
            id: "incomplete-run",
            status: "failed",
            error: "engine stopped without a verdict",
            steps: [{ stepId: "__drill_navigate", status: "completed" }]
          };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ run }));
      });
    });
    server.listen(AUTOMATIONS_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function runBook() {
  const response = await fetch(`${DRILL_BASE}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageIds: ["checkout"], viewports: ["desktop"] })
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).run;
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
    body: JSON.stringify({ autonomy: "auto", app: { name: "fixture", url: "http://example.test" } })
  });
  await fetch(`${DRILL_BASE}/api/pages/checkout`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Checkout",
      path: "/checkout",
      steps: ["total", "pay", "receipt"].map((id) => ({
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
}, 15000);

beforeEach(() => {
  inlineCalls = 0;
  hydrationGets = 0;
  mode = "product-then-infra";
});

afterAll(async () => {
  if (drill && !drill.killed) drill.kill("SIGTERM");
  await new Promise((resolve) => automations?.close(() => resolve(undefined)));
  drill = null;
  automations = null;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("Drill systemic-failure circuit", () => {
  it("continues after a product defect, then opens on structured infra and skips the rest", async () => {
    const run = await runBook();
    expect(inlineCalls).toBe(2);
    expect(hydrationGets).toBe(0);
    expect(run).toMatchObject({
      selection: { pageIds: ["checkout"], viewportIds: ["desktop"] },
      plannedChecks: 3,
      executedChecks: 2,
      circuit: {
        kind: "infra-failure",
        component: "vision",
        code: "vision-overloaded",
        afterCheck: 2,
        skippedChecks: 1,
        trigger: { pageId: "checkout", stepId: "pay", viewportId: "desktop" }
      }
    });
    expect(run.pages).toHaveLength(2);
    expect(run.pages[0].terminal.kind).toBe("product-failure");
    expect(run.pages[0].result.result.passed).toBe(false);
    expect(run.pages[1].terminal.kind).toBe("infra-failure");
    expect(run.findings).toHaveLength(1);
    expect(run.findings[0]).toMatchObject({ pageId: "checkout", stepId: "total", text: "The total is visually wrong" });
    expect(run.infraErrors).toHaveLength(1);

    const persisted = JSON.parse(readFileSync(path.join(ghome, "drill", "runs", `${run.id}.json`), "utf8"));
    expect(persisted.pages[0].terminal.kind).toBe("product-failure");
    expect(persisted.pages[1].terminal).toMatchObject({ kind: "infra-failure", code: "vision-overloaded" });

    // Optional hydration may still fail later; the persisted terminal remains
    // enough to render an honest result.
    const fetched = await (await fetch(`${DRILL_BASE}/api/runs/${run.id}`)).json();
    expect(hydrationGets).toBe(2);
    expect(fetched.run.pages[0].result.result.passed).toBe(false);
    expect(fetched.run.pages[0].result.status).toBe("failed");
    expect(fetched.run.pages[1].result.error).toBe("opaque localized dependency error");
    expect(fetched.run.pages[1].result.result.passed).toBe(false);
  });

  it("keeps product findings when recovery infrastructure fails and groups the outage separately", async () => {
    mode = "product-with-recovery-infra";
    const run = await runBook();

    expect(inlineCalls).toBe(3);
    expect(run.circuit).toBeUndefined();
    expect(run.pages).toHaveLength(3);
    expect(run.pages.every((page: any) => page.terminal.kind === "product-failure")).toBe(true);
    expect(run.pages.every((page: any) =>
      page.terminal.recoveryFailure?.kind === "infra-failure"
      && page.terminal.recoveryFailure?.component === "fixer"
    )).toBe(true);
    expect(run.findings).toHaveLength(3);
    expect(run.findings.every((finding: any) =>
      finding.kind === "step-fail"
      && finding.text === "The page control is still unusable"
    )).toBe(true);
    expect(run.infraErrors).toHaveLength(1);
    expect(run.infraErrors[0]).toMatchObject({
      component: "fixer",
      code: "fixer-http-503",
      count: 3
    });
    expect(run.summary).toMatchObject({ steps: 3, failed: 3, infra: 3 });
  });

  it.each([
    ["incomplete", "incomplete", "unclassified-failure"],
    ["blocked", "blocked", "paused_for_user"],
    ["transport", "infra-failure", "transport-fetch-failed"]
  ] as const)("opens immediately for %s outcomes", async (nextMode, kind, code) => {
    mode = nextMode;
    const run = await runBook();
    expect(inlineCalls).toBe(1);
    expect(run.findings).toHaveLength(0);
    expect(run.pages).toHaveLength(1);
    expect(run.pages[0].terminal).toMatchObject({ kind, code });
    expect(run.circuit).toMatchObject({ kind, code, afterCheck: 1, skippedChecks: 2 });
  });

  it("persists the requested selection when preflight opens before page entries exist", async () => {
    mode = "preflight";
    const run = await runBook();
    expect(inlineCalls).toBe(0);
    expect(run.pages).toHaveLength(0);
    expect(run).toMatchObject({
      selection: { pageIds: ["checkout"], viewportIds: ["desktop"] },
      plannedChecks: 3,
      executedChecks: 0,
      circuit: {
        kind: "infra-failure",
        component: "automations",
        code: "automations-http-503",
        afterCheck: 0,
        skippedChecks: 3
      }
    });
    expect(run.infraErrors).toHaveLength(1);
    expect(run.infraErrors[0]).toMatchObject({ count: 3, component: "automations", code: "automations-http-503" });
  });

  it("records an unmatched selection as incomplete instead of a false pass", async () => {
    const response = await fetch(`${DRILL_BASE}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIds: ["checkout"], viewports: ["desktop"], state: "not-authored" })
    });
    expect(response.status).toBe(200);
    const { run } = await response.json();
    expect(run).toMatchObject({
      plannedChecks: 0,
      executedChecks: 0,
      circuit: {
        kind: "incomplete",
        component: "drill",
        code: "no-matching-checks",
        skippedChecks: 0
      }
    });
    expect(run.infraErrors[0]).toMatchObject({ code: "no-matching-checks", component: "drill" });
    expect(inlineCalls).toBe(0);
  });
});
