// Per-turn JSONL parsing. Ported from
// ekoa-core/src/backends/claude-code-pty/jsonl.ts.
//
// Claude Code writes a JSONL transcript per session. A session's file grows
// across turns; to assess "what happened in THIS turn" the caller snapshots
// the file size before sending the user prompt and parses only events with
// byte offsets >= that snapshot (parseTurn's `fromOffset`).
//
// Garrison change vs the donor: readJsonlFrom advances `newOffset` only to
// the last COMPLETE line (last "\n"), never past a partial trailing line
// mid-write. The donor advanced to the full file size, which could skip a
// half-written final record once it completed.

import { openSync, fstatSync, readSync, closeSync, existsSync, statSync } from "node:fs";

/** Snapshot the current size in bytes of `path`, or 0 if missing. */
export function jsonlFileSize(path) {
  if (!existsSync(path)) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Read JSONL events from `filePath` starting at byte `offset`.
 * @returns {{events: Array<Record<string, unknown>>, newOffset: number}}
 */
export function readJsonlFrom(filePath, offset) {
  if (!existsSync(filePath)) return { events: [], newOffset: offset };
  // fd is closed in `finally` so a throw AFTER openSync (fstatSync / Buffer.alloc /
  // readSync on e.g. a directory or a racing truncation) never leaks it — the
  // 400ms AskUserQuestion watcher calls this on every tick, so a leak would
  // exhaust fds fast.
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    if (size <= offset) return { events: [], newOffset: offset };
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, size - offset, offset);
    const raw = buf.toString("utf8");
    // Only consume up to the last newline so a partial trailing record
    // (mid-write) is re-read next poll rather than dropped.
    const lastNl = raw.lastIndexOf("\n");
    const consumable = lastNl === -1 ? "" : raw.slice(0, lastNl + 1);
    const newOffset = offset + Buffer.byteLength(consumable, "utf8");
    const events = [];
    for (const line of consumable.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore malformed lines (mid-write, truncation, etc.)
      }
    }
    return { events, newOffset };
  } catch {
    return { events: [], newOffset: offset };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed / invalid fd — nothing to release
      }
    }
  }
}

const EMPTY_TURN = {
  userText: null,
  assistantTexts: [],
  thinkingTexts: [],
  toolUses: [],
  toolResults: [],
  systemEvents: [],
  turnDurationMs: null,
  stopHookSeen: false,
  model: null,
};

export function emptyTurn() {
  return { ...EMPTY_TURN, assistantTexts: [], thinkingTexts: [], toolUses: [], toolResults: [], systemEvents: [] };
}

/**
 * Parse all events in a JSONL file starting at `fromOffset` into a structured
 * turn record. The caller scopes the parse to one turn via `fromOffset`.
 */
export function parseTurn(jsonlPath, fromOffset) {
  if (jsonlPath === null || jsonlPath === undefined) return emptyTurn();
  const { events } = readJsonlFrom(jsonlPath, fromOffset);
  return parseEvents(events);
}

/** Parse an already-read array of JSONL events into a turn record. Shared by
 *  parseTurn and the streaming tail. */
