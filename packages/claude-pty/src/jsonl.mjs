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
  try {
    const fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    if (size <= offset) {
      closeSync(fd);
      return { events: [], newOffset: offset };
    }
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, size - offset, offset);
    closeSync(fd);
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
    turnDurationMs,
    stopHookSeen,
    model,
  };
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
