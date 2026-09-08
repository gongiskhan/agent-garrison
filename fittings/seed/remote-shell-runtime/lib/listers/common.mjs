import fs from "node:fs";

// Shared helpers for the four session listers (claude/codex/cursor/gemini).
// Kept tiny and dependency-free on purpose - each lister stays independently
// testable against its own fixture.

/** The project chip: the last path segment, or the whole string when there
 *  is no slash. Never throws on a null/empty cwd. */
export function projectName(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  const trimmed = cwd.replace(/\/+$/, "");
  const seg = trimmed.split("/").pop();
  return seg || trimmed || null;
}

// A pane a human is actively watching prints something at least this often;
// past this, "still running" is a guess this fitting should not make without
// hook evidence. Deliberately generous - session-index.mjs's hook layer is
// the precise signal, this is only the fallback for a CLI with none.
export const TRANSCRIPT_WORKING_WINDOW_MS = 20_000;

/** The honest baseline status for a session with no hook/registry signal: a
 *  transcript written to in the last TRANSCRIPT_WORKING_WINDOW_MS reads as
 *  working, anything older is unknown (never "idle" - idle implies a process
 *  that finished a turn and is waiting, which this fitting cannot see). */
export function transcriptStatus(mtimeMs, now = Date.now()) {
  if (!Number.isFinite(mtimeMs)) return { status: "unknown", statusSource: "none" };
  return now - mtimeMs <= TRANSCRIPT_WORKING_WINDOW_MS
    ? { status: "working", statusSource: "transcript" }
    : { status: "unknown", statusSource: "transcript" };
}

/** Read bounded complete JSONL records without loading an entire transcript.
 * Only metadata decisions are retained by callers; contents stay on this node. */
export function readJsonlSlice(file, { tail = false, maxBytes = 512 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = tail ? Math.max(0, size - maxBytes) : 0;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.subarray(0, read).toString("utf8");
    if (start) text = text.slice(text.indexOf("\n") + 1);
    if (start + read < size) text = text.slice(0, text.lastIndexOf("\n"));
    return text.split("\n").flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch { return []; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// A quiet tool/model call must not extinguish a spinner after twenty seconds.
// Explicit completion clears it immediately; the age ceiling prevents an
// interrupted client with no terminal event from spinning forever.
export const ACTIVE_TURN_MAX_AGE_MS = 6 * 60 * 60_000;
export function claudeTranscriptStatus(file, mtimeMs, now = Date.now()) {
  let state = null;
  let statusAt = null;
  for (const rec of readJsonlSlice(file, { tail: true })) {
    if (rec.type === "user") state = "working";
    else if (rec.type === "assistant") {
      const message = rec.message ?? {};
      const textOnly = Array.isArray(message.content) && message.content.length > 0
        && message.content.every((part) => part?.type === "text");
      state = ["end_turn", "stop_sequence"].includes(message.stop_reason) ? "idle"
        : message.stop_reason == null && textOnly ? "text" : "working";
    } else if (rec.type === "system" && rec.subtype === "turn_duration") state = "idle";
    else continue;
    statusAt = rec.timestamp ?? null;
  }
  if (!state) return null;
  // Some native print versions persist stop_reason:null even on their final
  // response. Give text blocks time to be followed by a tool/thinking block;
  // a settled text-only response then clears instead of spinning for hours.
  const statusInferred = state === "text" && now - (Date.parse(statusAt) || mtimeMs) > 5_000;
  if (state === "text") state = statusInferred ? "idle" : "working";
  return { status: state === "working" && now - mtimeMs > ACTIVE_TURN_MAX_AGE_MS ? "unknown" : state,
    statusSource: "transcript-events", statusAt, statusInferred };
}

export function codexTranscriptStatus(file, mtimeMs, now = Date.now()) {
  let state = null;
  let statusAt = null;
  for (const rec of readJsonlSlice(file, { tail: true })) {
    const p = rec?.payload;
    if (rec.type === "event_msg") {
      if (["task_started", "user_message"].includes(p?.type)) state = "working";
      else if (["task_complete", "turn_aborted", "turn_complete", "shutdown"].includes(p?.type)) state = "idle";
      else continue;
    } else if (rec.type === "response_item") {
      if (p?.type === "message" && p.role === "user") state = "working";
      else if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output", "reasoning"].includes(p?.type)) state = "working";
      else if (p?.type === "message" && p.role === "assistant" && p.channel === "final") state = "idle";
      else continue;
    } else continue;
    statusAt = rec.timestamp ?? null;
  }
  if (!state) return transcriptStatus(mtimeMs, now);
  return {
    status: state === "working" && now - mtimeMs > ACTIVE_TURN_MAX_AGE_MS ? "unknown" : state,
    statusSource: "transcript-events", statusAt
  };
}
