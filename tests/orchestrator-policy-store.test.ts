import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The routing-policy store behind the Muster Orchestrator tab — the successor
// to the retired own-port composer server's GET/PUT /routing + POST /simulate
// contract (tests ported from model-router-server / composer-view /
// composer-coordination / orchestrator-v1-migrate). Same semantics, no HTTP:
// whole-document baseline-guarded writes, validate + compile before persist,
// policy.json recompiled on every accepted write, v1 migrate-at-read.

const sandbox = mkdtempSync(join(tmpdir(), "gar-policy-store-"));
const POLICY = join(sandbox, "policy.json");
process.env.GARRISON_POLICY_PATH = POLICY;

import {
  readRoutingPolicy,
  writeRoutingPolicyForComposition,
  simulateTryIt,
  type PolicyWriteComposition
} from "@/lib/orchestrator-policy";

let seq = 0;
let dir = "";
const CONFIG = () => join(dir, ".garrison", "routing.json");

function composition(overrides: Partial<PolicyWriteComposition> = {}): PolicyWriteComposition {
  return {
    id: "policy-store-fixture",
    directory: dir,
    selections: {},
    duties: [],
    selectedDuties: [],
    ...overrides
  } as PolicyWriteComposition;
}

const write = (next: unknown, baseline?: string | null, comp?: PolicyWriteComposition) =>
  writeRoutingPolicyForComposition(comp ?? composition(), [], next, baseline);

