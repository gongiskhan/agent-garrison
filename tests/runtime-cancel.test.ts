import { describe, expect, it, vi } from "vitest";
// @ts-ignore - pure .mjs runtime fittings
import { CodexAdapter } from "../fittings/seed/codex-runtime/lib/codex-adapter.mjs";
// @ts-ignore
import { GeminiAdapter } from "../fittings/seed/gemini-runtime/lib/gemini-adapter.mjs";
// @ts-ignore
import { AgentSdkAdapter } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";

// Real cancel, per the 2026-07-25 web-channel run-context decision §9: teardown()
// killed nothing and no adapter stored the child/query handle, so a routed turn ran
// to completion no matter what the user pressed. These tests pin the kill primitives
// on the injection seams the adapters already have (`runExec` / `createClient`) - no
// real codex/gemini/SDK process is ever spawned.

const PKG = "@garrison/claude-pty";

// A stand-in for `defaultRunExec`: it honours the new `onSpawn` sink so the adapter
// can park the child, and lets the test drive stdout, signals and exit like a real
// node ChildProcess (`exitCode`/`signalCode` stay null until an exit is observed -
// `killed` deliberately is NOT a liveness signal).
function fakeExec(opts: { dieOnTerm?: boolean } = {}) {
  const state: any = { signals: [] as string[], child: null, emit: null, close: null, spawns: 0 };
  const runExec = ({ stdin, onSpawn }: any) =>
    new Promise((resolve) => {
      let out = "";
      let settled = false;
      const child: any = {
        exitCode: null,
        signalCode: null,
        killed: false,
        kill(sig: string) {
          state.signals.push(sig);
          child.killed = true;
          // A well-behaved child exits on SIGTERM; a wedged one ignores it and only
          // SIGKILL lands. That difference is what the escalation must react to.
          if (sig === "SIGKILL" || opts.dieOnTerm) child.signalCode = sig;
        }
      };
      const settle = (result: any) => {
        if (settled) return false;
        settled = true;
        resolve(result);
        return true;
      };
      state.spawns += 1;
      state.stdin = stdin;
      state.child = child;
      state.emit = (chunk: string) => (out += chunk);
      state.close = (code: number) => settle({ code, stdout: out, stderr: "" });
      onSpawn?.({ child, partial: () => out, settle });
    });
  return { runExec, state };
}

// The two CLI adapters are independent packages with a deliberately duplicated
// cancel implementation; assert both against the same contract so they cannot drift.
const cliAdapters: [string, any][] = [
  ["codex", CodexAdapter],
  ["gemini", GeminiAdapter]
];

