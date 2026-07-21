import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs routing layer
import { RoutedGateway, createRoutedGateway, resolvePrimaryAdapter } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore — pure .mjs
import { planSwitch } from "../fittings/seed/orchestrator/lib/stage-b.mjs";
// @ts-ignore — pure .mjs package
import { MultiRuntimePool } from "../packages/claude-pty/src/index.mjs";

// S2a — the http-gateway's three Claude-specific mechanisms route through the
// RuntimeAdapter interface so a NON-claude primary boots and serves sessions
// cleanly:
//   1. Stage-B model/effort moves via adapter.setModel/setEffort (not writeKeys)
//   2. respawn-resume via adapter.resume (not the claude spawnFn + --continue)
//   3. classifier falls back to the primary adapter when claude-code is absent
// Each proven with injected fakes — no live CLI, no real model.

// A minimal non-claude operative session: it has NO writeKeys (the thing that
// used to make Stage-B hard-skip). sessionId is carried through resume.
function fakeNonPtySession(sessionId: string | null = null) {
  return { alive: true, sessionId, isAlive: () => true };
}

describe("S2a.1 — Stage-B moves route through the operative adapter", () => {
  it("adapter WITH setModel/setEffort: a session without writeKeys takes adapter-moves, not the skip", async () => {
    const calls: any[] = [];
    const adapter: any = {
      id: "agent-sdk",
      setModel: async (s: any, m: any) => calls.push(["setModel", s, m]),
      setEffort: async (s: any, e: any) => calls.push(["setEffort", s, e]),
    };
    const events: any[] = [];
    const gw: any = new RoutedGateway({
      core: { planSwitch },
      config: {},
      logFn: (e: any) => events.push(e),
      operativeAdapter: adapter,
    });
    const session = fakeNonPtySession();
    gw.operative = { id: "op", session };
    gw.currentTarget = { provider: "anthropic-plan", model: "sonnet", effort: "medium" };

    const route = { targetId: "cc-haiku-low", target: { provider: "anthropic-plan", model: "haiku", effort: "low" } };
    await gw.applySwitch(route);

    // the moves were applied THROUGH the adapter, with the resolved target values
    expect(calls).toContainEqual(["setModel", session, "haiku"]);
    expect(calls).toContainEqual(["setEffort", session, "low"]);
    // the switch is recorded as adapter-moves and logged as such
    expect(gw.switchLog.some((s: any) => s.path === "adapter-moves")).toBe(true);
    expect(events.some((e) => e.kind === "route-switch" && e.path === "adapter-moves")).toBe(true);
    // and it did NOT take (or log) the old hard-skip
    expect(events.some((e) => e.kind === "route-switch-skipped")).toBe(false);
    expect(gw.switchLog.some((s: any) => s.path === "skipped-non-pty")).toBe(false);
    // the gateway now considers the operative to be on the resolved target
    expect(gw.currentTarget.model).toBe("haiku");
    expect(gw.currentTarget.effort).toBe("low");
  });

  it("adapter WITHOUT setModel/setEffort: the existing skip fires (regression guard)", async () => {
    const events: any[] = [];
    const adapter: any = { id: "agent-sdk" }; // no setModel/setEffort
    const gw: any = new RoutedGateway({
      core: { planSwitch },
      config: {},
      logFn: (e: any) => events.push(e),
      operativeAdapter: adapter,
    });
    gw.operative = { id: "op", session: fakeNonPtySession() };
    gw.currentTarget = { provider: "anthropic-plan", model: "sonnet", effort: "medium" };

    const route = { targetId: "cc-haiku-low", target: { provider: "anthropic-plan", model: "haiku", effort: "low" } };
    await gw.applySwitch(route);

    expect(events.some((e) => e.kind === "route-switch-skipped")).toBe(true);
    expect(gw.switchLog.some((s: any) => s.path === "skipped-non-pty")).toBe(true);
    expect(events.some((e) => e.kind === "route-switch" && e.path === "adapter-moves")).toBe(false);
    // the operative was NOT moved (model/effort stay launch-fixed)
    expect(gw.currentTarget.model).toBe("sonnet");
  });
});

