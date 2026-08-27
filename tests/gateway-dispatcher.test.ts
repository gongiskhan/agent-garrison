// S3d (GARRISON-MARATHON-V3) — the gateway's OPT-IN Dispatcher hook (D6).
// The dispatcher path is additive and default-off: a RoutedGateway constructed
// without a dispatcher bundle has an inert dispatchRoute() and an unchanged
// classify(), so the 122-case classifier corpus and the gateway suite are
// untouched. When a dispatcher IS wired, dispatchRoute() runs the real
// dispatch-core over an injected garrison-call and logs routing evidence.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs routing layer
import { RoutedGateway, buildProductionDispatcher, makeAdapterCallInvoker } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore — pure .mjs dispatch core (the real module, wired as the gateway would wire it)
import * as dispatchCore from "../fittings/seed/orchestrator/lib/dispatch-core.mjs";

function model() {
  return {
    duties: {
      code: {
        id: "code",
        title: "Code",
        description: "write or change software",
        levels: [
          { description: "trivial", cell: { target: "sdk-haiku", effort: "low" } },
          { description: "standard", cell: { target: "cc-sonnet", effort: "medium" } },
          { description: "deep", cell: { target: "cc-opus", effort: "high" } }
        ]
      },
      other: {
        id: "other",
        title: "Other",
        description: "anything else",
        levels: [
          { description: "trivial", cell: { target: "sdk-haiku", effort: "low" } },
          { description: "standard", cell: { target: "cc-sonnet", effort: "low" } },
          { description: "deep", cell: { target: "cc-sonnet", effort: "low" } }
        ]
      }
    },
    selectedDuties: ["code", "other"]
  };
}