describe.each(cliAdapters)("%s adapter cancel (run-context §9)", (_name, Adapter) => {
  it("stores the spawned child on the session so there is something to signal", async () => {
    const { runExec, state } = fakeExec();
    const adapter = new Adapter({ runExec });
    const s = await adapter.spawn({ model: "m", compositionDir: "/tmp" });
    expect(s.proc ?? null).toBeNull();
    await adapter.sendTurn(s, "a long job");
    expect(s.proc.child).toBe(state.child);
  });

  it("SIGTERMs, escalates to SIGKILL after the grace, and settles with the partial output", async () => {
    vi.useFakeTimers();
    try {
      const { runExec, state } = fakeExec();
      const adapter = new Adapter({ runExec });
      const s = await adapter.spawn({ model: "m", compositionDir: "/tmp" });
      await adapter.sendTurn(s, "a long job");
      state.emit("half a plan");

      expect(await adapter.cancel(s)).toBe(true);
      expect(state.signals).toEqual(["SIGTERM"]);
      expect(s.cancelRequested).toBe(true);

      // Idempotent: a second Stop must not re-signal or arm a second escalation.
      expect(await adapter.cancel(s)).toBe(true);
      expect(state.signals).toEqual(["SIGTERM"]);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.signals).toEqual(["SIGTERM", "SIGKILL"]);

      // The turn settles with what the CLI had already printed and an explicit stop
      // reason - a signalled child's non-zero exit must NOT surface as a throw.
      const r = await adapter.awaitResponse(s);
      expect(r).toMatchObject({ text: "half a plan", stoppedReason: "cancelled" });
      expect(s.proc).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not SIGKILL a child that already died on SIGTERM", async () => {
    vi.useFakeTimers();
    try {
      const { runExec, state } = fakeExec({ dieOnTerm: true });
      const adapter = new Adapter({ runExec });
      const s = await adapter.spawn({ model: "m", compositionDir: "/tmp" });
      await adapter.sendTurn(s, "a long job");
      await adapter.cancel(s);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(state.signals).toEqual(["SIGTERM"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op with no child, and never poisons the next turn", async () => {
    // An injected runExec that ignores onSpawn (every pre-existing test double)
    // reports no child, so cancel must degrade to false rather than throw.
    const adapter = new Adapter({ runExec: async () => ({ code: 0, stdout: "clean reply", stderr: "" }) });
    const s = await adapter.spawn({ model: "m", compositionDir: "/tmp" });
    expect(await adapter.cancel(s)).toBe(false);
    expect(s.cancelRequested ?? false).toBe(false);

    await adapter.sendTurn(s, "hi");
    expect(await adapter.cancel(s)).toBe(false);
    const r = await adapter.awaitResponse(s);
    expect(r.text).toBe("clean reply");
    expect(r.stoppedReason ?? null).toBeNull();
  });

  it("a cancelled turn does not leak its stop reason into the next turn", async () => {
    const first = fakeExec();
    const adapter = new Adapter({ runExec: first.runExec });
    const s = await adapter.spawn({ model: "m", compositionDir: "/tmp" });
    await adapter.sendTurn(s, "one");
    first.state.emit("partial");
    await adapter.cancel(s);
    expect(await adapter.awaitResponse(s)).toMatchObject({ stoppedReason: "cancelled" });

    await adapter.sendTurn(s, "two");
    expect(s.cancelRequested).toBe(false);
    first.state.emit("a full reply");
    first.state.close(0);
    const r = await adapter.awaitResponse(s);
    expect(r).toMatchObject({ text: "a full reply" });
    expect(r.stoppedReason ?? null).toBeNull();
  });

  it("teardown still kills nothing but releases the stored handle", async () => {
    const { runExec, state } = fakeExec();
    const adapter = new Adapter({ runExec });
    const s = await adapter.spawn({ model: "m", compositionDir: "/tmp" });
    await adapter.sendTurn(s, "a long job");
    await adapter.teardown(s);
    expect(state.signals).toEqual([]); // back-compat: teardown is not a kill primitive
    expect(s.alive).toBe(false);
    expect(s.proc).toBeNull();
  });
});

describe("gemini adapter cancel: artifacts", () => {
  it("scrapes artifacts out of the partial output of a cancelled turn", async () => {
    const { runExec, state } = fakeExec();
    const adapter = new GeminiAdapter({ runExec });
    const s = await adapter.spawn({ model: "gemini-2.5-pro", compositionDir: "/tmp" });
    await adapter.sendTurn(s, "draw two logos");
    state.emit("wrote /workspace/out/logo.png then kept going");
    await adapter.cancel(s);
    const r = await adapter.awaitResponse(s);
    expect(r.artifacts).toEqual(["/workspace/out/logo.png"]);
    expect(r.stoppedReason).toBe("cancelled");
  });
});

// A hand-rolled stand-in for the SDK's Query object: an async iterator whose
// return() is observable (the real one aborts the query). A plain generator would
// also have return(), but not a countable one.
function fakeSdkQuery(messages: any[], opts: { cancellable?: boolean } = {}) {
  const state = { returnCalls: 0, aborted: false, delivered: [] as any[] };
  let i = 0;
  const query: any = {
    state,
    [Symbol.asyncIterator]() {
      return query;
    },
    async next() {
      if (state.aborted || i >= messages.length) return { value: undefined, done: true };
      const value = messages[i++];
      state.delivered.push(value);
      return { value, done: false };
    }
  };
  // A client with NO return() proves the flag-only fallback still stops the loop.
  if (opts.cancellable !== false) {
    query.return = async () => {
      state.returnCalls += 1;
      state.aborted = true;
      return { value: undefined, done: true };
    };
  }
  return query;
}

const SDK_SPAWN = { provider: "anthropic", model: "sonnet", compositionDir: "/tmp" };

function textMsg(text: string) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

describe("agent-sdk adapter cancel (run-context §9)", () => {
  it("stashes the query on the session and aborts it via return()", async () => {
    const query = fakeSdkQuery([
      { type: "system", session_id: "sdk-1" },
      textMsg("partial "),
      textMsg("MUST NOT APPEAR"),
      { type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } }
    ]);
    const adapter = new AgentSdkAdapter({ createClient: async () => query });
    const s = await adapter.spawn(SDK_SPAWN);
    // Cancel from inside the stream (what a user's Stop does mid-turn). The onText
    // hook fires while the loop is suspended on the iterator, so this is the real
    // mid-turn ordering.
    await adapter.sendTurn(s, "a long job", {
      onText: (accumulated: string) => {
        if (accumulated === "partial ") void adapter.cancel(s);
      }
    });
    const r = await adapter.awaitResponse(s);
    expect(query.state.returnCalls).toBe(1);
    expect(r).toMatchObject({ text: "partial ", stoppedReason: "cancelled" });
    expect(r.text).not.toContain("MUST NOT APPEAR");
    // The handle is released, so a late Stop cannot abort a finished query.
    expect(s.client).toBeNull();
    expect(await adapter.cancel(s)).toBe(false);
    expect(query.state.returnCalls).toBe(1);
  });

  it("breaks the consume loop on the flag alone when the query cannot be returned", async () => {
    const query = fakeSdkQuery(
      [textMsg("first "), textMsg("MUST NOT APPEAR"), { type: "result", subtype: "success", usage: {} }],
      { cancellable: false }
    );
    const adapter = new AgentSdkAdapter({ createClient: async () => query });
    const s = await adapter.spawn(SDK_SPAWN);
    await adapter.sendTurn(s, "a long job", {
      onText: () => {
        void adapter.cancel(s);
      }
    });
    const r = await adapter.awaitResponse(s);
    expect(r).toMatchObject({ text: "first ", stoppedReason: "cancelled" });
    // The flag is observed at the next MESSAGE BOUNDARY: message 2 is pulled off the
    // iterator but never folded into the reply, and the result message is never
    // pulled at all. This is exactly the latency the decision calls out as the reason
    // a flag alone is not a cancel primitive.
    expect(query.state.delivered).toHaveLength(2);
  });

  it("settles with the partial reply when the aborted iterator throws", async () => {
    const state = { returnCalls: 0 };
    const query: any = {
      [Symbol.asyncIterator]() {
        return query;
      },
      calls: 0,
      async next() {
        query.calls += 1;
        if (query.calls === 1) return { value: textMsg("partial "), done: false };
        // The real SDK rejects the in-flight step when the query is aborted.
        throw new Error("AbortError: query aborted");
      },
      async return() {
        state.returnCalls += 1;
        return { value: undefined, done: true };
      }
    };
    const adapter = new AgentSdkAdapter({ createClient: async () => query });
    const s = await adapter.spawn(SDK_SPAWN);
    await adapter.sendTurn(s, "a long job", {
      onText: () => {
        void adapter.cancel(s);
      }
    });
    await expect(adapter.awaitResponse(s)).resolves.toMatchObject({
      text: "partial ",
      stoppedReason: "cancelled"
    });
    expect(state.returnCalls).toBe(1);
  });

  it("an uncancelled iterator failure still rejects", async () => {
    const adapter = new AgentSdkAdapter({
      createClient: async () =>
        (async function* () {
          yield textMsg("some text");
          throw new Error("upstream 500");
        })()
    });
    const s = await adapter.spawn(SDK_SPAWN);
    await adapter.sendTurn(s, "hi");
    await expect(adapter.awaitResponse(s)).rejects.toThrow("upstream 500");
  });

  it("cancel with no in-flight query records the intent and reports nothing to abort", async () => {
    const adapter = new AgentSdkAdapter({ createClient: async () => fakeSdkQuery([]) });
    const s = await adapter.spawn(SDK_SPAWN);
    expect(await adapter.cancel(s)).toBe(false);
    expect(s.cancelRequested).toBe(true);
    // ...and the next sendTurn clears it, so the flag cannot poison a fresh turn.
    await adapter.sendTurn(s, "hi");
    expect(s.cancelRequested).toBe(false);
  });

  it("streams onText (accumulated) and onTool per block without changing the returned reply", async () => {
    const seenText: string[] = [];
    const seenTools: any[] = [];
    const adapter = new AgentSdkAdapter({
      createClient: async () =>
        (async function* () {
          yield { type: "system", session_id: "sdk-stream" };
          yield textMsg("Reading ");
          yield {
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "t1", name: "Edit" }] }
          };
          yield textMsg("done.");
          yield { type: "result", subtype: "success", usage: { input_tokens: 2, output_tokens: 3 } };
        })()
    });
    const s = await adapter.spawn(SDK_SPAWN);
    await adapter.sendTurn(s, "edit the file", {
      onText: (t: string) => seenText.push(t),
      onTool: (t: any) => seenTools.push(t)
    });
    const r = await adapter.awaitResponse(s);
    // onText carries the reply accumulated SO FAR (a channel repaints one bubble).
    expect(seenText).toEqual(["Reading ", "Reading done."]);
    expect(seenTools).toEqual([{ name: "Edit", id: "t1" }]);
    // accumulate-and-return is unchanged for callers that pass no callbacks.
    expect(r).toMatchObject({ text: "Reading done.", toolUses: [{ name: "Edit", id: "t1" }] });
    expect(r.stoppedReason ?? null).toBeNull();
  });

  it("a throwing stream consumer cannot kill the turn", async () => {
    const adapter = new AgentSdkAdapter({
      createClient: async () =>
        (async function* () {
          yield textMsg("still fine");
          yield { type: "result", subtype: "success", usage: {} };
        })()
    });
    const s = await adapter.spawn(SDK_SPAWN);
    await adapter.sendTurn(s, "hi", {
      onText: () => {
        throw new Error("consumer blew up");
      },
      onTool: () => {
        throw new Error("consumer blew up");
      }
    });
    await expect(adapter.awaitResponse(s)).resolves.toMatchObject({ text: "still fine" });
  });
});

