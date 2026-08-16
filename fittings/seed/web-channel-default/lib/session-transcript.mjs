// Claude session transcript helpers for Drill's run observability (S31).
//
// Every vision-resolved check runs on a real Claude session behind the
// gateway; the engine threads {sessionId, transcriptPath} back onto each
// check's terminal (terminal.session). Claude Code journals that session to
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl on this same box, so the
// Drill server can tail it live while a run executes and store a per-run
// slice next to the run's other evidence when it finishes.
//
// The parser here is deliberately self-contained (no @garrison/claude-pty
// dependency in the fitting): it reads only the stable transcript shapes -
// user/assistant entries with content blocks (text / thinking / tool_use /
// tool_result incl. base64 images) plus ai-title lines - and ignores
// everything else. All helpers are warn-never-throw at the call sites;
// transcript observability must never fail a run.

import { createHash } from "node:crypto";
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

const cleanId = (value) => {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
};

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function taskNotificationText(content) {
  const text = contentText(content).trim();
  return /^<task-notification>[\s\S]*<\/task-notification>$/.test(text) ? text : null;
}

function normaliseTaskStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (["completed", "complete", "done", "success", "succeeded"].includes(status)) return "completed";
  if (["failed", "error", "cancelled", "canceled", "stopped"].includes(status)) return "failed";
  if (["running", "started", "in_progress", "pending"].includes(status)) return "running";
  return "unknown";
}

function xmlTag(text, name) {
  const match = new RegExp(`<${name}>([\\s\\S]{0,1000}?)<\\/${name}>`, "i").exec(String(text ?? ""));
  return match ? match[1].trim() : null;
}

/**
 * Ground Agent/Task fan-out in the actual Claude journal. Internal agent ids are
 * returned only to the same-origin server resolver; relatedTaskEvents below never
 * serializes them. Public task ids derive from the already-public tool-use id.
 */
export function extractRelatedTaskRecords(lines) {
  const tasks = new Map();
  const ensure = (toolUseId) => {
    const safe = cleanId(toolUseId);
    if (!safe) return null;
    let task = tasks.get(safe);
    if (!task) {
      task = {
        toolUseId: safe,
        taskId: `task-${safe}`,
        name: "Parallel task",
        detail: null,
        status: "unknown",
        text: null,
        agentId: null,
        ts: null,
        grounded: false,
      };
      tasks.set(safe, task);
    }
    return task;
  };

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const ts = entryTimestamp(entry);
    if (entry?.type === "progress" && entry.data?.type === "agent_progress") {
      const task = ensure(entry.parentToolUseID ?? entry.parentToolUseId);
      if (task) {
        // The live Agent SDK progress row grounds the child before the eventual
        // launch/completion tool_result. Keep the internal id server-side only;
        // relatedTaskEvents deliberately omits it from the descriptor.
        task.agentId = cleanId(entry.data.agentId) ?? task.agentId;
        task.status = "running";
        if (typeof entry.data.message === "string" && entry.data.message.trim()) {
          task.text = clampText(entry.data.message.trim()).slice(0, 500);
        }
        if (ts !== null) task.ts = ts;
      }
    }
    if (entry?.type === "assistant" && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type !== "tool_use" || (block.name !== "Agent" && block.name !== "Task")) continue;
        const task = ensure(block.id);
        if (!task) continue;
        const input = block.input && typeof block.input === "object" ? block.input : {};
        task.name = clampText(input.description ?? input.name ?? "Parallel task").slice(0, 200);
        task.detail = typeof input.subagent_type === "string" ? input.subagent_type.trim().slice(0, 80) || null : null;
        task.status = task.status === "unknown" ? "running" : task.status;
        task.ts ??= ts;
        task.grounded = true;
      }
    }

    if (entry?.type === "user" && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type !== "tool_result") continue;
        const task = ensure(block.tool_use_id);
        if (!task?.grounded) continue;
        const text = contentText(block.content);
        // Claude marks this id as internal metadata. It is used only to resolve the
        // confined child journal and is NEVER included in related_task blocks.
        const match = /\bagentId:\s*([A-Za-z0-9_-]{1,128})\b/.exec(text);
        if (match) task.agentId = cleanId(match[1]);
        if (block.is_error === true) task.status = "failed";
      }
    }

    const notification = entry?.type === "queue-operation"
      ? entry.content
      : entry?.type === "user"
        ? taskNotificationText(entry.message?.content)
        : null;
    if (typeof notification === "string" && notification.includes("<task-notification>")) {
      const task = ensure(xmlTag(notification, "tool-use-id"));
      if (!task) continue;
      task.status = normaliseTaskStatus(xmlTag(notification, "status"));
      const summary = xmlTag(notification, "summary");
      if (summary) task.text = clampText(summary).slice(0, 500);
      if (ts !== null) task.ts = ts;
    }
  }
  return [...tasks.values()].filter((task) => task.grounded);
}