beforeEach(() => {
  dir = join(sandbox, `comp-${seq++}`);
  mkdirSync(join(dir, ".garrison"), { recursive: true });
  rmSync(POLICY, { force: true });
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

describe("readRoutingPolicy", () => {
  it("seeds routing.json from the fitting seed on first touch + returns a baselineSha", async () => {
    const { config, baselineSha } = await readRoutingPolicy(dir);
    expect(config.activeProfile).toBe("balanced");
    expect(baselineSha).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(CONFIG())).toBe(true);
  });

  it("backfills absent-or-empty seed sections (served, not persisted) so the panel never renders bare", async () => {
    // A pre-flows scoped file: valid v2 but with empty policy machinery —
    // the shape found in live compositions created before those sections landed.
    const cur = await readRoutingPolicy(dir);
    const bare = structuredClone(cur.config) as Record<string, unknown>;
    bare.flows = {};
    bare.phasePlans = {};
    bare.phaseSkills = { bindings: {}, overrides: {} };
    delete bare.coordination;
    delete bare.uxQa;
    delete bare.projects;
    delete bare.defaultFlow;
    writeFileSync(CONFIG(), JSON.stringify(bare, null, 2) + "\n", "utf8");

    const { config } = await readRoutingPolicy(dir);
    // The backfill serves the SHIPPED library, whatever it currently is: the
    // flow the seed names as its default has to be both present and named.
    expect(config.defaultFlow).toBe("fix");
    expect(Object.keys(config.flows ?? {})).toContain(config.defaultFlow);
    expect((config as Record<string, unknown>).coordination).toBeTruthy();
    expect(config.uxQa?.severityThreshold).toBe("major");
    // served, not persisted: the disk file still carries the bare shape
    expect(Object.keys(JSON.parse(readFileSync(CONFIG(), "utf8")).flows)).toEqual([]);
  });
});

describe("writeRoutingPolicyForComposition — contract of the retired PUT /routing", () => {
  it("persists with the correct baseline; a re-read reflects it and the baseline advances", async () => {
    const cur = await readRoutingPolicy(dir);
    const next = structuredClone(cur.config);
    next.activeProfile = "economy";
    const res = await write(next, cur.baselineSha);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.baselineSha).toMatch(/^[0-9a-f]{64}$/);
    expect(res.baselineSha).not.toBe(cur.baselineSha);
    const after = await readRoutingPolicy(dir);
    expect(after.config.activeProfile).toBe("economy");
    expect(readFileSync(CONFIG(), "utf8")).toContain('"economy"');
  });

  it("a stale baseline → conflict with the current sha (the panel surfaces Reload)", async () => {
    const cur = await readRoutingPolicy(dir);
    const next = structuredClone(cur.config);
    next.activeProfile = "economy";
    const ok = await write(next, cur.baselineSha);
    expect(ok.status).toBe("ok");
    const stale = await write(next, cur.baselineSha);
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") expect(stale.currentSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an invalid config → invalid with errors, never persisted", async () => {
    const cur = await readRoutingPolicy(dir);
    const before = readFileSync(CONFIG(), "utf8");
    const res = await write({ version: 1, activeProfile: "nope", profiles: {} }, cur.baselineSha);
    expect(res.status).toBe("invalid");
    expect(readFileSync(CONFIG(), "utf8")).toBe(before);
  });

  it("a matrix-cell edit recompiles policy.json (bytes change) and reflects the new target", async () => {
    const cur = await readRoutingPolicy(dir);
    // Prime policy.json via a no-op-ish accepted write, then edit the cell.
    const first = await write(structuredClone(cur.config), cur.baselineSha);
    expect(first.status).toBe("ok");
    const before = readFileSync(POLICY, "utf8");
    expect(JSON.parse(before).matrix.code["T1-standard"].targetId).toBe("cc-sonnet-med");

    const mid = await readRoutingPolicy(dir);
    const next = structuredClone(mid.config) as {
      profiles: Record<string, { matrix: { rows: Record<string, { cells: Record<string, string> }> } }>;
    } & Record<string, unknown>;
    next.profiles.balanced.matrix.rows.code.cells["T1-standard"] = "cc-opus-high";
    const res = await write(next, mid.baselineSha);
    expect(res.status).toBe("ok");
    const after = readFileSync(POLICY, "utf8");
    expect(after).not.toBe(before);
    const policy = JSON.parse(after);
    expect(policy.matrix.code["T1-standard"].targetId).toBe("cc-opus-high");
    expect(policy.matrix.code["T1-standard"].rule).toBe("cell:code/T1-standard");
  });

  it("a coordination edit recompiles policy.json; a mistyped knob is rejected", async () => {
    const cur = await readRoutingPolicy(dir);
    const next = structuredClone(cur.config) as {
      coordination: { thresholds: { heavyFiles: number; heavyRatio: number }; exclusiveLeases: string[] };
    } & Record<string, unknown>;
    next.coordination.thresholds.heavyFiles = 2;
    next.coordination.exclusiveLeases = [...next.coordination.exclusiveLeases, "Cargo.lock"];
    const res = await write(next, cur.baselineSha);
    expect(res.status).toBe("ok");
    const policy = JSON.parse(readFileSync(POLICY, "utf8"));
    expect(policy.coordination.thresholds.heavyFiles).toBe(2);
    expect(policy.coordination.exclusiveLeases).toContain("Cargo.lock");

    const mid = await readRoutingPolicy(dir);
    const bad = structuredClone(mid.config) as typeof next;
    bad.coordination.thresholds.heavyRatio = 9; // out of (0,1]
    const rej = await write(bad, mid.baselineSha);
    expect(rej.status).toBe("invalid");
    if (rej.status === "invalid") expect(JSON.stringify(rej.errors)).toContain("heavyRatio");
  });

  it("primaryRuntime must be a stationed runtime fitting (default id always passes)", async () => {
    const cur = await readRoutingPolicy(dir);
    const next = structuredClone(cur.config);
    next.primaryRuntime = "codex-runtime";
    const rejected = await write(next, cur.baselineSha);
    expect(rejected.status).toBe("invalid");
    if (rejected.status === "invalid") {
      expect(rejected.errors.join(" ")).toContain("codex-runtime");
      expect(rejected.errors.join(" ")).toContain("not a stationed runtime");
    }
    const stationedComp = composition({
      selections: { runtimes: [{ id: "codex-runtime", config: {} }] }
    });
    const accepted = await write(next, rejected.status === "invalid" ? cur.baselineSha : null, stationedComp);
    expect(accepted.status).toBe("ok");
  });
});

describe("v1 → v2 migrate-at-read (moved from the retired server's startup)", () => {
  // Same v1 fixture the retired orchestrator-v1-migrate test used.
  const V1_CONFIG = {
    version: 1,
    activeProfile: "balanced",
    taskTypes: ["code", "review", "research", "image", "video", "writing", "ops", "other"],
    tiers: ["T0-trivial", "T1-standard", "T2-deep"],
    exceptions: [{ id: "ex-x", when: "x", role: "review" }],
    matrix: {
      defaults: { role: "standard" },
      columns: { "T2-deep": "expert" },
      rows: { code: { default: "standard", cells: { "T0-trivial": "fast" } } }
    },
    discipline: {
      "T0-trivial": { review: "none", testing: "none", evidence: "none", distribution: "none" },
      "T1-standard": { review: "self-review", testing: "tests", evidence: "text", distribution: "none" },
      "T2-deep": { review: "review-by:default", testing: "full-gates", evidence: "video", distribution: "link" }
    },
    continuations: [],
    targets: [
      { id: "a-low", type: "runtime-target", runtime: "claude-code", model: "haiku", effort: "low" },
      { id: "a-med", type: "runtime-target", runtime: "claude-code", model: "sonnet", effort: "medium" },
      { id: "a-high", type: "runtime-target", runtime: "claude-code", model: "opus", effort: "high" },
      { id: "sec-codex", type: "secondary", runtime: "codex", provider: "openai", model: "gpt-5-codex" }
    ],
    profiles: {
      balanced: {
        preRoute: "on",
        roleMap: { expert: "a-high", standard: "a-med", fast: "a-low", image: "a-med", video: "a-med", review: "a-med" },
        disciplineOverrides: {}
      }
    }
  };

  it("migrates an on-disk v1 to v2 in place, preserving a .v1.bak, and round-trips the validator", async () => {
    writeFileSync(CONFIG(), JSON.stringify(V1_CONFIG, null, 2) + "\n", "utf8");
    const { config, baselineSha } = await readRoutingPolicy(dir);
    expect((config as { version?: number }).version).toBe(2);
    // migration persisted: the on-disk file is now v2, original kept verbatim
    expect(JSON.parse(readFileSync(CONFIG(), "utf8")).version).toBe(2);
    const bak = `${CONFIG()}.v1.bak`;
    expect(existsSync(bak)).toBe(true);
    expect(JSON.parse(readFileSync(bak, "utf8")).version).toBe(1);
    // Known provider ids survive migration now that OpenAI-shaped runtimes are
    // first-class policy data; only ids absent from the registry are dropped.
    const targets = (config as { targets: { id: string; provider?: string; model?: string }[] }).targets;
    const sec = targets.find((t) => t.id === "sec-codex");
    expect(sec).toBeTruthy();
    expect(sec?.provider).toBe("openai");
    expect(sec?.model).toBe("gpt-5-codex");
    // and the migrated config passes its own v2 validation: a no-op write is accepted
    const res = await write(structuredClone(config), baselineSha);
    expect(res.status).toBe("ok");
  });

  it("a v1 document is rejected on write (migrate-at-read owns v1, never the write path)", async () => {
    const cur = await readRoutingPolicy(dir);
    const res = await write(V1_CONFIG, cur.baselineSha);
    expect(res.status).toBe("invalid");
    if (res.status === "invalid") expect(res.errors.join(" ")).toContain("v2");
  });
});

describe("simulateTryIt — dry-run rail + gate reasoning", () => {
  // 2026-08-09: flows became LEVELLED, and `simulateTryIt` takes no level — it
  // resolves each flow at that flow's own `defaultLevel`. So the deep rail is
  // reached the way a user would reach it from the panel: raise the flow's
  // default level through the store and dry-run again. That doubles as proof
  // that a level edit actually reaches the dry run, which is the whole point of
  // editing it.
  const raiseDefaultLevel = async (flow: string, level: number) => {
    const cur = await readRoutingPolicy(dir);
    const next = structuredClone(cur.config);
    // routing.json is owned by the fitting's routing-core; PolicyConfig only
    // narrows the fields the store itself touches, and `levels` is not one.
    const flows = (next as Record<string, unknown>).flows as Record<string, { defaultLevel?: number }>;
    flows[flow].defaultLevel = level;
    const res = await write(next, cur.baselineSha);
    expect(res.status).toBe("ok");
  };

  it("feature at level 3: every duty of the level is ON, enriched with skill + model + effort + runtime", async () => {
    await readRoutingPolicy(dir); // seed
    await raiseDefaultLevel("feature", 3);
    const out = await simulateTryIt(dir, { prompt: "implement a login page", flow: "feature" });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const r = out.result;
    expect(r.dryRun).toBe(true);
    expect(r.flow).toBe("feature");
    expect(r.classification.taskType).toBe("implement");
    expect(["interactive", "autonomous"]).toContain(r.classification.execution);
    const rail = r.rail as { phases: { id: string; on: boolean; skill?: string | null; target?: { targetId?: string; model: string | null; effort: string | null; runtime: string | null } }[] };
    const onChips = rail.phases.filter((p) => p.on);
    // The level's duty list, in the order it names them — the deepest rail the
    // library ships. Pinning the list, not a count, says what it actually runs.
    expect(onChips.map((p) => p.id)).toEqual([
      "plan",
      "implement",
      "test",
      "review",
      "adversarial-review",
      "adversarial-test",
      "ux-qa",
      "walkthrough",
      "validate",
      "report"
    ]);
    for (const ph of onChips) {
      expect(typeof ph.skill).toBe("string");
      expect((ph.skill as string).length).toBeGreaterThan(0);
      expect(ph.target).toBeTruthy();
      expect(ph.target?.model).toBeTruthy();
      expect(ph.target?.effort).toBeTruthy();
      expect(typeof ph.target?.runtime).toBe("string");
    }
    const impl = rail.phases.find((p) => p.id === "implement");
    expect(impl?.target?.targetId).toBe("cc-opus-high");
    expect(impl?.target?.model).toBe("opus");
  });

  it("a shallow level keeps OFF phases in the rail (honesty), un-enriched", async () => {
    await readRoutingPolicy(dir);
    // `fix` at its default level 1 is the two-duty cheap path — the successor to
    // the old api-change plan, and the same shape of claim.
    const out = await simulateTryIt(dir, { prompt: "add a REST endpoint", flow: "fix" });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const rail = out.result.rail as { phases: { id: string; on: boolean; off_reason?: string; target?: unknown }[] };
    expect(rail.phases.length).toBe(12);
    const offChips = rail.phases.filter((p) => p.on === false);
    expect(offChips.length).toBe(10);
    const off = offChips.find((p) => p.id === "ux-qa");
    expect(off?.off_reason).toBe("phase-plan");
    expect(off?.target).toBeUndefined();
    expect(
      rail.phases
        .filter((p) => p.on)
        .map((p) => p.id)
        .sort()
    ).toEqual(["implement", "test"]);
  });

  it("gate reasoning: a rail that runs ux-qa reports it (with threshold) but not security-review; a docs rail neither", async () => {
    await readRoutingPolicy(dir);
    await raiseDefaultLevel("feature", 3);
    const ui = await simulateTryIt(dir, { prompt: "implement a login page", flow: "feature" });
    expect(ui.status).toBe("ok");
    if (ui.status !== "ok") return;
    expect(ui.result.gates?.uxQa.included).toBe(true);
    expect(ui.result.gates?.uxQa.severityThreshold).toBe("major");
    expect(ui.result.gates?.securityReview.included).toBe(false);

    const docs = await simulateTryIt(dir, { prompt: "update the README", flow: "docs" });
    expect(docs.status).toBe("ok");
    if (docs.status !== "ok") return;
    expect(docs.result.gates?.uxQa.included).toBe(false);
    expect(docs.result.gates?.uxQa.reason).toContain("omits ux-qa");
    expect(docs.result.gates?.securityReview.included).toBe(false);
  });

  it("the SAME flow one level down drops the ux-qa gate", async () => {
    // The gate follows the level, not the flow name. Without this, "feature
    // includes ux-qa" could pass off a flow-wide claim as a level-wise one.
    await readRoutingPolicy(dir);
    const deep = await simulateTryIt(dir, { prompt: "implement a login page", flow: "feature" });
    expect(deep.status).toBe("ok");
    if (deep.status !== "ok") return;
    expect(deep.result.gates?.uxQa.included).toBe(false); // feature defaults to level 2
    await raiseDefaultLevel("feature", 3);
    const deeper = await simulateTryIt(dir, { prompt: "implement a login page", flow: "feature" });
    expect(deeper.status).toBe("ok");
    if (deeper.status !== "ok") return;
    expect(deeper.result.gates?.uxQa.included).toBe(true);
  });

  it("flipping a project's security_sensitive flag ADDS security-review to the same request", async () => {
    const cur = await readRoutingPolicy(dir);
    const before = await simulateTryIt(dir, {
      prompt: "implement a login page",
      flow: "feature",
      project: "agent-garrison"
    });
    expect(before.status).toBe("ok");
    if (before.status !== "ok") return;
    expect(before.result.gates?.securityReview.included).toBe(false);

    const next = structuredClone(cur.config) as {
      projects: Record<string, { security_sensitive?: boolean }>;
    } & Record<string, unknown>;
    next.projects["agent-garrison"] = { ...(next.projects["agent-garrison"] || {}), security_sensitive: true };
    const res = await write(next, cur.baselineSha);
    expect(res.status).toBe("ok");

    const after = await simulateTryIt(dir, {
      prompt: "implement a login page",
      flow: "feature",
      project: "agent-garrison"
    });
    expect(after.status).toBe("ok");
    if (after.status !== "ok") return;
    expect(after.result.gates?.securityReview.included).toBe(true);
    expect(after.result.gates?.securityReview.byProject).toBe(true);
    expect(after.result.gates?.securityReview.reason).toContain("security-sensitive");
  });
});