describe("non-Claude primary delegate routing", () => {
  it("does not mutate the primary adapter before a legacy Claude route takes the delegate lane", async () => {
    const moves: any[] = [];
    const target = {
      id: "cc-sonnet-med",
      runtime: "claude-code",
      provider: "anthropic-plan",
      model: "sonnet",
      effort: "medium"
    };
    const core: any = {
      resolveRoute: () => ({
        profile: "balanced",
        role: "standard",
        ruleId: "row:code",
        via: "matrix",
        targetId: target.id,
        target
      }),
      decisionRecord: ({ classification, route }: any) => ({
        ...classification,
        targetId: route.targetId
      }),
      appendDecision: async () => {},
      planSwitch: () => {
        throw new Error("delegate route must not plan a primary-runtime switch");
      }
    };
    const gw: any = new RoutedGateway({
      core,
      config: {
        activeProfile: "balanced",
        taskTypes: ["code"],
        tiers: ["T1-standard"]
      },
      primaryEngine: "codex",
      operativeAdapter: {
        id: "codex",
        setModel: async (...args: any[]) => moves.push(["model", ...args]),
        setEffort: async (...args: any[]) => moves.push(["effort", ...args])
      }
    });
    gw.operative = { session: fakeNonPtySession() };

    const pre = await gw.preRoute("implement the change", {
      classification: { taskType: "code", tier: "T1-standard" }
    });

    expect(pre.plan.path).toBe("claude-delegate");
    expect(moves).toEqual([]);
  });
});

describe("S2a.2 — respawn-resume routes through the operative adapter", () => {
  it("a non-claude adapter with resume: adapter.resume is called and the claude spawnFn is NOT", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-s2a-respawn-"));
    const calls: any[] = [];
    const resumedSession = { alive: true, sessionId: "resumed-1" };
    const adapter: any = {
      id: "agent-sdk",
      resume: async (config: any) => {
        calls.push(["resume", config]);
        return resumedSession;
      },
      teardown: async () => calls.push(["teardown"]),
    };
    let spawnCalled = false;
    const spawnFn = async () => {
      spawnCalled = true;
      return {};
    };
    const events: any[] = [];
    const gw: any = new RoutedGateway({
      core: {},
      config: {},
      compositionDir: tmp,
      logFn: (e: any) => events.push(e),
      operativeAdapter: adapter,
      spawnFn,
    });
    gw.operative = { id: "op", session: fakeNonPtySession("prior-sess") };

    const target = { id: "t-ollama", provider: "ollama-local", model: "qwen2.5-coder", effort: null };
    await gw.respawnOperative(target);

    // routed through the adapter, NOT the claude spawnFn + --continue path
    expect(spawnCalled).toBe(false);
    const resume = calls.find((c) => c[0] === "resume");
    expect(resume).toBeTruthy();
    // the resume config mirrors the adapter's spawn shape + carries the prior id
    expect(resume[1]).toMatchObject({ provider: "ollama-local", model: "qwen2.5-coder", sessionId: "prior-sess", compositionDir: tmp });
    // the fresh session replaces the operative, logged as adapter-resume
    expect(gw.getOperativeSession()).toBe(resumedSession);
    expect(events.some((e) => e.kind === "route-respawn" && e.path === "adapter-resume")).toBe(true);
  });

  it("a claude-code operative adapter takes the historical spawnFn path (regression guard)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-s2a-cc-respawn-"));
    let spawnCalled = false;
    const freshSession = { dispose: () => {} };
    const spawnFn = async () => {
      spawnCalled = true;
      return freshSession;
    };
    const claudeAdapter: any = { id: "claude-code", resume: async () => ({}) };
    const events: any[] = [];
    const gw: any = new RoutedGateway({
      core: {
        buildRespawnOpts: () => ({ compositionDir: tmp }),
        ensureProviders: () => ({ providers: [] }),
      },
      config: {},
      compositionDir: tmp,
      logFn: (e: any) => events.push(e),
      operativeAdapter: claudeAdapter,
      spawnFn,
    });
    gw.operative = { id: "op", session: { dispose: () => {} } };

    await gw.respawnOperative({ id: "t-anthropic", provider: "anthropic-plan", model: "opus" });

    // claude-code → the spawnFn path, NOT adapter.resume
    expect(spawnCalled).toBe(true);
    expect(gw.getOperativeSession()).toBe(freshSession);
    expect(events.some((e) => e.kind === "route-respawn" && e.path === "spawn-continue")).toBe(true);
    expect(events.some((e) => e.kind === "route-respawn" && e.path === "adapter-resume")).toBe(false);
  });
});

