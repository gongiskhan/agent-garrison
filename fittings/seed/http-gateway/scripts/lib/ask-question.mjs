// AskUserQuestion support for the gateway PTY engine (GARRISON-FLOW-V2 S8, D28).
//
// When the operative calls the AskUserQuestion tool, the interactive TUI shows a
// keyboard-driven picker. A phone/web channel has no arrow keys, so Garrison
// renders the options as tappable buttons and answers the picker for the user:
//
//   1. A background watcher tails the session JSONL, extracts AskUserQuestion
//      tool_use blocks as they land, and emits ONE `tool` event per tool_use id.
//   2. On the answer (a tapped option label), the gateway maps label -> option
//      INDEX and drives the picker via keySequence: arrow-down N times + Enter
//      (the TUI focuses the FIRST option, so index N is N downs from the top).
//      Escape dismisses.
//
// The label->keys mapping is a pure function so it is unit-tested without a live
// PTY; the watcher is thin glue over @garrison/claude-pty's JSONL helpers.

import { listJsonlFiles, readJsonlFrom, jsonlFileSize, extractAskUserQuestions } from "@garrison/claude-pty";

/**
 * Map a 0-based option index in a single-select picker to the key sequence that
 * selects it. The picker focuses the first option, so selecting index i is i
 * arrow-downs followed by Enter. `dismiss` yields a single Escape.
 * @param {number} optionIndex
 * @param {{dismiss?: boolean}} [opts]
 * @returns {string[]} ordered key names understood by claude-pty keySequence()
 */
export function answerKeySequence(optionIndex, opts = {}) {
  if (opts.dismiss) return ["escape"];
  const i = Number.isInteger(optionIndex) && optionIndex > 0 ? optionIndex : 0;
  const seq = [];
  for (let k = 0; k < i; k++) seq.push("down");
  seq.push("enter");
  return seq;
}

/**
 * Find the 0-based index of `label` among a question's options. -1 when absent.
 * @param {{options?: Array<{label?: string}>}} question
 * @param {string} label
 */
export function resolveOptionIndex(question, label) {
  const options = Array.isArray(question?.options) ? question.options : [];
  return options.findIndex((o) => (o?.label ?? "") === label);
}

/**
 * Tail the session JSONL directory for AskUserQuestion tool_use blocks and emit
 * one normalised payload per NEW tool_use id. Priming (default on `start`) sets
 * per-file offsets to the current sizes so questions already on disk from a prior
 * turn are not replayed on boot - only questions asked AFTER the watcher starts
 * surface to the channel.
 *
 * @param {{
 *   projectDir: string,
 *   onQuestion: (payload: {tool_use_id: string, name: string, questions: any[]}) => void,
 *   intervalMs?: number,
 *   logFn?: (e: object) => void,
 * }} opts
 */
export function createAskQuestionWatcher({ projectDir, onQuestion, intervalMs = 400, logFn } = {}) {
  const offsets = new Map(); // jsonl path -> byte offset already consumed
  const seen = new Set(); // tool_use_id already emitted (dedupe)
  let timer = null;

  const primeOffsets = () => {
    try {
      for (const file of listJsonlFiles(projectDir)) offsets.set(file, jsonlFileSize(file));
    } catch {
      /* projectDir not present yet - first real tick primes lazily at 0 */
    }
  };

  const tick = () => {
    let files;
    try {
      files = listJsonlFiles(projectDir);
    } catch {
      return;
    }
    for (const file of files) {
      const from = offsets.get(file) ?? 0;
      let events;
      let newOffset;
      try {
        ({ events, newOffset } = readJsonlFrom(file, from));
      } catch {
        continue;
      }
      offsets.set(file, newOffset);
      if (!events.length) continue;
      let questions;
      try {
        questions = extractAskUserQuestions(events);
      } catch {
        continue;
      }
      for (const q of questions) {
        // A tool_use with no id still gets a stable synthetic key so it is emitted
        // exactly once (the answer path then can't target it, but the button still
        // renders - better than dropping the question).
        const id = q.tool_use_id || `anon:${file}:${seen.size}`;
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          onQuestion?.({ ...q, tool_use_id: q.tool_use_id ?? id });
        } catch (err) {
          logFn?.({ kind: "ask-question-emit-failed", error: err?.message });
        }
      }
    }
  };

  return {
    start({ prime = true } = {}) {
      if (timer) return;
      if (prime) primeOffsets();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    prime: primeOffsets,
    /** Run one poll synchronously - exposed for tests. */
    tickOnce: tick,
  };
}
