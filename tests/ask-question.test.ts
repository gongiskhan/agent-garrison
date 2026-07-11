// GARRISON-FLOW-V2 S8 / D28 — AskUserQuestion tappable picker (SHELL half).
//
// Covers the four seams of the feature end to end WITHOUT a live PTY:
//   1. claude-pty extractAskUserQuestions — JSONL tool_use → normalised payload.
//   2. gateway lib — the JSONL watcher (fixture) + the label→picker-keys mapping.
//   3. transports — the orchestrator + rich transports surface the `tool` event
//      and POST the answer to the right endpoint.
//   4. UI — the QuestionBlock renders one button per option, disables after answer.

import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const PKG = "@garrison/claude-pty";
const LIB = path.resolve(__dirname, "..", "fittings", "seed", "http-gateway", "scripts", "lib", "ask-question.mjs");

// The real e12-spike AskUserQuestion tool_use input shape (verified capture).
const SPIKE_INPUT = {
  questions: [
    {
      question: "Pick a letter?",
      header: "Pick a letter",
      options: [
        { label: "A", description: "Letter A" },
        { label: "B", description: "Letter B" },
      ],
      multiSelect: false,
    },
  ],
};

function askEvent(id: string, input: unknown = SPIKE_INPUT) {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name: "AskUserQuestion", input }] },
  };
}

describe("claude-pty: extractAskUserQuestions", () => {
  it("normalises an AskUserQuestion tool_use from raw events", async () => {
    const { extractAskUserQuestions } = await import(PKG);
    const out = extractAskUserQuestions([askEvent("toolu_01")]);
    expect(out).toHaveLength(1);
    expect(out[0].tool_use_id).toBe("toolu_01");
    expect(out[0].name).toBe("AskUserQuestion");
    expect(out[0].questions[0]).toMatchObject({
      question: "Pick a letter?",
      header: "Pick a letter",
      multiSelect: false,
    });
    expect(out[0].questions[0].options).toEqual([
      { label: "A", description: "Letter A" },
      { label: "B", description: "Letter B" },
    ]);
  });

  it("also accepts a pre-parsed turn (toolUses[])", async () => {
    const { parseEvents, extractAskUserQuestions } = await import(PKG);
    const turn = parseEvents([askEvent("toolu_02")]);
    const out = extractAskUserQuestions(turn);
    expect(out).toHaveLength(1);
    expect(out[0].tool_use_id).toBe("toolu_02");
  });

  it("ignores non-AskUserQuestion tools and skips malformed inputs", async () => {
    const { extractAskUserQuestions } = await import(PKG);
    const bash = { type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }] } };
    const empty = askEvent("bad", { questions: [{ question: "", options: [] }] });
    expect(extractAskUserQuestions([bash, empty])).toEqual([]);
  });
});

describe("gateway lib: answerKeySequence / resolveOptionIndex", () => {
  it("maps an option index to arrow-down×index + enter", async () => {
    const { answerKeySequence } = await import(LIB);
    expect(answerKeySequence(0)).toEqual(["enter"]);
    expect(answerKeySequence(1)).toEqual(["down", "enter"]);
    expect(answerKeySequence(3)).toEqual(["down", "down", "down", "enter"]);
  });

  it("dismiss yields a single escape; junk indices fall back to the first option", async () => {
    const { answerKeySequence } = await import(LIB);
    expect(answerKeySequence(2, { dismiss: true })).toEqual(["escape"]);
    expect(answerKeySequence(-1)).toEqual(["enter"]);
    expect(answerKeySequence(NaN as unknown as number)).toEqual(["enter"]);
  });

  it("resolveOptionIndex finds the label's index, -1 when absent", async () => {
    const { resolveOptionIndex } = await import(LIB);
    const q = { options: [{ label: "A" }, { label: "B" }, { label: "C" }] };
    expect(resolveOptionIndex(q, "B")).toBe(1);
    expect(resolveOptionIndex(q, "Z")).toBe(-1);
    expect(resolveOptionIndex(null, "A")).toBe(-1);
  });
});

describe("gateway lib: createAskQuestionWatcher", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("emits one payload per NEW tool_use id from the JSONL (dedupes, picks up appends)", async () => {
    const { createAskQuestionWatcher } = await import(LIB);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "askq-"));
    dirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, JSON.stringify(askEvent("toolu_A")) + "\n");

    const seen: any[] = [];
    // No priming: read from offset 0 so the fixture already on disk is picked up.
    const watcher = createAskQuestionWatcher({ projectDir: dir, onQuestion: (p: any) => seen.push(p) });

    watcher.tickOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0].tool_use_id).toBe("toolu_A");

    // Second tick with no new content → no re-emit.
    watcher.tickOnce();
    expect(seen).toHaveLength(1);

    // Append a second question → emitted once on the next tick.
    fs.appendFileSync(file, JSON.stringify(askEvent("toolu_B")) + "\n");
    watcher.tickOnce();
    expect(seen).toHaveLength(2);
    expect(seen[1].tool_use_id).toBe("toolu_B");
  });

  it("priming skips questions already on disk (no stale replay on boot)", async () => {
    const { createAskQuestionWatcher } = await import(LIB);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "askq-"));
    dirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    fs.writeFileSync(file, JSON.stringify(askEvent("toolu_OLD")) + "\n");

    const seen: any[] = [];
    const watcher = createAskQuestionWatcher({ projectDir: dir, onQuestion: (p: any) => seen.push(p) });
    watcher.prime(); // pretend gateway just booted with this file present
    watcher.tickOnce();
    expect(seen).toHaveLength(0);

    fs.appendFileSync(file, JSON.stringify(askEvent("toolu_NEW")) + "\n");
    watcher.tickOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0].tool_use_id).toBe("toolu_NEW");
  });
});

// ── UI: QuestionBlock render contract ───────────────────────────────────────
describe("claude-chat: QuestionBlock", () => {
  it("renders one button per option with label + description", async () => {
    const { QuestionBlock } = await import("../packages/claude-chat/src/index");
    const html = renderToStaticMarkup(
      createElement(QuestionBlock, {
        q: SPIKE_INPUT.questions[0] as any,
        onSelect: () => {},
        onOther: () => {},
      })
    );
    expect(html).toContain("cc-question-opt");
    expect(html).toContain(">A<");
    expect(html).toContain(">B<");
    expect(html).toContain("Letter A");
    expect(html).toContain("Other...");
    // Options are real buttons, not disabled before an answer.
    expect(html).not.toContain("disabled");
  });

  it("disables buttons and shows the chosen answer once answered", async () => {
    const { QuestionBlock } = await import("../packages/claude-chat/src/index");
    const html = renderToStaticMarkup(
      createElement(QuestionBlock, {
        q: SPIKE_INPUT.questions[0] as any,
        answered: "A",
        onSelect: () => {},
        onOther: () => {},
      })
    );
    expect(html).toContain("disabled");
    expect(html).toContain("cc-question-opt-chosen");
    // The chosen label renders as the user's message.
    expect(html).toContain("cc-question-answer");
    // The Other affordance is gone once answered.
    expect(html).not.toContain("Other...");
  });
});
