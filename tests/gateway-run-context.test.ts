// Gateway half of the 2026-07-25 web-channel run-context contract.
//
// Four things are pinned here, because each of them was a silent lie before:
//   §6 ONE attribution helper, prefix-merged at three returns (not nine), so a
//      lane's own fields always win and kanban-loop's fixed-field routeFromDone
//      cannot break.
//   §3 a channel's pinned intent is validated at the edge — an invalid value is
//      DROPPED and RECORDED, never coerced and never passed through.
//   §7 the pin is honored on the resolved route BEFORE the decision record and
//      the plan selection, so it changes the RUNTIME LANE and not just the badge.
//   §9 every lane hands up a real cancel primitive, reachable by conversation id.
//
// gateway-pty.mjs boots a server when imported (gateway.mjs runs it that way), so
// the pure helpers are imported under its documented GARRISON_GATEWAY_NO_LISTEN
// seam: no HTTP listener, no claude spawn.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dutyEfforts } from "../src/lib/types";
import { writeGatewayV4ExecutionModel } from "./helpers/gateway-v4-fixture";
// @ts-ignore — Web's persistence sanitizer is plain ESM and is exercised here
// as the receiving half of the gateway's canonical failure-event contract.
import { sanitizeSessionEvent as sanitizeWebSessionEvent } from "../packages/talk/src/threads.mjs";
// @ts-ignore — pure .mjs routing layer, no .d.ts
import { applyTurnOverride, effortControllable, listVaultAccounts, resolveVaultAccount, readMaterializedSecrets, anthropicAccountEnv, createRoutedGateway, RoutedGateway, TURN_EFFORTS, AGENT_SDK_SESSION_CAP, normalizeFailureInfo } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore — pure .mjs adapter assembly resolver
import { resolveRoutedAgentSdkAssembly } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";
// @ts-ignore — shared harness constants prove the gateway has no divergent copy
import { BUILTIN_TOOLS, LEAN_SYSTEM_PROMPT } from "../fittings/seed/agent-sdk-runtime/lib/harness.mjs";
// @ts-ignore — provider-policy launch helpers are plain ESM.
import { buildRespawnOpts } from "../fittings/seed/orchestrator/lib/stage-b.mjs";
// @ts-ignore — provider registry migration helper is plain ESM.
import { ensureProviders } from "../fittings/seed/orchestrator/lib/policy-core.mjs";

const ROOT = path.resolve(__dirname, "..");
const AGENT_SDK_STUB = path.join(ROOT, "tests", "fixtures", "gateway-agent-sdk-runtime");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

// ── the gateway module under the no-listen seam ──────────────────────────────
let gw: any; // the gateway-pty.mjs module namespace
let compositionDir: string;
const savedEnv = { ...process.env };

beforeAll(async () => {
  compositionDir = mkdtempSync(path.join(tmpdir(), "gar-runctx-"));
  mkdirSync(path.join(compositionDir, ".garrison"), { recursive: true });
  // The materialized vault the runner writes before spawning the gateway: this is
  // the gateway's ONLY view of the vault (it holds no master key).
  writeFileSync(
    path.join(compositionDir, ".env"),
    [
      "ANTHROPIC_ACCOUNT__work=sk-ant-oat01-work-token",
      'ACCOUNT__OPENAI__codexer="oai-token"',
      "ACCOUNT__BOGUS=nonsense",
      "# a comment",
      "UNRELATED=1"
    ].join("\n") + "\n"
  );
  process.env.GARRISON_GATEWAY_NO_LISTEN = "1";
  process.env.GARRISON_COMPOSITION_DIR = compositionDir;
  delete process.env.GARRISON_ACCOUNT;
  gw = await import(pathToFileURL(path.join(ROOT, "fittings/seed/http-gateway/scripts/gateway-pty.mjs")).href);
});