describe("S2a.2b — adapter-resume retires the old operative cleanly (codex finding)", () => {
  it("evicts the old pool checkout exactly once — torn down via the adapter, never pool-disposed, no double on shutdown", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-s2a-evict-"));
    const teardowns: string[] = [];
    const disposes: string[] = [];
    let n = 0;
    const makeSession = (id: string) => ({
      id,
      alive: true,
      sessionId: id,
      dispose() {
        disposes.push(id);
        this.alive = false;
      },
      isAlive() {
        return this.alive;
      },
      isDisposed() {
        return !this.alive;
      },
    });
    const resumed = makeSession("resumed");
    const adapter: any = {
      id: "agent-sdk",
      spawn: async () => makeSession(`warm-${++n}`),
      resume: async () => resumed,
      // adapter teardown is NOT session.dispose (the real non-claude adapters set alive=false)
      teardown: async (s: any) => {
        teardowns.push(s?.id);
        if (s) s.alive = false;
      },
    };
    const pool: any = new MultiRuntimePool({
      maxTotal: 2,
      runtimes: [{ id: "operative", adapter, role: "primary", size: 1, spawnConfig: {} }],
    });
    await pool.start();
    const events: any[] = [];
    const gw: any = new RoutedGateway({
      core: {},
      config: {},
      compositionDir: tmp,
      logFn: (e: any) => events.push(e),
      operativeAdapter: adapter,
      pool,
      operativeRuntimeId: "operative",
    });
    gw.operative = await pool.checkout("operative");
    const oldId = gw.operative.session.id;
    expect(pool.status().operative.checkedOut).toBe(1);

    await gw.respawnOperative({ id: "t-ollama", provider: "ollama-local", model: "qwen2.5:3b" });

    // fresh session installed; the old checkout is evicted from the pool accounting
    expect(gw.getOperativeSession()).toBe(resumed);
    expect(pool.status().operative.checkedOut).toBe(0);
    // the old session was torn down EXACTLY ONCE (via the adapter), never pool-disposed
    expect(teardowns.filter((id) => id === oldId)).toHaveLength(1);
    expect(disposes).not.toContain(oldId);

    // shutdown must NOT dispose or re-teardown the retired old session (no double)
    gw.shutdown();
    expect(disposes).not.toContain(oldId);
    expect(teardowns.filter((id) => id === oldId)).toHaveLength(1);
  });

  it("a throwing teardown during resume logs route-respawn-teardown-failed loudly and resume still succeeds", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-s2a-teardown-throw-"));
    const resumed = { id: "resumed", alive: true, sessionId: "resumed" };
    const adapter: any = {
      id: "agent-sdk",
      resume: async () => resumed,
      teardown: async () => {
        throw new Error("stuck pipe");
      },
    };
    const events: any[] = [];
    const gw: any = new RoutedGateway({
      core: {},
      config: {},
      compositionDir: tmp,
      logFn: (e: any) => events.push(e),
      operativeAdapter: adapter,
    });
    gw.operative = { id: "op", session: { id: "old", sessionId: "old" }, release: () => {} };

    // resume must not reject even though teardown throws
    await expect(gw.respawnOperative({ id: "t", provider: "ollama-local", model: "x" })).resolves.toBeUndefined();

    // resume succeeded despite the teardown throw
    expect(gw.getOperativeSession()).toBe(resumed);
    // the failure was logged loudly, not swallowed
    const failed = events.find((e) => e.kind === "route-respawn-teardown-failed");
    expect(failed).toMatchObject({ error: "stuck pipe", runtime: "agent-sdk" });
    // the switch still logged success
    expect(events.some((e) => e.kind === "route-respawn" && e.path === "adapter-resume")).toBe(true);
  });
});