export function parseEvents(events) {
  const userText = [];
  const assistantTexts = [];
  const thinkingTexts = [];
  const toolUses = [];
  const toolResults = [];
  const systemEvents = [];
  // Per-assistant-event token usage, in file order. The LAST entry is the best
  // estimate of tokens-in-context (see contextTokensFrom). Kept additively — the
  // donor and the pre-2026-07 parser dropped `usage` entirely.
  const assistantUsages = [];
  let turnDurationMs = null;
  let stopHookSeen = false;
  let model = null;

  for (const ev of events) {
    const evType = ev?.type;
    if (evType === "system") {
      const sub = ev.subtype;
      if (sub === "turn_duration") {
        turnDurationMs = typeof ev.durationMs === "number" ? ev.durationMs : null;
        systemEvents.push({ subtype: sub, durationMs: ev.durationMs });
      } else if (sub === "stop_hook_summary") {
        stopHookSeen = true;
        systemEvents.push({ subtype: sub });
      } else if (sub === "compact_boundary") {
        // A context compaction happened. Carry the whole compactMetadata block
        // (trigger / preTokens / postTokens / durationMs / …) plus the line's
        // timestamp so compactionsFrom can reconstruct the ordered history.
        systemEvents.push({
          subtype: sub,
          compactMetadata: ev.compactMetadata ?? null,
          timestamp: typeof ev.timestamp === "string" ? ev.timestamp : null,
        });
      } else if (sub) {
        systemEvents.push({ subtype: sub, ...localCommandFields(ev) });
      }
    } else if (evType === "user") {
      const c = ev.message?.content;
      if (typeof c === "string" && userText.length === 0) userText.push(c);
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part?.type === "tool_result") {
            const content =
              typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? "");
            toolResults.push({
              tool_use_id: String(part.tool_use_id ?? ""),
              content,
              is_error: Boolean(part.is_error),
            });
          }
        }
      }
    } else if (evType === "assistant") {
      const msg = ev.message;
      if (msg?.model && model === null) model = msg.model;
      const usage = normalizeUsage(msg?.usage);
      if (usage) assistantUsages.push(usage);
      if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
          if (part?.type === "text" && typeof part.text === "string") {
            assistantTexts.push(part.text);
          } else if (part?.type === "thinking" && typeof part.thinking === "string") {
            thinkingTexts.push(part.thinking);
          } else if (part?.type === "tool_use") {
            toolUses.push({
              name: String(part.name ?? ""),
              input: part.input ?? {},
              tool_use_id: typeof part.id === "string" ? part.id : undefined,
            });
          }
        }
      }
    }
  }

  return {
    userText: userText[0] ?? null,
    assistantTexts,
    thinkingTexts,
    toolUses,
    toolResults,
    systemEvents,
    assistantUsages,
    turnDurationMs,
    stopHookSeen,
    model,
  };
}

const USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];

/**
 * Normalise an assistant event's `usage` block to the four token counters, or
 * null when none are present. Once any counter exists the shape is complete
 * (missing fields default to 0), so callers can sum without null-guards.
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (!USAGE_FIELDS.some((k) => typeof usage[k] === "number")) return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: n(usage.input_tokens),
    cache_creation_input_tokens: n(usage.cache_creation_input_tokens),
    cache_read_input_tokens: n(usage.cache_read_input_tokens),
    output_tokens: n(usage.output_tokens),
  };
}

/** Per-assistant-event usage blocks (file order) collected from raw events. */
function assistantUsagesFrom(events) {
  const out = [];
  for (const ev of events) {
    if (ev?.type !== "assistant") continue;
    const u = normalizeUsage(ev.message?.usage);
    if (u) out.push(u);
  }
  return out;
}

/**
 * Estimate tokens-in-context from the LAST assistant event's usage: the sum of
 * input + cache-creation + cache-read (the statusline's numerator; output tokens
 * are excluded as they are not yet part of the input context). Accepts raw JSONL
 * events or an already-parsed turn record. Returns null when no usage is known.
 */
export function contextTokensFrom(eventsOrTurn) {
  const usages = Array.isArray(eventsOrTurn)
    ? assistantUsagesFrom(eventsOrTurn)
    : Array.isArray(eventsOrTurn?.assistantUsages)
      ? eventsOrTurn.assistantUsages
      : [];
  if (usages.length === 0) return null;
  const last = usages[usages.length - 1];
  if (!last) return null;
  return (last.input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0);
}

/**
 * Ordered list of compaction records from `compact_boundary` system events, each
 * { trigger, preTokens, postTokens, durationMs, at }. Accepts raw JSONL events or
 * a parsed turn record (whose systemEvents carry compactMetadata + timestamp).
 */
export function compactionsFrom(eventsOrTurn) {
  const boundaries = Array.isArray(eventsOrTurn)
    ? eventsOrTurn
        .filter((e) => e?.type === "system" && e?.subtype === "compact_boundary")
        .map((e) => ({ compactMetadata: e.compactMetadata ?? null, timestamp: typeof e.timestamp === "string" ? e.timestamp : null }))
    : Array.isArray(eventsOrTurn?.systemEvents)
      ? eventsOrTurn.systemEvents.filter((s) => s?.subtype === "compact_boundary")
      : [];
  const out = [];
  for (const b of boundaries) {
    const m = b.compactMetadata ?? {};
    out.push({
      trigger: typeof m.trigger === "string" ? m.trigger : null,
      preTokens: typeof m.preTokens === "number" ? m.preTokens : null,
      postTokens: typeof m.postTokens === "number" ? m.postTokens : null,
      durationMs: typeof m.durationMs === "number" ? m.durationMs : null,
      at: b.timestamp ?? null,
    });
  }
  return out;
}