afterAll(() => {
  process.env = { ...savedEnv };
  try {
    rmSync(compositionDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// A resolved preRoute output, v4-shaped (the richest case: duty cell + pin).
function preFixture(overrides: Record<string, unknown> = {}) {
  return {
    duty: "develop",
    level: 2,
    phase: "implement",
    skill: null,
    classification: { taskType: "code", tier: "T1-standard" },
    route: {
      targetId: "cc-sonnet-med",
      target: { id: "cc-sonnet-med", runtime: "claude-code", provider: "anthropic-plan", model: "sonnet", effort: "medium" },
      via: "duty-cell",
      role: "implement",
      ruleId: "duty:develop/L2/implement",
      profile: "composition-v4"
    },
    decision: { taskType: "code", tier: "T1-standard", ruleId: "duty:develop/L2/implement", profile: "composition-v4", effort: "medium" },
    overridesApplied: null,
    overridesRejected: null,
    project: null,
    projectPath: null,
    ...overrides
  };
}

describe("routedClaudeMessage — Web text authority and internal routing prefixes (M7)", () => {
  const routing = new RoutedGateway();

  it("returns Web input byte-for-byte, without annotation or workflow instructions", () => {
    const message = "  leading whitespace\nexact middle\r\ntrailing whitespace \t";
    const pre = preFixture({
      annotation: "[ANNOTATION-MUST-NOT-LEAK]",
      route: {
        targetId: "cc-sonnet-med",
        target: { id: "cc-sonnet-med", type: "runtime-target", runtime: "claude-code", model: "sonnet" },
      },
    });

    expect(gw.routedClaudeMessage(pre, message, { channel: "web" })).toBe(message);
  });

  it("fails a Web workflow target with the typed control-plane routing error", () => {
    const pre = preFixture({
      route: {
        targetId: "workflow:weekly-review",
        target: { type: "workflow", workflow: "weekly-review" },
      },
    });
    let thrown: any;
    try {
      gw.routedClaudeMessage(pre, "run this", { channel: "web" }, routing);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "web_workflow_control_unavailable",
      kind: "routing",
      source: "gateway",
      retryable: false,
    });
  });

  it("fails a Web skill route with the typed control-plane routing error", () => {
    const pre = preFixture({ skill: "garrison-review" });
    let thrown: any;
    try {
      gw.routedClaudeMessage(pre, "run this", { channel: "web" }, routing);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: "web_skill_control_unavailable",
      kind: "routing",
      source: "gateway",
      retryable: false,
    });
  });

  it("fails a legacy Web skill hint even when preRoute did not copy it onto the route", () => {
    expect(() => gw.routedClaudeMessage(
      preFixture({ skill: null }),
      "run this",
      { channel: "web", skill: "garrison-review" },
      routing,
    )).toThrowError(expect.objectContaining({
      code: "web_skill_control_unavailable",
      kind: "routing",
    }));
  });

  it("keeps the legacy annotation and workflow prefix for non-Web internal routes", () => {
    const message = "  internal request  ";
    const pre = preFixture({
      annotation: "[LEGACY-ANNOTATION]",
      route: {
        targetId: "workflow:weekly-review",
        target: { type: "workflow", workflow: "weekly-review" },
      },
    });

    const routed = gw.routedClaudeMessage(pre, message, { channel: "kanban" }, routing);
    expect(routed).toContain("[LEGACY-ANNOTATION]\n");
    expect(routed).toContain("[workflow: weekly-review]");
    expect(routed.endsWith(message)).toBe(true);
  });
});

describe("turnAttribution — the run context the gateway always knew and never reported (§6)", () => {
  it("reports duty, level, phase, skill, via, project, turnSeq and the override bookkeeping", () => {
    const pre = preFixture({
      project: "agent-garrison",
      projectPath: "/home/u/dev/agent-garrison",
      overridesApplied: ["target", "project"],
      overridesRejected: [{ field: "effort", reason: "provider-has-no-effort-control" }]
    });
    const attribution = gw.turnAttribution(pre, { turnSeq: 7, sessionId: "thread-1" });
    expect(attribution).toMatchObject({
      duty: "develop",
      level: 2,
      phase: "implement",
      skill: null,
      via: "duty-cell",
      project: "agent-garrison",
      projectPath: "/home/u/dev/agent-garrison",
      overridesApplied: ["target", "project"],
      overridesRejected: [{ field: "effort", reason: "provider-has-no-effort-control" }],
      turnSeq: 7
    });
  });

  it("falls back to route.role for phase and to the hints for duty/level/project/skill", () => {
    const attribution = gw.turnAttribution(
      { route: { targetId: "t", target: {}, role: "review", via: "matrix" } },
      { duty: "review", level: 3, project: "ekoa-dev", skill: "garrison-review" }
    );
    expect(attribution).toMatchObject({ phase: "review", duty: "review", level: 3, project: "ekoa-dev", skill: "garrison-review" });
  });

  it("drops a non-integer level rather than reporting a fake one", () => {
    expect(gw.turnAttribution({ route: { level: "2" } }, {}).level).toBe(null);
  });

  it("distinguishes machine login (account null) from an account pin, and records the SOURCE", () => {
    // no pin anywhere → the turn genuinely ran on this box's own Claude login
    expect(gw.turnAttribution(preFixture(), {})).toMatchObject({ account: null, accountSource: null });

    // the runner's process-wide pin (Paymaster)
    process.env.GARRISON_ACCOUNT = "primary-acct";
    try {
      expect(gw.turnAttribution(preFixture(), {})).toMatchObject({ account: "primary-acct", accountSource: "process" });
    } finally {
      delete process.env.GARRISON_ACCOUNT;
    }

    // a target-carried account, and the same value reached by an override
    const target: any = preFixture();
    target.route.target.account = "work";
    expect(gw.turnAttribution(target, {})).toMatchObject({ account: "work", accountSource: "target" });
    const overridden: any = preFixture({ overridesApplied: ["account"] });
    overridden.route.target.account = "work";
    expect(gw.turnAttribution(overridden, {})).toMatchObject({ account: "work", accountSource: "override" });
  });

  it("carries the wire-validation rejections when the route never resolved", () => {
    const rejected = [{ field: "level", reason: "level-not-an-integer-1-9" }];
    expect(gw.turnAttribution(null, { routingRejected: rejected }).overridesRejected).toEqual(rejected);
  });

  it("is all-null for the two UNCOVERED intercepts (discuss + legacy), so their rail is empty not wrong", () => {
    // POST /chat/stream's discuss intercept and the legacy non-routed runTurn
    // return before any route exists. They are deliberately not wrapped: an empty
    // rail is honest, an invented one is not.
    const attribution = gw.turnAttribution(null, null);
    for (const [key, value] of Object.entries(attribution)) {
      expect(value, key).toBe(null);
    }
  });

  it("PREFIX-merges: every field a lane sets wins over the attribution", () => {
    const pre = preFixture({ project: "agent-garrison" });
    const laneResult = { reply: "hi", card: "01CARD", level: 9, project: "other-repo" };
    const done = { ...gw.turnAttribution(pre, { turnSeq: 2 }, { card: "01STALE" }), ...laneResult };
    expect(done.card).toBe("01CARD");
    expect(done.level).toBe(9);
    expect(done.project).toBe("other-repo");
    expect(done.turnSeq).toBe(2); // untouched by the lane
  });
});

describe("personal workspace rejection is fail-closed", () => {
  const rejection = {
    overridesRejected: [{ field: "project", reason: "personal-workspace-unavailable" }]
  };

  it("detects only the personal-workspace rejection", () => {
    expect(gw.personalWorkspaceRejection(rejection)).toEqual({
      field: "project",
      reason: "personal-workspace-unavailable"
    });
    expect(gw.personalWorkspaceRejection({
      overridesRejected: [{ field: "project", reason: "project-not-a-git-repo-under-dev-root" }]
    })).toBeNull();
  });

  it("throws a stable refusal before execution while leaving other project rejections unchanged", () => {
    expect(() => gw.assertExecutableRunScope(rejection)).toThrow(/personal execution refused.*GARRISON_HOME\/personal/i);
    try {
      gw.assertExecutableRunScope(rejection);
    } catch (err: any) {
      expect(err.code).toBe("personal-workspace-unavailable");
    }
    expect(() => gw.assertExecutableRunScope({
      overridesRejected: [{ field: "project", reason: "project-not-a-git-repo-under-dev-root" }]
    })).not.toThrow();
  });
});

describe("routeFieldsFrom — the pre-turn frame carries only what is already known (§4)", () => {
  it("reads the resolved route/runtime/model/effort and leaves the unknowable out", () => {
    const fields = gw.routeFieldsFrom(preFixture());
    expect(fields).toEqual({
      route: "cc-sonnet-med",
      runtime: "claude-code",
      provider: "anthropic-plan",
      model: "sonnet",
      effort: "medium",
      taskType: "code",
      tier: "T1-standard",
      ruleId: "duty:develop/L2/implement",
      profile: "composition-v4"
    });
    // effortApplied / honored are NOT claimed pre-turn.
    expect("effortApplied" in fields).toBe(false);
    expect("honored" in fields).toBe(false);
  });

  it("additively refines the pending frame with a journal identity", () => {
    const pending = gw.pendingRouteFrame(preFixture(), { turnSeq: 4 }, {
      session_id: "sdk-live",
      transcript_path: "/opaque/projects/sdk-live.jsonl"
    });
    expect(pending).toMatchObject({
      route: "cc-sonnet-med",
      runtime: "claude-code",
      pending: true,
      turnSeq: 4,
      session_id: "sdk-live",
      transcript_path: "/opaque/projects/sdk-live.jsonl"
    });
    for (const field of ["sessionDisposition", "sessionBoundaryReason", "sessionEpoch", "spawnSignature"]) {
      expect(pending).not.toHaveProperty(field);
    }
  });
});

describe("sanitizeRouting — invalid pins are dropped AND recorded (§3)", () => {
  it("keeps a well-formed pin and nothing else", () => {
    const { routing, rejected } = gw.sanitizeRouting({
      target: " cc-opus-high ",
      model: "claude-opus-4-6",
      effort: "high",
      duty: "review",
      level: 3,
      project: "agent-garrison",
      account: "work",
      // not part of TurnRouting — hard-dropped, no rejection (a future client key)
      runtime: "gemini",
      cwd: "/etc"
    });
    expect(routing).toEqual({
      target: "cc-opus-high",
      model: "claude-opus-4-6",
      effort: "high",
      duty: "review",
      level: 3,
      project: "agent-garrison",
      account: "work"
    });
    expect(rejected).toEqual([]);
  });

  it("refuses an out-of-vocabulary effort", () => {
    const { routing, rejected } = gw.sanitizeRouting({ effort: "ludicrous" });
    expect(routing).toBe(null);
    expect(rejected).toEqual([{ field: "effort", reason: "effort-not-in-vocabulary" }]);
  });

  it("accepts a digit-string level from a menu but refuses everything else", () => {
    expect(gw.sanitizeRouting({ level: "3" }).routing).toEqual({ level: 3 });
    for (const bad of [0, 10, 2.5, true, "two", [], {}]) {
      const { routing, rejected } = gw.sanitizeRouting({ level: bad });
      expect(routing, JSON.stringify(bad)).toBe(null);
      expect(rejected[0]).toEqual({ field: "level", reason: "level-not-an-integer-1-9" });
    }
  });

  it("refuses non-strings, blanks, control characters and oversized ids", () => {
    expect(gw.sanitizeRouting({ target: 42 }).rejected).toEqual([{ field: "target", reason: "not-a-non-empty-string" }]);
    expect(gw.sanitizeRouting({ project: "   " }).rejected).toEqual([{ field: "project", reason: "not-a-non-empty-string" }]);
    expect(gw.sanitizeRouting({ duty: "re\nview" }).rejected).toEqual([{ field: "duty", reason: "control-characters" }]);
    expect(gw.sanitizeRouting({ model: "m".repeat(400) }).rejected).toEqual([{ field: "model", reason: "too-long" }]);
  });

  it("treats absent / null / non-object bodies as no pin at all", () => {
    for (const raw of [undefined, null, "routing", 7, [], {}, { target: null, effort: undefined }]) {
      expect(gw.sanitizeRouting(raw)).toEqual({ routing: null, rejected: [] });
    }
  });

  // ── RUN-SPEC-V1: the run-plan pins ────────────────────────────────────────
  // These are validated against the LIVE policy vocabulary rather than a list
  // hardcoded here, so the tests pass one in explicitly (which is also what stops a
  // hidden module-global from making a test pass while production refuses).
  const VOCAB = {
    tiers: ["T0-trivial", "T1-standard", "T2-deep"],
    flows: ["full-feature", "docs-change"],
    phases: ["plan", "implement", "review", "adversarial-review", "walkthrough"]
  };

  it("keeps well-formed tier / flow / phasesOff pins", () => {
    const { routing, rejected } = gw.sanitizeRouting(
      { tier: " T2-deep ", flow: "docs-change", phasesOff: "review, walkthrough" },
      VOCAB
    );
    expect(routing).toEqual({ tier: "T2-deep", flow: "docs-change", phasesOff: "review,walkthrough" });
    expect(rejected).toEqual([]);
  });

  it("refuses an out-of-vocabulary tier or flow", () => {
    expect(gw.sanitizeRouting({ tier: "T9-heroic" }, VOCAB)).toEqual({
      routing: null,
      rejected: [{ field: "tier", reason: "tier-not-in-vocabulary" }]
    });
    expect(gw.sanitizeRouting({ flow: "vibes" }, VOCAB)).toEqual({
      routing: null,
      rejected: [{ field: "flow", reason: "flow-not-in-vocabulary" }]
    });
  });

  it("refuses the WHOLE phasesOff pin when any phase is unknown", () => {
    // All-or-nothing on purpose: keeping the recognised half would turn "skip these
    // two gates" into "skip one of them", with a phase the user believes is off
    // still running and nothing on the badge to say so.
    const { routing, rejected } = gw.sanitizeRouting({ phasesOff: "review,teleport" }, VOCAB);
    expect(routing).toBe(null);
    expect(rejected).toEqual([{ field: "phasesOff", reason: "unknown-phase:teleport" }]);
  });

  it("blames the missing policy, not the user, when the vocabulary cannot be read", () => {
    const empty = { tiers: [], flows: [], phases: [] };
    for (const field of ["tier", "flow", "phasesOff"]) {
      const { routing, rejected } = gw.sanitizeRouting({ [field]: "anything" }, empty);
      expect(routing, field).toBe(null);
      expect(rejected, field).toEqual([{ field, reason: "policy-unavailable" }]);
    }
  });

  it("folds a phasesOff pin into the toggle map the card and the rail already speak", () => {
    expect(gw.phaseTogglesFromCsv("review,walkthrough")).toEqual({ review: false, walkthrough: false });
    // Empty stays NULL so an unpinned turn's hints are byte-identical to before.
    for (const empty of [null, undefined, "", " , "]) expect(gw.phaseTogglesFromCsv(empty)).toBe(null);
    // The inverse reports a RESOLVED plan back onto the badge row. Only `false`
    // entries are "off" - a `true` means the phase runs and must not be listed.
    expect(gw.phaseTogglesToCsv({ review: false, plan: true, walkthrough: false })).toBe("review,walkthrough");
    expect(gw.phaseTogglesToCsv({ plan: true })).toBe(null);
    expect(gw.phaseTogglesToCsv(null)).toBe(null);
  });

  it("is wired into routeHintsFromBody together with the turnSeq echo (§5)", () => {
    const hints = gw.routeHintsFromBody({ message: "hi", channel: "web", routing: { effort: "max", level: 99 }, turnSeq: 4 });
    expect(hints.routing).toEqual({ effort: "max" });
    expect(hints.routingRejected).toEqual([{ field: "level", reason: "level-not-an-integer-1-9" }]);
    expect(hints.turnSeq).toBe(4);
    // A body with no pin keeps the historical hint shape (nulls, not surprises).
    const bare = gw.routeHintsFromBody({ message: "hi" });
    expect(bare.routing).toBe(null);
    expect(bare.routingRejected).toEqual([]);
    expect(bare.turnSeq).toBe(null);
  });

  it("accepts only a complete exact Agent SDK resume attribution and rejects incompatible generations", () => {
    const spawnSignature = {
      version: 2,
      target: "sdk-haiku-chat",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      account: "work",
      accountSource: "target",
      projectPath: "/work/project",
      assembly: `a1:${"a".repeat(64)}`,
    };
    const candidate = {
      sessionId: "resume-session-1",
      route: "sdk-haiku-chat",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      effort: "high",
      account: "work",
      accountSource: "target",
      projectPath: "/work/project",
      spawnSignature,
    };
    expect(gw.sanitizeAgentSdkResume(candidate)).toEqual(candidate);
    expect(gw.routeHintsFromBody({ agentSdkResume: candidate }).agentSdkResume).toEqual(candidate);
    expect(gw.routeHintsFromBody({ agentSdkNewGeneration: true }).agentSdkNewGeneration).toBe(true);
    expect(gw.routeHintsFromBody({ agentSdkNewGeneration: "true" }).agentSdkNewGeneration).toBe(false);
    for (const malformed of [
      { ...candidate, extra: true },
      { ...candidate, sessionId: "../foreign" },
      { ...candidate, runtime: "claude-code" },
      { ...candidate, effort: "ultra" },
      { ...candidate, projectPath: "relative/project" },
      { ...candidate, spawnSignature: { ...spawnSignature, assembly: "a1:not-a-digest" } },
      { ...candidate, spawnSignature: { ...spawnSignature, model: "claude-sonnet-4-6" } },
      {
        ...candidate,
        spawnSignature: Object.fromEntries(
          Object.entries(spawnSignature).filter(([key]) => !["version", "assembly"].includes(key)),
        ),
      },
      Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== "accountSource")),
    ]) {
      expect(gw.sanitizeAgentSdkResume(malformed)).toBe(null);
    }

    const pre: any = preFixture({
      projectPath: "/work/project",
      route: {
        targetId: "sdk-haiku-chat",
        target: {
          id: "sdk-haiku-chat",
          runtime: "agent-sdk",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          effort: "high",
          account: "work",
        },
        role: "fast",
      },
    });
    pre.agentSdkAssembly = { digest: spawnSignature.assembly };
    pre.routeSession = gw.resolveRouteSession(pre, {
      routeSession: { epoch: 4, signature: spawnSignature },
    });
    expect(pre.routeSession).toMatchObject({ epoch: 4, disposition: "warm", boundaryReason: null });
    expect(gw.compatibleAgentSdkResumeSessionId(candidate, pre, {})).toBe("resume-session-1");
    expect(gw.compatibleAgentSdkResumeSessionId({ ...candidate, model: "claude-sonnet-4-6" }, pre, {})).toBe(null);
    expect(gw.compatibleAgentSdkResumeSessionId({ ...candidate, account: "personal" }, pre, {})).toBe(null);
    expect(gw.compatibleAgentSdkResumeSessionId({ ...candidate, projectPath: "/work/other" }, pre, {})).toBe(null);
    // Effort rotates the Query but remains the same logical journal/signature.
    expect(gw.compatibleAgentSdkResumeSessionId({ ...candidate, effort: "low" }, pre, {})).toBe("resume-session-1");

    // S completed under assembly A. A later turn resolved assembly B and
    // durably advanced routeSession, but failed before it could nominate a new
    // completed session. A cold gateway must reject S rather than resume A's
    // journal under B's prompt/tools/MCP/permission assembly.
    const spawnSignatureB = { ...spawnSignature, assembly: `a1:${"b".repeat(64)}` };
    pre.agentSdkAssembly = { digest: spawnSignatureB.assembly };
    pre.routeSession = gw.resolveRouteSession(pre, {
      routeSession: { epoch: 5, signature: spawnSignatureB },
    });
    expect(pre.routeSession).toMatchObject({ epoch: 5, disposition: "warm", boundaryReason: null });
    expect(gw.compatibleAgentSdkResumeSessionId(candidate, pre, {})).toBe(null);
  });

  it("accepts only an exact durable routeSession and computes stable/boundary epochs", () => {
    const legacySignature = {
      target: "sdk-haiku-chat",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      account: null,
      accountSource: null,
      projectPath: "/work/project",
    };
    const assembly = `a1:${"a".repeat(64)}`;
    const signature = { version: 2, ...legacySignature, assembly };
    const hint = { epoch: 4, signature };
    expect(gw.sanitizeRouteSession(hint)).toEqual(hint);
    expect(gw.sanitizeRouteSession({ epoch: 3, signature: legacySignature })).toEqual({
      epoch: 3,
      signature: legacySignature,
    });
    expect(gw.routeHintsFromBody({ routeSession: hint }).routeSession).toEqual(hint);
    expect(gw.sanitizeRouteSession({ ...hint, extra: true })).toBe(null);
    expect(gw.sanitizeRouteSession({ epoch: 0, signature })).toBe(null);
    expect(gw.sanitizeRouteSession({ epoch: 4, signature: { ...signature, effort: "high" } })).toBe(null);

    const pre: any = preFixture({
      projectPath: "/work/project",
      route: {
        targetId: "sdk-haiku-chat",
        target: {
          id: "sdk-haiku-chat",
          runtime: "agent-sdk",
          provider: "anthropic",
          model: "claude-haiku-4-5",
        },
        role: "fast",
      },
      agentSdkAssembly: { digest: assembly },
    });
    expect(gw.resolveRouteSession(pre, {})).toMatchObject({
      epoch: 1,
      signature,
      boundaryReason: "initial",
      disposition: "new",
      hadPrior: false,
    });
    expect(gw.resolveRouteSession(pre, { routeSession: hint })).toMatchObject({
      epoch: 4,
      boundaryReason: null,
      disposition: "warm",
      hadPrior: true,
    });
    expect(gw.resolveRouteSession(pre, {
      routeSession: { epoch: 4, signature: { ...signature, model: "claude-sonnet-4-6" } },
    })).toMatchObject({ epoch: 5, boundaryReason: "spawn-signature-changed", disposition: "new" });
    pre.agentSdkAssembly = { digest: `a1:${"b".repeat(64)}` };
    expect(gw.resolveRouteSession(pre, { routeSession: hint })).toMatchObject({
      epoch: 5,
      boundaryReason: "spawn-signature-changed",
      disposition: "new",
      signature: expect.objectContaining({ assembly: `a1:${"b".repeat(64)}` }),
    });
    pre.agentSdkAssembly = { digest: assembly };
    expect(gw.resolveRouteSession(pre, { routeSession: hint, agentSdkNewGeneration: true }))
      .toMatchObject({ epoch: 5, boundaryReason: "restart-recovery", disposition: "new" });

    const statelessWeb = preFixture({
      route: {
        targetId: "sec-codex",
        target: {
          id: "sec-codex",
          runtime: "codex",
          provider: "openai",
          model: "gpt-5-codex",
        },
      },
    });
    const firstStateless = gw.resolveRouteSession(statelessWeb, { channel: "web" });
    expect(firstStateless).toMatchObject({
      epoch: 1,
      boundaryReason: "initial",
      disposition: "new",
    });
    expect(gw.resolveRouteSession(statelessWeb, {
      channel: "web",
      routeSession: { epoch: firstStateless.epoch, signature: firstStateless.signature },
    })).toMatchObject({
      epoch: 2,
      boundaryReason: "stateless-runtime",
      disposition: "new",
    });

    const controlOnlyPre = {
      ...pre,
      routeSession: gw.resolveRouteSession(pre, { routeSession: hint }),
    };
    const controlAttribution = gw.controlTurnAttribution(controlOnlyPre, { channel: "web" }, {
      card: "control-card",
    });
    expect(controlAttribution).toMatchObject({ card: "control-card" });
    expect(controlAttribution).not.toHaveProperty("sessionDisposition");
    expect(controlAttribution).not.toHaveProperty("sessionBoundaryReason");
    expect(controlAttribution).not.toHaveProperty("sessionEpoch");
    expect(controlAttribution).not.toHaveProperty("spawnSignature");

    // The configured target is Agent SDK, but an image on ollama-local is
    // executed by the native one-shot vision lane. Its durable status must name
    // the runtime that actually owns continuity: there is no warm Query to reuse.
    const nativeVisionWeb = preFixture({
      route: {
        targetId: "sdk-ollama-chat",
        target: {
          id: "sdk-ollama-chat",
          runtime: "agent-sdk",
          provider: "ollama-local",
          model: "qwen3:0.6b",
        },
      },
      agentSdkAssembly: { digest: assembly },
    });
    const firstVision = gw.resolveRouteSession(nativeVisionWeb, {
      channel: "web",
      images: ["/tmp/bounded-vision-fixture.png"],
    });
    expect(firstVision).toMatchObject({
      epoch: 1,
      boundaryReason: "initial",
      disposition: "new",
      signature: {
        target: "sdk-ollama-chat",
        runtime: "ollama-native",
        provider: "ollama-local",
        model: "qwen3:0.6b",
      },
    });
    expect(firstVision.signature).not.toHaveProperty("assembly");
    expect(gw.resolveRouteSession(nativeVisionWeb, {
      channel: "web",
      images: ["/tmp/bounded-vision-fixture.png"],
      routeSession: { epoch: firstVision.epoch, signature: firstVision.signature },
    })).toMatchObject({
      epoch: 2,
      boundaryReason: "stateless-runtime",
      disposition: "new",
    });

    const textSdk = gw.resolveRouteSession(nativeVisionWeb, { channel: "web" });
    expect(textSdk.signature).toMatchObject({
      version: 2,
      runtime: "agent-sdk",
      assembly,
    });
    const visionAfterText = gw.resolveRouteSession(nativeVisionWeb, {
      channel: "web",
      images: ["/tmp/bounded-vision-fixture.png"],
      routeSession: { epoch: textSdk.epoch, signature: textSdk.signature },
    });
    expect(visionAfterText).toMatchObject({
      epoch: 2,
      boundaryReason: "spawn-signature-changed",
      signature: expect.objectContaining({ runtime: "ollama-native" }),
    });
    expect(gw.resolveRouteSession(nativeVisionWeb, {
      channel: "web",
      routeSession: { epoch: visionAfterText.epoch, signature: visionAfterText.signature },
    })).toMatchObject({
      epoch: 3,
      boundaryReason: "spawn-signature-changed",
      signature: expect.objectContaining({ runtime: "agent-sdk", assembly }),
    });

    pre.routeSession = gw.resolveRouteSession(pre, {});
    const routeEvents: any[] = [];
    const publisher = gw.createRouteSessionEventPublisher(pre, { turnSeq: 7 }, {
      generationId: "generation-route-contract",
      onSessionEvent: (event: any) => routeEvents.push(event),
    });
    publisher.observe();
    expect(routeEvents).toHaveLength(1);
    expect(routeEvents[0].blocks).toEqual([
      expect.objectContaining({ type: "route", attribution: expect.objectContaining({ spawnSignature: signature }) }),
    ]);
    expect(sanitizeWebSessionEvent(routeEvents[0])).toMatchObject({
      id: "route:generation-route-contract",
      order: 0,
      revision: 1,
      generationId: "generation-route-contract",
      blocks: [{
        type: "route",
        attribution: expect.objectContaining({
          route: "sdk-haiku-chat",
          model: "claude-haiku-4-5",
          sessionEpoch: 1,
          spawnSignature: signature,
        }),
      }],
    });

    const secondary = preFixture({
      route: {
        targetId: "sec-gemini",
        target: { id: "sec-gemini", runtime: "gemini", model: "gemini-2.5-flash" },
        role: "fast",
      },
    });
    expect(gw.resolvedSpawnSignature(secondary, {})).toMatchObject({
      target: "sec-gemini",
      runtime: "gemini",
      provider: "google",
      model: "gemini-2.5-flash",
    });
  });

  it("bounds gateway failures into the shared typed vocabulary", () => {
    const failure = normalizeFailureInfo(Object.assign(new Error(`boom\u0000${"x".repeat(2_000)}`), {
      code: "ECONNRESET",
      status: 503,
      request_id: "request-safe",
    }));
    expect(failure).toMatchObject({
      source: "gateway",
      kind: "transport",
      code: "ECONNRESET",
      retryable: true,
      httpStatus: 503,
      requestId: "request-safe",
    });
    expect(failure.text.length).toBeLessThanOrEqual(1_000);
    expect(failure.text).not.toContain("\u0000");
    expect(normalizeFailureInfo({ code: "retry", text: "later", retryable: true, retryAt: 0 }))
      .not.toHaveProperty("retryAt");
    expect(normalizeFailureInfo({ code: "retry", text: "later", retryable: true, retryAt: 123 }))
      .toHaveProperty("retryAt", 123);
  });

  it("emits a canonical gateway terminal that survives the Web persistence sanitizer", () => {
    const event = gw.gatewayFailureSessionEvent({
      generationId: "generation-gateway-failure",
      turnId: "9",
      order: 3,
      ts: 1234,
      failure: {
        source: "gateway",
        kind: "execution",
        code: "one_shot_failed",
        text: "Disposable runtime failed.",
        retryable: false,
      },
    });
    expect(event.blocks[1]).toMatchObject({
      type: "turn_end",
      status: "error",
      subtype: "one_shot_failed",
      reason: "one_shot_failed",
      stopReason: null,
      terminalReason: "error",
    });
    expect(sanitizeWebSessionEvent(event)).toEqual(event);
  });
});

describe("the effort vocabulary cannot drift from dutyEfforts", () => {
  it("TURN_EFFORTS === dutyEfforts (src/lib/types.ts)", () => {
    expect(TURN_EFFORTS).toEqual([...dutyEfforts]);
  });
});

