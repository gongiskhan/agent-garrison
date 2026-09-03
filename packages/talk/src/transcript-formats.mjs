// Parsers for the non-Claude transcript formats a session row can point at
// (Row.transcript.format), each returning the SAME {events, title} shape
// parseTranscriptLines does, so handleExternalSessionStream can emit the
// identical SSE frames regardless of which CLI wrote the file. Event shape:
// { id, role: "user"|"assistant", ts (ms epoch or null), blocks[],
//   toolResultsOnly? }. Block shape matches session-transcript.mjs's
// parseBlock: {type: text|thinking|tool_use|tool_result, ...}.

import { parseBlock, parseTranscriptLines } from "./session-transcript.mjs";

const TEXT_CAP = 20_000;
const clampText = (value) => {
  const text = String(value ?? "");
  return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n… [truncated ${text.length - TEXT_CAP} chars]` : text;
};

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// ── Cursor (agent-transcripts JSONL) ────────────────────────────────────────
// {role: "user"|"assistant", message: {content: [...Anthropic-shaped blocks]}}
// - the same shape Claude's own transcript uses, so this reuses parseBlock.

export function parseCursorTranscriptLines(lines) {
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    const entry = parseJsonLine(lines[i]);
    if (!entry || (entry.role !== "user" && entry.role !== "assistant")) continue;
    const rawContent = entry.message?.content;
    const content = Array.isArray(rawContent)
      ? rawContent
      : typeof rawContent === "string"
        ? [{ type: "text", text: rawContent }]
        : [];
    const blocks = content.map(parseBlock).filter(Boolean);
    if (!blocks.length) continue;
    events.push({
      id: `cursor:${i}`,
      role: entry.role,
      ts: null,
      toolResultsOnly: blocks.every((b) => b.type === "tool_result"),
      blocks
    });
  }
  return { events, title: null };
}

// ── Codex (rollout JSONL) ───────────────────────────────────────────────────
// One record per line: {timestamp, type, payload}. Only `response_item`
// records carry conversation content; `session_meta`/`turn_context`/
// `event_msg` are metadata. Verified against a real rollout on this box
// (2026-09-03): message content blocks are {type:"input_text"|"output_text",
// text}, NOT the generic Anthropic {type:"text"} shape; custom_tool_call's
// `input` is already a string; custom_tool_call_output's `output` is an
// ARRAY of input_text blocks; function_call's `arguments` is a JSON string;
// function_call_output's `output` is a plain string (two coexisting tool-call
// conventions in the same rollout format).

function codexMessageBlocks(payload) {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const blocks = [];
  for (const c of content) {
    if ((c?.type === "input_text" || c?.type === "output_text") && typeof c.text === "string" && c.text) {
      blocks.push({ type: "text", text: clampText(c.text) });
    }
  }
  return blocks;
}

function codexToolOutputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .filter((o) => (o?.type === "input_text" || o?.type === "output_text") && typeof o.text === "string")
      .map((o) => o.text)
      .join("\n");
  }
  try {
    return JSON.stringify(output ?? {});
  } catch {
    return String(output ?? "");
  }
}

export function parseCodexRolloutLines(lines) {
  const events = [];
  let n = 0;
  for (const line of lines) {
    const rec = parseJsonLine(line);
    if (!rec || rec.type !== "response_item") continue;
    const payload = rec.payload;
    if (!payload || typeof payload !== "object") continue;
    const ts = Date.parse(rec.timestamp ?? "");
    const tsMs = Number.isFinite(ts) ? ts : null;
    const id = `codex:${n++}`;

    if (payload.type === "message") {
      // developer messages are system/context scaffolding, not conversation.
      if (payload.role === "developer") continue;
      const blocks = codexMessageBlocks(payload);
      if (!blocks.length) continue;
      events.push({ id, role: payload.role === "user" ? "user" : "assistant", ts: tsMs, blocks });
    } else if (payload.type === "agent_message") {
      // Sub-agent chatter: input_text/output_text parts only (encrypted_content dropped).
      const blocks = codexMessageBlocks(payload);
      if (!blocks.length) continue;
      events.push({ id, role: "assistant", ts: tsMs, blocks });
    } else if (payload.type === "reasoning") {
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const text = summary.map((s) => (typeof s?.text === "string" ? s.text : "")).filter(Boolean).join("\n");
      if (text) events.push({ id, role: "assistant", ts: tsMs, blocks: [{ type: "thinking", text: clampText(text) }] });
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const input = payload.type === "function_call" ? payload.arguments : payload.input;
      events.push({
        id,
        role: "assistant",
        ts: tsMs,
        blocks: [{ type: "tool_use", toolUseId: payload.call_id ?? null, name: payload.name ?? "tool", input: clampText(typeof input === "string" ? input : JSON.stringify(input ?? {})) }]
      });
    } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      const text = codexToolOutputText(payload.output);
      events.push({
        id,
        role: "user",
        ts: tsMs,
        toolResultsOnly: true,
        blocks: [{ type: "tool_result", toolUseId: payload.call_id ?? null, isError: false, text: clampText(text), images: [] }]
      });
    }
  }
  return { events, title: null };
}

// ── Gemini (per-project chat JSONL) ─────────────────────────────────────────
// Line 1: header {sessionId, projectHash, startTime, lastUpdated, kind}.
// Following lines: {"$set": {"messages": [{id, timestamp, type, content}]}}
// patches - each patch REPLACES the whole messages array (latest-wins), so
// only the LAST patch's array is the current state.

export function parseGeminiChatLines(lines) {
  let latestMessages = null;
  for (const line of lines) {
    const rec = parseJsonLine(line);
    const messages = rec?.$set?.messages;
    if (Array.isArray(messages)) latestMessages = messages;
  }
  if (!latestMessages) return { events: [], title: null };
  const events = [];
  for (const m of latestMessages) {
    if (m?.type !== "user" && m?.type !== "gemini") continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n");
    if (!text) continue;
    const ts = Number.isFinite(m.timestamp) ? m.timestamp : Date.parse(m.timestamp ?? "");
    events.push({
      id: typeof m.id !== "undefined" ? `gemini:${m.id}` : `gemini:${events.length}`,
      role: m.type === "user" ? "user" : "assistant",
      ts: Number.isFinite(ts) ? ts : null,
      blocks: [{ type: "text", text: clampText(text) }]
    });
  }
  return { events, title: null };
}

const PARSERS = {
  "claude-jsonl": (lines) => parseTranscriptLines(lines),
  "cursor-agent-jsonl": parseCursorTranscriptLines,
  "codex-rollout": parseCodexRolloutLines,
  "gemini-chat-jsonl": parseGeminiChatLines
};

export function parseByFormat(format, lines) {
  const parser = PARSERS[format];
  return parser ? parser(lines) : { events: [], title: null };
}