/** Safe, runtime-neutral descriptors for the transcript UI. `streamUrlFor` may
 * return a same-origin child stream only after the server verified the child file. */
export function relatedTaskEvents(lines, { streamUrlFor } = {}) {
  return extractRelatedTaskRecords(lines).map((task) => {
    const streamUrl = task.agentId && typeof streamUrlFor === "function" ? streamUrlFor(task) : null;
    const block = {
      type: "related_task",
      toolUseId: task.toolUseId,
      taskId: task.taskId,
      name: task.name,
      ...(task.detail ? { detail: task.detail } : {}),
      status: task.status,
      ...(task.text ? { text: task.text } : {}),
      ...(streamUrl ? { streamUrl } : {}),
    };
    return {
      id: `related:${task.taskId}`,
      role: "assistant",
      ts: task.ts,
      blocks: [block],
    };
  });
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
    // Agent SDK emits live Bash output as progress rows outside the ordinary
    // user/assistant message envelope. Normalize it to a provider-neutral block;
    // renderers can associate it with the existing tool_use by toolUseId.
    if (entry?.type === "progress" && entry.data?.type === "bash_progress") {
      const toolUseId = cleanId(entry.parentToolUseID ?? entry.parentToolUseId);
      if (!toolUseId) continue;
      const rawSeconds = Number(entry.data.elapsedTimeSeconds);
      const elapsedMs = Number.isFinite(rawSeconds) && rawSeconds >= 0 ? Math.round(rawSeconds * 1000) : null;
      const taskId = cleanId(entry.data.taskId);
      const block = {
        type: "tool_progress",
        toolUseId,
        text: clampText(entry.data.fullOutput ?? entry.data.output ?? ""),
        ...(elapsedMs !== null ? { elapsedMs } : {}),
        status: "running",
        ...(taskId ? { taskId } : {}),
        ...(Number.isFinite(entry.data.timeoutMs) ? { timeoutMs: Math.max(0, Math.trunc(entry.data.timeoutMs)) } : {}),
        ...(Number.isFinite(entry.data.totalBytes) ? { totalBytes: Math.max(0, Math.trunc(entry.data.totalBytes)) } : {}),
        ...(Number.isFinite(entry.data.totalLines) ? { totalLines: Math.max(0, Math.trunc(entry.data.totalLines)) } : {}),
      };
      events.push({
        id: entry.uuid ?? `progress:${toolUseId}:${entry.timestamp ?? events.length}`,
        role: "assistant",
        ts: entryTimestamp(entry),
        blocks: [block],
      });
      continue;
    }
    if (entry?.type !== "user" && entry?.type !== "assistant") continue;
    const message = entry.message ?? {};
    // Claude records Agent/Task completion notifications as user-shaped rows,
    // in both string and text-block-array forms. They are runtime metadata, not
    // a human prompt: rendering one would expose the XML and split the final
    // answer into a fake new conversational turn. relatedTaskEvents consumes
    // the same row above, so dropping it here loses no visible activity.
    if (entry.type === "user" && taskNotificationText(message.content)) continue;
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

const transcriptIdentity = (value, fallback) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw && raw.length <= 512) return raw;
  return `transcript:${createHash("sha256").update(String(fallback)).digest("hex").slice(0, 32)}`;
};

const transcriptTurnIdentity = (sessionId, value) =>
  `transcript-turn:${createHash("sha256")
    .update(`${sessionId}\0${String(value)}`)
    .digest("hex")
    .slice(0, 32)}`;

/**
 * Rebuild canonical, revisioned activity from one completed Claude JSONL file.
 *
 * Ordinary `parseTranscriptLines` intentionally preserves the loose viewer
 * contract. Recovery has stricter needs: the durable Web journal accepts only
 * stable ids, finite timestamps, per-turn ordering, and revisions. Human user
 * prompts are boundaries rather than assistant-bubble content, while user-shaped
 * tool results stay available for association with their tool call.
 */