describe("generation-safe Web permission control", () => {
  it("runs every lane unattended, including a named Web thread", () => {
    // A prompt stops the work until someone is watching that tab. Every lane -
    // Web, board, schedule, phone - runs without asking.
    delete process.env.GARRISON_WEB_PERMISSION_PROMPTS;
    for (const hints of [
      { channel: "web", sessionId: "thread-1" },
      { channel: "web", sessionId: "" },
      { channel: "kanban", sessionId: "thread-1" },
      null,
    ]) {
      expect(gw.permissionModeForHints(hints)).toBe("bypassPermissions");
    }
  });

  it("still has the whole prompting path behind an explicit opt-in", () => {
    // The durable permission card is a lot of machinery to lose by deletion; it
    // stays reachable so turning prompts back on is a flag, not a rebuild.
    process.env.GARRISON_WEB_PERMISSION_PROMPTS = "1";
    try {
      expect(gw.permissionModeForHints({ channel: "web", sessionId: "thread-1" })).toBe("default");
      for (const hints of [
        { channel: "web", sessionId: "" },
        { channel: "web", sessionId: "   " },
        { channel: "web", sessionId: " thread-1 " },
        { channel: "web" },
        { channel: "kanban", sessionId: "thread-1" },
        null,
      ]) {
        expect(gw.permissionModeForHints(hints)).toBe("bypassPermissions");
      }
    } finally {
      delete process.env.GARRISON_WEB_PERMISSION_PROMPTS;
    }
  });

  it("binds multiple one-shot resolvers to the exact thread, generation, and request", async () => {
    let id = 0;
    const control = gw.createPermissionControlPlane({ generateId: () => `generation-${++id}` });
    const generationId = control.openGeneration("thread-a");
    const first = control.awaitDecision("thread-a", generationId, {
      requestId: "request-1", generationId, inputComplete: true, suggestionsComplete: true, suggestions: [],
    });
    const second = control.awaitDecision("thread-a", generationId, {
      requestId: "request-2", generationId, inputComplete: true, suggestionsComplete: true, suggestions: [{ type: "addRules" }],
    });
    await expect(control.awaitDecision("thread-a", generationId, {
      requestId: "request-1", generationId, inputComplete: true, suggestionsComplete: true, suggestions: [],
    }))
      .rejects.toMatchObject({ code: "permission_request_conflict" });
    await expect(control.awaitDecision("thread-a", generationId, {
      requestId: "request-wrong-generation", generationId: "generation-other", inputComplete: true, suggestionsComplete: true,
    })).rejects.toMatchObject({ code: "permission_generation_unavailable" });

    expect(control.decide({ threadId: "thread-b", generationId, requestId: "request-1", decision: "allow_once" }).status).toBe(409);
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-2", decision: "allow_always" }).status).toBe(200);
    expect(await second).toBe("allow_always");
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-2", decision: "deny" }).status).toBe(409);

    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-1", decision: "allow_always" }).status).toBe(422);
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-1", decision: "allow_once" }).status).toBe(200);
    expect(await first).toBe("allow_once");

    const incomplete = control.awaitDecision("thread-a", generationId, {
      requestId: "request-incomplete", generationId, inputComplete: false, suggestionsComplete: false, suggestions: [{ type: "addRules" }],
    });
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-incomplete", decision: "allow_once" }).status).toBe(422);
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-incomplete", decision: "allow_always" }).status).toBe(422);
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-incomplete", decision: "deny" }).status).toBe(200);
    expect(await incomplete).toBe("deny");

    const partialSuggestions = control.awaitDecision("thread-a", generationId, {
      requestId: "request-partial-suggestions", generationId, inputComplete: true, suggestionsComplete: false, suggestions: [{ type: "addRules" }],
    });
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-partial-suggestions", decision: "allow_always" }).status).toBe(422);
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-partial-suggestions", decision: "allow_once" }).status).toBe(200);
    expect(await partialSuggestions).toBe("allow_once");
  });

  it("rejects malformed decisions and treats restart, abort, and teardown as unavailable without auto-denying", async () => {
    const control = gw.createPermissionControlPlane({ generateId: () => "generation-live" });
    const generationId = control.openGeneration("thread-a");
    const abort = new AbortController();
    const aborted = control
      .awaitDecision("thread-a", generationId, { requestId: "request-abort", generationId, inputComplete: true, suggestionsComplete: true, suggestions: [] }, { signal: abort.signal })
      .then(() => null, (error: any) => error);
    abort.abort();
    expect((await aborted)?.name).toBe("AbortError");
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-abort", decision: "deny" }).status).toBe(409);

    const closed = control
      .awaitDecision("thread-a", generationId, { requestId: "request-close", generationId, inputComplete: true, suggestionsComplete: true, suggestions: [] })
      .then(() => null, (error: any) => error);
    expect(control.closeGeneration(generationId)).toBe(true);
    expect((await closed)?.name).toBe("AbortError");
    expect(control.decide({ threadId: "thread-a", generationId, requestId: "request-close", decision: "deny" }).status).toBe(409);

    const restarted = gw.createPermissionControlPlane({ generateId: () => "generation-after-restart" });
    expect(restarted.decide({ threadId: "thread-a", generationId, requestId: "request-close", decision: "deny" }).status).toBe(409);
    expect(restarted.decide({ threadId: "thread-a", generationId, requestId: "request-close", decision: "yes" }).status).toBe(400);
    expect(restarted.decide({ threadId: "thread-a", generationId, requestId: "request-close", decision: "deny", extra: true }).status).toBe(400);
  });
});

