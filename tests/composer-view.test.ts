import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the orchestrator server's config + policy + decisions to temp files
// BEFORE importing it (the module reads these env vars at load). GARRISON_POLICY_PATH
// lets us read the compiled policy.json bytes the composer's autosave recompiles.
const dir = mkdtempSync(join(tmpdir(), "gar-composer-"));
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

// Dynamic import: a static import hoists ABOVE the env sandbox lines, so the
// module would capture the real ~/.garrison as GARRISON_HOME and write/read the
// live install's status slot.
// @ts-ignore — pure .mjs server
const { startServer } = await import("../fittings/seed/orchestrator/scripts/server.mjs");

let base = "";
let handle: any;

async function getRouting() {
  return (await fetch(`${base}/routing`)).json();
}
async function putRouting(config: any, baselineSha: string) {
  return fetch(`${base}/routing?baseline=${encodeURIComponent(baselineSha)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config })
  });
}

beforeAll(async () => {
  handle = await startServer({ port: 0 });
  base = `http://127.0.0.1:${handle.port}`;
});
afterAll(async () => {
  await handle?.close?.();
});

describe("composer view (S3) — server contract behind the composer", () => {
  it("PUT of a matrix-cell edit recompiles policy.json (bytes change) and reflects the new target", async () => {
    const before = readFileSync(POLICY, "utf8"); // written on startup from the seed
    const beforePolicy = JSON.parse(before);
    // seed: code/T1-standard inherits the row default (cc-sonnet-med), not an explicit cell.
    expect(beforePolicy.matrix.code["T1-standard"].targetId).toBe("cc-sonnet-med");

    const cur = await getRouting();
    const next = structuredClone(cur.config);
    next.profiles.balanced.matrix.rows.code.cells["T1-standard"] = "cc-opus-high";
    const put = await putRouting(next, cur.baselineSha);
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.ok).toBe(true);
    expect(putBody.policyPath).toBe(POLICY);
    expect(putBody.baselineSha).toMatch(/^[0-9a-f]{64}$/);

    const after = readFileSync(POLICY, "utf8");
    expect(after).not.toBe(before); // policy.json was recompiled
    const afterPolicy = JSON.parse(after);
    expect(afterPolicy.matrix.code["T1-standard"].targetId).toBe("cc-opus-high");
    expect(afterPolicy.matrix.code["T1-standard"].rule).toBe("cell:code/T1-standard");
  });

  it("PUT with a stale baseline → 409 conflict (the composer surfaces a Reload banner)", async () => {
    const cur = await getRouting();
    const next = structuredClone(cur.config);
    next.activeProfile = "economy";
    // A first PUT with the fresh baseline succeeds and moves the baseline forward.
    const ok = await putRouting(next, cur.baselineSha);
    expect(ok.status).toBe(200);
    // Re-using the now-stale baseline must conflict.
    const stale = await putRouting(next, cur.baselineSha);
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.error).toBe("conflict");
    expect(body.currentSha).toMatch(/^[0-9a-f]{64}$/);
    // restore to balanced so later tests resolve against the seed profile
    const reset = await getRouting();
    const back = structuredClone(reset.config);
    back.activeProfile = "balanced";
    await putRouting(back, reset.baselineSha);
  });

  it("POST /simulate {tryIt} returns a dry-run rail whose ON chips carry skill+model+effort+runtime", async () => {
    const r = await (
      await fetch(`${base}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tryIt: true, prompt: "implement a login page", workKind: "full-feature" })
      })
    ).json();

    expect(r.dryRun).toBe(true);
    expect(r.workKind).toBe("full-feature");
    expect(r.classification.taskType).toBe("implement");
    // execution is decided by the pure classifyExecution — assert it is a valid axis value.
    expect(["interactive", "autonomous"]).toContain(r.classification.execution);
    expect(r.rail.workKind).toBe("full-feature");

    // full-feature runs the full plan → every phase ON, each enriched with its target.
    const onChips = r.rail.phases.filter((p: any) => p.on);
    expect(onChips.length).toBe(11);
    for (const ph of onChips) {
      expect(typeof ph.skill).toBe("string");
      expect(ph.skill.length).toBeGreaterThan(0);
      expect(ph.target).toBeTruthy();
      expect(typeof ph.target.runtime).toBe("string");
      // model + effort keys are always present on an ON chip (value may be null for a
      // bare secondary, but these full-plan phases all resolve to fully-specified targets).
      expect(ph.target).toHaveProperty("model");
      expect(ph.target).toHaveProperty("effort");
      expect(ph.target.model).toBeTruthy();
      expect(ph.target.effort).toBeTruthy();
    }
    // implement resolves at the classified tier (T1-standard) to the row default.
    const impl = r.rail.phases.find((p: any) => p.id === "implement");
    expect(impl.target.targetId).toBe("cc-opus-high");
    expect(impl.target.model).toBe("opus");
  });

  it("a partial-plan work kind keeps OFF phases in the rail (on:false), dimmed but present", async () => {
    const r = await (
      await fetch(`${base}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tryIt: true, prompt: "add a REST endpoint", workKind: "api-change" })
      })
    ).json();

    // api-change → implement-test plan (implement, test); the other 9 pipeline phases
    // stay in the rail rendered OFF (honesty — never a silent pass).
    const phases = r.rail.phases;
    expect(phases.length).toBe(11);
    const offChips = phases.filter((p: any) => p.on === false);
    expect(offChips.length).toBe(9);
    // an off chip still carries its bound skill and an off_reason, but no resolved target.
    const off = offChips.find((p: any) => p.id === "design-audit");
    expect(off).toBeTruthy();
    expect(off.off_reason).toBe("phase-plan");
    expect(off.target).toBeUndefined();
    // the two ON phases are enriched.
    const on = phases.filter((p: any) => p.on);
    expect(on.map((p: any) => p.id).sort()).toEqual(["implement", "test"]);
    for (const ph of on) expect(ph.target.runtime).toBeTruthy();
  });

  // D38 ghost edits — this runs BEFORE the live-Improver block writes improver.json.
  it("GET /ghost-edits with no Improver registered → available:false, skipped silently", async () => {
    const j = await (await fetch(`${base}/ghost-edits`)).json();
    expect(j.available).toBe(false);
    expect(j.proposals).toEqual([]);
  });
});

