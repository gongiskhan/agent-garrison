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

export type PermissionRequestStatus = "pending" | "resolved" | "cancelled";
export type PermissionDecision = "allow_once" | "allow_always" | "deny";

export type FailureSource =
  | "assistant"
  | "result"
  | "runtime"
  | "session"
  | "transport"
  | "system"
  | "gateway"
  | "web";

export type FailureKind =
  | "authentication"
  | "authorization"
  | "billing"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "not_found"
  | "limit"
  | "execution"
  | "runtime"
  | "transport"
  | "routing"
  | "protocol"
  | "permission"
  | "unknown";

/** Provider-neutral failure details shared by thrown transport errors, live
 * error frames, canonical journal blocks, and durable terminal projections. */
export interface FailureInfo {
  source: FailureSource;
  kind: FailureKind;
  code: string;
  text: string;
  retryable: boolean;
  requestId?: string;
  httpStatus?: number;
  /** Epoch seconds supplied by the producer when a retry time is known. */
  retryAt?: number;
}

/** A deliberately tolerant attribution bag. The canonical route producer owns
 * the full schema; the shared renderer reads only stable presentation fields. */
export interface SessionRouteAttribution {
  route?: string | null;
  runtime?: string | null;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  account?: string | null;
  project?: string | null;
  sessionId?: string | null;
  sessionEpoch?: string | number | null;
  sessionDisposition?: "new" | "warm" | "resumed" | string | null;
  sessionBoundaryReason?: string | null;
  spawnSignature?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** Stable coordinates sent back to the runtime when a user answers a durable
 * permission prompt. The generation id prevents a late click from answering a
 * newer request that happens to reuse the same request id. */
export interface PermissionAnswer {
  requestId: string;
  generationId: string;
  decision: PermissionDecision;
}

export interface SessionBlock {
  type: string;
  text?: string;
  /** Typed terminal/error metadata emitted by channel-neutral runtimes. */
  kind?: string;
  source?: FailureSource;
  code?: string | null;
  retryable?: boolean;
  requestId?: string;
  httpStatus?: number | null;
  retryAt?: number;
  result?: string;
  errors?: string[];
  subtype?: string | null;
  stopReason?: string | null;
  terminalReason?: string | null;
  name?: string;
  /** Tool input is normally a JSON string. Permission requests may retain the
   * SDK's JSON value directly so the approval surface can show it verbatim. */
  input?: unknown;
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
  /** Durable permission-request extension fields. */
  generationId?: string;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  agentId?: string;
  reason?: string | null;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorKind?: string;
  fromModel?: string;
  toModel?: string;
  direction?: string;
  rateLimitType?: string;
  resetsAt?: number;
  utilization?: number;
  overageStatus?: string;
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  overageInUse?: boolean;
  surpassedThreshold?: number;
  attribution?: SessionRouteAttribution;
  requestedModel?: string;
  decision?: PermissionDecision;
  suggestions?: unknown[];
  /** Explicit completeness flags for security-sensitive permission display. A
   * missing/false flag means the corresponding value must not be approved. */
  inputComplete?: boolean;
  suggestionsComplete?: boolean;
  /** Conversation-ledger extension fields (block types `stretch` / `ledger`).
   * A stretch is one short-lived runtime session inside a conversation; a ledger
   * row is a conversation event (handoff, delegation, card state, escalation). */
  phase?: string;
  stretchId?: string;
  duty?: string | null;
  chosenBy?: string | null;
  outcome?: string | null;
  usedTokens?: number | null;
  durationMs?: number | null;
  payloadRef?: string | null;
  seq?: number | null;
  /** `stretch` phase `ended` only - where the handoff pointed and, when it
   * blocked, what it needs. These drive the conversation activity derivation
   * (spinner vs "needs your input" banner) without parsing ledger prose. */
  next?: string | null;
  summary?: string | null;
  blockerWhat?: string | null;
  blockerNeeds?: string | null;
  blockerWho?: string | null;
}

export interface SessionErrorBlock extends SessionBlock {
  type: "error";
  source: FailureSource;
  kind: FailureKind;
  code: string;
  text: string;
  retryable: boolean;
  requestId?: string;
  httpStatus?: number;
  retryAt?: number;
}

export interface SessionRetryBlock extends SessionBlock {
  type: "retry";
  kind: "api" | "model_fallback";
  text: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  httpStatus?: number | null;
  errorKind?: string;
  requestId?: string;
  fromModel?: string;
  toModel?: string;
  direction?: string;
}

export interface SessionRateLimitBlock extends SessionBlock {
  type: "rate_limit";
  status: "allowed" | "allowed_warning" | "rejected" | string;
}

export interface SessionRouteBlock extends SessionBlock {
  type: "route";
  attribution: SessionRouteAttribution;
  requestedModel?: string;
}

/** One boundary of a stretch: a short-lived runtime session that boots from a
 * brief, works, and dies. The pair (started/ended) brackets the work it did, and
 * the `ended` row is normally a REVISION of the `started` event id rather than a
 * second row, so the boundary settles in place. */
export type StretchPhase = "started" | "ended";

export interface SessionStretchBlock extends SessionBlock {
  type: "stretch";
  phase: StretchPhase;
  stretchId: string;
  /** What actually ran this stretch. Rendered with the Turn Rail's badge
   * vocabulary, so a dimension the attribution cannot report gets NO badge. */
  attribution: SessionRouteAttribution;
  duty?: string | null;
  /** Who picked the rung: a pin, the ceiling clamp, a tripwire, the duty default. */
  chosenBy?: string | null;
  /** `ended` only - the handoff status the exit gate recorded. */
  outcome?: string | null;
  usedTokens?: number | null;
  durationMs?: number | null;
  /** `ended` only - where the handoff pointed next: another duty, `done`, or
   * `needs-input`. The conversation activity derivation reads this to tell a
   * spinner (more work coming) from a terminal state (banner). */
  next?: string | null;
  /** `ended` only - the handoff's one-paragraph summary, capped by the adapter. */
  summary?: string | null;
  /** `ended` only, blocked/needs-input handoffs - what stopped the work, what it
   * needs, and from whom. Rendered verbatim in the needs-input banner. */
  blockerWhat?: string | null;
  blockerNeeds?: string | null;
  blockerWho?: string | null;
}

/** A conversation-ledger event rendered inline in the timeline. `title` is the
 * one-line record; `detail` is the expandable body; `payloadRef` names a spilled
 * payload in the conversation store (an opaque reference, not a path). */
export type SessionLedgerKind =
  | "handoff"
  | "delegation-dispatched"
  | "delegation-returned"
  | "delegation-failed"
  | "card-state-changed"
  | "escalation"
  | "policy-rewrite"
  | "approval-requested";

export interface SessionLedgerBlock extends SessionBlock {
  type: "ledger";
  kind: SessionLedgerKind;
  title: string;
  detail?: string | null;
  payloadRef?: string | null;
  seq?: number | null;
}

export interface SessionTurnEndBlock extends SessionBlock {
  type: "turn_end";
  status: "completed" | "error" | "cancelled";
  subtype: string;
  reason: string | null;
  stopReason: string | null;
  terminalReason: string | null;
}

/** Public canonical shape for a durable permission prompt. SessionBlock stays
 * deliberately tolerant because it is also the runtime-neutral extension seam;
 * producers and consumers that create permission blocks should use this strict
 * contract. Suggestions are opaque SDK permission updates: the UI displays
 * their exact JSON but never interprets or mutates them. */
export interface PermissionRequestBlock extends SessionBlock {
  type: "permission_request";
  requestId: string;
  generationId: string;
  toolUseId: string | null;
  name: string;
  input: unknown;
  title?: string;
  displayName?: string;
  description?: string;
  blockedPath?: string;
  agentId?: string;
  reason?: string;
  status: PermissionRequestStatus;
  decision?: PermissionDecision;
  suggestions?: unknown[];
  inputComplete: boolean;
  suggestionsComplete: boolean;
}

/**
 * The canonical block vocabulary, in one machine-readable place.
 *
 * A new block type has to be added in SIX places: this list, the block
 * interface above, {@link SessionActivityBeat}, {@link sessionActivityBeats},
 * the {@link hasVisibleSessionActivity} whitelist, the SessionTranscript render
 * switch - and the web channel's own `SESSION_BLOCK_TYPES` sanitizer whitelist
 * in `scripts/threads.mjs`. Miss that last one and every event carrying the new
 * block is dropped WHOLE on its way to disk, silently.
 * `tests/session-block-parity.test.ts` mechanises the server half.
 */
export const SESSION_BLOCK_TYPES = [
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "tool_progress",
  "related_task",
  "status",
  "route",
  "retry",
  "error",
  "rate_limit",
  "turn_end",
  "permission_request",
  "stretch",
  "ledger",
] as const;

export interface SessionEvent {
  id: string | null;
  role: string;
  ts: number | null;
  /** Optional channel turn identity. Numeric values (or numeric strings) bind
   * the event to the matching chat Turn.seq. */
  turnId?: string | number | null;
  /** Runtime-owned Claude/Agent SDK session identity. */
  sessionId?: string | null;
  /** Gateway-owned turn generation. Present on generated Web streams so a
   * reconnect can bind retained canonical frames without trusting turn order. */
  generationId?: string | null;
  /** First-seen chronological position assigned by the runtime normalizer. */
  order?: number | null;
  /** Monotonic snapshot revision for a stable event id. */
  revision?: number | null;
  /** Canonical event ids made obsolete by this accepted snapshot. Tombstones
   * remain effective across replay so a late/stale row cannot reappear. */
  retracts?: string[];
  toolResultsOnly?: boolean;
  blocks: SessionBlock[];
}

/** One user prompt and every assistant journal envelope that follows it. The
 * transcript producer writes an assistant row for each interim message/tool
 * beat; the UI presents those rows as one conversational turn. */
export interface SessionTurn {
  key: string;
  userEvents: SessionEvent[];
  assistantEvents: SessionEvent[];
}

export interface SessionTurnPresentation {
  /** While live, every text envelope accumulated with paragraph boundaries;
   * once settled, only the final assistant envelope. */
  primaryText: string;
  /** Text from earlier assistant envelopes, retained behind the settled turn's
   * expandable interim-activity disclosure. */
  interimText: string[];
  /** Index in assistantEvents whose text is the final response. */
  finalTextEventIndex: number | null;
}

export type SessionActivityBeat =
  | { type: "text"; eventIndex: number; blockIndex: number; text: string }
  | { type: "error"; eventIndex: number; blockIndex: number; text: string; block: SessionBlock }
  | { type: "retry" | "rate_limit" | "route" | "turn_end" | "status"; eventIndex: number; blockIndex: number; block: SessionBlock }
  | { type: "thinking" | "tool_use" | "permission_request"; eventIndex: number; blockIndex: number; block: SessionBlock }
  | { type: "stretch" | "ledger"; eventIndex: number; blockIndex: number; block: SessionBlock };

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
const SESSION_RETRACT_CAP = 64;
const FAILURE_SOURCES: ReadonlySet<string> = new Set([
  "assistant", "result", "runtime", "session", "transport", "system", "gateway", "web",
]);
const FAILURE_KINDS: ReadonlySet<string> = new Set([
  "authentication", "authorization", "billing", "rate_limit", "overloaded",
  "invalid_request", "not_found", "limit", "execution", "runtime", "transport",
  "routing", "protocol", "permission", "unknown",
]);

export function isFailureInfo(value: unknown): value is FailureInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  const optionalText = (key: string) => failure[key] === undefined ||
    (typeof failure[key] === "string" && Boolean((failure[key] as string).trim()));
  return typeof failure.source === "string" && FAILURE_SOURCES.has(failure.source) &&
    typeof failure.kind === "string" && FAILURE_KINDS.has(failure.kind) &&
    typeof failure.code === "string" && Boolean(failure.code.trim()) &&
    typeof failure.text === "string" && Boolean(failure.text.trim()) &&
    typeof failure.retryable === "boolean" &&
    optionalText("requestId") &&
    (failure.httpStatus === undefined ||
      (typeof failure.httpStatus === "number" && Number.isInteger(failure.httpStatus) && failure.httpStatus >= 100 && failure.httpStatus <= 599)) &&
    (failure.retryAt === undefined ||
      (typeof failure.retryAt === "number" && Number.isFinite(failure.retryAt) && failure.retryAt > 0));
}