// ── §7 the pin honored on the route, with reasons for everything refused ──────
const CONFIG = {
  version: 1,
  activeProfile: "demo",
  roles: ["expert", "standard", "fast", "image", "video", "review"],
  taskTypes: ["code", "review", "research", "image", "video", "writing", "ops", "other"],
  tiers: ["T0-trivial", "T1-standard", "T2-deep"],
  matrix: { defaults: { role: "standard" }, columns: {}, rows: {} },
  exceptions: [],
  discipline: {},
  continuations: [],
  targets: [
    { id: "cc-sonnet-med", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "sonnet", effort: "medium" },
    { id: "cc-opus-high", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "opus", effort: "high" },
    { id: "sdk-haiku-chat", type: "runtime-target", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", promptMode: "lean" },
    { id: "gemini-flash", type: "runtime-target", runtime: "gemini", provider: "google", model: "gemini-2.5-flash" },
    { id: "dispatch-fast", type: "runtime-target", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", pinned: true }
  ],
  profiles: {
    demo: {
      preRoute: "on",
      roleMap: {
        expert: "cc-opus-high",
        standard: "cc-sonnet-med",
        fast: "cc-sonnet-med",
        image: "cc-sonnet-med",
        video: "cc-sonnet-med",
        review: "cc-sonnet-med"
      }
    }
  }
};

function routeFixture() {
  return {
    targetId: "cc-sonnet-med",
    target: CONFIG.targets[0],
    via: "matrix",
    ruleId: "row:code/T1-standard",
    role: "standard"
  };
}

describe("applyTurnOverride — the pin reaches the route, refusals carry a reason (§7)", () => {
  it("swaps the whole target coherently and stamps via/ruleId", () => {
    const route: any = routeFixture();
    const out = applyTurnOverride(CONFIG, route, { target: "sdk-haiku-chat" });
    expect(out.applied).toEqual(["target"]);
    expect(route.targetId).toBe("sdk-haiku-chat");
    expect(route.target).toMatchObject({ runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5" });
    expect(route.via).toBe("turn-override");
    expect(route.ruleId).toBe("override:sdk-haiku-chat");
  });

  it("never mutates the config's own target record", () => {
    const route: any = routeFixture();
    applyTurnOverride(CONFIG, route, { target: "cc-opus-high", model: "opus-mangled", effort: "low" });
    expect(CONFIG.targets[1]).toMatchObject({ model: "opus", effort: "high" });
  });

  it("refuses an unknown target and leaves the resolved route untouched", () => {
    const route: any = routeFixture();
    const out = applyTurnOverride(CONFIG, route, { target: "no-such-target" });
    expect(out.rejected).toEqual([{ field: "target", reason: "unknown-target" }]);
    expect(route.targetId).toBe("cc-sonnet-med");
    expect(route.via).toBe("matrix"); // no via/ruleId rewrite for a refused pin
  });

  it("refuses effort where the provider has no effort control, honors it where it does", () => {
    const claude: any = routeFixture();
    expect(applyTurnOverride(CONFIG, claude, { effort: "max" }).applied).toEqual(["effort"]);
    expect(claude.target.effort).toBe("max");

    const gemini: any = { targetId: "gemini-flash", target: CONFIG.targets[3], via: "matrix" };
    expect(applyTurnOverride(CONFIG, gemini, { effort: "high" }).rejected).toEqual([
      { field: "effort", reason: "provider-has-no-effort-control" }
    ]);
    expect(gemini.target.effort).toBeUndefined();

    const sdk: any = { targetId: "sdk-haiku-chat", target: CONFIG.targets[2], via: "matrix" };
    expect(applyTurnOverride(CONFIG, sdk, { effort: "high" }).applied).toEqual(["effort"]);
    expect(effortControllable({ runtime: "agent-sdk", provider: "anthropic" })).toBe(true);
    expect(effortControllable({ runtime: "codex" })).toBe(true);
    // Cursor bakes effort into its model ids (gpt-5.3-codex-low vs -high), so an
    // effort pin has nothing behind it — same verdict as gemini, different cause.
    expect(effortControllable({ runtime: "cursor" })).toBe(false);
  });

  it("resolves a project to a real cwd, and REFUSES rather than falling back", () => {
    const ok: any = routeFixture();
    const applied = applyTurnOverride(CONFIG, ok, { project: "agent-garrison" }, {
      resolveProject: (name: string) => (name === "agent-garrison" ? "/home/u/dev/agent-garrison" : null)
    });
    expect(applied.applied).toEqual(["project"]);
    expect(applied.project).toBe("agent-garrison");
    expect(applied.projectPath).toBe("/home/u/dev/agent-garrison");

    const bad: any = routeFixture();
    const refused = applyTurnOverride(CONFIG, bad, { project: "../../etc" }, { resolveProject: () => null });
    expect(refused.rejected).toEqual([{ field: "project", reason: "project-not-a-git-repo-under-dev-root" }]);
    // The critical half: no cwd is reported, so no project badge is rendered and
    // the turn cannot run in the composition dir while claiming a project.
    expect(refused.projectPath).toBe(null);
    expect(refused.project).toBe(null);
  });

  it("refuses an account that is absent from the vault, or wrong for the runtime", () => {
    const absent: any = routeFixture();
    expect(applyTurnOverride(CONFIG, absent, { account: "ghost" }, { resolveAccount: () => null }).rejected).toEqual([
      { field: "account", reason: "account-not-found-in-vault" }
    ]);

    // An Anthropic token does nothing for a Google runtime: refused, not shown.
    const gemini: any = { targetId: "gemini-flash", target: CONFIG.targets[3], via: "matrix" };
    const mismatch = applyTurnOverride(CONFIG, gemini, { account: "work" }, {
      resolveAccount: () => ({ name: "work", platform: "anthropic", token: "t" })
    });
    expect(mismatch.rejected).toEqual([{ field: "account", reason: "account-platform-mismatch" }]);
    expect(gemini.target.account).toBeUndefined();

    const claude: any = routeFixture();
    const honored = applyTurnOverride(CONFIG, claude, { account: "work" }, {
      resolveAccount: () => ({ name: "work", platform: "anthropic", token: "t" })
    });
    expect(honored.applied).toEqual(["account"]);
    expect(claude.target.account).toBe("work");
  });

  it("is a no-op with no pin", () => {
    const route: any = routeFixture();
    expect(applyTurnOverride(CONFIG, route, null)).toMatchObject({ applied: [], rejected: [] });
    expect(route.via).toBe("matrix");
  });
});

// ── the pin must change the LANE, not the label ───────────────────────────────
// The pure helper cases below deliberately retain a routing.json-v1 fixture to
// cover the isolated compatibility path. The real-process fixture later in the
// file projects schema-v4 dispatch-fast through a v2 execution model.
class FakeSession {
  cfg: any;
  keys: string[] = [];
  disposed = false;
  constructor(cfg: any) {
    this.cfg = cfg;
  }
  async runTurn({ message }: { message: string }) {
    if (/routing classifier/i.test(message)) {
      return { reply: JSON.stringify({ taskType: "code", tier: "T1-standard", matchedException: null }), sessionId: "fake-classifier" };
    }
    return { reply: "ok\n[route: x | rule: y | profile: z]", sessionId: "fake-operative" };
  }
  writeKeys(b: string) {
    this.keys.push(b);
  }
  isAlive() {
    return !this.disposed;
  }
  isDisposed() {
    return this.disposed;
  }
  getClaudeSessionId() {
    return "fake";
  }
  status() {
    return { model: this.cfg?.model };
  }
  dispose() {
    this.disposed = true;
  }
}

async function bootGateway(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gar-runctx-gw-"));
  mkdirSync(path.join(dir, ".garrison"), { recursive: true });
  const decisionsFile = path.join(dir, ".garrison", "decisions.jsonl");
  const gateway: any = await createRoutedGateway({
    compositionDir: dir,
    config: JSON.parse(JSON.stringify(CONFIG)),
    decisionsFile,
    spawnFn: (cfg: any) => Promise.resolve(new FakeSession(cfg)),
    logFn: () => {},
    ...extra
  });
  gateway.injectSettleMs = 1;
  await gateway.start();
  return { gateway, dir, decisionsFile };
}

describe("a pinned target changes the resolved LANE, not just the badge (§7)", () => {
  it("preRoute honors the pin BEFORE the plan selection and the decision record", async () => {
    const { gateway, decisionsFile } = await bootGateway();
    try {
      const pre = await gateway.preRoute("add a test for the login flow", {
        channel: "web",
        routing: { target: "sdk-haiku-chat" }
      });
      // The lane: an agent-sdk plan, NOT the claude-code PTY switch the matrix
      // resolved to. This is the difference between honoring a pin and labelling it.
      expect(pre.route.target.runtime).toBe("agent-sdk");
      expect(pre.plan.path).toBe("agent-sdk");
      expect(gateway.isAgentSdkTarget(pre.route)).toBe(true);
      expect(pre.overridesApplied).toEqual(["target"]);
      expect(pre.route.via).toBe("turn-override");
      // The decision log — written after the overlay — records what actually ran.
      const decisions = readFileSync(decisionsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const last = decisions[decisions.length - 1];
      expect(last).toMatchObject({ targetId: "sdk-haiku-chat", runtime: "agent-sdk", overrides: ["target"] });
      // The PTY operative was never switched for a pin that left the Claude lane.
      expect(gateway.getOperativeSession().keys.join("")).toBe("");
    } finally {
      gateway.shutdown();
    }
  });

  it("keeps an unpinned durable conversation on its prior target without claiming a new override", async () => {
    const { gateway } = await bootGateway();
    try {
      const pre = await gateway.preRoute("add a test for the login flow", {
        channel: "web",
        routeSession: {
          epoch: 7,
          signature: {
            target: "sdk-haiku-chat",
            runtime: "agent-sdk",
            provider: "anthropic",
            model: "claude-haiku-4-5",
            account: null,
            accountSource: null,
            projectPath: null,
          },
        },
      });
      expect(pre.route.targetId).toBe("sdk-haiku-chat");
      expect(pre.plan.path).toBe("agent-sdk");
      expect(pre.overridesApplied).toBe(null);
      expect(pre.route.via).toBe("global-default");
    } finally {
      gateway.shutdown();
    }
  });

  it("carries an unresolvable project as a rejection, never as a silent cwd fallback", async () => {
    const { gateway } = await bootGateway({ resolveProject: () => null });
    try {
      const pre = await gateway.preRoute("do the thing", { channel: "web", routing: { project: "not-a-repo" } });
      expect(pre.projectPath).toBe(null);
      expect(pre.project).toBe(null);
      expect(pre.overridesRejected).toEqual([{ field: "project", reason: "project-not-a-git-repo-under-dev-root" }]);
      // …and therefore no project badge: the one-shot lane runs in the composition
      // dir, which is exactly what the (absent) badge says.
      expect(gw.turnAttribution(pre, {}).project).toBe(null);
    } finally {
      gateway.shutdown();
    }
  });

  it("plans an unavailable personal scope as refused without switching the operative", async () => {
    const { gateway } = await bootGateway({ resolveProject: () => null });
    try {
      const pre = await gateway.preRoute("do the personal thing", {
        channel: "kanban",
        routing: { project: "@personal" }
      });
      expect(pre.overridesRejected).toEqual([
        { field: "project", reason: "personal-workspace-unavailable" }
      ]);
      expect(pre.plan).toEqual({ path: "refused", reasons: ["managed personal workspace unavailable"] });
      expect(gateway.getOperativeSession().keys.join("")).toBe("");
      expect(() => gw.assertExecutableRunScope(pre)).toThrow(/personal execution refused/i);
    } finally {
      gateway.shutdown();
    }
  });

  it("plans a scoped Claude pin onto the cwd-keyed lane without switching the standing operative", async () => {
    const scopedCwd = path.join(compositionDir, "scoped-project");
    mkdirSync(scopedCwd, { recursive: true });
    const { gateway } = await bootGateway({ resolveProject: () => scopedCwd });
    try {
      const pre = await gateway.preRoute("do the thing", {
        channel: "kanban",
        routing: { target: "cc-opus-high", project: "scoped-project" }
      });
      expect(pre.projectPath).toBe(scopedCwd);
      expect(pre.plan.path).toBe("claude-delegate");
      expect(pre.plan.reasons.join(" ")).toContain(scopedCwd);
      expect(gateway.getOperativeSession().keys.join("")).toBe("");
    } finally {
      gateway.shutdown();
    }
  });

  it("folds the edge's own validation rejections into the same list", async () => {
    const { gateway } = await bootGateway();
    try {
      const hints = gw.routeHintsFromBody({ message: "hi", channel: "web", routing: { target: "cc-opus-high", effort: "nope" } });
      const pre = await gateway.preRoute("hi", hints);
      expect(pre.overridesApplied).toEqual(["target"]);
      expect(pre.overridesRejected).toEqual([{ field: "effort", reason: "effort-not-in-vocabulary" }]);
    } finally {
      gateway.shutdown();
    }
  });

  it("records a duty pin that no cell can resolve, and still routes the turn", async () => {
    const { gateway } = await bootGateway();
    try {
      // No v4 execution manifest is projected for this fixture, so the duty lane
      // cannot resolve — a rejection, not a 500.
      const pre = await gateway.preRoute("hi", { channel: "web", routing: { duty: "develop", level: 2 } });
      expect(pre.overridesRejected).toEqual([{ field: "duty", reason: "duty-cell-unresolved" }]);
      expect(pre.route.targetId).toBe("cc-sonnet-med");
    } finally {
      gateway.shutdown();
    }
  });
});

// ── §9 cancel: the registry, and the lanes that fill it ──────────────────────
describe("the interrupt registry (§9)", () => {
  it("dispatches to the lane's stop primitive and reports which lane", async () => {
    const stop = vi.fn(() => true);
    const turns = new Map([["thread-1", { lane: "agent-sdk", stop, cancelled: false }]]);
    const r = await gw.handleInterrupt({ sessionId: "thread-1" }, turns);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, lane: "agent-sdk", stopped: true });
    expect(stop).toHaveBeenCalledTimes(1);
    // The flag is what turns into stoppedByUser on the done frame.
    expect(turns.get("thread-1")!.cancelled).toBe(true);
  });

  it("404s an unknown conversation instead of stopping somebody else's turn", async () => {
    const stop = vi.fn();
    const turns = new Map([["thread-1", { lane: "standing-pty", stop, cancelled: false }]]);
    const r = await gw.handleInterrupt({ sessionId: "thread-9" }, turns);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ ok: false, error: "no-active-turn" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("falls back to the reserved key when the client sends no conversation id", async () => {
    const turns = new Map([["operative", { lane: "standing-pty", stop: () => true, cancelled: false }]]);
    expect((await gw.handleInterrupt({}, turns)).status).toBe(200);
  });

  it("fails closed when a card-bound interrupt does not own the active turn", async () => {
    const stop = vi.fn(() => true);
    const turns = new Map([[
      "operative",
      { lane: "agent-sdk", stop, cancelled: false, cardIds: ["CARD-A"], dutyKey: "CARD-A:plan" }
    ]]);

    const r = await gw.handleInterrupt({ cardId: "CARD-B" }, turns);

    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({
      ok: false,
      error: "active-turn-belongs-to-another-card",
      cardId: "CARD-B",
      activeCardIds: ["CARD-A"]
    });
    expect(stop).not.toHaveBeenCalled();
    expect(turns.get("operative")!.cancelled).toBe(false);

    // A turn without card identity (for example, one started by an older client)
    // is unverifiable too. Never interpret missing ownership as a match.
    const unidentifiedStop = vi.fn(() => true);
    const unidentified = new Map([[
      "operative",
      { lane: "standing-pty", stop: unidentifiedStop, cancelled: false }
    ]]);
    expect((await gw.handleInterrupt({ cardId: "CARD-B" }, unidentified)).status).toBe(409);
    expect(unidentifiedStop).not.toHaveBeenCalled();
  });

  it("stops a shared batch only when the requested card is one of its members", async () => {
    const stop = vi.fn(() => true);
    const turns = new Map([[
      "operative",
      { lane: "agent-sdk", stop, cancelled: false, cardIds: ["CARD-A", "CARD-B"] }
    ]]);

    const r = await gw.handleInterrupt({ cardId: "CARD-B" }, turns);

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, cardIds: ["CARD-A", "CARD-B"], stopped: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(turns.get("operative")!.cancelled).toBe(true);
    expect((turns.get("operative") as any).interruptedByCardId).toBe("CARD-B");
  });

  it("409s a lane with no cancel primitive rather than claiming a stop", async () => {
    const turns = new Map([["t", { lane: "ollama-native", stop: null, cancelled: false }]]);
    const r = await gw.handleInterrupt({ sessionId: "t" }, turns);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "lane-has-no-cancel-primitive", lane: "ollama-native" });
  });

  it("does not mark a turn interrupted when its cancel primitive explicitly declines", async () => {
    const turns = new Map([[
      "operative",
      { lane: "standing-pty", stop: () => false, cancelled: false, cardIds: ["CARD-A"] }
    ]]);
    const r = await gw.handleInterrupt({ cardId: "CARD-A" }, turns);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: "cancel-primitive-did-not-stop" });
    expect(turns.get("operative")!.cancelled).toBe(false);
  });

  it("reports a throwing stop as a failure, not a success", async () => {
    const turns = new Map([
      [
        "t",
        {
          lane: "codex",
          stop: () => {
            throw new Error("dead child");
          },
          cancelled: false
        }
      ]
    ]);
    expect((await gw.handleInterrupt({ sessionId: "t" }, turns)).status).toBe(500);
  });
});

describe("streamed Web generation interrupt control", () => {
  it("latches before stop registration and coalesces concurrent duplicate interrupts", async () => {
    const control = gw.createGenerationTurnControlPlane({ logFn: vi.fn() });
    const claimed = control.claim("thread-a", "generation-a", { lane: "routing" });
    expect(claimed.status).toBe(201);
    const entry = claimed.entry;

    // `open` is already visible but routing has not supplied a runtime primitive.
    expect(await control.interrupt({ threadId: "thread-a", generationId: "generation-a" }))
      .toMatchObject({ status: 202, body: { ok: true, state: "pending-stop" } });

    let resolveStop!: (stopped: boolean) => void;
    const stop = vi.fn(() => new Promise<boolean>((resolve) => { resolveStop = resolve; }));
    expect(control.registerStop(entry, "agent-sdk", stop)).toEqual({
      registered: true,
      cancelRequested: true,
    });
    expect(stop).toHaveBeenCalledTimes(1);

    const duplicateA = control.interrupt({ threadId: "thread-a", generationId: "generation-a" });
    const duplicateB = control.interrupt({ threadId: "thread-a", generationId: "generation-a" });
    resolveStop(true);

    expect((await duplicateA).status).toBe(200);
    expect((await duplicateB).status).toBe(200);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(entry.cancelled).toBe(true);
  });

  it("reports an in-flight non-cancellable Ollama vision lane honestly while preserving the pre-runtime latch", async () => {
    const control = gw.createGenerationTurnControlPlane({ logFn: vi.fn() });
    const running = control.claim("thread-vision", "generation-vision", { lane: "routing" });
    const cannotStop = vi.fn(() => false);
    expect(control.registerStop(running.entry, "ollama-native", cannotStop)).toEqual({
      registered: true,
      cancelRequested: false,
    });

    expect(await control.interrupt({ threadId: "thread-vision", generationId: "generation-vision" }))
      .toMatchObject({
        status: 409,
        body: { error: "cancel-primitive-did-not-stop", lane: "ollama-native" },
      });
    expect(running.entry.cancelled).toBe(false);

    const beforeRuntime = control.claim("thread-before-runtime", "generation-before-runtime", { lane: "routing" });
    expect(await control.interrupt({
      threadId: "thread-before-runtime",
      generationId: "generation-before-runtime",
    })).toMatchObject({ status: 202, body: { state: "pending-stop" } });
    const latchedPrimitive = vi.fn(() => false);
    expect(control.registerStop(beforeRuntime.entry, "ollama-native", latchedPrimitive)).toEqual({
      registered: true,
      cancelRequested: true,
    });
    expect(latchedPrimitive).toHaveBeenCalledTimes(1);
  });

  it("retries a refused exact stop after settling all callers coalesced on that attempt", async () => {
    const control = gw.createGenerationTurnControlPlane({ logFn: vi.fn() });
    const claimed = control.claim("thread-retry-false", "generation-retry-false");
    let settleFirst!: (stopped: boolean) => void;
    const stop = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { settleFirst = resolve; }))
      .mockReturnValueOnce(true);
    control.registerStop(claimed.entry, "agent-sdk", stop);

    const firstA = control.interrupt({ threadId: "thread-retry-false", generationId: "generation-retry-false" });
    const firstB = control.interrupt({ threadId: "thread-retry-false", generationId: "generation-retry-false" });
    expect(stop).toHaveBeenCalledTimes(1);
    settleFirst(false);
    expect((await firstA).status).toBe(409);
    expect((await firstB).status).toBe(409);

    expect((await control.interrupt({
      threadId: "thread-retry-false",
      generationId: "generation-retry-false",
    })).status).toBe(200);
    // Success alone is memoized; another duplicate does not signal twice.
    expect((await control.interrupt({
      threadId: "thread-retry-false",
      generationId: "generation-retry-false",
    })).status).toBe(200);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(claimed.entry.cancelled).toBe(true);
  });

  it("lets Retry reach a stop primitive after a transient synchronous failure", async () => {
    const control = gw.createGenerationTurnControlPlane({ logFn: vi.fn() });
    const claimed = control.claim("thread-retry-error", "generation-retry-error");
    const stop = vi.fn()
      .mockImplementationOnce(() => { throw new Error("runtime still starting"); })
      .mockReturnValueOnce(true);
    control.registerStop(claimed.entry, "secondary", stop);

    expect(await control.interrupt({ threadId: "thread-retry-error", generationId: "generation-retry-error" }))
      .toMatchObject({ status: 500, body: { error: "cancel-failed", lane: "secondary" } });
    expect(await control.interrupt({ threadId: "thread-retry-error", generationId: "generation-retry-error" }))
      .toMatchObject({ status: 200, body: { stopped: true, lane: "secondary" } });
    expect(await control.interrupt({ threadId: "thread-retry-error", generationId: "generation-retry-error" }))
      .toMatchObject({ status: 200 });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("rejects overlap and stale or wrong tuples without touching the current generation", async () => {
    const control = gw.createGenerationTurnControlPlane();
    const first = control.claim("thread-a", "generation-a");
    expect(first.status).toBe(201);
    expect(control.claim("thread-a", "generation-b")).toMatchObject({
      status: 409,
      body: { code: "thread_generation_conflict" },
    });

    const firstStop = vi.fn(() => true);
    control.registerStop(first.entry, "agent-sdk", firstStop);
    expect(await control.interrupt({ threadId: "thread-wrong", generationId: "generation-a" }))
      .toMatchObject({ status: 409, body: { code: "turn_generation_unavailable" } });
    expect(await control.interrupt({ threadId: "thread-a", generationId: "generation-wrong" }))
      .toMatchObject({ status: 409, body: { code: "turn_generation_unavailable" } });
    expect(firstStop).not.toHaveBeenCalled();

    expect(control.release(first.entry)).toBe(true);
    const current = control.claim("thread-a", "generation-b");
    expect(current.status).toBe(201);
    const currentStop = vi.fn(() => true);
    control.registerStop(current.entry, "agent-sdk", currentStop);

    expect(await control.interrupt({ threadId: "thread-a", generationId: "generation-a" }))
      .toMatchObject({ status: 409, body: { code: "turn_generation_unavailable" } });
    // Cleanup from the old request is identity-bound and cannot erase its successor.
    expect(control.release(first.entry)).toBe(false);
    expect(control.currentGenerationByThread.get("thread-a")).toBe("generation-b");
    expect(currentStop).not.toHaveBeenCalled();
  });

  it("recovers a claimed generation only through its exact durable Web input id", () => {
    const control = gw.createGenerationTurnControlPlane();
    const claimed = control.claim("thread-restart", "generation-restart", {
      lane: "agent-sdk",
      inputId: "input-restart",
    });
    expect(claimed.status).toBe(201);
    expect(control.lookupInput({ threadId: "thread-restart", inputId: "input-restart" })).toEqual({
      status: 200,
      body: {
        ok: true,
        threadId: "thread-restart",
        inputId: "input-restart",
        generationId: "generation-restart",
        lane: "agent-sdk",
        state: "starting",
      },
    });
    expect(control.lookupInput({ threadId: "thread-restart", inputId: "input-foreign" }))
      .toMatchObject({ status: 409, body: { code: "thread_input_generation_conflict" } });
    expect(control.lookupInput({ threadId: "thread-foreign", inputId: "input-restart" }))
      .toMatchObject({ status: 404, body: { code: "input_generation_unavailable" } });
    expect(control.lookupInput({ threadId: "thread-restart", inputId: "input-restart", extra: true }))
      .toMatchObject({ status: 400 });
    expect(control.claim("thread-invalid", "generation-invalid", { inputId: "bad\ninput" }))
      .toMatchObject({ status: 400, body: { code: "invalid_turn_generation" } });

    expect(control.release(claimed.entry)).toBe(true);
    expect(control.lookupInput({ threadId: "thread-restart", inputId: "input-restart" }))
      .toMatchObject({ status: 404, body: { code: "input_generation_unavailable" } });
  });

  it("holds a recovered generation through its runtime reset before admitting a successor", async () => {
    const control = gw.createGenerationTurnControlPlane();
    const claimed = control.claim("thread-recovery", "generation-recovery", {
      lane: "agent-sdk",
      inputId: "input-recovery",
    });
    const stop = vi.fn(() => true);
    control.registerStop(claimed.entry, "agent-sdk", stop);
    let announceReset!: () => void;
    const resetStarted = new Promise<void>((resolve) => { announceReset = resolve; });
    let finishReset!: () => void;
    const allowReset = new Promise<void>((resolve) => { finishReset = resolve; });
    const reset = vi.fn(async () => {
      announceReset();
      await allowReset;
    });
    expect(control.registerRecoveryReset(claimed.entry, reset)).toBe(true);

    expect(await control.recoverInput({ threadId: "thread-recovery", inputId: "input-recovery" }))
      .toMatchObject({
        status: 200,
        body: { stopped: true, generationId: "generation-recovery" },
      });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(control.release(claimed.entry)).toBe(true);
    await resetStarted;
    expect(control.lookupInput({ threadId: "thread-recovery", inputId: "input-recovery" }))
      .toMatchObject({ status: 200, body: { state: "releasing" } });
    expect(control.claim("thread-recovery", "generation-successor", { inputId: "input-successor" }))
      .toMatchObject({ status: 409, body: { code: "thread_generation_conflict" } });

    finishReset();
    await vi.waitFor(() => expect(
      control.lookupInput({ threadId: "thread-recovery", inputId: "input-recovery" }).status,
    ).toBe(404));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(control.claim("thread-recovery", "generation-successor", { inputId: "input-successor" }).status)
      .toBe(201);
  });

  it("parses Web and legacy interrupt bodies as a strict, fail-closed union", async () => {
    const control = gw.createGenerationTurnControlPlane();
    const legacyStop = vi.fn(() => true);
    const legacy = new Map([["legacy-session", { lane: "standing-pty", stop: legacyStop, cancelled: false }]]);

    expect(await gw.handleInterrupt(
      { threadId: "thread-a", generationId: "generation-a", sessionId: "legacy-session" },
      legacy,
      control,
    )).toMatchObject({ status: 400 });
    expect(await gw.handleInterrupt({ sessionId: "legacy-session", extra: true }, legacy, control))
      .toMatchObject({ status: 400 });
    expect(legacyStop).not.toHaveBeenCalled();

    expect(await gw.handleInterrupt({ sessionId: "legacy-session" }, legacy, control))
      .toMatchObject({ status: 200, body: { lane: "standing-pty" } });
    expect(legacyStop).toHaveBeenCalledTimes(1);
  });
});

describe("concurrent AskUserQuestion stream ownership", () => {
  it("delivers only to the transcript owner and remains correct when streams finish out of order", () => {
    const pending = new Map();
    const rich: any[] = [];
    const registry = gw.createQuestionTurnRegistry({
      pending,
      broadcastRichFn: (type: string, payload: any) => rich.push({ type, payload }),
      nowFn: () => 123,
    });
    const seenA: any[] = [];
    const seenB: any[] = [];
    const turnA = { questionCardId: "CARD-A", questionSink: (payload: any) => seenA.push(payload) };
    const turnB = { questionCardId: "CARD-B", questionSink: (payload: any) => seenB.push(payload) };
    const transcriptA = path.join(tmpdir(), "concurrent-question-a.jsonl");
    const transcriptB = path.join(tmpdir(), "concurrent-question-b.jsonl");
    registry.bind(turnA, { transcript_path: transcriptA });
    registry.bind(turnB, { transcript_path: transcriptB });

    registry.deliver(
      { tool_use_id: "question-a", questions: [{ question: "A only?" }] },
      { transcriptPath: transcriptA },
    );
    registry.deliver(
      { tool_use_id: "question-b", questions: [{ question: "B only?" }] },
      { transcriptPath: transcriptB },
    );
    expect(seenA.map((payload) => payload.tool_use_id)).toEqual(["question-a"]);
    expect(seenB.map((payload) => payload.tool_use_id)).toEqual(["question-b"]);
    expect(pending.get("question-a")).toMatchObject({ cardId: "CARD-A", at: 123 });
    expect(pending.get("question-b")).toMatchObject({ cardId: "CARD-B", at: 123 });

    // B completes first. Its cleanup neither removes A's pending question nor
    // diverts a later watcher event from A into B's already-finished stream.
    registry.release(turnB);
    registry.deliver(
      { tool_use_id: "question-a-2", questions: [{ question: "Still A?" }] },
      { transcriptPath: transcriptA },
    );
    expect(seenA.map((payload) => payload.tool_use_id)).toEqual(["question-a", "question-a-2"]);
    expect(seenB.map((payload) => payload.tool_use_id)).toEqual(["question-b"]);
    expect(pending.has("question-b")).toBe(false);
    expect(pending.has("question-a")).toBe(true);

    // If a transcript coordinate is reclaimed, late cleanup by its older owner
    // is identity-checked and cannot erase the new stream's binding.
    registry.bind(turnB, { transcript_path: transcriptA });
    registry.release(turnA);
    registry.deliver(
      { tool_use_id: "question-b-2", questions: [{ question: "Now B?" }] },
      { transcriptPath: transcriptA },
    );
    expect(seenA).toHaveLength(2);
    expect(seenB.map((payload) => payload.tool_use_id)).toEqual(["question-b", "question-b-2"]);
    expect(rich).toHaveLength(4);
  });

  it("actuates concurrent answers only on the exact owning thread session", async () => {
    const pending = new Map();
    const writesA: string[] = [];
    const writesB: string[] = [];
    const question = { options: [{ label: "Yes" }, { label: "No" }] };
    pending.set("tool-a", {
      threadId: "thread-a",
      questions: [question],
      actuator: { available: () => true, write: (bytes: string) => writesA.push(bytes) },
    });
    pending.set("tool-b", {
      threadId: "thread-b",
      questions: [question],
      actuator: { available: () => true, write: (bytes: string) => writesB.push(bytes) },
    });

    const [answerA, answerB] = await Promise.all([
      gw.handleAnswer({ session_id: "thread-a", tool_use_id: "tool-a", label: "Yes" }, { pending }),
      gw.handleAnswer({ session_id: "thread-b", tool_use_id: "tool-b", label: "No" }, { pending }),
    ]);
    expect(answerA).toMatchObject({ status: 200, body: { action: "select", label: "Yes" } });
    expect(answerB).toMatchObject({ status: 200, body: { action: "select", label: "No" } });
    expect(writesA).toHaveLength(1);
    expect(writesB).toHaveLength(2);
    expect(pending.size).toBe(0);
  });

  it("requires a tool id and refuses foreign-thread dismiss or free-text actuation", async () => {
    const writes: string[] = [];
    const actuator = { available: () => true, write: (bytes: string) => writes.push(bytes) };
    const pending = new Map([
      ["tool-dismiss", { threadId: "thread-a", questions: [{ options: [] }], actuator }],
      ["tool-text", { threadId: "thread-a", questions: [{ options: [] }], actuator }],
    ]);

    expect(await gw.handleAnswer({ session_id: "thread-a", dismiss: true }, { pending }))
      .toMatchObject({ status: 400, body: { code: "question_id_required" } });
    expect(await gw.handleAnswer({
      session_id: "thread-b",
      tool_use_id: "tool-dismiss",
      dismiss: true,
    }, { pending })).toMatchObject({ status: 409, body: { code: "question_owner_mismatch" } });
    expect(await gw.handleAnswer({
      session_id: "thread-b",
      tool_use_id: "tool-text",
      text: "foreign answer",
    }, { pending })).toMatchObject({ status: 409, body: { code: "question_owner_mismatch" } });
    expect(writes).toEqual([]);
    expect(pending.size).toBe(2);

    expect(await gw.handleAnswer({
      session_id: "thread-a",
      tool_use_id: "tool-dismiss",
      dismiss: true,
    }, { pending })).toMatchObject({ status: 200, body: { action: "dismiss" } });
    expect(await gw.handleAnswer({
      session_id: "thread-a",
      tool_use_id: "tool-text",
      text: "owner answer",
    }, { pending })).toMatchObject({ status: 200, body: { action: "text" } });
    expect(writes).toHaveLength(4); // Escape; Ctrl-U, text, Enter.
    expect(pending.size).toBe(0);
  });
});

// A fake AgentSdkAdapter with the new cancel + streaming hooks.
class FakeAgentSdk {
  id = "agent-sdk";
  spawned: any[] = [];
  cancelled: any[] = [];
  tornDown: any[] = [];
  hooks: any[] = [];
  turns: string[] = [];
  response: any = { text: "final answer", toolUses: [], stoppedReason: null };
  blocks: { text?: string; tool?: { name: string; id: string } }[] = [];
  initialSessionId: string | null | undefined = undefined;
  systemSessionId: string | null = null;
  async spawn(cfg: any) {
    this.spawned.push(cfg);
    const generated = `sdk-${this.spawned.length}`;
    return {
      alive: true,
      sessionId: this.initialSessionId === undefined ? (cfg.sessionId ?? generated) : this.initialSessionId,
      harness: { promptMode: cfg.promptMode },
      config: cfg
    };
  }
  async awaitReady() {}
  async sendTurn(s: any, text: string, hooks: any = {}) {
    this.turns.push(text);
    this.hooks.push(hooks);
    if (this.systemSessionId) {
      s.sessionId = this.systemSessionId;
      hooks.onSession?.(this.systemSessionId);
    }
    let acc = "";
    for (const block of this.blocks) {
      if (block.text) {
        acc += block.text;
        hooks.onText?.(acc);
      }
      if (block.tool) hooks.onTool?.(block.tool);
    }
  }
  async awaitResponse() {
    return this.response;
  }
  async setEffort(session: any, effort: string) {
    session.effort = effort;
    session.effortApplied = true;
  }
  async cancel(session: any) {
    this.cancelled.push(session.sessionId);
    return true;
  }
  async teardown(s: any) {
    this.tornDown.push(s.sessionId);
    s.alive = false;
  }
}

function sdkRoute() {
  return { targetId: "sdk-haiku-chat", target: { ...CONFIG.targets[2] } };
}

function bareGateway(agentSdk: any) {
  const gateway: any = Object.create(RoutedGateway.prototype);
  gateway.logFn = () => {};
  gateway.compositionDir = compositionDir;
  gateway.config = CONFIG;
  gateway._agentSdkAdapter = agentSdk;
  gateway._agentSdkAssemblyResolver = resolveRoutedAgentSdkAssembly;
  gateway._agentSdkSessions = new Map();
  gateway.secrets = null;
  gateway.secretsFn = null;
  return gateway;
}

describe("agent-sdk lane: conversation identity, liveness and a real stop (§9, §12)", () => {
  it("signs and retains one immutable prompt/tool/MCP assembly without leaking raw bytes into cache keys", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const mcp = {
      garrison: {
        command: "node",
        args: ["/private/mcp-sentinel.mjs", "stdio"],
        env: { SENTINEL: "mcp-secret-sentinel" },
      },
    };
    gateway._agentSdkAppendSystemPrompt = "assembled prompt sentinel";
    gateway._agentSdkMcpServers = mcp;
    const route = sdkRoute();
    (route.target as any).promptMode = "full";
    (route.target as any).allowedTools = ["Write", "Read", "Write"];
    (route.target as any).disallowedTools = ["WebSearch"];
    const assembly = gateway.resolveAgentSdkAssembly(route, {
      cwd: "/work/project",
      permissionMode: "default",
      streamingInput: true,
    });

    expect(assembly.digest).toMatch(/^a1:[a-f0-9]{64}$/);
    expect(assembly.config).toMatchObject({
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "assembled prompt sentinel",
      },
      settingSources: [],
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: ["Read", "Write"],
      disallowedTools: ["WebSearch"],
      mcpServers: mcp,
      strictMcpConfig: true,
      permissionMode: "default",
      compositionDir: "/work/project",
      streamingInput: true,
    });
    expect(Object.isFrozen(assembly.config)).toBe(true);
    expect(Object.isFrozen(assembly.config.mcpServers.garrison.args)).toBe(true);

    const originalEffort = (route.target as any).effort;
    (route.target as any).effort = "max";
    const effortOnly = gateway.resolveAgentSdkAssembly(route, {
      cwd: "/work/project",
      permissionMode: "default",
      streamingInput: true,
    });
    expect(effortOnly.digest).toBe(assembly.digest);
    (route.target as any).effort = originalEffort;

    mcp.garrison.args[0] = "/mutated.mjs";
    (route.target as any).allowedTools.push("Bash");
    await gateway.runAgentSdkTurn(route, "exact user text", undefined, {
      sessionKey: "assembly-thread",
      generationId: "assembly-generation",
      streamingInput: true,
      permissionMode: "default",
      assembly,
    });
    expect(adapter.turns).toEqual(["exact user text"]);
    expect(adapter.spawned[0]).toMatchObject({
      fixedAssembly: {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: "assembled prompt sentinel",
        },
        settingSources: [],
        tools: { type: "preset", preset: "claude_code" },
        allowedTools: ["Read", "Write"],
        mcpServers: { garrison: { args: ["/private/mcp-sentinel.mjs", "stdio"] } },
        strictMcpConfig: true,
      },
    });
    const cacheIdentity = [...gateway._agentSdkSessions.keys()].join("\n");
    expect(cacheIdentity).toContain(assembly.digest);
    expect(cacheIdentity).not.toContain("assembled prompt sentinel");
    expect(cacheIdentity).not.toContain("mcp-secret-sentinel");
    expect(cacheIdentity).not.toContain("/private/mcp-sentinel.mjs");

    gateway._agentSdkAppendSystemPrompt = "changed prompt bytes";
    const changed = gateway.resolveAgentSdkAssembly(route, {
      cwd: "/work/project",
      permissionMode: "default",
      streamingInput: true,
    });
    expect(changed.digest).not.toBe(assembly.digest);
  });

  it("signs the exact lean prompt and complete built-in tool denial with no setting rereads", () => {
    const gateway = bareGateway(new FakeAgentSdk());
    gateway._agentSdkAppendSystemPrompt = "lean assembled sentinel";
    gateway._agentSdkMcpServers = {};
    const route = sdkRoute();
    (route.target as any).promptMode = "lean";

    const assembly = gateway.resolveAgentSdkAssembly(route, { cwd: "/work/lean" });
    expect(assembly.config.systemPrompt).toBe(`${LEAN_SYSTEM_PROMPT}\n\nlean assembled sentinel`);
    expect(assembly.config.settingSources).toEqual([]);
    expect(assembly.config.tools).toEqual([]);
    expect(assembly.config.allowedTools).toEqual([]);
    expect(assembly.config.disallowedTools).toEqual(BUILTIN_TOOLS);
    expect(assembly.config.mcpServers).toEqual({});
    expect(assembly.config.strictMcpConfig).toBe(true);
  });

  it("keys the warm session by CONVERSATION so two threads never share one session_id", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const a = await gateway.runAgentSdkTurn(sdkRoute(), "hi", undefined, { sessionKey: "thread-a" });
    const b = await gateway.runAgentSdkTurn(sdkRoute(), "hi", undefined, { sessionKey: "thread-b" });
    const again = await gateway.runAgentSdkTurn(sdkRoute(), "hi", undefined, { sessionKey: "thread-a" });
    expect(adapter.spawned).toHaveLength(2); // one per conversation, reused after
    expect(a.session_id).not.toBe(b.session_id);
    expect(again.session_id).toBe(a.session_id);
    // §12: the transcript badge needs a real file for that session.
    expect(a.transcript_path).toContain(`${a.session_id}.jsonl`);
  });

  it("retires a Query rejected by a latched pre-runtime Stop so the next admitted turn is not warm", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const interrupted = Object.assign(new Error("turn interrupted before runtime start"), {
      code: "turn_interrupted_before_runtime",
    });
    const firstAdmission = vi.fn();

    await expect(gateway.runAgentSdkTurn(sdkRoute(), "must not be admitted", undefined, {
      sessionKey: "pre-runtime-stop-thread",
      streamingInput: true,
      generationId: "pre-runtime-stop-1",
      registerStop: () => { throw interrupted; },
      onRuntimeAdmission: firstAdmission,
    })).rejects.toBe(interrupted);

    expect(firstAdmission).not.toHaveBeenCalled();
    expect(adapter.turns).toEqual([]);
    expect(adapter.tornDown).toEqual(["sdk-1"]);
    expect(gateway._agentSdkSessions.size).toBe(0);

    const observations: any[] = [];
    const admitted = await gateway.runAgentSdkTurn(sdkRoute(), "first admitted input", undefined, {
      sessionKey: "pre-runtime-stop-thread",
      streamingInput: true,
      generationId: "pre-runtime-stop-2",
      onRuntimeAdmission: vi.fn(),
      onRouteSession: (value: any) => observations.push(value),
    });
    expect(adapter.spawned).toHaveLength(2);
    expect(adapter.turns).toEqual(["first admitted input"]);
    expect(admitted.sessionDisposition).toBe("new");
    expect(observations[0]?.sessionDisposition).toBe("new");
  });

  it("rotates an idle warm standing session when its effective named-account token changes", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const secrets: Record<string, string> = { ANTHROPIC_ACCOUNT__work: "token-version-one" };
    gateway.secrets = secrets;
    const route = sdkRoute();
    (route.target as any).account = "work";

    const first = await gateway.runAgentSdkTurn(route, "first", undefined, {
      sessionKey: "credential-thread",
      streamingInput: true,
      generationId: "credential-generation-1",
    });
    secrets.ANTHROPIC_ACCOUNT__work = "token-version-two";
    const second = await gateway.runAgentSdkTurn(route, "second", undefined, {
      sessionKey: "credential-thread",
      streamingInput: true,
      generationId: "credential-generation-2",
      resumeSessionId: first.session_id,
    });

    expect(adapter.spawned).toHaveLength(2);
    expect(second.session_id).not.toBe(first.session_id);
    await vi.waitFor(() => expect(adapter.tornDown).toContain(first.session_id));
    expect(adapter.cancelled).toEqual([]); // standing Query retirement closes; it does not interrupt
    expect(gateway._agentSdkSessions.size).toBe(1);
    expect(adapter.spawned[1]).not.toHaveProperty("sessionId");
    expect(adapter.turns.at(-1)).toBe("second");
    const cacheIdentity = [...gateway._agentSdkSessions.keys()].join("\n");
    expect(cacheIdentity).not.toContain("token-version-one");
    expect(cacheIdentity).not.toContain("token-version-two");
  });

  it("rotates effort by awaiting teardown and native-resuming the same journal/epoch", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const signature = {
      target: "sdk-haiku-chat",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      account: null,
      accountSource: null,
      projectPath: null,
    };
    const low = sdkRoute();
    (low.target as any).effort = "low";
    const first = await gateway.runAgentSdkTurn(low, "first", undefined, {
      sessionKey: "effort-thread",
      streamingInput: true,
      generationId: "effort-generation-1",
      routeSession: { epoch: 1, signature, boundaryReason: "initial", disposition: "new", hadPrior: false },
    });

    const order: string[] = [];
    const originalTeardown = adapter.teardown.bind(adapter);
    adapter.teardown = async (session: any) => {
      order.push("teardown:start");
      await Promise.resolve();
      await originalTeardown(session);
      order.push("teardown:end");
    };
    const originalSpawn = adapter.spawn.bind(adapter);
    adapter.spawn = async (config: any) => {
      order.push("spawn");
      return originalSpawn(config);
    };
    const high = sdkRoute();
    (high.target as any).effort = "high";
    const observations: any[] = [];
    const second = await gateway.runAgentSdkTurn(high, "second", undefined, {
      sessionKey: "effort-thread",
      streamingInput: true,
      generationId: "effort-generation-2",
      routeSession: { epoch: 1, signature, boundaryReason: null, disposition: "warm", hadPrior: true },
      resumeSessionId: first.session_id,
      onRouteSession: (value: any) => observations.push(value),
    });

    expect(order).toEqual(["teardown:start", "teardown:end", "spawn"]);
    expect(adapter.spawned.at(-1)).toMatchObject({ sessionId: first.session_id, effort: "high" });
    expect(adapter.turns.at(-1)).toBe("second");
    expect(second).toMatchObject({
      session_id: first.session_id,
      sessionDisposition: "resumed",
      sessionBoundaryReason: null,
      sessionEpoch: 1,
      spawnSignature: signature,
    });
    expect(observations[0]).toMatchObject({ sessionDisposition: "resumed", sessionEpoch: 1 });
  });

  it("does not spawn a second journal owner when an effort rotation cannot close the old Query", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const low = sdkRoute();
    (low.target as any).effort = "low";
    await gateway.runAgentSdkTurn(low, "first", undefined, {
      sessionKey: "effort-close-failure",
      streamingInput: true,
      generationId: "effort-close-failure-1",
    });
    const closeFailure = new Error("standing Query close failed");
    adapter.teardown = async () => { throw closeFailure; };
    const high = sdkRoute();
    (high.target as any).effort = "high";

    await expect(gateway.runAgentSdkTurn(high, "second", undefined, {
      sessionKey: "effort-close-failure",
      streamingInput: true,
      generationId: "effort-close-failure-2",
    })).rejects.toBe(closeFailure);

    expect(adapter.spawned).toHaveLength(1);
    expect(gateway._agentSdkSessions.size).toBe(1);
  });

  it("forces a clean same-thread Query and new epoch on a spawn-signature boundary", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const oldSignature = {
      target: "sdk-haiku-chat",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      account: null,
      accountSource: null,
      projectPath: null,
    };
    const first = await gateway.runAgentSdkTurn(sdkRoute(), "first", undefined, {
      sessionKey: "signature-thread",
      streamingInput: true,
      generationId: "signature-generation-1",
      routeSession: { epoch: 2, signature: oldSignature, boundaryReason: "initial", disposition: "new", hadPrior: false },
    });
    const changedRoute = sdkRoute();
    (changedRoute.target as any).model = "claude-sonnet-4-6";
    const signature = { ...oldSignature, model: "claude-sonnet-4-6" };
    const second = await gateway.runAgentSdkTurn(changedRoute, "second", undefined, {
      sessionKey: "signature-thread",
      streamingInput: true,
      generationId: "signature-generation-2",
      forceNewSession: true,
      resumeSessionId: first.session_id,
      routeSession: {
        epoch: 3,
        signature,
        boundaryReason: "spawn-signature-changed",
        disposition: "new",
        hadPrior: true,
      },
    });

    expect(adapter.tornDown).toContain(first.session_id);
    expect(adapter.spawned.at(-1)).not.toHaveProperty("sessionId");
    expect(adapter.turns.at(-1)).toBe("second");
    expect(second).toMatchObject({
      sessionDisposition: "new",
      sessionBoundaryReason: "spawn-signature-changed",
      sessionEpoch: 3,
      spawnSignature: signature,
    });
    expect(second.session_id).not.toBe(first.session_id);
  });

  it("preserves the runtime's typed terminal and final observed attribution", async () => {
    const adapter = new FakeAgentSdk();
    adapter.response = {
      text: "",
      toolUses: [],
      stoppedReason: "provider_error",
      terminalStatus: "error",
      failure: {
        source: "result",
        kind: "execution",
        code: "provider_failed",
        text: "Provider failed.",
        retryable: false,
      },
      sessionId: "sdk-final",
      model: "claude-fallback",
    };
    const gateway = bareGateway(adapter);
    const result = await gateway.runAgentSdkTurn(sdkRoute(), "fail visibly", undefined, {
      sessionKey: "terminal-thread",
    });
    expect(result).toMatchObject({
      terminalStatus: "error",
      failure: adapter.response.failure,
      session_id: "sdk-final",
      model: "claude-fallback",
    });
  });

  it("holds build-mode regeneration terminals until the final fresh Query settles", async () => {
    const adapter = new FakeAgentSdk();
    let attempt = 0;
    adapter.sendTurn = async (session: any, text: string, hooks: any = {}) => {
      attempt += 1;
      adapter.turns.push(text);
      adapter.hooks.push(hooks);
      hooks.onEvent?.({
        id: `terminal-build-${attempt}`,
        role: "assistant",
        ts: attempt,
        order: 2,
        revision: 1,
        blocks: [{
          type: "turn_end",
          status: "completed",
          subtype: `attempt-${attempt}`,
          reason: "completed",
          stopReason: "end_turn",
          terminalReason: "completed",
        }],
      });
      session.lastAttempt = attempt;
    };
    adapter.awaitResponse = async () => attempt === 1
      ? { text: "not committable", toolUses: [], stoppedReason: null, sessionId: "sdk-1" }
      : {
          text: "```js\nexport const regenerated = true;\n```",
          toolUses: [],
          stoppedReason: null,
          sessionId: "sdk-2",
          terminalStatus: "completed",
        };
    const gateway = bareGateway(adapter);
    gateway.buildWorkspace = compositionDir;
    const signature = {
      target: "sdk-haiku-chat",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      account: null,
      accountSource: null,
      projectPath: null,
    };
    const forwarded: any[] = [];
    const order: string[] = [];
    const result = await gateway.runAgentSdkTurn(
      sdkRoute(),
      "write src/m6-regenerated.mjs",
      undefined,
      {
        sessionKey: "build-regeneration",
        routeSession: { epoch: 1, signature, boundaryReason: "initial", disposition: "new", hadPrior: false },
        onRouteSession: (value: any) => {
          if (value.sessionId === "sdk-2") order.push("route-final");
        },
        onEvent: (event: any) => {
          forwarded.push(event);
          order.push("terminal");
        },
      },
    );

    expect(adapter.spawned).toHaveLength(2);
    expect(adapter.tornDown).toContain("sdk-1");
    expect(forwarded.map((event) => event.id)).toEqual(["terminal-build-2"]);
    expect(order.at(-1)).toBe("terminal");
    expect(result).toMatchObject({ session_id: "sdk-2", terminalStatus: "completed" });
    expect(readFileSync(path.join(compositionDir, "src", "m6-regenerated.mjs"), "utf8"))
      .toContain("export const regenerated = true");
  });

  it("reports a resumed SDK journal before send and de-duplicates its system frame", async () => {
    const order: string[] = [];
    const adapter = new FakeAgentSdk();
    adapter.systemSessionId = "sdk-1";
    const originalSend = adapter.sendTurn.bind(adapter);
    adapter.sendTurn = async (session: any, text: string, hooks: any = {}) => {
      order.push("send");
      return originalSend(session, text, hooks);
    };
    const gateway = bareGateway(adapter);
    const journals: any[] = [];
    await gateway.runAgentSdkTurn(sdkRoute(), "hi", undefined, {
      sessionKey: "thread-journal",
      onJournal: (identity: any) => {
        order.push("journal");
        journals.push(identity);
      }
    });
    expect(order.slice(0, 2)).toEqual(["journal", "send"]);
    expect(journals).toEqual([
      expect.objectContaining({
        session_id: "sdk-1",
        transcript_path: expect.stringContaining("sdk-1.jsonl")
      })
    ]);
  });

  it("reports a fresh SDK journal as soon as sendTurn receives the system frame", async () => {
    const adapter = new FakeAgentSdk();
    adapter.initialSessionId = null;
    adapter.systemSessionId = "sdk-fresh";
    const journals: any[] = [];
    const gateway = bareGateway(adapter);
    const result = await gateway.runAgentSdkTurn(sdkRoute(), "hi", undefined, {
      sessionKey: "thread-fresh-journal",
      onJournal: (identity: any) => journals.push(identity)
    });
    expect(journals).toEqual([
      expect.objectContaining({
        session_id: "sdk-fresh",
        transcript_path: expect.stringContaining("sdk-fresh.jsonl")
      })
    ]);
    expect(result.session_id).toBe("sdk-fresh");
    expect(typeof adapter.hooks[0].onSession).toBe("function");
  });

  it("reports the persisted and provider-refined ids in order when cold-resuming a standing Query", async () => {
    const adapter = new FakeAgentSdk();
    adapter.systemSessionId = "sdk-resumed-refined";
    const journals: any[] = [];
    const gateway = bareGateway(adapter);
    const result = await gateway.runAgentSdkTurn(sdkRoute(), "continue exactly once", undefined, {
      sessionKey: "thread-process-restart",
      streamingInput: true,
      generationId: "generation-process-restart",
      resumeSessionId: "sdk-persisted",
      onJournal: (identity: any) => journals.push(identity),
    });

    expect(adapter.spawned[0]).toMatchObject({ sessionId: "sdk-persisted", streamingInput: true });
    expect(adapter.turns).toEqual(["continue exactly once"]);
    expect(journals.map((identity) => identity.session_id)).toEqual(["sdk-persisted", "sdk-resumed-refined"]);
    expect(result.session_id).toBe("sdk-resumed-refined");
  });

  it("abandons a recovered SDK journal and starts the successor clean", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    let recoverReset: null | (() => Promise<void>) = null;
    const first = await gateway.runAgentSdkTurn(sdkRoute(), "orphaned input", undefined, {
      sessionKey: "thread-host-recovery",
      streamingInput: true,
      generationId: "generation-host-recovery-1",
      registerRecoveryReset: (reset: () => Promise<void>) => { recoverReset = reset; },
    });
    expect(recoverReset).toBeTypeOf("function");
    await recoverReset!();
    expect(adapter.tornDown).toContain(first.session_id);

    const successor = await gateway.runAgentSdkTurn(sdkRoute(), "safe successor", undefined, {
      sessionKey: "thread-host-recovery",
      streamingInput: true,
      generationId: "generation-host-recovery-2",
      resumeSessionId: first.session_id,
    });
    expect(adapter.spawned.at(-1)).not.toHaveProperty("sessionId");
    expect(adapter.turns.at(-1)).toBe("safe successor");
    expect(successor.session_id).not.toBe(first.session_id);
  });

  it("treats a durable generation barrier as stronger than a same-thread warm Query", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const first = await gateway.runAgentSdkTurn(sdkRoute(), "first", undefined, {
      sessionKey: "thread-durable-barrier",
      streamingInput: true,
      generationId: "generation-durable-barrier-1",
    });
    const successor = await gateway.runAgentSdkTurn(sdkRoute(), "after recovered orphan", undefined, {
      sessionKey: "thread-durable-barrier",
      streamingInput: true,
      generationId: "generation-durable-barrier-2",
      resumeSessionId: first.session_id,
      forceNewSession: true,
    });

    expect(adapter.tornDown).toContain(first.session_id);
    expect(adapter.spawned).toHaveLength(2);
    expect(adapter.spawned.at(-1)).not.toHaveProperty("sessionId");
    expect(adapter.turns.at(-1)).toBe("after recovered orphan");
    expect(successor.session_id).not.toBe(first.session_id);
  });

  it("caps the warm map and releases the evicted session WITHOUT relying on teardown", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    for (let i = 0; i < AGENT_SDK_SESSION_CAP + 1; i++) {
      await gateway.runAgentSdkTurn(sdkRoute(), "hi", undefined, { sessionKey: `thread-${i}` });
    }
    expect(gateway._agentSdkSessions.size).toBe(AGENT_SDK_SESSION_CAP);
    // cancel() is the primitive that actually frees the query; teardown is a no-op.
    expect(adapter.cancelled).toEqual(["sdk-1"]);
  });

  it("allows temporary overflow instead of evicting the oldest in-flight standing Query, then trims on idle", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const releases = new Map<string, (value: any) => void>();
    (adapter as any).awaitResponse = (session: any) => new Promise((resolve) => {
      releases.set(session.sessionId, resolve);
    });

    const turns = Array.from({ length: AGENT_SDK_SESSION_CAP + 1 }, (_, index) =>
      gateway.runAgentSdkTurn(sdkRoute(), `turn ${index}`, undefined, {
        sessionKey: `busy-thread-${index}`,
        streamingInput: true,
        generationId: `busy-generation-${index}`,
      })
    );
    await vi.waitFor(() => expect(releases.size).toBe(AGENT_SDK_SESSION_CAP + 1));
    expect(gateway._agentSdkSessions.size).toBe(AGENT_SDK_SESSION_CAP + 1);
    expect(adapter.cancelled).toEqual([]);
    expect(adapter.tornDown).toEqual([]);
    const oldestSession = [...gateway._agentSdkSessions.values()]
      .find((session: any) => session.sessionId === "sdk-1");
    expect(oldestSession?.alive).toBe(true);

    // Only the newest lane becomes idle. It is the sole safe eviction candidate,
    // even though sdk-1 is the oldest LRU entry and is still executing.
    releases.get(`sdk-${AGENT_SDK_SESSION_CAP + 1}`)!({ text: "newest done", toolUses: [], stoppedReason: null });
    await turns.at(-1);
    await vi.waitFor(() => expect(gateway._agentSdkSessions.size).toBe(AGENT_SDK_SESSION_CAP));
    expect(adapter.tornDown).toEqual([`sdk-${AGENT_SDK_SESSION_CAP + 1}`]);
    expect(oldestSession?.alive).toBe(true);
    expect([...gateway._agentSdkSessions.values()]).toContain(oldestSession);

    for (let index = 1; index <= AGENT_SDK_SESSION_CAP; index += 1) {
      releases.get(`sdk-${index}`)!({ text: `done ${index}`, toolUses: [], stoppedReason: null });
    }
    await Promise.all(turns.slice(0, -1));
  });

  it("starts an evicted Web conversation clean without rewriting its admitted messages", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const standingTurn = (sessionKey: string, message: string, generationId: string) =>
      gateway.runAgentSdkTurn(sdkRoute(), message, undefined, {
        sessionKey,
        streamingInput: true,
        generationId,
      });

    await standingTurn("thread-a", "first", "generation-a-1");
    await standingTurn("thread-a", "second", "generation-a-2");
    expect(adapter.turns.slice(0, 2)).toEqual(["first", "second"]);

    // A is the oldest warm entry. Filling the remaining cache plus one evicts it;
    // the next A input therefore owns a fresh standing Query.
    for (let index = 0; index < AGENT_SDK_SESSION_CAP; index += 1) {
      await standingTurn(
        `pressure-${index}`,
        `pressure message ${index}`,
        `pressure-generation-${index}`,
      );
    }
    expect(adapter.tornDown).toContain("sdk-1");

    const spawnsBeforeReturn = adapter.spawned.length;
    await standingTurn("thread-a", "third", "generation-a-3");
    expect(adapter.spawned).toHaveLength(spawnsBeforeReturn + 1);
    expect(adapter.turns.at(-1)).toBe("third");
  });

  it("natively resumes an evicted standing Query and does not duplicate durable context", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const turn = (sessionKey: string, message: string, generationId: string, extra: Record<string, unknown> = {}) =>
      gateway.runAgentSdkTurn(sdkRoute(), message, undefined, {
        sessionKey,
        streamingInput: true,
        generationId,
        ...extra,
      });

    const first = await turn("resume-a", "first", "resume-generation-a-1");
    for (let index = 0; index < AGENT_SDK_SESSION_CAP; index += 1) {
      await turn(`resume-pressure-${index}`, `pressure ${index}`, `resume-pressure-generation-${index}`);
    }
    expect(adapter.tornDown).toContain(first.session_id);

    const resumed = await turn("resume-a", "after eviction", "resume-generation-a-2", {
      resumeSessionId: first.session_id,
    });
    expect(adapter.spawned.at(-1)).toMatchObject({ sessionId: first.session_id, streamingInput: true });
    expect(adapter.turns.at(-1)).toBe("after eviction");
    expect(resumed.session_id).toBe(first.session_id);
  });

  it("does not resume a journal while its evicted standing Query is still tearing down", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const turn = (sessionKey: string, message: string, generationId: string, extra: Record<string, unknown> = {}) =>
      gateway.runAgentSdkTurn(sdkRoute(), message, undefined, {
        sessionKey,
        streamingInput: true,
        generationId,
        ...extra,
      });

    const first = await turn("release-a", "first", "release-generation-a-1");
    for (let index = 0; index < AGENT_SDK_SESSION_CAP - 1; index += 1) {
      await turn(`release-pressure-${index}`, `pressure ${index}`, `release-pressure-generation-${index}`);
    }

    let announceRelease!: () => void;
    const releaseStarted = new Promise<void>((resolve) => { announceRelease = resolve; });
    let finishRelease!: () => void;
    const allowRelease = new Promise<void>((resolve) => { finishRelease = resolve; });
    const originalTeardown = adapter.teardown.bind(adapter);
    adapter.teardown = async (session: any) => {
      if (session.sessionId === first.session_id) {
        announceRelease();
        await allowRelease;
      }
      return originalTeardown(session);
    };

    const overflowing = turn(
      "release-overflow",
      "overflow",
      "release-overflow-generation",
    );
    await releaseStarted;
    const resumed = await turn("release-a", "after eviction", "release-generation-a-2", {
      resumeSessionId: first.session_id,
    });
    const resumedSpawn = adapter.spawned.at(-1);
    const resumedMessage = adapter.turns.at(-1);
    finishRelease();
    await overflowing;

    expect(resumedSpawn).not.toHaveProperty("sessionId");
    expect(resumedMessage).toBe("after eviction");
    expect(resumed.session_id).not.toBe(first.session_id);
  });

  it("streams text through onChunk(replace) and turns tool_use into an activity payload", async () => {
    const adapter = new FakeAgentSdk();
    adapter.blocks = [{ text: "thinking" }, { tool: { name: "Edit", id: "tu-1" } }, { text: " done" }];
    const gateway = bareGateway(adapter);
    const chunks: [string, boolean | undefined][] = [];
    const activity: any[] = [];
    await gateway.runAgentSdkTurn(sdkRoute(), "hi", (text: string, replace?: boolean) => chunks.push([text, replace]), {
      sessionKey: "t",
      onActivity: (payload: any) => activity.push(payload)
    });
    expect(chunks.slice(0, 2)).toEqual([
      ["thinking", true],
      ["thinking done", true]
    ]);
    expect(activity).toEqual([{ kind: "tool", name: "Edit", id: "tu-1" }]);
  });

  it("hands the caller a stop bound to THIS turn's session", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    let stop: null | (() => unknown) = null;
    await gateway.runAgentSdkTurn(sdkRoute(), "hi", undefined, { sessionKey: "t", registerStop: (s: any) => (stop = s) });
    expect(typeof stop).toBe("function");
    await stop!();
    expect(adapter.cancelled).toEqual(["sdk-1"]);
  });

  it("passes the target's account through to buildSdkEnv with the materialized vault", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const route: any = sdkRoute();
    route.target.account = "work";
    await gateway.runAgentSdkTurn(route, "hi", undefined, { sessionKey: "t" });
    expect(adapter.spawned[0].account).toBe("work");
    // Read from <compositionDir>/.env at call time — no vault master key here.
    expect(adapter.spawned[0].secrets?.ANTHROPIC_ACCOUNT__work).toBe("sk-ant-oat01-work-token");
  });

  it("keeps bypass as the default and forwards trusted permission controls unchanged", async () => {
    const adapter = new FakeAgentSdk();
    const gateway = bareGateway(adapter);
    const onPermissionRequest = () => Promise.resolve("allow_once");

    await gateway.runAgentSdkTurn(sdkRoute(), "legacy", undefined, { sessionKey: "legacy-thread" });
    await gateway.runAgentSdkTurn(sdkRoute(), "web", undefined, {
      sessionKey: "web-thread",
      permissionMode: "default",
      generationId: "generation-web",
      onPermissionRequest,
    });

    expect(adapter.spawned.map((config) => config.permissionMode)).toEqual(["bypassPermissions", "default"]);
    expect(adapter.hooks[0]).toMatchObject({ generationId: undefined, onPermissionRequest: undefined });
    expect(adapter.hooks[1].generationId).toBe("generation-web");
    expect(adapter.hooks[1].onPermissionRequest).toBe(onPermissionRequest);
  });
});