/**
 * Extract AskUserQuestion tool_use payloads from either raw JSONL events or a
 * parsed turn. Returns one entry per AskUserQuestion tool_use, in file order:
 *   { tool_use_id, name: "AskUserQuestion", questions: [{ question, header,
 *     options: [{ label, description }], multiSelect }] }
 *
 * The option `label`s are load-bearing: the channel renders them as tappable
 * buttons and the answer path maps a tapped label back to its option INDEX to
 * drive the TUI picker (see fittings/seed/http-gateway/scripts/lib/ask-question.mjs).
 * Malformed / partial inputs are skipped defensively - a mid-write JSONL line
 * can carry a half-serialised object.
 */
export function extractAskUserQuestions(eventsOrTurn) {
  const toolUses = Array.isArray(eventsOrTurn)
    ? parseEvents(eventsOrTurn).toolUses
    : Array.isArray(eventsOrTurn?.toolUses)
      ? eventsOrTurn.toolUses
      : [];
  const out = [];
  for (const tu of toolUses) {
    if (tu?.name !== "AskUserQuestion") continue;
    const rawQuestions = Array.isArray(tu.input?.questions) ? tu.input.questions : [];
    const questions = rawQuestions.map(normalizeQuestion).filter(Boolean);
    if (questions.length === 0) continue;
    out.push({
      tool_use_id: typeof tu.tool_use_id === "string" ? tu.tool_use_id : null,
      name: "AskUserQuestion",
      questions,
    });
  }
  return out;
}

function normalizeQuestion(q) {
  if (!q || typeof q !== "object") return null;
  const question = typeof q.question === "string" ? q.question : "";
  const header = typeof q.header === "string" ? q.header : "";
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((o) =>
      o && typeof o === "object"
        ? {
            label: typeof o.label === "string" ? o.label : String(o.label ?? ""),
            description: typeof o.description === "string" ? o.description : "",
          }
        : { label: String(o ?? ""), description: "" }
    )
    .filter((o) => o.label.length > 0);
  if (!question && options.length === 0) return null;
  return { question, header, options, multiSelect: q.multiSelect === true };
}

function localCommandFields(ev) {
  // Surface local-command-stdout payloads so command-only turns (Signal-C)
  // can produce a reply. Claude Code records slash-command output in a few
  // shapes across versions; capture whichever is present.
  const out = {};
  if (typeof ev.content === "string") out.content = ev.content;
  if (typeof ev.stdout === "string") out.stdout = ev.stdout;
  if (typeof ev.output === "string") out.output = ev.output;
  return out;
}

const LOCAL_COMMAND_MARKERS = [
  /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g,
  /<command-stdout>([\s\S]*?)<\/command-stdout>/g,
];

/**
 * Extract slash-command output from a parsed turn (or raw events). Returns
 * the joined stdout text, or "" if none. Used to build a reply for command-
 * only turns that emit no assistant text.
 */
export function extractLocalCommandOutput(turnOrEvents) {
  const texts = [];
  const collect = (s) => {
    if (typeof s !== "string" || !s.trim()) return;
    let matched = false;
    for (const re of LOCAL_COMMAND_MARKERS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s)) !== null) {
        if (m[1] && m[1].trim()) texts.push(m[1].trim());
        matched = true;
      }
    }
    if (!matched) texts.push(s.trim());
  };

  if (Array.isArray(turnOrEvents)) {
    for (const ev of turnOrEvents) {
      if (ev?.type === "user" && typeof ev.message?.content === "string") collect(ev.message.content);
      if (typeof ev?.content === "string") collect(ev.content);
      if (typeof ev?.stdout === "string") collect(ev.stdout);
      if (typeof ev?.output === "string") collect(ev.output);
    }
  } else if (turnOrEvents && Array.isArray(turnOrEvents.systemEvents)) {
    for (const se of turnOrEvents.systemEvents) {
      collect(se.content);
      collect(se.stdout);
      collect(se.output);
    }
    if (typeof turnOrEvents.userText === "string") collect(turnOrEvents.userText);
  }
  return texts.join("\n").trim();
}
