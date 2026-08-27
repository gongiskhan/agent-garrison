// Conversations B4 — a delegation is a LEDGER EVENT, not just an artifact.
//
// `delegate()` takes two optional injected sinks (`recordEvent`,
// `writePayloadCopy`) plus `opts.stretchId/briefRef`. When they are present the
// delegation lands in the conversation ledger as dispatched -> returned | failed
// and the raw output is copied beside it (L3 stays one greppable directory).
// When they are ABSENT nothing changes — every pre-conversation caller
// (bridge.mjs, garrison-codex-checkpoint, the existing suites) is unmodified.
//
// The failed event is the load-bearing one: it feeds the repeated-failure
// metric, so a throw path that escapes unrecorded makes a failing delegation
// invisible. These tests pin every exit.
import { describe, it, expect } from "vitest";
// @ts-ignore — pure .mjs package
import { delegate, DelegationError } from "../packages/claude-pty/src/index.mjs";

type Evt = { kind: string; stretch: string | null; payload: any };

function stubAdapter(opts: { text?: string; usedTokens?: number; throws?: boolean } = {}) {
  return {
    id: "codex",
    async spawn(c: any) {
      if (opts.throws) throw new Error("spawn boom");
      return { alive: true, cwd: c?.compositionDir };
    },
    async awaitReady() {},
    async sendTurn() {},
    async awaitResponse() {
      return {
        text: opts.text ?? "[codex] handled the task",
        artifacts: ["secondary/out.md"],
        ...(typeof opts.usedTokens === "number" ? { usedTokens: opts.usedTokens } : {})
      };
    },
    async teardown() {}
  };
}

function deps(extra: any = {}) {
  const events: Evt[] = [];
  const payloads: Array<{ name: string; content: string }> = [];
  return {
    events,
    payloads,
    adapter: stubAdapter(),
    spawnConfig: { compositionDir: "/tmp/x", model: "gpt-5-codex" },
    writeArtifact: async (ns: string, name: string) => `artifacts/${ns}/${name}`,
    logDecision: async () => {},
    now: () => "2026-08-26T00:00:00Z",
    recordEvent: (evt: Evt) => {
      events.push(evt);
    },
    writePayloadCopy: (name: string, content: string) => {
      payloads.push({ name, content });
      return { ref: `payloads/${name}`, bytes: content.length, truncated: false };
    },
    ...extra
  };
}