describe("secondary (codex/gemini) lane: cancel is feature-detected (§9)", () => {
  class FakeExecAdapter {
    cancelled: any[] = [];
    supportsCancel: boolean;
    constructor(supportsCancel: boolean) {
      this.supportsCancel = supportsCancel;
      if (!supportsCancel) (this as any).cancel = undefined;
    }
    async spawn(cfg: any) {
      return { alive: true, config: cfg, effortApplied: true };
    }
    async awaitReady() {}
    async sendTurn() {}
    async awaitResponse() {
      return { text: "partial output", stoppedReason: "cancelled" };
    }
    async teardown(s: any) {
      s.alive = false;
    }
    cancel? = async (session: any) => {
      this.cancelled.push(session);
      return true;
    };
  }

  function execGateway(adapter: any, runtime: string) {
    const gateway: any = Object.create(RoutedGateway.prototype);
    gateway.logFn = () => {};
    gateway.compositionDir = compositionDir;
    gateway.buildWorkspace = compositionDir;
    gateway._secondaryAdapters = new Map([[runtime, adapter]]);
    return gateway;
  }

  it("registers a stop and forwards the cancelled stop reason to the done frame", async () => {
    const adapter = new FakeExecAdapter(true);
    const gateway = execGateway(adapter, "codex");
    let stop: any = null;
    const r = await gateway.runSecondaryTurn(
      { targetId: "codex-1", target: { runtime: "codex", provider: "openai", model: "gpt-5-codex" } },
      "hi",
      { registerStop: (s: any) => (stop = s) }
    );
    expect(typeof stop).toBe("function");
    await stop();
    expect(adapter.cancelled).toHaveLength(1);
    // Dropping this (as the old return did) made a stopped turn look completed.
    expect(r.stoppedReason).toBe("cancelled");
    expect(r.reply).toBe("partial output");
  });

  it("does not register a stop for an adapter that cannot cancel", async () => {
    const adapter = new FakeExecAdapter(false);
    const gateway = execGateway(adapter, "gemini");
    let registered = false;
    await gateway.runSecondaryTurn(
      { targetId: "gemini-flash", target: { runtime: "gemini", provider: "google", model: "gemini-2.5-flash" } },
      "hi",
      { registerStop: () => (registered = true) }
    );
    expect(registered).toBe(false);
  });
});