describe("RoutedGateway dispatch hook (opt-in, default off)", () => {
  it("builds dispatch-fast on a lean, no-tools Agent SDK subscription turn (never Ollama)", async () => {
    const dispatchModel: any = {
      ...model(),
      duties: {
        ...model().duties,
        dispatch: { id: "dispatch", title: "Dispatch", description: "route", levels: [{ description: "once", cell: { target: "dispatch-fast", effort: "low" } }] }
      },
      selectedDuties: ["code", "other", "dispatch"]
    };
    let spawned: any = null;
    const adapter = {
      spawn: async (config: any) => ((spawned = config), {}),
      awaitReady: async () => {},
      sendTurn: async () => {},
      awaitResponse: async () => ({ text: '{"duty":"code","level":1,"confidence":"high"}' }),
      teardown: async () => {}
    };
    const resolvedLib = {
      dispatcherModelFrom: () => dispatchModel,
      loadResolvedModel: () => dispatchModel,
      executionRouteFor: () => ({ target: { runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", authMode: "subscription", promptMode: "lean", maxTurns: 1, timeoutMs: 8000 } })
    };
    const dispatcher = await buildProductionDispatcher({
      compositionDir: mkdtempSync(join(tmpdir(), "gw-prod-dispatch-")),
      compositionId: "fixture",
      executionModel: dispatchModel,
      resolvedLib,
      agentSdkAdapter: adapter
    });
    expect(dispatcher?.configuredCall).toBe("agent-sdk-adapter");
    const out = await dispatcher!.core.dispatch(dispatchModel, "small task", {
      call: dispatcher!.call,
      ...dispatcher!.callOpts
    });
    expect(out.dispatchOk).toBe(true);
    expect(out.provider).toBe("anthropic");
    expect(out.model).toBe("claude-haiku-4-5");
    expect(spawned).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      authMode: "subscription",
      promptMode: "lean",
      maxTurns: 1,
      allowedTools: [],
      thinking: { type: "disabled" }
    });
    expect(JSON.stringify(spawned)).not.toMatch(/ollama/i);
  });

  it("does not warm or checkout a Stage-A classifier when Orchestrator dispatch is present", async () => {
    const checkedOut: string[] = [];
    const pool = {
      start: async () => {},
      checkout: async (id: string) => {
        checkedOut.push(id);
        return { id, session: { isAlive: () => true }, release: () => {} };
      }
    };
    const gw = new RoutedGateway({
      pool,
      dispatcher: { core: dispatchCore, model: model(), call: async () => ({ ok: true, structured: { duty: "code", level: 1 } }) }
    });
    await gw.start();
    expect(checkedOut).toEqual(["operative"]);
    expect(gw.classifier).toBeNull();
  });

  it("cancels and tears down a session whose spawn resolves after the bounded timeout", async () => {
    let releaseSpawn!: (session: any) => void;
    const lateSession = { id: "late-dispatch" };
    const calls: string[] = [];
    const adapter = {
      spawn: () => new Promise((resolve) => { releaseSpawn = resolve; }),
      awaitReady: async () => { calls.push("ready"); },
      sendTurn: async () => { calls.push("send"); },
      awaitResponse: async () => ({ text: "too late" }),
      cancel: async (session: any) => { expect(session).toBe(lateSession); calls.push("cancel"); },
      teardown: async (session: any) => { expect(session).toBe(lateSession); calls.push("teardown"); }
    };
    const invoke = makeAdapterCallInvoker(adapter, {}, { timeoutMs: 5 });
    await expect(invoke({ prompt: "route", timeoutMs: 5 })).resolves.toMatchObject({ code: "timeout" });
    releaseSpawn(lateSession);
    for (let i = 0; i < 4 && !calls.includes("teardown"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(calls).toEqual(["cancel", "teardown"]);
  });

  it("keeps the inference deadline bounded even when adapter cleanup never settles", async () => {
    const calls: string[] = [];
    const never = new Promise(() => {});
    const adapter = {
      spawn: async () => ({ id: "wedged-dispatch" }),
      awaitReady: async () => {},
      sendTurn: async () => {},
      awaitResponse: async () => never,
      cancel: async () => { calls.push("cancel"); return never; },
      teardown: async () => { calls.push("teardown"); return never; }
    };
    const invoke = makeAdapterCallInvoker(adapter, {}, { timeoutMs: 5 });
    await expect(invoke({ prompt: "route", timeoutMs: 5 })).resolves.toMatchObject({ code: "timeout" });
    expect(calls).toEqual(["cancel", "teardown"]);
  });

  it("a gateway with no dispatcher wired has an inert dispatchRoute (classifier stays the default)", async () => {
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] } });
    expect(gw._dispatcher).toBeNull();
    await expect(gw.dispatchRoute("anything")).rejects.toThrow(/no Orchestrator routing inference wired/);
  });

  it("routes a message through the real dispatch-core when a dispatcher is wired, and logs digest-only evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-dispatch-"));
    const decisionsFile = join(dir, "decisions.jsonl");
    const call = async () => ({ ok: true, structured: { duty: "code", level: 3, confidence: "high", reason: "wide blast radius" } });
    const gw = new RoutedGateway({
      decisionsFile,
      nowFn: () => "2026-03-03T00:00:00Z",
      dispatcher: { core: dispatchCore, model: model(), call }
    });

    const out = await gw.dispatchRoute("re-architect the auth layer");
    expect(out.duty).toBe("code");
    expect(out.level).toBe(3);
    expect(out.confidence).toBe("high");
    expect(out.dispatchOk).toBe(true);

    expect(existsSync(decisionsFile)).toBe(true);
    const rec = JSON.parse(readFileSync(decisionsFile, "utf8").trim());
    expect(rec.kind).toBe("dispatch");
    expect(rec.duty).toBe("code");
    expect(rec.messageDigest).toBe(dispatchCore.messageDigest("re-architect the auth layer"));
    // the raw message must never reach the decisions log
    expect(readFileSync(decisionsFile, "utf8")).not.toContain("re-architect the auth layer");
  });

  it("a human 'run at level N' override wins over the model's pick", async () => {
    const call = async () => ({ ok: true, structured: { duty: "code", level: 3, confidence: "high", reason: "x" } });
    const gw = new RoutedGateway({
      decisionsFile: join(mkdtempSync(join(tmpdir(), "gw-dispatch-ov-")), "d.jsonl"),
      dispatcher: { core: dispatchCore, model: model(), call }
    });
    const out = await gw.dispatchRoute("re-architect but run at level 1");
    expect(out.duty).toBe("code");
    expect(out.level).toBe(1);
    expect(out.overridden).toBe(true);
    expect(out.overrideSource).toBe("message");
  });

  it("a card-level override is honored through the gateway", async () => {
    const call = async () => ({ ok: true, structured: { duty: "code", level: 3, confidence: "high", reason: "x" } });
    const gw = new RoutedGateway({
      decisionsFile: join(mkdtempSync(join(tmpdir(), "gw-dispatch-card-")), "d.jsonl"),
      dispatcher: { core: dispatchCore, model: model(), call }
    });
    const out = await gw.dispatchRoute("do the thing", { cardLevel: 2 });
    expect(out.level).toBe(2);
    expect(out.overrideSource).toBe("card");
  });
});