/** Runtime guard for the live canonical-event boundary. The server deliberately
 * keeps malformed frames observable on its SSE stream for diagnostics, but a
 * renderer must never accept a shape that can make `blocks.some()` throw. */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.id !== null && typeof event.id !== "string") return false;
  if (typeof event.role !== "string" || !Array.isArray(event.blocks)) return false;
  if (
    event.retracts !== undefined &&
    (!Array.isArray(event.retracts) || event.retracts.length > SESSION_RETRACT_CAP ||
      event.retracts.some((id) => typeof id !== "string" || !id.trim() || id.startsWith("terminal:")))
  ) return false;
  return event.blocks.every(
    (block) => Boolean(block) && typeof block === "object" && !Array.isArray(block) && typeof (block as Record<string, unknown>).type === "string"
  );
}

/** Text blocks inside one assistant envelope are fragments of the same message. */
export function sessionEventText(event: SessionEvent): string {
  return (event.blocks ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

/** The final response carried on a typed turn boundary, if present. Some SDK
 * failures/recoveries have no separate final text envelope. */
export function sessionEventTerminalText(event: SessionEvent): string {
  for (let index = event.blocks.length - 1; index >= 0; index -= 1) {
    const block = event.blocks[index];
    if (block.type === "turn_end" && typeof block.result === "string" && block.result.trim()) return block.result;
  }
  return "";
}

/**
 * Flatten assistant journal envelopes into display beats without losing their
 * chronology. Adjacent text blocks inside one SDK envelope are fragments of the
 * same message and coalesce; thinking and tool-use blocks remain in-place between
 * prose beats instead of being hoisted below all live text.
 */
export function sessionActivityBeats(events: SessionEvent[]): SessionActivityBeat[] {
  const beats: SessionActivityBeat[] = [];
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    for (let blockIndex = 0; blockIndex < event.blocks.length; blockIndex += 1) {
      const block = event.blocks[blockIndex];
      if (block.type === "text" && typeof block.text === "string") {
        const previous = beats[beats.length - 1];
        if (previous?.type === "text" && previous.eventIndex === eventIndex) {
          previous.text += block.text;
        } else {
          beats.push({ type: "text", eventIndex, blockIndex, text: block.text });
        }
      } else if (block.type === "error" && typeof block.text === "string" && block.text.trim() !== "") {
        beats.push({ type: "error", eventIndex, blockIndex, text: block.text, block });
      } else if (block.type === "rate_limit") {
        const status = String(block.status ?? "").toLowerCase();
        const overageStatus = String(block.overageStatus ?? "").toLowerCase();
        // Routine allowed telemetry is retained durably but does not interrupt the
        // conversation. A warning/rejection in either window is user-visible.
        if (status !== "allowed" || (overageStatus && overageStatus !== "allowed")) {
          beats.push({ type: "rate_limit", eventIndex, blockIndex, block });
        }
      } else if (block.type === "retry" || block.type === "route" || block.type === "turn_end") {
        beats.push({ type: block.type, eventIndex, blockIndex, block });
      } else if (
        block.type === "status" &&
        (block.subtype === "api_retry" || block.subtype === "model_refusal_fallback")
      ) {
        // Migration compatibility for durable M2/M5 rows produced before the
        // typed retry block existed.
        beats.push({ type: "status", eventIndex, blockIndex, block });
      } else if (block.type === "thinking" || block.type === "tool_use" || block.type === "permission_request") {
        beats.push({ type: block.type, eventIndex, blockIndex, block });
      } else if (block.type === "stretch" || block.type === "ledger") {
        // Conversation ledger rows are chronological facts about the work, not
        // decoration: they interleave with the prose rather than being hoisted.
        beats.push({ type: block.type, eventIndex, blockIndex, block });
      }
    }
  }
  return beats;
}

/**
 * Group the flat Claude/Agent SDK journal into conversational turns. A real user
 * message starts a turn; user-shaped tool-result rows remain attached to the
 * preceding assistant tool and never open a new visual message. Assistant-only
 * journals (for example a recovered kickoff) receive stable synthetic turns,
 * split only when their exact non-null turn coordinate changes.
 */
export function groupSessionTurns(events: SessionEvent[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  let current: SessionTurn | null = null;
  let currentAssistantTurnId: string | null = null;
  const assistantTurnId = (event: SessionEvent): string | null => {
    if (typeof event.turnId === "number" && Number.isFinite(event.turnId)) return String(event.turnId);
    if (typeof event.turnId !== "string") return null;
    const value = event.turnId.trim();
    return value || null;
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.role === "user" && !event.toolResultsOnly) {
      current = {
        key: event.id || `user-turn-${index}`,
        userEvents: [event],
        assistantEvents: [],
      };
      turns.push(current);
      currentAssistantTurnId = null;
      continue;
    }
    if (event.role !== "assistant") continue;
    const eventTurnId = assistantTurnId(event);
    // Thread-level recovery intentionally excludes the raw human prompt because
    // the chat already owns that bubble. Its assistant-only canonical chain still
    // needs conversational boundaries. Split only synthetic (no real user row)
    // turns with established, differing exact coordinates; null/legacy streams
    // retain their historical grouping.
    if (
      current && current.userEvents.length === 0 && current.assistantEvents.length > 0 &&
      currentAssistantTurnId !== null && eventTurnId !== null && currentAssistantTurnId !== eventTurnId
    ) {
      current = null;
    }
    if (!current) {
      current = {
        key: event.id ? `assistant-turn-${event.id}` : `assistant-turn-${index}`,
        userEvents: [],
        assistantEvents: [],
      };
      turns.push(current);
    }
    current.assistantEvents.push(event);
    if (eventTurnId !== null) currentAssistantTurnId = eventTurnId;
  }
  return turns;
}

/** Select the one text surface a visual assistant turn should show. */
export function presentSessionTurn(turn: SessionTurn, live: boolean): SessionTurnPresentation {
  const textual = turn.assistantEvents
    .map((event, eventIndex) => ({ eventIndex, text: sessionEventTerminalText(event) || sessionEventText(event) }))
    .filter((entry) => entry.text.trim() !== "");
  if (live) {
    return {
      primaryText: textual.map((entry) => entry.text).join("\n\n"),
      interimText: [],
      finalTextEventIndex: null,
    };
  }
  const final = textual[textual.length - 1] ?? null;
  return {
    primaryText: final?.text ?? "",
    interimText: final ? textual.slice(0, -1).map((entry) => entry.text) : [],
    finalTextEventIndex: final?.eventIndex ?? null,
  };
}

export function parseToolInput(input: unknown): JsonRecord | null {
  if (!input) return null;
  if (typeof input === "object" && !Array.isArray(input)) return input as JsonRecord;
  if (typeof input !== "string") return null;
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
      (typeof block.input === "string" ? block.input : JSON.stringify(block.input))
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

/** Whether a turn has canonical assistant activity that belongs in the primary
 * bubble. Tool results/progress are attachments to a visible tool_use and do not
 * create a timeline on their own; terminal text and errors are independently
 * visible so a recovered turn cannot disappear when no text envelope survived. */
export function hasVisibleSessionActivity(events: SessionEvent[]): boolean {
  return events.some(
    (event) =>
      event.role === "assistant" &&
      !event.toolResultsOnly &&
      event.blocks.some(
        (block) =>
          (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") ||
          (block.type === "error" && typeof block.text === "string" && block.text.trim() !== "") ||
          block.type === "retry" ||
          block.type === "route" ||
          block.type === "turn_end" ||
          (block.type === "rate_limit" && (
            String(block.status ?? "").toLowerCase() !== "allowed" ||
            Boolean(block.overageStatus && String(block.overageStatus).toLowerCase() !== "allowed")
          )) ||
          (block.type === "status" && (block.subtype === "api_retry" || block.subtype === "model_refusal_fallback")) ||
          block.type === "thinking" ||
          block.type === "tool_use" ||
          block.type === "permission_request" ||
          // A conversation event may be the ONLY thing a turn carries (a stretch
          // boundary, a handoff): without these two the turn renders as empty.
          block.type === "stretch" ||
          block.type === "ledger"
      )
  );
}

function canonicalRevision(event: SessionEvent): number | null {
  const revision = event.revision;
  return typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? revision : null;
}

/** Decide whether a stable-id snapshot may replace the first-seen slot.
 * Canonical revisions are strict: newer wins; equal/lower is an idempotent
 * no-op. A canonical snapshot also outranks a legacy unrevisioned row, while an
 * unrevisioned replay can never erase canonical live state. Two legacy rows keep
 * the historical latest-wins behavior used by transcript polling. */
function shouldReplaceSessionEvent(current: SessionEvent, incoming: SessionEvent): boolean {
  const currentRevision = canonicalRevision(current);
  const incomingRevision = canonicalRevision(incoming);
  if (currentRevision !== null && incomingRevision !== null) return incomingRevision > currentRevision;
  if (currentRevision !== null) return false;
  if (incomingRevision !== null) return true;
  return current !== incoming;
}

/**
 * Merge a streamed journal batch by stable event identity. Ordinary append-only
 * rows retain their order; snapshot rows may replace themselves in place as
 * status, progress, or an opaque child-stream URL becomes available.
 */
export function mergeSessionEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (!incoming.length) return current;
  let next = current;
  let indexes = new Map<string, number>();
  const tombstones = new Set<string>();
  const retractionsFor = (event: SessionEvent): string[] => {
    const ids = Array.isArray(event.retracts) ? event.retracts : [];
    return [...new Set(ids.map((id) => String(id).trim()).filter(
      (id) => id && id !== event.id && !id.startsWith("terminal:")
    ))]
      .slice(0, SESSION_RETRACT_CAP);
  };
  const rebuildIndexes = () => {
    indexes = new Map<string, number>();
    next.forEach((event, index) => { if (event.id && !indexes.has(event.id)) indexes.set(event.id, index); });
  };
  current.forEach((event) => retractionsFor(event).forEach((id) => tombstones.add(id)));
  rebuildIndexes();
  for (const event of incoming) {
    const index = event.id ? indexes.get(event.id) : undefined;
    if (event.id && tombstones.has(event.id)) continue;
    if (index !== undefined && !shouldReplaceSessionEvent(next[index], event)) continue;

    const retracts = retractionsFor(event);
    if (retracts.length) {
      retracts.forEach((id) => tombstones.add(id));
      const filtered = next.filter((candidate) => !candidate.id || !tombstones.has(candidate.id));
      if (filtered.length !== next.length) {
        next = filtered;
        rebuildIndexes();
      }
    }

    const acceptedIndex = event.id ? indexes.get(event.id) : undefined;
    if (acceptedIndex === undefined) {
      if (next === current) next = current.slice();
      next.push(event);
    } else {
      if (next === current) next = current.slice();
      // A newer revision may omit tombstones that were already accepted on this
      // stable event. Carry them forward so a later replay cannot resurrect the
      // retracted row merely because only the newest snapshot was persisted.
      const retainedRetracts = [...new Set([
        ...retractionsFor(next[acceptedIndex]),
        ...retracts,
      ])].slice(0, SESSION_RETRACT_CAP);
      next[acceptedIndex] = retainedRetracts.length
        ? { ...event, retracts: retainedRetracts }
        : event;
    }
    rebuildIndexes();
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

/**
 * Drop the exit contract's \`\`\`handoff fence (and everything after it) from a
 * conversation stretch's displayed prose. The fence is protocol addressed to
 * the exit gate - already extracted, validated and preserved in the store - and
 * by contract it is the TAIL of the reply, so cutting from the opener is also
 * exactly right mid-stream (the partial fence never flashes raw JSON).
 */
export function stripHandoffFence(text: string): string {
  const index = text.indexOf("```handoff");
  return index === -1 ? text : text.slice(0, index).trimEnd();
}

// ── Conversation activity ───────────────────────────────────────────────────

/**
 * What a conversation is doing RIGHT NOW, derived purely from its rendered
 * events. `none` means the events carry no conversation spine at all (a plain
 * runtime session) - every consumer should treat that as "this derivation does
 * not apply", not as idle.
 *
 * The launcher's real state machine lives server-side; this is the client's
 * honest reconstruction from the ledger, and it deliberately says `idle` when
 * the record is too old to carry `next` on its stretch boundaries.
 */
export type ConversationActivityMode =
  | "none"
  | "idle"
  | "starting"
  | "working"
  | "handoff"
  | "awaiting-approval"
  | "needs-input"
  | "done";

export interface ConversationActivity {
  mode: ConversationActivityMode;
  /** Duty of the governing stretch (the running one, or the last ended one). */
  duty: string | null;
  model: string | null;
  /** Where the last handoff pointed (`done`, `needs-input`, or a duty). */
  next: string | null;
  summary: string | null;
  blockerWhat: string | null;
  blockerNeeds: string | null;
  blockerWho: string | null;
  /** Epoch ms of the event that established this mode - the spinner's elapsed base. */
  since: number | null;
}

function activityLabel(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Derive the conversation's current activity from its event stream.
 *
 * Position comparisons use ARRAY ORDER, which is chronological for everything
 * that matters here: a stretch's `ended` block revises its `started` slot in
 * place, so the slot position is the stretch's START - and a user message or an
 * approval ask that arrived after the stretch began always sits later in the
 * array, which is exactly the "who moved last" question this answers.
 */
export function conversationActivity(events: SessionEvent[]): ConversationActivity {
  let sawSpine = false;
  let stretchIndex = -1;
  let stretch: SessionBlock | null = null;
  let stretchTs: number | null = null;
  let approvalIndex = -1;
  let approvalTs: number | null = null;
  let userIndex = -1;
  let userTs: number | null = null;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.role === "user") {
      // Only a HUMAN message counts. The runtime tee also writes user-SHAPED
      // events (tool results ride as role "user" with toolResultsOnly in the
      // canonical vocabulary), and counting one of those made every finished
      // stretch read as "a message is waiting".
      const isMessage = !event.toolResultsOnly &&
        (event.blocks ?? []).some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "");
      if (isMessage) {
        userIndex = index;
        userTs = typeof event.ts === "number" ? event.ts : null;
      }
      continue;
    }
    for (const block of event.blocks ?? []) {
      if (block.type === "stretch") {
        sawSpine = true;
        stretchIndex = index;
        stretch = block;
        stretchTs = typeof event.ts === "number" ? event.ts : null;
      } else if (block.type === "ledger") {
        sawSpine = true;
        if (block.kind === "approval-requested") {
          approvalIndex = index;
          approvalTs = typeof event.ts === "number" ? event.ts : null;
        }
      }
    }
  }

  const empty: Omit<ConversationActivity, "mode" | "since"> = {
    duty: null,
    model: null,
    next: null,
    summary: null,
    blockerWhat: null,
    blockerNeeds: null,
    blockerWho: null,
  };
  if (!sawSpine) return { mode: "none", ...empty, since: null };

  const attribution = (stretch?.attribution ?? {}) as Record<string, unknown>;
  const detail: Omit<ConversationActivity, "mode" | "since"> = {
    duty: activityLabel(stretch?.duty),
    model: activityLabel(attribution.model),
    next: activityLabel(stretch?.next),
    summary: activityLabel(stretch?.summary),
    blockerWhat: activityLabel(stretch?.blockerWhat),
    blockerNeeds: activityLabel(stretch?.blockerNeeds),
    blockerWho: activityLabel(stretch?.blockerWho),
  };

  // A user message after everything else: the launcher owes the next stretch.
  if (userIndex > stretchIndex && userIndex > approvalIndex) {
    return { mode: "starting", ...detail, since: userTs };
  }
  // An unanswered approval ask after the last stretch boundary.
  if (approvalIndex > stretchIndex) {
    return { mode: "awaiting-approval", ...detail, since: approvalTs };
  }
  if (stretch && stretch.phase === "started") {
    return { mode: "working", ...detail, since: stretchTs };
  }
  if (stretch && stretch.phase === "ended") {
    if (detail.next === "needs-input") return { mode: "needs-input", ...detail, since: stretchTs };
    if (detail.next === "done") return { mode: "done", ...detail, since: stretchTs };
    // A named duty: the exit gate accepted the handoff and the launcher is
    // choosing what runs next. A record too old to carry `next` reads idle -
    // claiming a spinner for it would be a guess.
    if (detail.next) return { mode: "handoff", ...detail, since: stretchTs };
  }
  return { mode: "idle", ...detail, since: stretchTs };
}