describe("web one-shot lane: project → real cwd, account → real env (§6, §8)", () => {
  it("keeps a policy-selected non-plan provider env and forwards hostile message whitespace exactly", async () => {
    const calls: any[] = [];
    const provider = {
      id: "ollama-local",
      kind: "local",
      baseUrl: "http://127.0.0.1:11434",
      dummyToken: "ollama-test"
    };
    const gateway: any = new RoutedGateway({
      core: { buildRespawnOpts, ensureProviders },
      config: {
        providers: [
          { id: "anthropic-plan", kind: "anthropic-plan", baseUrl: null },
          provider
        ]
      },
      compositionDir,
      operativeSpawnConfig: { compositionDir, model: "sonnet", permissionMode: "bypassPermissions" },
      oneShotFn: async (opts: any) => {
        calls.push(opts);
        return { reply: "one-shot reply", sessionId: "provider-os-1", effortApplied: true };
      }
    });
    gateway.secrets = {};
    const target = {
      id: "cc-ollama-local",
      type: "runtime-target",
      runtime: "claude-code",
      provider: provider.id,
      model: "qwen3:8b",
      effort: "max"
    };
    const launch = gateway.resolveWebOneShotLaunch(target);
    const exactMessage = " \t/effort low must stay user text\r\n--provider anthropic-plan \n ";

    expect(launch.providerLaunch).toBe(true);
    expect(launch.env.ANTHROPIC_BASE_URL).toBe(provider.baseUrl);
    expect(launch.env.ANTHROPIC_AUTH_TOKEN).toBe(provider.dummyToken);
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();

    await gateway.runWebOneShot({
      message: exactMessage,
      model: target.model,
      effort: target.effort,
      cwd: compositionDir,
      ...launch
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      message: exactMessage,
      model: target.model,
      effort: target.effort,
      providerLaunch: true
    });
    expect(calls[0].env.ANTHROPIC_BASE_URL).toBe(provider.baseUrl);
    expect(calls[0].env.ANTHROPIC_AUTH_TOKEN).toBe(provider.dummyToken);
  });

  it("forwards the per-turn cwd and env to oneShotTurn, and reports the transcript under that cwd", async () => {
    const calls: any[] = [];
    const gateway: any = Object.create(RoutedGateway.prototype);
    gateway.logFn = () => {};
    gateway.compositionDir = compositionDir;
    gateway._operativeSpawnConfig = { compositionDir, model: "sonnet", claudeBinary: "claude" };
    gateway._oneShotFn = async (opts: any) => {
      calls.push(opts);
      return { reply: "one-shot reply", sessionId: "os-1", effortApplied: true };
    };
    const exactMessage = " \tvisible text\r\nwith trailing space ";
    const out = await gateway.runWebOneShot({
      message: exactMessage,
      model: "opus",
      effort: "high",
      cwd: compositionDir,
      env: { ...process.env, ANTHROPIC_AUTH_TOKEN: "tok", GARRISON_ACCOUNT: "work" }
    });
    expect(calls[0].cwd).toBe(compositionDir);
    expect(calls[0].env.GARRISON_ACCOUNT).toBe("work");
    expect(calls[0].message).toBe(exactMessage);
    expect(calls[0].effort).toBe("high");
    expect(out.effortApplied).toBe(true);
    expect(out.transcriptPath).toContain("os-1.jsonl");
  });

  it("defaults to the composition dir and passes NO env when nothing is pinned", async () => {
    const calls: any[] = [];
    const gateway: any = Object.create(RoutedGateway.prototype);
    gateway.logFn = () => {};
    gateway.compositionDir = compositionDir;
    gateway._operativeSpawnConfig = { compositionDir };
    gateway._oneShotFn = async (opts: any) => {
      calls.push(opts);
      return { reply: "", sessionId: null };
    };
    await gateway.runWebOneShot({ message: "hi" });
    expect(calls[0].cwd).toBe(compositionDir);
    expect("env" in calls[0]).toBe(false);
  });

  it("propagates a disposable one-shot failure instead of fabricating an empty result", async () => {
    const gateway: any = Object.create(RoutedGateway.prototype);
    gateway.compositionDir = compositionDir;
    gateway._operativeSpawnConfig = { compositionDir };
    const failure = Object.assign(new Error("one-shot failed"), {
      code: "one_shot_failed",
      kind: "execution",
    });
    gateway._oneShotFn = async () => { throw failure; };
    await expect(gateway.runWebOneShot({ message: "fail visibly" })).rejects.toBe(failure);
  });
});

