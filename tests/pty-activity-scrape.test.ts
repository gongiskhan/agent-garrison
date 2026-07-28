import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error - plain .mjs sibling package, no types
import { parseActivity } from "../packages/claude-pty/src/screen.mjs";

// The interactive claude lane has NO structured event stream: thinking and tool
// use are DRAWN on the terminal, not emitted as data. So a channel watching that
// lane shows nothing at all between "sent" and the final reply — the silence the
// web channel's working indicator exists to fill. parseActivity reads the two
// things the screen does say (the newest tool invocation, and the spinner's own
// verb for the current phase) so the lane gets a liveness hint anyway.
//
// A fake handle is enough: parseActivity only touches handle.term.buffer.active.
function screen(lines: string[]) {
  return {
    term: {
      buffer: {
        active: {
          length: lines.length,
          getLine: (i: number) => ({ translateToString: () => lines[i] })
        }
      }
    }
  };
}

describe("parseActivity (PTY-lane liveness fallback)", () => {
  it("prefers the newest tool invocation over the spinner verb", () => {
    // A tool name says what is HAPPENING; "Infusing…" is whimsy. When the screen
    // carries both, the tool wins.
    expect(
      parseActivity(
        screen([
          "❯ fix the bug",
          "⏺ I'll look at the config first.",
          "⏺ Read(src/lib/runner.ts)",
          "  ⎿  read 240 lines",
          "✻ Infusing… (12s · ↑ 1.4k tokens · esc to interrupt)",
          "❯ "
        ])
      )
    ).toEqual({ kind: "tool", text: "Read(src/lib/runner.ts)" });
  });

  it("takes the LAST tool line, not the first", () => {
    // The TUI appends downward and every prior tool line stays on screen for the
    // rest of the turn, so a top-down scan would pin the hint to the first tool
    // the turn ever ran.
    expect(
      parseActivity(
        screen(["⏺ Read(a.ts)", "⏺ Bash(npm test)", "✻ Working… (2s · esc to interrupt)"])
      )
    ).toEqual({ kind: "tool", text: "Bash(npm test)" });
  });

  it("falls back to the spinner verb before any tool has run", () => {
    expect(parseActivity(screen(["❯ think hard", "✻ Pondering… (6s · esc to interrupt)", "❯ "]))).toEqual(
      { kind: "thinking", text: "Pondering" }
    );
  });

  it("never reads assistant PROSE as a tool call", () => {
    // Assistant blocks and tool actions share the "⏺" marker, so the tool pattern
    // requires a Capitalised identifier followed immediately by "(" - otherwise
    // every reply opening would be reported as a tool named after its first word.
    expect(
      parseActivity(
        screen(["⏺ Looking at the configuration now.", "✻ Cogitating… (3s · esc to interrupt)"])
      )
    ).toEqual({ kind: "thinking", text: "Cogitating" });
  });

  it("returns null on an idle screen so no hint is invented", () => {
    expect(parseActivity(screen(["❯ ", "garrison | 14% | Sonnet 4.6@high"]))).toBeNull();
  });

  it("survives a torn-down handle instead of throwing into the turn", () => {
    // onScreen fires on every repaint, including ones racing session disposal. A
    // throw here would propagate into the turn that is otherwise fine.
    const dead = { term: { buffer: { get active(): never { throw new Error("disposed"); } } } };
    expect(parseActivity(dead)).toBeNull();
  });
});

// ── The emitter that carries a scraped activity onto the wire ────────────────
// Exported from gateway-pty under its documented GARRISON_GATEWAY_NO_LISTEN
// seam (no HTTP listener, no claude spawn). Throttle, dedupe and the per-kind
// wire shape all regress silently, so they are pinned here rather than left to
// a live turn to reveal.
describe("screenActivityEmitter", () => {
  let screenActivityEmitter: (
    handle: unknown,
    onActivity: (p: unknown) => void,
    nowFn?: () => number
  ) => () => void;

  beforeAll(async () => {
    process.env.GARRISON_GATEWAY_NO_LISTEN = "1";
    const mod = await import(
      pathToFileURL(
        path.join(process.cwd(), "fittings/seed/http-gateway/scripts/gateway-pty.mjs")
      ).href
    );
    screenActivityEmitter = mod.screenActivityEmitter;
  });

  // A live handle whose visible frame the test can swap between ticks.
  function liveHandle(getFrame: () => string[]) {
    return {
      term: {
        buffer: {
          get active() {
            const lines = getFrame();
            return {
              length: lines.length,
              getLine: (i: number) => ({ translateToString: () => lines[i] })
            };
          }
        }
      }
    };
  }

  it("throttles, dedupes, and emits the per-kind wire shape", () => {
    const sent: unknown[] = [];
    let clock = 0;
    let frame = ["✻ Pondering… (1s · esc to interrupt)"];
    const tick = screenActivityEmitter(
      liveHandle(() => frame),
      (p) => sent.push(p),
      () => clock
    );

    tick(); // first thinking beat
    clock += 100;
    tick(); // inside the 400ms throttle - dropped
    clock += 500;
    tick(); // past the throttle but SAME value - deduped
    clock += 500;
    frame = ["⏺ Read(a.ts)", "✻ Pondering… (3s · esc to interrupt)"];
    tick(); // a tool appears and outranks the spinner verb
    clock += 500;
    tick(); // same tool, still on screen - deduped
    clock += 500;
    frame = ["⏺ Read(a.ts)", "⏺ Bash(npm test)", "✻ Working… (5s · esc to interrupt)"];
    tick(); // a NEW tool is a new value

    expect(sent).toEqual([
      // thinking frames are keyed on `text`, tool frames on `name` - matching
      // what the SDK lanes emit, or the client drops them.
      { kind: "thinking", text: "Pondering" },
      { kind: "tool", name: "Read(a.ts)" },
      { kind: "tool", name: "Bash(npm test)" }
    ]);
  });

  it("is inert without a consumer or a handle", () => {
    expect(() => screenActivityEmitter(null, () => {})()).not.toThrow();
    expect(() =>
      screenActivityEmitter(liveHandle(() => ["✻ Thinking… (1s · esc to interrupt)"]), undefined as never)()
    ).not.toThrow();
  });

  it("swallows a throwing consumer instead of killing the turn", () => {
    let clock = 0;
    const tick = screenActivityEmitter(
      liveHandle(() => ["✻ Thinking… (1s · esc to interrupt)"]),
      () => {
        throw new Error("client gone");
      },
      () => clock
    );
    expect(() => tick()).not.toThrow();
  });
});
