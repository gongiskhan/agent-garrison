// canonical copy: fittings/seed/drill/lib/session-transcript.mjs
//
// Claude session transcript helpers for the Kanban board's rich-Log view. Every
// gateway-served operative turn is journaled by Claude Code to
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl on this same box, so the
// board server can tail it live while a card runs and replay it afterwards.
//
// The parser is deliberately self-contained (no @garrison/claude-pty dependency
// in the fitting): it reads only the stable transcript shapes - user/assistant
// entries with content blocks (text / thinking / tool_use / tool_result incl.
// base64 images) plus ai-title lines - and ignores everything else. All helpers
// are warn-never-throw at the call sites; transcript observability must never
// fail a run.

import fs from "node:fs/promises";

// Text blocks are capped so one giant tool result cannot balloon the SSE
// stream or the stored slice's parsed view. Images pass through whole - they
// ARE the payload the viewer exists to show.
const TEXT_BLOCK_CAP = 20_000;

const clampText = (value) => {
  const text = String(value ?? "");
  return text.length > TEXT_BLOCK_CAP
    ? `${text.slice(0, TEXT_BLOCK_CAP)}\n… [truncated ${text.length - TEXT_BLOCK_CAP} chars]`
    : text;
};

// Read COMPLETE lines from `file` starting at byte `offset`. A partial
// trailing line (mid-write) stays unread and is re-read on the next poll.
// Returns { lines, offset } - offset advances only past consumed newlines.
export async function readJsonlLines(file, offset = 0) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    if (size <= offset) return { lines: [], offset: Math.min(offset, size) };
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const text = buffer.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return { lines: [], offset };
    const complete = text.slice(0, lastNewline);
    const lines = complete.split("\n").filter((line) => line.trim() !== "");
    return { lines, offset: offset + Buffer.byteLength(complete, "utf8") + 1 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseBlock(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: clampText(block.text) };
  }
  if (block.type === "thinking") {
    return { type: "thinking", text: clampText(block.thinking ?? block.text ?? "") };
  }
  if (block.type === "tool_use") {
    let input = "";
    try {
      input = clampText(JSON.stringify(block.input ?? {}, null, 2));
    } catch {
      input = String(block.input ?? "");
    }
    return { type: "tool_use", toolUseId: block.id ?? null, name: String(block.name ?? "tool"), input };
  }
  if (block.type === "tool_result") {
    const texts = [];
    const images = [];
    const content = Array.isArray(block.content)
      ? block.content
      : typeof block.content === "string"
        ? [{ type: "text", text: block.content }]
        : [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
      if (item.type === "image" && item.source?.type === "base64" && item.source.data) {
        images.push({ mediaType: item.source.media_type ?? "image/jpeg", data: item.source.data });
      }
    }
    return {
      type: "tool_result",
      toolUseId: block.tool_use_id ?? null,
      isError: block.is_error === true,
      text: clampText(texts.join("\n")),
      images
    };
  }
  return null;
}

function entryTimestamp(entry) {
  const ts = Date.parse(entry?.timestamp ?? "");
  return Number.isFinite(ts) ? ts : null;
}

// Map raw transcript jsonl lines to viewer events:
//   { id, role: "user"|"assistant", ts, blocks: [...] }
// A user entry that carries ONLY tool_result blocks keeps role "user" but is
// flagged toolResultsOnly - the viewer folds it into the preceding tool call
// instead of rendering a user bubble. Unknown/meta lines produce no event;
// ai-title lines feed the returned `title`.
export function parseTranscriptLines(lines) {
  const events = [];
  let title = null;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "ai-title" && typeof entry.title === "string" && entry.title.trim()) {
      title = entry.title.trim();
      continue;
    }
    if (entry?.type !== "user" && entry?.type !== "assistant") continue;
    const message = entry.message ?? {};
    const rawContent = Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [];
    const blocks = rawContent.map(parseBlock).filter(Boolean);
    if (blocks.length === 0) continue;
    events.push({
      id: entry.uuid ?? null,
      role: entry.type,
      ts: entryTimestamp(entry),
      toolResultsOnly: blocks.every((b) => b.type === "tool_result"),
      blocks
    });
  }
  return { events, title };
}

// Keep only the lines whose timestamp falls inside [sinceIso, untilIso]
// (with margin). Lines without a timestamp are dropped except ai-title (tiny,
// and it names the session in the stored slice too).
export function linesInWindow(lines, sinceIso, untilIso, marginMs = 10_000) {
  const since = Date.parse(sinceIso ?? "") - marginMs;
  const until = (untilIso ? Date.parse(untilIso) : Date.now()) + marginMs;
  return lines.filter((line) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return false;
    }
    if (entry?.type === "ai-title") return true;
    const ts = entryTimestamp(entry);
    if (ts === null) return false;
    return ts >= since && ts <= until;
  });
}

// Read + window + parse a live transcript in one call (replay/snapshot path).
export async function readSessionWindow(transcriptPath, sinceIso, untilIso) {
  const { lines } = await readJsonlLines(transcriptPath, 0);
  const windowed = linesInWindow(lines, sinceIso, untilIso);
  return parseTranscriptLines(windowed);
}
