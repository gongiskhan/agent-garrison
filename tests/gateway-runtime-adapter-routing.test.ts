import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs routing layer
import { RoutedGateway, createRoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore — pure .mjs
import { planSwitch } from "../fittings/seed/orchestrator/lib/stage-b.mjs";

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

describe("S2a.3 — classifier falls back to the primary adapter when claude-code is absent", () => {
  it("non-claude primary + claude-code unresolvable → classifier-fallback logged, primary adapter classifies", async () => {
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

    const fallback = events.find((e) => e.kind === "classifier-fallback");
    expect(fallback).toMatchObject({ from: "claude-code", to: "agent-sdk" });

    // the built pool's classifier runtime now uses the PRIMARY adapter, not a
    // fresh ClaudeCodeAdapter, with the primary's spawn config
    const classifierRt = gw.pool.runtimes.find((r: any) => r.id === "classifier");
    expect(classifierRt.adapter).toBe(fakePrimary);
    expect(classifierRt.spawnConfig).toMatchObject({ provider: "anthropic" });
    // the operative also runs on the primary adapter (sanity)
    const operativeRt = gw.pool.runtimes.find((r: any) => r.id === "operative");
    expect(operativeRt.adapter).toBe(fakePrimary);

    gw.shutdown?.();
  });

  it("non-claude primary + claude-code resolvable → classifier STAYS on claude-code (byte-identical default)", async () => {
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
    expect(classifierRt.adapter?.constructor?.name).toBe("ClaudeCodeAdapter");
    expect(classifierRt.spawnConfig.model).toBe("haiku");

    gw.shutdown?.();
  });
});