describe("composer ghost edits (D38) — Improver proxy", () => {
  let improver: http.Server;
  let improverPort = 0;
  let applied: string[] = [];

  beforeAll(async () => {
    improver = http.createServer((req, res) => {
      if (req.url === "/api/queue" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            queue: [
              {
                id: "gp-1",
                rule: "orchestrator-policy",
                claim: "code/T2-deep misroutes to sonnet on 3 recent turns",
                diff: "matrix cell code/T2-deep: cc-sonnet-med -> cc-opus-high",
                decision: "cc-opus-high",
                status: "pending",
                at: "2026-07-10T00:00:00Z"
              },
              { id: "gp-other", rule: "some-other-rule", claim: "unrelated", diff: "x", status: "pending" },
              { id: "gp-done", rule: "orchestrator-policy", claim: "already applied", diff: "y", status: "applied" }
            ],
            autonomy: {},
            promotionThreshold: 5
          })
        );
        return;
      }
      const m = req.url && req.url.match(/^\/api\/proposals\/([^/]+)\/(apply|reject)$/);
      if (m && req.method === "POST") {
        applied.push(`${m[2]}:${m[1]}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: decodeURIComponent(m[1]), status: m[2] === "apply" ? "applied" : "rejected" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => improver.listen(0, "127.0.0.1", () => r()));
    improverPort = (improver.address() as any).port;
    mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
    writeFileSync(
      IMPROVER_STATUS,
      JSON.stringify({ fittingId: "improver", port: improverPort, url: `http://127.0.0.1:${improverPort}`, pid: process.pid })
    );
  });
  afterAll(async () => {
    rmSync(IMPROVER_STATUS, { force: true });
    await new Promise<void>((r) => improver.close(() => r()));
  });

  it("GET /ghost-edits returns ONLY rule=orchestrator-policy proposals from the Improver queue", async () => {
    const j = await (await fetch(`${base}/ghost-edits`)).json();
    expect(j.available).toBe(true);
    expect(j.improverUrl).toBe(`http://127.0.0.1:${improverPort}`);
    // gp-other (different rule) is filtered out; gp-1 and gp-done (both policy) remain.
    const ids = j.proposals.map((p: any) => p.id).sort();
    expect(ids).toEqual(["gp-1", "gp-done"]);
    const p1 = j.proposals.find((p: any) => p.id === "gp-1");
    expect(p1.claim).toContain("code/T2-deep");
    expect(p1.diff).toContain("cc-opus-high");
    expect(p1.decision).toBe("cc-opus-high");
    expect(p1.status).toBe("pending");
  });

  it("POST /ghost-edits/:id/apply proxies to the Improver (never auto-applies)", async () => {
    const r = await fetch(`${base}/ghost-edits/gp-1/apply`, { method: "POST" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("applied");
    expect(applied).toContain("apply:gp-1");
  });

  it("POST /ghost-edits/:id/reject proxies to the Improver", async () => {
    const r = await fetch(`${base}/ghost-edits/gp-1/reject`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(applied).toContain("reject:gp-1");
  });
});