export function recoverTranscriptSessionEvents(lines, { sessionId, streamUrlFor } = {}) {
  const safeSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!safeSessionId || safeSessionId.length > 512 || !Array.isArray(lines)) return [];
  const events = [];
  const indexes = new Map();
  const revisions = new Map();
  let turnOrdinal = 0;
  let turnId = transcriptTurnIdentity(safeSessionId, "opening");
  let order = 0;

  const push = (rawEvent, rawIdentity, lineIndex) => {
    if (!rawEvent?.blocks?.length) return;
    const id = transcriptIdentity(rawIdentity, `${safeSessionId}:${lineIndex}:${JSON.stringify(rawEvent.blocks)}`);
    const revision = (revisions.get(id) ?? 0) + 1;
    revisions.set(id, revision);
    const event = {
      id,
      role: rawEvent.role,
      ts: Number.isFinite(rawEvent.ts) ? rawEvent.ts : lineIndex,
      turnId,
      sessionId: safeSessionId,
      order: ++order,
      revision,
      ...(rawEvent.toolResultsOnly ? { toolResultsOnly: true } : {}),
      blocks: rawEvent.blocks,
    };
    const existing = indexes.get(id);
    if (existing === undefined) {
      indexes.set(id, events.length);
      events.push(event);
    } else {
      events[existing] = event;
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    let entry;
    try { entry = JSON.parse(lines[lineIndex]); } catch { continue; }
    if (!entry || typeof entry !== "object") continue;
    const message = entry.message ?? {};
    const ts = entryTimestamp(entry);

    if (entry.type === "progress" && entry.data?.type === "bash_progress") {
      const parsed = parseTranscriptLines([lines[lineIndex]]).events[0];
      if (parsed) push(parsed, entry.uuid, lineIndex);
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.type === "user" && taskNotificationText(message.content)) continue;
    const rawContent = Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [];
    const blocks = rawContent.map(parseBlock).filter(Boolean);
    if (!blocks.length) continue;
    const toolResultsOnly = blocks.every((block) => block.type === "tool_result");
    if (entry.type === "user" && !toolResultsOnly) {
      turnOrdinal += 1;
      const boundaryIdentity = transcriptIdentity(
        message.id,
        `${safeSessionId}:user:${entry.uuid ?? turnOrdinal}`
      );
      turnId = transcriptTurnIdentity(
        safeSessionId,
        boundaryIdentity
      );
      order = 0;
      continue;
    }
    push({ role: entry.type, ts, toolResultsOnly, blocks }, message.id ?? entry.uuid, lineIndex);
  }

  const related = relatedTaskEvents(lines, { streamUrlFor });
  for (let index = 0; index < related.length; index += 1) {
    const event = related[index];
    const toolUseId = event.blocks?.[0]?.toolUseId;
    const owner = toolUseId
      ? events.find((candidate) => candidate.blocks.some(
          (block) => block.type === "tool_use" && block.toolUseId === toolUseId
        ))
      : null;
    const previousTurnId = turnId;
    const previousOrder = order;
    if (owner) {
      turnId = owner.turnId;
      order = events
        .filter((candidate) => candidate.turnId === owner.turnId)
        .reduce((highest, candidate) => Math.max(highest, candidate.order), 0);
    }
    push(event, `related:${safeSessionId}:${event.id ?? index}`, lines.length + index);
    turnId = previousTurnId;
    order = previousOrder;
  }
  return events;
}

function visibleTextSnapshot(value) {
  if (typeof value !== "string") return null;
  const match = /^(.*)\n… \[truncated (\d+) chars\]$/s.exec(value);
  if (!match) return { prefix: value, omitted: 0, truncated: false };
  const omitted = Number(match[2]);
  return match[1].length === TEXT_BLOCK_CAP && Number.isSafeInteger(omitted) && omitted > 0
    ? { prefix: match[1], omitted, truncated: true }
    : null;
}

function textSnapshotExtends(current, recovered) {
  const before = visibleTextSnapshot(current);
  const after = visibleTextSnapshot(recovered);
  if (!before || !after) return false;
  if (before.truncated) {
    return after.truncated && after.prefix === before.prefix && after.omitted >= before.omitted;
  }
  return after.prefix.startsWith(before.prefix);
}