describe("delegation ledger events (conversations B4)", () => {
  it("emits dispatched -> returned with a payload ref and the adapter's usedTokens", async () => {
    const d = deps({ adapter: stubAdapter({ usedTokens: 15373 }) });
    const result = await delegate(
      { task: "trace the auth path", paths: ["src/auth.ts"], model: "gpt-5-codex" },
      d,
      { stretchId: "stretch-7", briefRef: "handoffs/0003.json" }
    );

    expect(d.events.map((e: Evt) => e.kind)).toEqual(["delegation-dispatched", "delegation-returned"]);

    const [dispatched, returned] = d.events;
    expect(dispatched.stretch).toBe("stretch-7");
    expect(dispatched.payload).toMatchObject({
      runtime: "codex",
      model: "gpt-5-codex",
      task: "trace the auth path",
      paths: ["src/auth.ts"],
      briefRef: "handoffs/0003.json"
    });
    expect(dispatched.payload.delegationId).toBeTruthy();

    // Both events carry the SAME delegation id — that is the join key.
    expect(returned.payload.delegationId).toBe(dispatched.payload.delegationId);
    expect(returned.payload).toMatchObject({ ok: true, usedTokens: 15373 });
    expect(returned.payload.summary).toBe(result.summary);
    expect(returned.payload.artifacts).toEqual(result.artifacts);
    expect(typeof returned.payload.durationMs).toBe("number");

    // The raw output was copied beside the ledger, and the returned event points at it.
    expect(d.payloads).toHaveLength(1);
    expect(d.payloads[0].name).toBe(`delegation-${dispatched.payload.delegationId}.md`);
    expect(d.payloads[0].content).toBe("[codex] handled the task");
    expect(returned.payload.payloadRef).toBe(d.payloads[0] && `payloads/${d.payloads[0].name}`);
  });

  it("redacts secrets and home paths from the dispatched task (the ledger is durable)", async () => {
    const d = deps();
    await delegate({ task: "read /home/ggomes/.garrison/data.json with OPENAI_API_KEY=sk-abcdef123456" }, d);
    const task = d.events[0].payload.task;
    expect(task).not.toContain("/home/ggomes");
    expect(task).not.toContain("sk-abcdef123456");
    expect(task).toContain("[path]");
  });

  it("reports usedTokens as null (never a fabricated 0) when the adapter reports none", async () => {
    const d = deps();
    await delegate({ task: "x" }, d);
    const returned = d.events.find((e: Evt) => e.kind === "delegation-returned")!;
    expect(returned.payload.usedTokens).toBeNull();
  });

  it("emits dispatched -> failed with the error code when both attempts throw, and still rethrows", async () => {
    const d = deps({ adapter: stubAdapter({ throws: true }) });
    await expect(delegate({ task: "x" }, d)).rejects.toMatchObject({ code: "delegation-failed" });

    expect(d.events.map((e: Evt) => e.kind)).toEqual(["delegation-dispatched", "delegation-failed"]);
    const failed = d.events[1];
    expect(failed.payload).toMatchObject({ code: "delegation-failed" });
    expect(failed.payload.delegationId).toBe(d.events[0].payload.delegationId);
    expect(failed.payload.message).toMatch(/after retry/);
    expect(typeof failed.payload.durationMs).toBe("number");
    // A failure writes no payload copy — there is no output to copy.
    expect(d.payloads).toHaveLength(0);
  });

  it("emits delegation-failed with code 'empty-output' when the secondary returns nothing", async () => {
    const d = deps({ adapter: stubAdapter({ text: "   \n  " }) });
    await expect(delegate({ task: "x" }, d)).rejects.toMatchObject({
      name: "DelegationError",
      code: "empty-output"
    });
    expect(d.events.map((e: Evt) => e.kind)).toEqual(["delegation-dispatched", "delegation-failed"]);
    expect(d.events[1].payload.code).toBe("empty-output");
  });

  it("records a PRE-DISPATCH failure too (an invalid spec never reaches the runtime but still failed)", async () => {
    const d = deps();
    await expect(delegate({ model: "gpt-5-codex" } as any, d)).rejects.toBeInstanceOf(DelegationError);
    expect(d.events.map((e: Evt) => e.kind)).toEqual(["delegation-failed"]);
    expect(d.events[0].payload.code).toBe("invalid-task-spec");
  });

  it("with NO sinks injected the result is byte-identical to the wired one (every legacy caller is unchanged)", async () => {
    // A deps object with NEITHER sink — the shape every pre-conversation caller
    // passes. A regression that calls an absent sink unguarded throws here.
    const bare = {
      adapter: stubAdapter({ usedTokens: 42 }),
      spawnConfig: { compositionDir: "/tmp/x" },
      writeArtifact: async (ns: string, name: string) => `artifacts/${ns}/${name}`,
      logDecision: async () => {},
      now: () => "2026-08-26T00:00:00Z"
    };
    const bareResult = await delegate({ task: "x" }, bare);

    const wired = deps({ adapter: stubAdapter({ usedTokens: 42 }) });
    const wiredResult = await delegate({ task: "x" }, wired);
    expect(bareResult).toEqual(wiredResult);

    // …and the failure path still fails the same way, with no sink to call.
    await expect(delegate({ task: "x" }, { ...bare, adapter: stubAdapter({ throws: true }) })).rejects.toMatchObject({
      code: "delegation-failed"
    });
  });

  it("a ledger sink that throws never fails the delegation (observation is not control flow)", async () => {
    const d = deps({
      recordEvent: () => {
        throw new Error("ledger disk full");
      },
      writePayloadCopy: () => {
        throw new Error("payload dir gone");
      }
    });
    const result = await delegate({ task: "x" }, d);
    expect(result.summary).toContain("[codex] handled");
  });
});