// A frozen-mirror handle: xterm rows plus the optional `isAlive` predicate the real
// pty handle exposes (pty.mjs). Disposing the pty leaves `term` intact, so the
// snapshot stops changing while the poller keeps reading it.
function fakeHandle(getRows: () => string[], isAlive?: () => boolean) {
  const handle: any = {
    term: {
      buffer: {
        active: {
          get length() {
            return getRows().length;
          },
          getLine(i: number) {
            const text = getRows()[i] ?? "";
            return { translateToString: () => text };
          }
        }
      }
    }
  };
  if (isAlive) handle.isAlive = isAlive;
  return handle;
}

describe("waitForTurnComplete liveness (run-context §9)", () => {
  it("resolves immediately with the partial screen when the handle dies mid-turn", async () => {
    const { waitForTurnComplete } = await import(PKG);
    vi.useFakeTimers();
    try {
      let rows = ["⏺ Inspecting…", "✻ Cooking… (esc to interrupt · 1s)", "❯ "];
      let alive = true;
      const handle = fakeHandle(
        () => rows,
        () => alive
      );
      const result = waitForTurnComplete(handle, {
        startTs: Date.now(),
        // The real one-shot timeout. Before the liveness check a cancelled turn held
        // the HTTP request open for this whole window.
        timeoutMs: 300_000,
        settleMs: 1_400,
        requireWork: true
      });
      await vi.advanceTimersByTimeAsync(400);
      // The lane disposed the disposable session out from under the poller: the
      // mirror is frozen mid-turn (still busy, so nothing else would ever settle).
      alive = false;
      await vi.advanceTimersByTimeAsync(400);
      await expect(result).resolves.toMatchObject({
        signal: "dead",
        sawWork: true,
        reason: "handle-not-alive"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the happy path alone for a live handle, and for a handle with no liveness predicate", async () => {
    const { waitForTurnComplete } = await import(PKG);
    for (const withPredicate of [true, false]) {
      vi.useFakeTimers();
      try {
        let rows = ["⏺ Inspecting…", "✻ Cooking… (esc to interrupt · 1s)", "❯ "];
        const handle = fakeHandle(
          () => rows,
          withPredicate ? () => true : undefined
        );
        const result = waitForTurnComplete(handle, {
          startTs: Date.now(),
          timeoutMs: 10_000,
          settleMs: 700,
          requireWork: true
        });
        await vi.advanceTimersByTimeAsync(400);
        rows = ["❯ verify the page", "⏺ The page is correct.", "✻ Baked for 3s", "❯ "];
        await vi.advanceTimersByTimeAsync(1_500);
        await expect(result).resolves.toMatchObject({ signal: "done", sawWork: true });
      } finally {
        vi.useRealTimers();
      }
    }
  });
});