function parsedJson(value) {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

function jsonSnapshotsEqual(current, recovered) {
  if (Object.is(current, recovered)) return true;
  if (Array.isArray(current)) {
    return Array.isArray(recovered) && current.length === recovered.length &&
      current.every((value, index) => jsonSnapshotsEqual(value, recovered[index]));
  }
  if (current && recovered && typeof current === "object" && typeof recovered === "object" &&
      !Array.isArray(recovered)) {
    const currentKeys = Object.keys(current);
    const recoveredKeys = Object.keys(recovered);
    return currentKeys.length === recoveredKeys.length && currentKeys.every((key) =>
      Object.hasOwn(recovered, key) && jsonSnapshotsEqual(current[key], recovered[key])
    );
  }
  return false;
}

function compactJsonPrefix(value) {
  if (typeof value !== "string") return null;
  let out = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (quoted) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      out += char;
    } else if (!/\s/.test(char)) {
      out += char;
    }
  }
  return out;
}

function toolInputSnapshotExtends(current, recovered) {
  const beforeJson = parsedJson(current);
  const afterJson = parsedJson(recovered);
  // Once a streamed input parses as JSON it is a complete public snapshot.
  // Only invalid/incomplete input_json_delta text may grow by prefix; otherwise a
  // later journal object with extra/different keys is a different input.
  if (beforeJson !== null && afterJson !== null) return jsonSnapshotsEqual(beforeJson, afterJson);
  const before = compactJsonPrefix(visibleTextSnapshot(current)?.prefix);
  const after = compactJsonPrefix(visibleTextSnapshot(recovered)?.prefix);
  return before !== null && after !== null && after.startsWith(before);
}

function recoveryExtendsBlock(current, recovered) {
  if (!current || !recovered || current.type !== recovered.type) return false;
  if (JSON.stringify(current) === JSON.stringify(recovered)) return true;
  if (current.type === "text" || current.type === "thinking") {
    return textSnapshotExtends(current.text, recovered.text);
  }
  if (current.type === "tool_use") {
    return current.toolUseId === recovered.toolUseId && current.name === recovered.name &&
      typeof current.input === "string" && typeof recovered.input === "string" &&
      toolInputSnapshotExtends(current.input, recovered.input);
  }
  if (current.type === "tool_result") {
    return current.toolUseId === recovered.toolUseId && current.isError === recovered.isError &&
      typeof current.text === "string" && typeof recovered.text === "string" &&
      textSnapshotExtends(current.text, recovered.text) &&
      JSON.stringify(current.images ?? []) === JSON.stringify(recovered.images ?? []);
  }
  return false;
}

function recoveryExtendsEvent(current, recovered) {
  if (current.role !== recovered.role || current.blocks.length > recovered.blocks.length) return false;
  return current.blocks.every((block, index) => recoveryExtendsBlock(block, recovered.blocks[index]));
}

/**
 * Reconcile the low-latency Web journal with completed on-disk transcripts.
 * Stable canonical events stay authoritative. A transcript may fill an absent
 * row, or complete a strict prefix snapshot of the same provider message, but it
 * can never erase typed errors, terminal state, permissions, or richer blocks.
 */