describe("scoped Claude lane: never use the composition-rooted standing PTY", () => {
  it("selects the cwd-keyed Claude session for a scoped turn under a Claude primary", () => {
    const gateway: any = new RoutedGateway({ primaryEngine: "claude-code" });
    const route = { target: { runtime: "claude-code", provider: "anthropic-plan", model: "sonnet" } };
    expect(gateway.usesScopedClaudeSession(route, "/tmp/personal")).toBe(true);
    expect(gateway.usesScopedClaudeSession(route, null)).toBe(false);
    expect(gateway.usesScopedClaudeSession({ target: { type: "workflow", workflow: "weekly-review" } }, "/tmp/personal")).toBe(true);
    expect(gw.shouldUseScopedClaudeLane(gateway, route, "/tmp/personal")).toBe(true);
  });

  it("spawns that warm session at the resolved cwd and reuses the cwd-keyed session", async () => {
    const cwd = path.join(compositionDir, "personal");
    mkdirSync(cwd, { recursive: true });
    const spawnConfigs: any[] = [];
    const sessions: any[] = [];
    const adapter = {
      spawn: async (cfg: any) => {
        spawnConfigs.push(cfg);
        const session = {
          compositionDir: cfg.compositionDir,
          getClaudeSessionId: () => "scoped-1",
          isAlive: () => true,
          runTurn: async () => ({ reply: `cwd=${cfg.compositionDir}`, sessionId: "scoped-1" })
        };
        sessions.push(session);
        return session;
      },
      awaitReady: async () => {},
      setEffort: async () => {},
      cancel: () => true
    };
    const gateway: any = new RoutedGateway({
      primaryEngine: "claude-code",
      compositionDir,
      buildWorkspace: null,
      appendSystemPromptFile: null,
      config: {},
      secrets: null,
      core: {
        buildRespawnOpts: (_target: any, opts: any) => ({ compositionDir: opts.compositionDir }),
        ensureProviders: () => ({ providers: {} })
      },
      logFn: () => {}
    });
    gateway.getClaudeDelegateAdapter = async () => adapter;

    const route = {
      targetId: "cc-sonnet",
      target: { runtime: "claude-code", provider: "anthropic-plan", model: "sonnet" }
    };
    const first = await gateway.runClaudeDelegateTurn(route, "first", { cwd });
    const second = await gateway.runClaudeDelegateTurn(route, "second", { cwd });

    expect(first.reply).toBe(`cwd=${cwd}`);
    expect(second.reply).toBe(`cwd=${cwd}`);
    expect(spawnConfigs).toHaveLength(1);
    expect(spawnConfigs[0].compositionDir).toBe(cwd);
    expect(sessions[0].compositionDir).toBe(cwd);
  });
});