describe("S2a.3 — classifier resolution per primary engine", () => {
  it("agent-sdk primary → classifier runs LEAN on the same engine (no PTY), even with claude-code absent", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-s2a-classifier-"));
    const fakePrimary: any = { id: "agent-sdk", spawn: async () => ({ alive: true }) };
    const events: any[] = [];
    const gw: any = await createRoutedGateway({
      compositionDir: tmp,
      primaryEngine: "agent-sdk",
      agentSdkAdapter: fakePrimary,
      operativeSpawnConfig: { compositionDir: tmp, model: "sonnet" },
      // inject: claude-code is NOT resolvable (never probe a real CLI in a unit test)
      claudeCodeResolvable: false,
      logFn: (e: any) => events.push(e),
    });

    // no "fallback" — classifying on the primary engine IS the design for agent-sdk
    expect(events.some((e) => e.kind === "classifier-fallback")).toBe(false);
    const classifierRt = gw.pool.runtimes.find((r: any) => r.id === "classifier");
    expect(classifierRt.adapter).toBe(fakePrimary);
    // lean + the cheap classifier model, NOT the operative's coding harness
    expect(classifierRt.spawnConfig).toMatchObject({ provider: "anthropic", model: "haiku", promptMode: "lean" });
    // the operative also runs on the primary adapter (sanity)
    const operativeRt = gw.pool.runtimes.find((r: any) => r.id === "operative");
    expect(operativeRt.adapter).toBe(fakePrimary);

    gw.shutdown?.();
  });

  it("agent-sdk primary + claude-code RESOLVABLE → classifier still avoids the PTY (a wedged PTY classifier would block every pre-route)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-s2a-classifier-cc-"));
    const fakePrimary: any = { id: "agent-sdk", spawn: async () => ({ alive: true }) };
    const events: any[] = [];
    const gw: any = await createRoutedGateway({
      compositionDir: tmp,
      primaryEngine: "agent-sdk",
      agentSdkAdapter: fakePrimary,
      operativeSpawnConfig: { compositionDir: tmp, model: "sonnet" },
      claudeCodeResolvable: true,
      logFn: (e: any) => events.push(e),
    });

    expect(events.some((e) => e.kind === "classifier-fallback")).toBe(false);
    const classifierRt = gw.pool.runtimes.find((r: any) => r.id === "classifier");
    expect(classifierRt.adapter).toBe(fakePrimary);
    expect(classifierRt.spawnConfig).toMatchObject({ model: "haiku", promptMode: "lean" });

    gw.shutdown?.();
  });

  it("codex primary + claude-code resolvable → classifier STAYS on claude-code (byte-identical default)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-s2a-classifier-codex-"));
    const fakeExec: any = { id: "codex", spawn: async () => ({ alive: true }) };
    const events: any[] = [];
    const gw: any = await createRoutedGateway({
      compositionDir: tmp,
      primaryEngine: "codex",
      secondaryAdapters: new Map([["codex", fakeExec]]),
      operativeSpawnConfig: { compositionDir: tmp, model: "gpt-5-codex" },
      claudeCodeResolvable: true,
      logFn: (e: any) => events.push(e),
    });

    expect(events.some((e) => e.kind === "classifier-fallback")).toBe(false);
    const classifierRt = gw.pool.runtimes.find((r: any) => r.id === "classifier");
    expect(classifierRt.adapter?.constructor?.name).toBe("ClaudeCodeAdapter");
    expect(classifierRt.spawnConfig.model).toBe("haiku");

    gw.shutdown?.();
  });
});