export function reconcileTranscriptSessionEvents(durable, recovered) {
  if (!Array.isArray(recovered) || recovered.length === 0) {
    return Array.isArray(durable) ? durable : [];
  }
  const retractionsFor = (event) => Array.isArray(event?.retracts)
    ? [...new Set(event.retracts.filter(
        (id) => typeof id === "string" && id && id !== event.id && !id.startsWith("terminal:")
      ))].slice(0, 64)
    : [];
  const tombstones = new Set();
  const output = Array.isArray(durable) ? durable.slice() : [];
  for (const event of output) {
    for (const target of retractionsFor(event)) tombstones.add(target);
  }
  const indexes = new Map();
  output.forEach((event, index) => {
    if (typeof event?.id === "string" && !indexes.has(event.id)) indexes.set(event.id, index);
  });
  for (const recoveredCandidate of Array.isArray(recovered) ? recovered : []) {
    let candidate = recoveredCandidate;
    if (!candidate || typeof candidate.id !== "string" || !Array.isArray(candidate.blocks)) continue;
    if (tombstones.has(candidate.id)) continue;
    for (const target of retractionsFor(candidate)) tombstones.add(target);
    let index = indexes.get(candidate.id);
    if (index !== undefined && output[index]?.sessionId !== candidate.sessionId) {
      const currentSessionId = typeof output[index]?.sessionId === "string" && output[index].sessionId
        ? output[index].sessionId
        : null;
      const candidateSessionId = typeof candidate.sessionId === "string" && candidate.sessionId
        ? candidate.sessionId
        : null;
      // A durable typed/error event without session attribution owns its id
      // outright. There is not enough evidence to add a transcript collision as
      // a second visible row, let alone promote the durable one.
      if (!currentSessionId || !candidateSessionId) continue;
      // Provider message ids are stable within a Claude session, not globally
      // across every journal a Web thread has ever used. Keep both rows under a
      // deterministic recovery-only id rather than letting one session promote
      // or erase another session's durable event.
      const namespacedId = `recovered:${createHash("sha256")
        .update(`${String(candidate.sessionId ?? "")}\0${candidate.id}`)
        .digest("hex")
        .slice(0, 32)}`;
      const namespaced = { ...candidate, id: namespacedId };
      candidate = namespaced;
      index = indexes.get(namespacedId);
      if (index === undefined) {
        indexes.set(namespacedId, output.length);
        output.push(namespaced);
        continue;
      }
      if (output[index]?.sessionId !== candidate.sessionId) continue;
    }
    if (index === undefined) {
      indexes.set(candidate.id, output.length);
      output.push(candidate);
      continue;
    }
    const current = output[index];
    const retainedRetracts = [...new Set([
      ...retractionsFor(current),
      ...retractionsFor(candidate),
    ])].slice(0, 64);
    const retractionsChanged = JSON.stringify(retainedRetracts) !== JSON.stringify(retractionsFor(current));
    if (JSON.stringify(current.blocks) === JSON.stringify(candidate.blocks) && !retractionsChanged) continue;
    if (!recoveryExtendsEvent(current, candidate)) continue;
    const revision = Number.isInteger(current.revision) && current.revision >= 0
      ? current.revision + 1
      : Math.max(1, candidate.revision ?? 1);
    output[index] = {
      ...candidate,
      id: current.id,
      role: current.role,
      ts: Number.isFinite(current.ts) ? current.ts : candidate.ts,
      turnId: current.turnId ?? candidate.turnId,
      sessionId: current.sessionId ?? candidate.sessionId,
      ...(current.generationId ? { generationId: current.generationId } : {}),
      order: Number.isInteger(current.order) ? current.order : candidate.order,
      revision,
      ...(retainedRetracts.length ? { retracts: retainedRetracts } : {}),
    };
  }
  return output
    .filter((event) => !tombstones.has(event?.id))
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftTs = Number.isFinite(left.event?.ts) ? left.event.ts : Number.MAX_SAFE_INTEGER;
      const rightTs = Number.isFinite(right.event?.ts) ? right.event.ts : Number.MAX_SAFE_INTEGER;
      return leftTs - rightTs || left.index - right.index;
    })
    .map(({ event }) => event);
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

// Upsert the check's vision session onto the run record. Returns the entry
// (or null when the terminal carries no session linkage). Mutates the
// terminal: the absolute transcript path moves to record.sessions (the
// server-side read coordinate) and the per-check terminal keeps only the
// session id - no host path reaches the wire through pages[].terminal.
export function noteRunSession(record, terminal, at = new Date().toISOString()) {
  const session = terminal?.session;
  if (!session?.id) return null;
  record.sessions ??= [];
  let entry = record.sessions.find((candidate) => candidate.id === session.id);
  if (!entry) {
    entry = { id: session.id, transcriptPath: session.transcriptPath ?? null, firstAt: at, lastAt: at, checks: 0 };
    record.sessions.push(entry);
  }
  if (session.transcriptPath && !entry.transcriptPath) entry.transcriptPath = session.transcriptPath;
  delete session.transcriptPath;
  entry.lastAt = at;
  entry.checks += 1;
  return entry;
}

// The stored per-run slice filename for a session. Session ids are uuids from
// the gateway, but sanitize anyway - this lands inside the evidence dir and is
// served through the flat-name confined route.
export function sessionSliceName(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9-]/g, "");
  return `session-${safe}.jsonl`;
}
