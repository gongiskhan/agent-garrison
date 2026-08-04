/**
 * Runtime-neutral activity-journal model consumed by SessionStream.
 *
 * Claude/Agent SDK JSONL is the first producer, but the UI intentionally speaks
 * in generic text/thinking/tool/progress/related-task blocks. A future runtime
 * only needs to adapt its own event stream to this shape; it does not need to
 * teach the React renderer runtime-specific wire formats.
 */
export interface SessionImage {
  mediaType: string;
  data: string;
}

export type RelatedTaskStatus = "running" | "completed" | "failed" | "unknown";

export interface SessionBlock {
  type: string;
  text?: string;
  name?: string;
  input?: string;
  toolUseId?: string | null;
  isError?: boolean;
  images?: SessionImage[];
  /** Additive live-output fields (e.g. Claude JSONL bash_progress). */
  elapsedMs?: number | null;
  timeoutMs?: number | null;
  totalBytes?: number | null;
  totalLines?: number | null;
  status?: RelatedTaskStatus | string | null;
  taskId?: string | null;
  /** A host-generated, same-origin URL; never a transcript filesystem path. */
  streamUrl?: string | null;
  detail?: string | null;
}

export interface SessionEvent {
  id: string | null;
  role: string;
  ts: number | null;
  toolResultsOnly?: boolean;
  blocks: SessionBlock[];
}

export interface RelatedTask {
  key: string;
  toolUseId: string | null;
  taskId: string | null;
  label: string;
  detail: string | null;
  status: RelatedTaskStatus;
  text: string | null;
  streamUrl: string | null;
}

type JsonRecord = Record<string, unknown>;
const FANOUT_TOOL_NAMES = new Set(["agent", "task", "spawn_agent", "create_thread", "fork_thread"]);

export function parseToolInput(input: string | undefined): JsonRecord | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonRecord) : null;
  } catch {
    return null;
  }
}

function compact(value: unknown, cap = 110): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

