// GARRISON-FLOW-V2 S6 — the orchestrator server contract behind the composer's
// new surfaces: coordination edits recompile policy.json, the Try-it strip
// resolves security-review + ux-qa inclusion WITH reasons (incl. the flag-flip
// acceptance 11-UI-half), and the ghost-edit proxy surfaces coordination-rule
// proposals alongside orchestrator-policy ones.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gar-composer-coord-"));
const CONFIG = join(dir, "routing.json");
const DECISIONS = join(dir, "decisions.jsonl");
const POLICY = join(dir, "policy.json");
process.env.MODEL_ROUTER_CONFIG = CONFIG;
process.env.MODEL_ROUTER_DECISIONS = DECISIONS;
process.env.GARRISON_POLICY_PATH = POLICY;
const GARRISON_HOME = join(dir, "garrison-home");
process.env.GARRISON_HOME = GARRISON_HOME;
delete process.env.GARRISON_COMPOSITION_DIR;
const IMPROVER_STATUS = join(GARRISON_HOME, "ui-fittings", "improver.json");

// @ts-ignore — pure .mjs server
const { startServer } = await import("../fittings/seed/orchestrator/scripts/server.mjs");

let base = "";
let handle: any;
const getRouting = async () => (await fetch(`${base}/routing`)).json();
const putRouting = (config: any, baselineSha: string) =>
  fetch(`${base}/routing?baseline=${encodeURIComponent(baselineSha)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config })
  });
const tryIt = async (body: Record<string, unknown>) =>
  (await fetch(`${base}/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tryIt: true, ...body }) })).json();

beforeAll(async () => {
  handle = await startServer({ port: 0 });
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(async () => {
  await handle?.close?.();
});

describe("composer coordination controls (S6) — server contract", () => {
  it("startup seeds policy.json carrying the coordination section", () => {
    const p = JSON.parse(readFileSync(POLICY, "utf8"));
    expect(p.coordination).toBeTruthy();
    expect(p.coordination.thresholds.heavyFiles).toBe(3);
    expect(p.coordination.exclusiveLeases).toContain("package-lock.json");
  });

  it("a coordination edit (heavyFiles 3 → 2) recompiles policy.json", async () => {
    const cur = await getRouting();
    const next = structuredClone(cur.config);
    next.coordination.thresholds.heavyFiles = 2;
    next.coordination.exclusiveLeases = [...next.coordination.exclusiveLeases, "Cargo.lock"];
    const put = await putRouting(next, cur.baselineSha);
    expect(put.status).toBe(200);
    const p = JSON.parse(readFileSync(POLICY, "utf8"));
    expect(p.coordination.thresholds.heavyFiles).toBe(2);
    expect(p.coordination.exclusiveLeases).toContain("Cargo.lock");
  });

  it("a mistyped coordination knob is rejected (422), never persisted", async () => {
    const cur = await getRouting();
    const next = structuredClone(cur.config);
    next.coordination.thresholds.heavyRatio = 9; // out of (0,1]
    const put = await putRouting(next, cur.baselineSha);
    expect(put.status).toBe(422);
    const body = await put.json();
    expect(JSON.stringify(body.errors)).toContain("heavyRatio");
  });
});

describe("composer try-it gate reasoning (S6 D13/D15)", () => {
  it("a ui-change request includes ux-qa (with the severity threshold) and NOT security-review", async () => {
    const r = await tryIt({ prompt: "implement a login page", workKind: "ui-change" });
    expect(r.gates).toBeTruthy();
    expect(r.gates.uxQa.included).toBe(true);
    expect(r.gates.uxQa.severityThreshold).toBe("major");
    expect(r.gates.uxQa.reason).toContain("ux-qa");
    expect(r.gates.securityReview.included).toBe(false);
    expect(r.gates.securityReview.reason).toContain("security-review");
  });

  it("a docs-change request includes NEITHER ux-qa nor security-review, and says why", async () => {
    const r = await tryIt({ prompt: "update the README", workKind: "docs-change" });
    expect(r.gates.uxQa.included).toBe(false);
    expect(r.gates.uxQa.reason).toContain("omits ux-qa");
    expect(r.gates.securityReview.included).toBe(false);
  });

  it("flipping a project's security_sensitive flag ADDS security-review to the same request (acceptance 11)", async () => {
    // baseline: agent-garrison not security-sensitive → security-review off even when selected.
    const before = await tryIt({ prompt: "implement a login page", workKind: "ui-change", project: "agent-garrison" });
    expect(before.gates.securityReview.included).toBe(false);

    // flip the flag through the same PUT the composer uses.
    const cur = await getRouting();
    const next = structuredClone(cur.config);
    next.projects = next.projects || {};
    next.projects["agent-garrison"] = { ...(next.projects["agent-garrison"] || {}), security_sensitive: true };
    const put = await putRouting(next, cur.baselineSha);
    expect(put.status).toBe(200);

    const after = await tryIt({ prompt: "implement a login page", workKind: "ui-change", project: "agent-garrison" });
    expect(after.gates.securityReview.included).toBe(true);
    expect(after.gates.securityReview.byProject).toBe(true);
    expect(after.gates.securityReview.reason).toContain("security-sensitive");
  });
});

describe("composer ghost edits (S6 D17) — coordination proposals proxy", () => {
  let improver: http.Server;
  let improverPort = 0;

  beforeAll(async () => {
    improver = http.createServer((req, res) => {
      if (req.url === "/api/queue" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            queue: [
              { id: "cp-1", rule: "coordination", claim: "package-lock.json keeps colliding", diff: "add package-lock.json to exclusiveLeases", decision: "add lease", status: "pending", at: "2026-07-11T00:00:00Z" },
              { id: "op-1", rule: "orchestrator-policy", claim: "test gate under-powered", diff: "step up", decision: "up", status: "pending", at: "2026-07-11T00:00:00Z" },
              { id: "other-1", rule: "skill-suggest", claim: "unrelated", diff: "x", status: "pending" }
            ],
            autonomy: {},
            promotionThreshold: 5
          })
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => improver.listen(0, "127.0.0.1", () => r()));
    improverPort = (improver.address() as any).port;
    mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
    writeFileSync(IMPROVER_STATUS, JSON.stringify({ fittingId: "improver", port: improverPort, url: `http://127.0.0.1:${improverPort}`, pid: process.pid }));
  });
  afterAll(async () => {
    rmSync(IMPROVER_STATUS, { force: true });
    await new Promise<void>((r) => improver.close(() => r()));
  });

  it("GET /ghost-edits surfaces BOTH coordination and orchestrator-policy proposals, filtering others", async () => {
    const j = await (await fetch(`${base}/ghost-edits`)).json();
    expect(j.available).toBe(true);
    const ids = j.proposals.map((p: any) => p.id).sort();
    expect(ids).toEqual(["cp-1", "op-1"]);
    const coord = j.proposals.find((p: any) => p.id === "cp-1");
    expect(coord.rule).toBe("coordination");
    expect(coord.diff).toContain("exclusiveLeases");
  });
});
