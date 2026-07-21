import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
// @ts-ignore — pure .mjs package
import { parseTurn, parseEvents, contextTokensFrom, compactionsFrom, OperativePtySession, delegate } from "../packages/claude-pty/src/index.mjs";
// @ts-ignore — pure .mjs
import { contextFromDone } from "../fittings/seed/kanban-loop/lib/gateway-client.mjs";

// D5b / S1a — context telemetry substrate: usage parsing, context-tokens + compaction
// helpers, session-lifetime peak tracking, delegate usedTokens preservation, and the
// kanban gateway-client context pass-through.

const USAGE_A = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 40 };
const USAGE_B = { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500, output_tokens: 80 };
const COMPACT = {
  type: "system",
  subtype: "compact_boundary",
  timestamp: "2026-07-14T10:00:00.000Z",
  compactMetadata: { trigger: "auto", preTokens: 999682, postTokens: 18375, durationMs: 142897 },
};

function rawEvents() {
  return [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "assistant", message: { model: "claude-opus-4-8", usage: USAGE_A, content: [{ type: "text", text: "one" }] } },
    { type: "assistant", message: { model: "claude-opus-4-8", usage: USAGE_B, content: [{ type: "text", text: "two" }] } },
    COMPACT,
  ];
}

describe("context telemetry — usage parsing (jsonl)", () => {
  it("parseTurn keeps per-assistant-event usage (file order) and the compaction record", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-usage-"));
    const f = path.join(dir, "s.jsonl");
    fs.writeFileSync(f, rawEvents().map((e) => JSON.stringify(e)).join("\n") + "\n");
    const turn = parseTurn(f, 0);
    // Both assistant events' usage survive, normalised to the four counters.
    expect(turn.assistantUsages).toHaveLength(2);
    expect(turn.assistantUsages[0]).toEqual(USAGE_A);
    expect(turn.assistantUsages[1]).toEqual(USAGE_B);
    // The compact_boundary line lands as a system event carrying its metadata + timestamp.
    const boundary = turn.systemEvents.find((s: any) => s.subtype === "compact_boundary");
    expect(boundary).toBeTruthy();
    expect(boundary.compactMetadata).toMatchObject({ trigger: "auto", preTokens: 999682, postTokens: 18375, durationMs: 142897 });
    expect(boundary.timestamp).toBe("2026-07-14T10:00:00.000Z");
  });

  it("an assistant event with a partial usage block defaults missing counters to 0", () => {
    const turn = parseEvents([
      { type: "assistant", message: { usage: { input_tokens: 50 }, content: [{ type: "text", text: "x" }] } },
    ]);
    expect(turn.assistantUsages[0]).toEqual({ input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
  });

  it("an assistant event with no usage contributes nothing", () => {
    const turn = parseEvents([
      { type: "assistant", message: { content: [{ type: "text", text: "x" }] } },
    ]);
    expect(turn.assistantUsages).toEqual([]);
  });
});

describe("context telemetry — contextTokensFrom / compactionsFrom", () => {
  it("contextTokensFrom sums the LAST assistant usage (input + cache-creation + cache-read, no output)", () => {
    // From raw events and from a parsed turn — both paths agree. 200 + 0 + 1500 = 1700.
    expect(contextTokensFrom(rawEvents())).toBe(1700);
    expect(contextTokensFrom(parseEvents(rawEvents()))).toBe(1700);
  });

  it("contextTokensFrom is null when no usage is known", () => {
    expect(contextTokensFrom([])).toBeNull();
    expect(contextTokensFrom([{ type: "assistant", message: { content: [] } }])).toBeNull();
    expect(contextTokensFrom(parseEvents([{ type: "user", message: { content: "hi" } }]))).toBeNull();
  });

  it("compactionsFrom returns the ordered compaction records from raw events and a parsed turn", () => {
    const expected = [{ trigger: "auto", preTokens: 999682, postTokens: 18375, durationMs: 142897, at: "2026-07-14T10:00:00.000Z" }];
    expect(compactionsFrom(rawEvents())).toEqual(expected);
    expect(compactionsFrom(parseEvents(rawEvents()))).toEqual(expected);
  });

  it("compactionsFrom is empty when no compaction happened", () => {
    expect(compactionsFrom([])).toEqual([]);
    expect(compactionsFrom(parseEvents([{ type: "assistant", message: { usage: USAGE_A, content: [] } }]))).toEqual([]);
  });
});

// A mutable fake xterm-like handle: parseStatus reads the status row off the screen,
// so mutating `rows` between status() calls simulates a live context % changing.
function mutableHandle(initial: string[]) {
  let rows = initial.slice();
  return {
    setLines(lines: string[]) {
      rows = lines.slice();
    },
    term: {
      buffer: {
        active: {
          get length() {
            return rows.length;
          },
          cursorY: 0,
          cursorX: 0,
          getLine(i: number) {
            const text = rows[i] ?? "";
            return { translateToString: () => text };
          },
        },
      },
    },
  };
}

const screenFor = (pct: number) => ["❯ ", `  myproj | ${pct}% | Sonnet 4.6@high`, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"];

describe("context telemetry — session peakContextPct tracking", () => {
  it("status() folds each sampled contextPct into a session-lifetime peak that never regresses", () => {
    const handle = mutableHandle(screenFor(40));
    const session = new OperativePtySession({ handle, compositionDir: os.tmpdir(), claudeSessionId: "sess-1" });
    // Null before the first sample.
    expect(session.getPeakContextPct()).toBeNull();

    let s = session.status();
    expect(s.contextPct).toBe(40);
    expect(s.peakContextPct).toBe(40);

    handle.setLines(screenFor(72));
    s = session.status();
    expect(s.contextPct).toBe(72);
    expect(s.peakContextPct).toBe(72);

    // Context drops after a compaction — the LIVE % follows it, the peak holds.
    handle.setLines(screenFor(30));
    s = session.status();
    expect(s.contextPct).toBe(30);
    expect(s.peakContextPct).toBe(72);
    expect(session.getPeakContextPct()).toBe(72);
  });

  it("notePeakContextPct ignores non-numeric samples and raises the peak on a higher one", () => {
    const session = new OperativePtySession({ handle: mutableHandle(screenFor(50)), compositionDir: os.tmpdir(), claudeSessionId: "sess-2" });
    session.notePeakContextPct(50);
    session.notePeakContextPct(null as any); // missing statusline → null sample
    session.notePeakContextPct("x" as any);
    session.notePeakContextPct(NaN);
    expect(session.getPeakContextPct()).toBe(50);
    session.notePeakContextPct(88);
    expect(session.getPeakContextPct()).toBe(88);
  });
});

describe("context telemetry — kanban gateway-client contextFromDone", () => {
  it("folds a done frame's context object; null when nothing context-related flowed", () => {
    expect(contextFromDone({ reply: "x" })).toBeNull();
    expect(contextFromDone(null)).toBeNull();
    expect(contextFromDone({ context: {} })).toBeNull();
    expect(contextFromDone({ context: { contextPct: null, peakContextPct: null, compactions: { count: 0, last: null } } })).toBeNull();
  });

  it("surfaces contextPct + peakContextPct + compactions when present", () => {
    const c = contextFromDone({
      reply: "x",
      context: { contextPct: 42, peakContextPct: 71, compactions: { count: 2, last: { preTokens: 1000, postTokens: 30, trigger: "auto" } } },
    });
    expect(c).toEqual({ contextPct: 42, peakContextPct: 71, compactions: { count: 2, last: { preTokens: 1000, postTokens: 30, trigger: "auto" } } });
  });

  it("surfaces a compactions-only signal (count > 0) even with no live percentages", () => {
    const c = contextFromDone({ context: { compactions: { count: 1, last: null } } });
    expect(c).toEqual({ contextPct: null, peakContextPct: null, compactions: { count: 1, last: null } });
  });
});

// A stub secondary adapter that reports cumulative usedTokens in its response
// envelope — mirrors what agent-sdk / openai-agents adapters now return.
function stubAdapterWithTokens(usedTokens: number | undefined) {
  return {
    id: "codex",
    _q: new WeakMap<object, string>(),
    async spawn(c: any) {
      return { alive: true, cwd: c?.compositionDir };
    },
    async awaitReady() {},
    async sendTurn(s: any, text: string) {
      (this as any)._q.set(s, `handled: ${text.split("\n")[0]}`);
    },
    async awaitResponse(s: any) {
      const text = (this as any)._q.get(s);
      return usedTokens === undefined ? { text, artifacts: [] } : { text, artifacts: [], usedTokens };
    },
    async teardown() {},
  };
}

function bridgeDeps(adapter: any) {
  return {
    adapter,
    spawnConfig: { compositionDir: "/tmp/x", model: "gpt-5-codex" },
    writeArtifact: async (ns: string, name: string) => `artifacts/${ns}/${name}`,
    logDecision: async () => {},
    now: () => "2026-07-14T00:00:00Z",
  };
}

describe("context telemetry — delegate usedTokens preservation (runtime-bridge)", () => {
  it("preserves usedTokens in the delegate result when the adapter reports it", async () => {
    const result = await delegate({ task: "refactor utils" }, bridgeDeps(stubAdapterWithTokens(4210)));
    expect(result.usedTokens).toBe(4210);
    expect(result.summary).toContain("handled");
    expect(Array.isArray(result.artifacts)).toBe(true);
  });

  it("omits usedTokens when the adapter does not report it (no fabricated field)", async () => {
    const result = await delegate({ task: "refactor utils" }, bridgeDeps(stubAdapterWithTokens(undefined)));
    expect(result).not.toHaveProperty("usedTokens");
  });
});
