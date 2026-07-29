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
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dutyEfforts } from "../src/lib/types";
// @ts-ignore — pure .mjs routing layer, no .d.ts
import { applyTurnOverride, effortControllable, listVaultAccounts, resolveVaultAccount, readMaterializedSecrets, anthropicAccountEnv, createRoutedGateway, RoutedGateway, TURN_EFFORTS, AGENT_SDK_SESSION_CAP } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";

const ROOT = path.resolve(__dirname, "..");

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
    workKinds: ["full-feature", "docs-change"],
    phases: ["plan", "implement", "review", "adversarial-review", "walkthrough"]
  };

  it("keeps well-formed tier / workKind / phasesOff pins", () => {
    const { routing, rejected } = gw.sanitizeRouting(
      { tier: " T2-deep ", workKind: "docs-change", phasesOff: "review, walkthrough" },
      VOCAB
    );
    expect(routing).toEqual({ tier: "T2-deep", workKind: "docs-change", phasesOff: "review,walkthrough" });
    expect(rejected).toEqual([]);
  });

  it("refuses an out-of-vocabulary tier or work kind", () => {
    expect(gw.sanitizeRouting({ tier: "T9-heroic" }, VOCAB)).toEqual({
      routing: null,
      rejected: [{ field: "tier", reason: "tier-not-in-vocabulary" }]
    });
    expect(gw.sanitizeRouting({ workKind: "vibes" }, VOCAB)).toEqual({
      routing: null,
      rejected: [{ field: "workKind", reason: "workKind-not-in-vocabulary" }]
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
    const empty = { tiers: [], workKinds: [], phases: [] };
    for (const field of ["tier", "workKind", "phasesOff"]) {
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
});

describe("the effort vocabulary cannot drift from dutyEfforts", () => {
  it("TURN_EFFORTS === dutyEfforts (src/lib/types.ts)", () => {
    expect(TURN_EFFORTS).toEqual([...dutyEfforts]);
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
    { id: "sdk-ollama-chat", type: "runtime-target", runtime: "agent-sdk", provider: "ollama-local", model: "qwen3:0.6b", promptMode: "lean" },
    { id: "gemini-flash", type: "runtime-target", runtime: "gemini", provider: "google", model: "gemini-2.5-flash" },
    { id: "classifier", type: "runtime-target", runtime: "claude-code", provider: "anthropic-plan", model: "haiku", pinned: true }
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
    const out = applyTurnOverride(CONFIG, route, { target: "sdk-ollama-chat" });
    expect(out.applied).toEqual(["target"]);
    expect(route.targetId).toBe("sdk-ollama-chat");
    expect(route.target).toMatchObject({ runtime: "agent-sdk", provider: "ollama-local", model: "qwen3:0.6b" });
    expect(route.via).toBe("turn-override");
    expect(route.ruleId).toBe("override:sdk-ollama-chat");
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

    // agent-sdk marks effort:false for every non-Anthropic provider.
    const sdk: any = { targetId: "sdk-ollama-chat", target: CONFIG.targets[2], via: "matrix" };
    expect(applyTurnOverride(CONFIG, sdk, { effort: "high" }).rejected[0].reason).toBe("provider-has-no-effort-control");
    expect(effortControllable({ runtime: "agent-sdk", provider: "anthropic" })).toBe(true);
    expect(effortControllable({ runtime: "codex" })).toBe(true);
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

    // An Anthropic token does nothing for an ollama endpoint: refused, not shown.
    const sdk: any = { targetId: "sdk-ollama-chat", target: CONFIG.targets[2], via: "matrix" };
    const mismatch = applyTurnOverride(CONFIG, sdk, { account: "work" }, {
      resolveAccount: () => ({ name: "work", platform: "anthropic", token: "t" })
    });
    expect(mismatch.rejected).toEqual([{ field: "account", reason: "account-platform-mismatch" }]);
    expect(sdk.target.account).toBeUndefined();

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
        routing: { target: "sdk-ollama-chat" }
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
      expect(last).toMatchObject({ targetId: "sdk-ollama-chat", runtime: "agent-sdk", overrides: ["target"] });
      // The PTY operative was never switched for a pin that left the Claude lane.
      expect(gateway.getOperativeSession().keys.join("")).toBe("");
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

  it("409s a lane with no cancel primitive rather than claiming a stop", async () => {
    const turns = new Map([["t", { lane: "ollama-native", stop: null, cancelled: false }]]);
    const r = await gw.handleInterrupt({ sessionId: "t" }, turns);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "lane-has-no-cancel-primitive", lane: "ollama-native" });
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

// A fake AgentSdkAdapter with the new cancel + streaming hooks.
class FakeAgentSdk {
  id = "agent-sdk";
  spawned: any[] = [];
  cancelled: any[] = [];
  hooks: any[] = [];
  response: any = { text: "final answer", toolUses: [], stoppedReason: null };
  blocks: { text?: string; tool?: { name: string; id: string } }[] = [];
  async spawn(cfg: any) {
    this.spawned.push(cfg);
    return { alive: true, sessionId: `sdk-${this.spawned.length}`, harness: { promptMode: cfg.promptMode }, config: cfg };
  }
  async awaitReady() {}
  async sendTurn(_s: any, _text: string, hooks: any = {}) {
    this.hooks.push(hooks);
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
  async cancel(session: any) {
    this.cancelled.push(session.sessionId);
    return true;
  }
  async teardown(s: any) {
    s.alive = false;
  }
}

function sdkRoute() {
  return { targetId: "sdk-ollama-chat", target: { ...CONFIG.targets[2] } };
}

function bareGateway(agentSdk: any) {
  const gateway: any = Object.create(RoutedGateway.prototype);
  gateway.logFn = () => {};
  gateway.compositionDir = compositionDir;
  gateway.config = CONFIG;
  gateway._agentSdkAdapter = agentSdk;
  gateway._agentSdkSessions = new Map();
  gateway.secrets = null;
  gateway.secretsFn = null;
  return gateway;
}

describe("agent-sdk lane: conversation identity, liveness and a real stop (§9, §12)", () => {
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
  it("forwards the per-turn cwd and env to oneShotTurn, and reports the transcript under that cwd", async () => {
    const calls: any[] = [];
    const gateway: any = Object.create(RoutedGateway.prototype);
    gateway.logFn = () => {};
    gateway.compositionDir = compositionDir;
    gateway._operativeSpawnConfig = { compositionDir, model: "sonnet", claudeBinary: "claude" };
    gateway._oneShotFn = async (opts: any) => {
      calls.push(opts);
      return { reply: "one-shot reply", sessionId: "os-1" };
    };
    const out = await gateway.runWebOneShot({
      message: "hi",
      model: "opus",
      cwd: compositionDir,
      env: { ...process.env, ANTHROPIC_AUTH_TOKEN: "tok", GARRISON_ACCOUNT: "work" }
    });
    expect(calls[0].cwd).toBe(compositionDir);
    expect(calls[0].env.GARRISON_ACCOUNT).toBe("work");
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
      "sdk-ollama-chat",
      "gemini-flash"
    ]); // the pinned classifier target is infrastructure, never offered
    expect(options.efforts).toEqual([...dutyEfforts]);
    expect(options.projects).toEqual(["repo-a"]); // confined: the non-repo is not offered
    expect(options.activeProfile).toBe("demo");

    // The proof that this endpoint is not gated on readiness.
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health.pty_status).toBe("spawning");
  }, 30_000);

  it("404s an interrupt for a conversation with no in-flight turn", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/chat/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "thread-nope" })
    });
    expect(r.status).toBe(404);
    await expect(r.json()).resolves.toMatchObject({ ok: false, error: "no-active-turn" });
  });
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
