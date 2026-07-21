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
    // A pre-workKinds scoped file: valid v2 but with empty policy machinery —
    // the shape found in live compositions created before those sections landed.
    const cur = await readRoutingPolicy(dir);
    const bare = structuredClone(cur.config) as Record<string, unknown>;
    bare.workKinds = {};
    bare.phasePlans = {};
    bare.phaseSkills = { bindings: {}, overrides: {} };
    delete bare.coordination;
    delete bare.uxQa;
    delete bare.projects;
    delete bare.defaultWorkKind;
    writeFileSync(CONFIG(), JSON.stringify(bare, null, 2) + "\n", "utf8");

    const { config } = await readRoutingPolicy(dir);
    expect(Object.keys(config.workKinds ?? {})).toContain("full-feature");
    expect(config.defaultWorkKind).toBe("full-feature");
    expect((config as Record<string, unknown>).coordination).toBeTruthy();
    expect(config.uxQa?.severityThreshold).toBe("major");
    // served, not persisted: the disk file still carries the bare shape
    expect(Object.keys(JSON.parse(readFileSync(CONFIG(), "utf8")).workKinds)).toEqual([]);
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
    // unknown provider ids are dropped from migrated secondaries
    const targets = (config as { targets: { id: string; provider?: string; model?: string }[] }).targets;
    const sec = targets.find((t) => t.id === "sec-codex");
    expect(sec).toBeTruthy();
    expect(sec?.provider).toBeUndefined();
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
  it("full-feature: every phase ON, enriched with skill + model + effort + runtime", async () => {
    await readRoutingPolicy(dir); // seed
    const out = await simulateTryIt(dir, { prompt: "implement a login page", workKind: "full-feature" });
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    const r = out.result;
    expect(r.dryRun).toBe(true);
    expect(r.workKind).toBe("full-feature");
    expect(r.classification.taskType).toBe("implement");
    expect(["interactive", "autonomous"]).toContain(r.classification.execution);
    const rail = r.rail as { phases: { id: string; on: boolean; skill?: string | null; target?: { targetId?: string; model: string | null; effort: string | null; runtime: string | null } }[] };
    const onChips = rail.phases.filter((p) => p.on);
    expect(onChips.length).toBe(11);
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

  it("a partial-plan work kind keeps OFF phases in the rail (honesty), un-enriched", async () => {
    await readRoutingPolicy(dir);
    const out = await simulateTryIt(dir, { prompt: "add a REST endpoint", workKind: "api-change" });
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

  it("gate reasoning: ui-change includes ux-qa (with threshold) but not security-review; docs-change neither", async () => {
    await readRoutingPolicy(dir);
    const ui = await simulateTryIt(dir, { prompt: "implement a login page", workKind: "ui-change" });
    expect(ui.status).toBe("ok");
    if (ui.status !== "ok") return;
    expect(ui.result.gates?.uxQa.included).toBe(true);
    expect(ui.result.gates?.uxQa.severityThreshold).toBe("major");
    expect(ui.result.gates?.securityReview.included).toBe(false);

    const docs = await simulateTryIt(dir, { prompt: "update the README", workKind: "docs-change" });
    expect(docs.status).toBe("ok");
    if (docs.status !== "ok") return;
    expect(docs.result.gates?.uxQa.included).toBe(false);
    expect(docs.result.gates?.uxQa.reason).toContain("omits ux-qa");
    expect(docs.result.gates?.securityReview.included).toBe(false);
  });

  it("flipping a project's security_sensitive flag ADDS security-review to the same request", async () => {
    const cur = await readRoutingPolicy(dir);
    const before = await simulateTryIt(dir, {
      prompt: "implement a login page",
      workKind: "ui-change",
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
      workKind: "ui-change",
      project: "agent-garrison"
    });
    expect(after.status).toBe("ok");
    if (after.status !== "ok") return;
    expect(after.result.gates?.securityReview.included).toBe(true);
    expect(after.result.gates?.securityReview.byProject).toBe(true);
    expect(after.result.gates?.securityReview.reason).toContain("security-sensitive");
  });
});