function stringField(input: JsonRecord | null, ...keys: string[]): string {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** One presentable line describing what a tool call is doing. */
export function sessionToolSummary(block: SessionBlock): string {
  const input = parseToolInput(block.input);
  const name = String(block.name ?? "tool").split(/[.:/]/).pop()?.toLowerCase() ?? "tool";
  if (name === "bash" || name === "shell" || name === "exec" || name === "exec_command") {
    return compact(stringField(input, "command", "cmd") || block.input);
  }
  if (name === "read" || name === "write" || name === "edit" || name === "multiedit") {
    return compact(stringField(input, "file_path", "path", "file"));
  }
  if (name === "grep" || name === "glob" || name === "search") {
    const pattern = stringField(input, "pattern", "query");
    const where = stringField(input, "path", "cwd");
    return compact([pattern, where && `in ${where}`].filter(Boolean).join(" "));
  }
  if (isFanoutTool(block.name)) {
    return compact(stringField(input, "description", "task", "name", "prompt"));
  }
  return compact(
    stringField(input, "description", "query", "url", "path", "file_path", "command", "cmd", "pattern", "prompt") ||
      block.input
  );
}

export function sessionThinkingSummary(text: string | undefined): string {
  const clean = String(text ?? "")
    .replace(/[`*_>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Reasoning";
  const sentence = clean.match(/^(.{1,110}?)(?:[.!?](?:\s|$)|$)/)?.[1] ?? clean;
  return compact(sentence, 96);
}

export function isFanoutTool(name: string | undefined): boolean {
  const leaf = String(name ?? "").split(/[.:/]/).pop()?.toLowerCase() ?? "";
  return FANOUT_TOOL_NAMES.has(leaf);
}

export function latestBlocksByToolUse(events: SessionEvent[], type: string): Map<string, SessionBlock> {
  const out = new Map<string, SessionBlock>();
  for (const event of events) {
    for (const block of event.blocks ?? []) {
      if (block.type === type && block.toolUseId) out.set(block.toolUseId, block);
    }
  }
  return out;
}

/**
 * Merge a streamed journal batch by stable event identity. Ordinary append-only
 * rows retain their order; snapshot rows may replace themselves in place as
 * status, progress, or an opaque child-stream URL becomes available.
 */
export function mergeSessionEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (!incoming.length) return current;
  const next = current.slice();
  const indexes = new Map<string, number>();
  next.forEach((event, index) => { if (event.id) indexes.set(event.id, index); });
  for (const event of incoming) {
    const index = event.id ? indexes.get(event.id) : undefined;
    if (index === undefined) {
      if (event.id) indexes.set(event.id, next.length);
      next.push(event);
    } else {
      next[index] = event;
    }
  }
  return next;
}

function normaliseTaskStatus(value: unknown, fallback: RelatedTaskStatus): RelatedTaskStatus {
  const status = String(value ?? "").toLowerCase();
  if (["running", "active", "streaming", "started", "pending"].includes(status)) return "running";
  if (["complete", "completed", "done", "success", "succeeded"].includes(status)) return "completed";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return fallback;
}

function sameOriginStreamUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  // A server adapter may expose an opaque same-origin endpoint, never a host
  // path or an external URL copied out of model-controlled journal content.
  if (!/^\/(?!\/)/.test(url) || url.includes("\\") || /(?:^|\/)\.\.(?:\/|$)/.test(url)) return null;
  return url;
}

/**
 * Build the fan-out panel solely from journal evidence. Agent/Task tool calls
 * are sufficient evidence; richer `related_task` blocks can later add an opaque
 * stream URL and live status without changing the component API.
 */
export function collectRelatedTasks(events: SessionEvent[], live = false): RelatedTask[] {
  const results = latestBlocksByToolUse(events, "tool_result");
  const progress = latestBlocksByToolUse(events, "tool_progress");
  const byKey = new Map<string, RelatedTask>();

  for (const event of events) {
    for (const block of event.blocks ?? []) {
      if (block.type === "related_task") {
        const key = block.taskId || block.toolUseId || event.id;
        if (!key) continue;
        const aliased = block.toolUseId
          ? [...byKey.values()].find((candidate) => candidate.toolUseId === block.toolUseId)
          : undefined;
        const previous = byKey.get(key) ?? aliased;
        if (aliased && aliased.key !== key) byKey.delete(aliased.key);
        const result = block.toolUseId ? results.get(block.toolUseId) : undefined;
        const fallback: RelatedTaskStatus = result ? (result.isError ? "failed" : "completed") : previous?.status ?? "unknown";
        byKey.set(key, {
          key,
          toolUseId: block.toolUseId ?? previous?.toolUseId ?? null,
          taskId: block.taskId ?? previous?.taskId ?? null,
          label: compact(block.name || previous?.label || "Related task", 80),
          detail: compact(block.detail || previous?.detail || "", 60) || null,
          status: result ? fallback : normaliseTaskStatus(block.status, fallback),
          text: block.text ? compact(block.text, 160) : previous?.text ?? null,
          streamUrl: sameOriginStreamUrl(block.streamUrl) ?? previous?.streamUrl ?? null,
        });
        continue;
      }
      if (block.type !== "tool_use" || !isFanoutTool(block.name)) continue;
      const toolUseId = block.toolUseId ?? null;
      const input = parseToolInput(block.input);
      const result = toolUseId ? results.get(toolUseId) : undefined;
      const beat = toolUseId ? progress.get(toolUseId) : undefined;
      const taskId =
        beat?.taskId ??
        (stringField(input, "task_id", "taskId", "resume") || null);
      const label = compact(stringField(input, "description", "task", "name") || sessionToolSummary(block) || block.name || "Related task", 80);
      const detail = compact(stringField(input, "subagent_type", "subagentType", "kind", "model"), 60) || null;
      const fallback: RelatedTaskStatus = result ? (result.isError ? "failed" : "completed") : live ? "running" : "unknown";
      const key = taskId || toolUseId || `${event.id ?? "event"}:${label}`;
      byKey.set(key, {
        key,
        toolUseId,
        taskId,
        label,
        detail,
        status: result ? fallback : normaliseTaskStatus(beat?.status, fallback),
        text: beat?.text ? compact(beat.text, 160) : null,
        streamUrl: sameOriginStreamUrl(beat?.streamUrl),
      });
    }
  }
  return [...byKey.values()];
}