describe("the materialized vault is the gateway's only account source (§6)", () => {
  it("lists both key shapes and resolves one account's token", () => {
    expect(listVaultAccounts(compositionDir)).toEqual([
      { name: "codexer", platform: "openai" },
      { name: "work", platform: "anthropic" }
    ]);
    expect(resolveVaultAccount(compositionDir, "work")).toEqual({
      name: "work",
      platform: "anthropic",
      token: "sk-ant-oat01-work-token"
    });
    expect(resolveVaultAccount(compositionDir, "ghost")).toBe(null);
    expect(resolveVaultAccount(compositionDir, "")).toBe(null);
  });

  it("reads no secrets at all when the vault was never materialized (locked / down)", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "gar-novault-"));
    try {
      expect(readMaterializedSecrets(empty)).toEqual({});
      expect(listVaultAccounts(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("injects the Anthropic account as the vehicle the CLI actually honors", () => {
    expect(anthropicAccountEnv("work", "tok")).toEqual({
      GARRISON_ACCOUNT: "work",
      ANTHROPIC_AUTH_TOKEN: "tok",
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      // Empty, not absent: an inherited raw key would outrank the plan token.
      ANTHROPIC_API_KEY: ""
    });
  });
});

describe("generated Web dispatch boundary", () => {
  const routed = {};

  it("rejects both reload phases but preserves routed and explicit-console dispatch", () => {
    expect(gw.shouldRejectGeneratedWebDispatch({ channel: "web" }, routed, "starting")).toBe(true);
    expect(gw.shouldRejectGeneratedWebDispatch({ channel: "web" }, null, "ready")).toBe(true);
    expect(gw.shouldRejectGeneratedWebDispatch({ channel: "web" }, routed, "ready")).toBe(false);
    expect(gw.shouldRejectGeneratedWebDispatch({ channel: "web-console", directOperative: true }, null, "starting")).toBe(false);
    expect(gw.shouldRejectGeneratedWebDispatch({ channel: "web", directOperative: true }, null, "starting")).toBe(false);
  });
});

describe("GET /route/options + POST /chat/interrupt over real HTTP, while the operative is still spawning", () => {
  // Boots the REAL gateway-pty.mjs with a runtime stub whose spawn never
  // resolves, so `readyPromise` is permanently unresolved. That is the whole
  // point of §11's "NOT behind await readyPromise": the menu has to work while
  // the operative comes up, which is exactly when a user reaches for it.
  let child: ChildProcess | undefined;
  let dir = "";
  let port = 0;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "gar-runctx-http-"));
    mkdirSync(path.join(dir, ".garrison"), { recursive: true });
    writeFileSync(path.join(dir, ".garrison", "routing.json"), JSON.stringify(CONFIG));
    const kanbanRoot = path.join(dir, "kanban-loop");
    writeGatewayV4ExecutionModel(dir, kanbanRoot);
    // A hermetic dev-root: one git repo, one plain dir. Only the repo may be offered.
    const devRoot = path.join(dir, "dev");
    mkdirSync(path.join(devRoot, "repo-a", ".git"), { recursive: true });
    mkdirSync(path.join(devRoot, "not-a-repo"), { recursive: true });
    writeFileSync(path.join(dir, "dev-root"), devRoot);
    const stub = path.join(dir, "hanging-stub.mjs");
    writeFileSync(stub, "export function spawnFn() {\n  return new Promise(() => {});\n}\n");

    port = await freePort();
    child = spawn(process.execPath, [path.join(ROOT, "fittings/seed/http-gateway/scripts/gateway-pty.mjs")], {
      env: {
        ...process.env,
        GARRISON_GATEWAY_HOST: "127.0.0.1",
        GARRISON_GATEWAY_PORT: String(port),
        GARRISON_COMPOSITION_DIR: dir,
        GARRISON_HOME: dir,
        GARRISON_KANBAN_DIR: kanbanRoot,
        GARRISON_AGENT_SDK_DIR: AGENT_SDK_STUB,
        GARRISON_GATEWAY_RUNTIME_STUB: stub,
        GARRISON_GATEWAY_NO_LISTEN: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.resume();
    child.stderr?.resume();
  }, 30_000);

  afterAll(() => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("answers the menu with a live routing config while pty_status is still spawning", async () => {
    // Poll until the routing layer is constructed (the dispatcher probe takes a
    // moment); EVERY answer along the way must already be a 200.
    const deadline = Date.now() + 25_000;
    let options: any = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/route/options`);
        expect(r.status).toBe(200);
        const body = await r.json();
        if (body.routing === true) {
          options = body;
          break;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(options, "gateway never exposed /route/options").toBeTruthy();
    expect(options.targets.map((t: any) => t.id)).toEqual([
      "cc-sonnet-med",
      "cc-opus-high",
      "sdk-haiku-chat",
      "gemini-flash"
    ]); // the pinned dispatch target is infrastructure, never offered
    expect(options.efforts).toEqual([...dutyEfforts]);
    expect(options.projects).toEqual(["repo-a"]); // confined: the non-repo is not offered
    expect(options.activeProfile).toBe("demo");

    // The proof that this endpoint is not gated on readiness.
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.pty_status).toBe("spawning");
  }, 30_000);

  it("rejects threadless generated Web turns before readiness or any routed runtime/cache lane", async () => {
    const post = (pathname: "/chat" | "/chat/stream") => fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "quick: this must never reach a runtime",
        channel: "web",
        routing: { target: "sdk-haiku-chat" },
      }),
      // The operative spawn deliberately never settles in this fixture. A
      // response under this cap proves the Web identity gate is outside it.
      signal: AbortSignal.timeout(2_000),
    });

    const [chat, stream] = await Promise.all([post("/chat"), post("/chat/stream")]);
    for (const response of [chat, stream]) {
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("application/json");
      await expect(response.json()).resolves.toEqual({
        error: "Generated Web turns require a durable thread identity.",
        failure: {
          source: "gateway",
          kind: "invalid_request",
          code: "web_thread_required",
          text: "Generated Web turns require a durable thread identity.",
          retryable: false,
          httpStatus: 400,
        },
      });
    }

    const nonStream = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "quick: a durable Web turn still requires SSE generations",
        channel: "web",
        thread: "durable-thread",
        routing: { target: "sdk-haiku-chat" },
      }),
      signal: AbortSignal.timeout(2_000),
    });
    expect(nonStream.status).toBe(400);
    await expect(nonStream.json()).resolves.toMatchObject({
      failure: {
        source: "gateway",
        kind: "invalid_request",
        code: "web_stream_required",
        retryable: false,
        httpStatus: 400,
      },
    });

    const missingInput = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "quick: a generated stream needs its durable input coordinate",
        channel: "web",
        thread: "durable-thread",
        routing: { target: "sdk-haiku-chat" },
      }),
      signal: AbortSignal.timeout(2_000),
    });
    expect(missingInput.status).toBe(400);
    await expect(missingInput.json()).resolves.toEqual({
      error: "Generated Web streams require a durable input identity.",
      failure: {
        source: "gateway",
        kind: "invalid_request",
        code: "web_input_required",
        text: "Generated Web streams require a durable input identity.",
        retryable: false,
        httpStatus: 400,
      },
    });

    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.pty_status).toBe("spawning");
  }, 10_000);

  it("404s an interrupt for a conversation with no in-flight turn", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/chat/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "thread-nope" })
    });
    expect(r.status).toBe(404);
    await expect(r.json()).resolves.toMatchObject({ ok: false, error: "no-active-turn" });
  });

  it("validates permission decisions before readiness and reports missing live handles as 409", async () => {
    const malformed = await fetch(`http://127.0.0.1:${port}/chat/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const invalid = await fetch(`http://127.0.0.1:${port}/chat/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-a", generationId: "generation-old", requestId: "request-1", decision: "allow" }),
    });
    expect(invalid.status).toBe(400);

    const stale = await fetch(`http://127.0.0.1:${port}/chat/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: "thread-a", generationId: "generation-before-restart", requestId: "request-1", decision: "deny" }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: "permission_request_unavailable" });
  });
});

describe("router-disabled generated Web ingress over real HTTP", () => {
  let child: ChildProcess | undefined;
  let dir = "";
  let port = 0;
  let logs = "";
  let capturedInput = "";

  const readCapturedInput = () => {
    try {
      return readFileSync(capturedInput, "utf8");
    } catch {
      return "";
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "gar-routerless-web-"));
    mkdirSync(path.join(dir, ".garrison"), { recursive: true });
    mkdirSync(path.join(dir, "claude-home"), { recursive: true });
    capturedInput = path.join(dir, "operative-input.bin");
    const fakeClaude = path.join(dir, "fake-claude.mjs");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
import fs from "node:fs";
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => fs.appendFileSync(process.env.GARRISON_TEST_OPERATIVE_INPUT, chunk));
process.stdout.write([
  "Garrison fake Claude interactive runtime",
  "Routerless regression screen remains stable.",
  "❯ "
].join("\\r\\n"));
setInterval(() => {}, 1000);
`,
      { encoding: "utf8", mode: 0o755 },
    );

    port = await freePort();
    child = spawn(process.execPath, [path.join(ROOT, "fittings/seed/http-gateway/scripts/gateway-pty.mjs")], {
      env: {
        ...process.env,
        GARRISON_GATEWAY_HOST: "127.0.0.1",
        GARRISON_GATEWAY_PORT: String(port),
        GARRISON_COMPOSITION_DIR: dir,
        GARRISON_HOME: dir,
        GARRISON_CLAUDE_HOME: path.join(dir, "claude-home"),
        GARRISON_CLAUDE_PROJECTS_DIR: path.join(dir, "claude-home", "projects"),
        GARRISON_CLAUDE_CONFIG_PATH: path.join(dir, "claude-home", ".claude.json"),
        GARRISON_CLAUDE_BINARY: fakeClaude,
        GARRISON_PERMISSION_MODE: "default",
        GARRISON_ROUTING: "0",
        GARRISON_TEST_OPERATIVE_INPUT: capturedInput,
        GARRISON_GATEWAY_NO_LISTEN: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => (logs += String(chunk)));
    child.stderr?.on("data", (chunk) => (logs += String(chunk)));

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`gateway exited early (${child.exitCode}): ${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        const health = await response.json();
        if (health.pty_status === "failed") throw new Error(`gateway failed: ${health.error}\n${logs}`);
        if (health.pty_status === "ready") return;
      } catch (err) {
        if (err instanceof Error && /gateway failed/.test(err.message)) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`gateway never became ready: ${logs}`);
  }, 20_000);

  afterAll(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child?.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails a generated Web stream before the standing PTY, while preserving the explicit console", async () => {
    const generatedBytes = "routerless generated Web bytes must never reach the operative";
    const response = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: generatedBytes,
        channel: "web",
        thread: "durable-routerless-thread",
        inputId: "durable-routerless-input",
      }),
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Generated Web turns require model routing, but the routed gateway is unavailable.",
      failure: {
        source: "gateway",
        kind: "routing",
        code: "gateway_route_unavailable",
        text: "Generated Web turns require model routing, but the routed gateway is unavailable.",
        retryable: true,
        httpStatus: 503,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(readCapturedInput()).toBe("");
    expect(logs).not.toContain(generatedBytes);

    const consoleBytes = "explicit console bytes still reach the standing operative";
    const consoleResponse = await fetch(`http://127.0.0.1:${port}/claude/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: consoleBytes }),
    });
    expect(consoleResponse.status).toBe(202);
    await expect(consoleResponse.json()).resolves.toEqual({ ack: true });

    const deadline = Date.now() + 2_000;
    while (!readCapturedInput().includes(consoleBytes) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(readCapturedInput()).toContain(consoleBytes);
    expect(readCapturedInput()).not.toContain(generatedBytes);
  }, 10_000);
});

describe("prompt reload cannot race a generated Web turn onto the standing PTY", () => {
  let child: ChildProcess | undefined;
  let board: http.Server | undefined;
  let dir = "";
  let port = 0;
  let logs = "";
  let lookupStarted: Promise<void>;
  let releaseLookup = () => {};
  let holdReload = "";
  let releaseReload = "";
  let reloadSpawnStarted = "";
  let legacyInput = "";
  let routedMessages = "";

  const readOptional = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "gar-reload-web-race-"));
    mkdirSync(path.join(dir, ".garrison"), { recursive: true });
    mkdirSync(path.join(dir, "claude-home"), { recursive: true });
    writeFileSync(path.join(dir, ".garrison", "routing.json"), JSON.stringify(CONFIG));
    const kanbanRoot = path.join(dir, "kanban-loop");
    writeGatewayV4ExecutionModel(dir, kanbanRoot);

    let markLookupStarted = () => {};
    lookupStarted = new Promise<void>((resolve) => (markLookupStarted = resolve));
    let finishLookup = () => {};
    const lookupRelease = new Promise<void>((resolve) => (finishLookup = resolve));
    releaseLookup = finishLookup;
    board = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/cards" && url.searchParams.has("origin_id")) {
        markLookupStarted();
        await lookupRelease;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ cards: [] }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    });
    const boardPort = await freePort();
    await new Promise<void>((resolve, reject) => {
      board?.once("error", reject);
      board?.listen(boardPort, "127.0.0.1", () => resolve());
    });
    mkdirSync(path.join(dir, "ui-fittings"), { recursive: true });
    writeFileSync(
      path.join(dir, "ui-fittings", "kanban-loop.json"),
      JSON.stringify({ url: `http://127.0.0.1:${boardPort}` }),
    );

    holdReload = path.join(dir, "hold-reload");
    releaseReload = path.join(dir, "release-reload");
    reloadSpawnStarted = path.join(dir, "reload-spawn-started");
    legacyInput = path.join(dir, "legacy-pty-input.bin");
    routedMessages = path.join(dir, "routed-runtime-messages.jsonl");
    const runtimeStub = path.join(dir, "runtime-stub.mjs");
    writeFileSync(
      runtimeStub,
      `import fs from "node:fs";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class StubSession {
  constructor(config) { this.config = config; this.disposed = false; this.handle = {}; }
  async runTurn({ message }) {
    fs.appendFileSync(process.env.GARRISON_TEST_ROUTED_MESSAGES, JSON.stringify({ message }) + "\\n");
    return { reply: "routed reply", sessionId: "routed-stub" };
  }
  writeKeys() {}
  isAlive() { return !this.disposed; }
  isDisposed() { return this.disposed; }
  getClaudeSessionId() { return "routed-stub"; }
  status() { return { model: this.config?.model }; }
  dispose() { this.disposed = true; }
}
export async function spawnFn(config) {
  if (fs.existsSync(process.env.GARRISON_TEST_HOLD_RELOAD)) {
    fs.writeFileSync(process.env.GARRISON_TEST_RELOAD_SPAWN_STARTED, "started");
    while (!fs.existsSync(process.env.GARRISON_TEST_RELEASE_RELOAD)) await sleep(10);
  }
  return new StubSession(config);
}
`,
      "utf8",
    );
    const fakeClaude = path.join(dir, "fake-claude.mjs");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
import fs from "node:fs";
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => fs.appendFileSync(process.env.GARRISON_TEST_LEGACY_INPUT, chunk));
process.stdout.write([
  "Garrison fake Claude reload-race runtime",
  "Legacy fallback screen remains stable.",
  "❯ "
].join("\\r\\n"));
setInterval(() => {}, 1000);
`,
      { encoding: "utf8", mode: 0o755 },
    );

    port = await freePort();
    child = spawn(process.execPath, [path.join(ROOT, "fittings/seed/http-gateway/scripts/gateway-pty.mjs")], {
      env: {
        ...process.env,
        GARRISON_GATEWAY_HOST: "127.0.0.1",
        GARRISON_GATEWAY_PORT: String(port),
        GARRISON_COMPOSITION_DIR: dir,
        GARRISON_HOME: dir,
        GARRISON_KANBAN_DIR: kanbanRoot,
        GARRISON_AGENT_SDK_DIR: AGENT_SDK_STUB,
        GARRISON_GATEWAY_RUNTIME_STUB: runtimeStub,
        GARRISON_CLAUDE_HOME: path.join(dir, "claude-home"),
        GARRISON_CLAUDE_PROJECTS_DIR: path.join(dir, "claude-home", "projects"),
        GARRISON_CLAUDE_CONFIG_PATH: path.join(dir, "claude-home", ".claude.json"),
        GARRISON_CLAUDE_BINARY: fakeClaude,
        GARRISON_PERMISSION_MODE: "default",
        GARRISON_ROUTING: "1",
        GARRISON_TEST_HOLD_RELOAD: holdReload,
        GARRISON_TEST_RELEASE_RELOAD: releaseReload,
        GARRISON_TEST_RELOAD_SPAWN_STARTED: reloadSpawnStarted,
        GARRISON_TEST_LEGACY_INPUT: legacyInput,
        GARRISON_TEST_ROUTED_MESSAGES: routedMessages,
        GARRISON_GATEWAY_NO_LISTEN: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => (logs += String(chunk)));
    child.stderr?.on("data", (chunk) => (logs += String(chunk)));

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`gateway exited early (${child.exitCode}): ${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        const health = await response.json();
        if (health.pty_status === "failed") throw new Error(`gateway failed: ${health.error}\n${logs}`);
        if (health.pty_status === "ready") return;
      } catch (err) {
        if (err instanceof Error && /gateway failed/.test(err.message)) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`gateway never became ready: ${logs}`);
  }, 25_000);

  afterAll(async () => {
    releaseLookup();
    try {
      writeFileSync(releaseReload, "release");
    } catch {
      /* fixture may have failed before paths were initialised */
    }
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child?.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }
    if (board) await new Promise<void>((resolve) => board?.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails typed at dispatch when reload starts during Discuss lookup and writes no PTY bytes", async () => {
    const generatedBytes = "reload-race generated Web bytes must never reach a shared runtime";
    const streamRequest = fetch(`http://127.0.0.1:${port}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: generatedBytes,
        channel: "web",
        thread: "durable-reload-race-thread",
        sessionId: "durable-reload-race-thread",
        inputId: "durable-reload-race-input",
      }),
      signal: AbortSignal.timeout(8_000),
    });

    await Promise.race([
      lookupStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Discuss lookup did not start: ${logs}`)), 3_000)),
    ]);
    writeFileSync(holdReload, "hold");
    const reloadResponse = await fetch(`http://127.0.0.1:${port}/control/reload-prompt`, { method: "POST" });
    expect(reloadResponse.status).toBe(202);

    const reloadDeadline = Date.now() + 3_000;
    while (!readOptional(reloadSpawnStarted) && Date.now() < reloadDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(readOptional(reloadSpawnStarted)).toBe("started");
    const reloadingHealth = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(reloadingHealth.pty_status).toBe("starting");

    releaseLookup();
    const response = await streamRequest;
    expect(response.status).toBe(200);
    const frames = (await response.text())
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => {
        const lines = frame.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
        const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        return { event, data: JSON.parse(data) };
      });
    const failure = frames.find((frame) => frame.event === "error")?.data;
    expect(failure).toMatchObject({
      source: "gateway",
      kind: "routing",
      code: "gateway_route_unavailable",
      text: "Generated Web turns require model routing, but the routed gateway is unavailable.",
      retryable: true,
      httpStatus: 503,
      failure: {
        source: "gateway",
        kind: "routing",
        code: "gateway_route_unavailable",
        retryable: true,
        httpStatus: 503,
      },
    });
    expect(frames.some((frame) => frame.event === "done")).toBe(false);
    expect(readOptional(legacyInput)).toBe("");
    expect(readOptional(routedMessages)).toBe("");
    expect(logs).not.toContain(generatedBytes);

    writeFileSync(releaseReload, "release");
  }, 15_000);
});

describe("GET /route/options — one read for every menu (§11)", () => {
  it("offers exactly the efforts, accounts and projects the resolvers accept", () => {
    const options = gw.buildRouteOptions();
    expect(options.efforts).toEqual([...dutyEfforts]);
    expect(options.accounts).toEqual([
      { name: "codexer", platform: "openai" },
      { name: "work", platform: "anthropic" }
    ]);
    // No account pinned on this process → the honest "machine login" reading.
    expect(options.account).toEqual({ name: null, source: null });
    expect(Array.isArray(options.projects)).toBe(true);
    // Routing is off in this import (no live router), which the menu must say
    // rather than offering pins nothing would honor.
    expect(options.routing).toBe(false);
    expect(options.targets).toEqual([]);
    expect(options.duties).toEqual([]);
  });
});