// codex-checkpoint pass B: an agent-sdk PRIMARY must resolve its own provider
// spec, not silently fall back to "anthropic". The gateway entrypoint now
// threads GARRISON_PROVIDER into operativeSpawnConfig.provider; this locks the
// consuming contract in resolvePrimaryAdapter.
describe("S2a — agent-sdk primary honors its configured provider", () => {
  const tmp = mkdtempSync(join(tmpdir(), "primary-provider-"));
  const ctx = (provider?: string) => ({
    compositionDir: tmp,
    spawnFn: null,
    operativeSpawnConfig: { compositionDir: tmp, model: "qwen2.5:3b", ...(provider ? { provider } : {}) },
    // Inject a fake adapter so we don't dynamic-import the real fitting.
    opts: { agentSdkAdapter: { name: "fake-sdk" } }
  });

  it("threads a non-anthropic provider (ollama-local) into the spawn config", async () => {
    const resolved = await resolvePrimaryAdapter("agent-sdk", ctx("ollama-local"));
    expect(resolved.claude).toBe(false);
    expect(resolved.spawnConfig.provider).toBe("ollama-local");
    expect(resolved.spawnConfig.model).toBe("qwen2.5:3b");
  });

  it("preserves the byte-identical anthropic default when no provider is named", async () => {
    const resolved = await resolvePrimaryAdapter("agent-sdk", ctx());
    expect(resolved.spawnConfig.provider).toBe("anthropic");
  });

  it("seeds the agent-sdk primary spawn env from the gateway process env (config-dir + account pin survive the SDK's env replacement)", async () => {
    const resolved = await resolvePrimaryAdapter("agent-sdk", ctx());
    // The Agent SDK replaces the subprocess env with options.env; an empty
    // baseEnv would strip CLAUDE_CONFIG_DIR / PATH / HOME and the Paymaster
    // account token. It must inherit the gateway's own process env.
    expect(resolved.spawnConfig.env).toBe(process.env);
  });
});

// The classifier de-PTY (agent-sdk primary): classify() drives the classifier
// session through its ADAPTER when the session has no runTurn (an agent-sdk
// session), instead of throwing `session.runTurn is not a function` and
// defaulting every turn to other/T1.
describe("classify() drives an adapter-backed classifier session (no runTurn)", () => {
  it("uses the classifier adapter's sendTurn/awaitResponse and parses the reply", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-sdk-classify-"));
    const captured: string[] = [];
    // A fake agent-sdk adapter: spawn returns a session WITHOUT runTurn; the turn
    // runs via sendTurn/awaitResponse (like the Claude delegate lane).
    const fakeSdk: any = {
      id: "agent-sdk",
      spawn: async (cfg: any) => ({ alive: true, config: cfg }),
      awaitReady: async () => {},
      sendTurn: async (_s: any, text: string) => { captured.push(text); },
      awaitResponse: async () => ({
        text: JSON.stringify({ taskType: "research", tier: "T1-standard", matchedException: null, contextKind: "unit" }),
      }),
    };
    const gw: any = await createRoutedGateway({
      compositionDir: tmp,
      primaryEngine: "agent-sdk",
      agentSdkAdapter: fakeSdk,
      operativeSpawnConfig: { compositionDir: tmp, model: "sonnet" },
      claudeCodeResolvable: false,
      logFn: () => {},
    });
    await gw.start();
    // A message with no deterministic-keyword match → the LLM classifier path.
    const cls = await gw.classify("tell me what the weather is like today");
    expect(cls.taskType).toBe("research");
    expect(cls.tier).toBe("T1-standard");
    // proves the adapter path ran (the classifier session had no runTurn)
    expect(captured.length).toBe(1);
    gw.shutdown?.();
  });
});
