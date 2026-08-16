import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import yaml from "highlight.js/lib/languages/yaml";
import sql from "highlight.js/lib/languages/sql";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import diff from "highlight.js/lib/languages/diff";
import { isChatInputReceipt } from "./transport";
import type {
  ChatEvent,
  ChatFrameCoordinate,
  ChatInputReceipt,
  ChatInputState,
  ChatSendMeta as TransportChatSendMeta,
  ChatTransport,
  ClaudeStatus,
  PermissionMode,
  RouteAttribution,
  SlashCommand,
  ToolQuestion,
  TurnRouting,
} from "./transport";
import { AttributionRail, type PinField, type PinPatch, type RailOptions } from "./AttributionRail";
import {
  getChatMode,
  resolvedChatScheme,
  setChatMode,
  subscribeChatTheme,
  type ChatThemeMode,
} from "./chat-theme";
import { createVoiceClient, type VoiceClient, type VoiceHealth } from "./voice";
import { sanitizeAssistantBadges, sanitizeAssistantText, routeChipLabel, routeChipFromAttribution } from "./sanitize";
import { rewriteHostUrl, filePathMarkedExtension, type HostContext } from "./host-rewrite";
import {
  escapeMarkdownHtml,
  hostCtx,
  installSafeMarkdownRenderer,
  loadHostMap,
} from "./markdown-safety";
import { SessionEventTimeline, SessionStream } from "./SessionTranscript";
import {
  hasVisibleSessionActivity,
  isSessionEvent,
  mergeSessionEvents,
  sessionEventText,
  type SessionEvent,
} from "./journal";

// A PRIVATE marked instance for the chat. We deliberately do NOT mutate the
// process-wide `marked` singleton: the chat-specific link/code renderers
// (cross-fitting links, the .cc-codeblock card) must never leak into any other
// `marked.parse()` consumer that happens to share this bundle.
const md = new Marked({ breaks: true, gfm: true });

// Syntax highlighting for fenced code blocks. A curated language set keeps the
// bundle small while covering what the Operative emits most (TS/JS/py/shell/json
// /css/html/yaml/sql/rust/go/diff/markdown). hljs token classes (.hljs-*) are
// coloured in claude-chat.css against theme-driven CSS vars, so the same output
// reads on the dark code card (web-channel + dev-env dark) and the light one
// (dev-env light).
for (const [name, lang] of Object.entries({
  typescript, javascript, python, bash, json, css, xml, markdown, yaml, sql, rust, go, diff,
})) {
  try { hljs.registerLanguage(name, lang as any); } catch { /* already registered */ }
}

// Write to the clipboard, resolving to whether it actually succeeded. Guards an
// absent Clipboard API (insecure context / older webview) AND a rejected write
// (denied permission, unfocused document) so callers never flash a false
// "Copied" or throw on a missing API.
function writeClipboard(text: string): Promise<boolean> {
  const cb = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!cb?.writeText) return Promise.resolve(false);
  return cb.writeText(text).then(() => true, () => false);
}

// Generic link handling for rendered assistant markdown. Content-agnostic (no
// kanban / dev-env knowledge):
//   1. `garrison://<fitting-id>/<rest>` cross-fitting links → `/fitting/<id>/<rest>`
//      (the UI-contract-v2 translation), so a produced doc/artifact link the
//      Operative emits is a real, clickable link, never shown raw.
//   2. http(s) links open in a new tab (rel=noopener) so following a produced
//      document doesn't tear down the live chat.
//   3. UNSAFE schemes (javascript:/data:/…) are NOT linkified - the text is kept,
//      the dangerous href is dropped. href/title are HTML-attribute-escaped.
// Additive: only the <a> attributes change; link text/structure is untouched, so
// dev-env's existing rendering is unaffected (and safer).
installSafeMarkdownRenderer(md, hostCtx);
md.use({
  renderer: {
    // Rich fenced code block: a dark "card" with a header (uppercase mono
    // language label + a Copy button) over a syntax-highlighted <pre>. The Copy
    // button carries no inline handler (the markdown is injected via
    // dangerouslySetInnerHTML); a single delegated click handler on the scroll
    // container (onCodeCopyClick) reads the block's text and writes the
    // clipboard. Highlighting is applied for known languages; unknown/none falls
    // back to escaped plain text. Additive: only `<pre><code>` markup changes,
    // so dev-env keeps working (and gains highlighting too).
    code({ text, lang }: { text: string; lang?: string }) {
      // marked stores the WHOLE fence info-string in `lang` (e.g.
      // `ts title="x.ts"` or `python {1,3}`); the language is just its first
      // whitespace-delimited token. Use that, or both the highlight lookup and
      // the label break for any annotated fence.
      const language = (lang || "").trim().split(/\s+/)[0].toLowerCase();
      let body: string;
      if (language && hljs.getLanguage(language)) {
        try {
          body = hljs.highlight(text, { language, ignoreIllegals: true }).value;
        } catch {
          body = escapeMarkdownHtml(text);
        }
      } else {
        body = escapeMarkdownHtml(text);
      }
      const label = escapeMarkdownHtml(language || "text");
      return (
        `<div class="cc-codeblock">` +
        `<div class="cc-codehead">` +
        `<span class="cc-codelang">${label}</span>` +
        `<button type="button" class="cc-codecopy" aria-label="Copy code">Copy</button>` +
        `</div>` +
        `<pre class="hljs"><code>${body}</code></pre>` +
        `</div>`
      );
    },
  },
});
// Render bare absolute filesystem paths (uploaded attachments, run artifacts) as
// inline images / same-origin /file links (issue #2/#4). Never fires inside code
// (marked tokenizes fences/spans separately).
md.use({ extensions: [filePathMarkedExtension()] });

function renderChatMarkdown(text: string): string {
  return md.parse(text) as string;
}

/** Canonical assistant blocks cross the same display sanitizer as the legacy
 * scraped reply, so control tokens never leak beside the structured route rail. */
function renderAssistantMarkdown(text: string): string {
  return renderChatMarkdown(sanitizeAssistantBadges(text).text);
}

// Persisted thread history bypasses the live Web Channel transport normaliser.
// Rewrite at the final render boundary as well, so a reloaded card badge can
// never hand a remote browser the board machine's 127.0.0.1 URL.
export function rewriteRouteForHost(
  route: RouteAttribution | null | undefined,
  ctx: HostContext
): RouteAttribution | null | undefined {
  if (!route || typeof route.cardUrl !== "string") return route;
  const cardUrl = rewriteHostUrl(route.cardUrl, ctx);
  return cardUrl === route.cardUrl ? route : { ...route, cardUrl };
}

// ── Composer draft persistence (unsent text + attachments) ──────────────────
// A multi-thread host re-mounts ClaudeChat with a fresh key on a thread switch,
// which drops the composer state. When a `draftKey` is present we mirror the
// draft to sessionStorage under it: the text, and any SETTLED attachment (one
// whose upload finished, so it carries a server `path`). Mid-upload attachments
// and their objectURL previews are not serialisable and are skipped; a restored
// attachment shows its name (no thumbnail) and still sends by path. Best-effort:
// every storage access is guarded so a disabled/full store never breaks typing.
const DRAFT_TEXT_PREFIX = "cc-draft-text:";
const DRAFT_ATTACH_PREFIX = "cc-draft-attach:";

function loadDraftText(key?: string): string {
  if (!key || typeof sessionStorage === "undefined") return "";
  try {
    return sessionStorage.getItem(DRAFT_TEXT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

function loadDraftAttachments(key?: string): PendingAttachment[] {
  if (!key || typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(DRAFT_ATTACH_PREFIX + key);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((a) => a && typeof a.path === "string" && a.path)
      .map((a) => ({
        id: String(a.id),
        name: String(a.name || "file"),
        path: a.path as string,
        uploading: false,
        error: null,
        previewUrl: null,
      }));
  } catch {
    return [];
  }
}

function saveDraft(key: string | undefined, text: string, attachments: PendingAttachment[]): void {
  if (!key || typeof sessionStorage === "undefined") return;
  try {
    if (text) sessionStorage.setItem(DRAFT_TEXT_PREFIX + key, text);
    else sessionStorage.removeItem(DRAFT_TEXT_PREFIX + key);
    const settled = attachments
      .filter((a) => a.path && !a.uploading)
      .map((a) => ({ id: a.id, name: a.name, path: a.path }));
    if (settled.length) sessionStorage.setItem(DRAFT_ATTACH_PREFIX + key, JSON.stringify(settled));
    else sessionStorage.removeItem(DRAFT_ATTACH_PREFIX + key);
  } catch {
    /* best-effort: a disabled/full sessionStorage must never break the composer */
  }
}

interface Turn {
  id: string;
  user: string;
  assistant: string;
  streaming: boolean;
  /** Monotonic per-send turn number, stamped by {@link send}. A `route`/`activity`
   *  frame carries the seq of the send it belongs to, so a LATE frame from an
   *  already-superseded turn is dropped instead of landing on this bubble. Turns
   *  this client did not send (a reload rebinding a server-side turn, seeded
   *  history) carry 0 - the same value an unstamped transport reports. */
  seq: number;
  /** Canonical Agent SDK activity for this exchange. Stable-id revisions replace
   * themselves in place; this timeline supersedes the legacy assistant scrape
   * when it contains visible text/thinking/tool activity. */
  sessionEvents: SessionEvent[];
  /** Hide the user bubble for this turn (e.g. a host kickoff that primes the operative
   *  but shouldn't be shown as a chat message - the reply still renders normally). */
  hideUser?: boolean;
  /** An AskUserQuestion the operative raised during this turn (D28). Rendered as
   *  tappable option buttons; answered via transport.answerQuestion. Only the first
   *  question is answerable (the TUI picker is one widget). */
  question?: { toolUseId: string; questions: ToolQuestion[] };
  /** The label/text the user chose for `question` (set on tap; disables the buttons
   *  and renders as the user's message). */
  answered?: string;
  /** True while the answer POST is in flight (buttons show a pending state). */
  answering?: boolean;
  /** Safe, retryable answer-delivery failure. The transport's raw error is not
   * rendered because it may contain server markup or operational detail. */
  questionError?: string;
  /** Structured runtime attribution for this turn's reply (gateway `done`
   *  payload → transport `route` event). The Turn Rail renders this; the legacy
   *  routing chip is the fallback for a turn that carries none (a pre-migration
   *  persisted turn, or a lane that reports nothing). */
  route?: RouteAttribution;
  /** The pins that were in force when this turn was SENT (the intent), kept apart
   *  from `route` (what actually ran) so a refused pin can never read as honored. */
  overrides?: TurnRouting;
  /** Orchestrated input identity. The browser owns only clientRequestId; inputId
   * and generationId are bound from the host receipt/lifecycle stream. */
  clientRequestId?: string;
  inputId?: string;
  generationId?: string;
  inputState?: ChatInputState;
  inputPosition?: number;
  inputReason?: string;
  inputAcceptedAt?: string;
  /** Last runtime activity for this exact generated turn. */
  activity?: string;
  /** Exact interrupt failure. It belongs to this turn and cannot leak onto a
   * newer generation that starts while a retry is visible. */
  stopError?: string;
}

export interface GeneratedTurnCoordinate extends ChatFrameCoordinate {
  clientRequestId?: string;
}

export interface GeneratedTurnState extends GeneratedTurnCoordinate {
  streaming: boolean;
  inputState?: ChatInputState;
  inputPosition?: number;
  inputReason?: string;
  inputAcceptedAt?: string;
  stopError?: string;
}

function generatedCoordinateKeys(coordinate: GeneratedTurnCoordinate): string[] {
  const keys: string[] = [];
  if (coordinate.clientRequestId) keys.push(`client:${coordinate.clientRequestId}`);
  if (coordinate.inputId) keys.push(`input:${coordinate.inputId}`);
  if (coordinate.generationId) keys.push(`generation:${coordinate.generationId}`);
  return keys;
}

/** One generated frame may arrive after a newer input was queued. Resolve only
 * an explicit, non-conflicting identity; there is deliberately no trailing-turn
 * fallback on this path. */
export function findGeneratedTurnIndex(
  turns: readonly GeneratedTurnCoordinate[],
  coordinate: GeneratedTurnCoordinate
): number {
  const fields: (keyof GeneratedTurnCoordinate)[] = ["clientRequestId", "inputId", "generationId"];
  const matched = new Set<number>();
  let supplied = false;
  for (const field of fields) {
    const value = coordinate[field];
    if (typeof value !== "string" || !value.trim()) continue;
    supplied = true;
    const indices: number[] = [];
    turns.forEach((turn, index) => {
      if (turn[field] === value) indices.push(index);
    });
    // Duplicate durable coordinates are unsafe to guess between.
    if (indices.length > 1) return -1;
    if (indices.length === 1) matched.add(indices[0]);
  }
  if (!supplied || matched.size !== 1) return -1;
  const index = [...matched][0];
  for (const field of fields) {
    const incoming = coordinate[field];
    const existing = turns[index][field];
    if (
      typeof incoming === "string" && incoming.trim() &&
      typeof existing === "string" && existing.trim() &&
      incoming !== existing
    ) return -1;
  }
  return index;
}

export function applyGeneratedTurn<T extends GeneratedTurnCoordinate>(
  turns: readonly T[],
  coordinate: GeneratedTurnCoordinate,
  update: (turn: T) => T
): T[] {
  const index = findGeneratedTurnIndex(turns, coordinate);
  if (index < 0) return turns as T[];
  const updated = update(turns[index]);
  const bindings: GeneratedTurnCoordinate = {};
  if (!updated.clientRequestId && coordinate.clientRequestId) bindings.clientRequestId = coordinate.clientRequestId;
  if (!updated.inputId && coordinate.inputId) bindings.inputId = coordinate.inputId;
  if (!updated.generationId && coordinate.generationId) bindings.generationId = coordinate.generationId;
  const nextTurn = Object.keys(bindings).length ? { ...updated, ...bindings } : updated;
  if (nextTurn === turns[index]) return turns as T[];
  const next = turns.slice() as T[];
  next[index] = nextTurn;
  return next;
}

const INPUT_STATE_ORDER: Record<ChatInputState, number> = {
  queued: 0,
  starting: 1,
  running: 2,
  stopping: 3,
  settled: 4,
  stopped: 4,
  failed: 4,
};

export function isActiveInputState(state?: ChatInputState): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}

export function isPendingInputState(state?: ChatInputState): boolean {
  return state === "queued" || isActiveInputState(state);
}

export function inputLifecycleAnnouncement(input: Pick<ChatInputReceipt, "state" | "position" | "reason">): string {
  const position = typeof input.position === "number" && Number.isFinite(input.position)
    ? Math.max(0, Math.trunc(input.position))
    : null;
  const reason = typeof input.reason === "string" ? input.reason.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  switch (input.state) {
    case "queued": return position && position > 0 ? `Message queued, position ${position}.` : "Message queued.";
    case "starting": return "Starting response.";
    case "running": return "Response started.";
    case "stopping": return "Stopping current response.";
    case "settled": return "Response complete.";
    case "stopped": return "Response stopped.";
    case "failed": return reason ? `Message failed: ${reason}.` : "Message failed.";
  }
}

/** Bind a host receipt or lifecycle event to its optimistic turn. State never
 * regresses when the POST receipt races a newer SSE update. */
export function applyInputLifecycle<T extends GeneratedTurnState>(
  turns: readonly T[],
  input: ChatInputReceipt
): T[] {
  return applyGeneratedTurn(turns, input, (turn) => {
    if (turn.inputId && turn.inputId !== input.inputId) return turn;
    if (turn.generationId && input.generationId && turn.generationId !== input.generationId) return turn;
    if (turn.clientRequestId && turn.clientRequestId !== input.clientRequestId) return turn;

    const currentState = turn.inputState;
    const currentTerminal = currentState ? INPUT_STATE_ORDER[currentState] === 4 : false;
    // The first host binding replaces our optimistic guess even when the host
    // says `queued` after we painted `starting`. Once inputId is bound, only
    // monotonic lifecycle movement is accepted, so a late POST receipt cannot
    // regress a newer SSE `running`/terminal event.
    const stateAdvances = !currentState || !turn.inputId || currentState === input.state ||
      (!currentTerminal && INPUT_STATE_ORDER[input.state] >= INPUT_STATE_ORDER[currentState]);
    const nextState = stateAdvances ? input.state : currentState;
    const nextStreaming = isActiveInputState(nextState);
    const position = typeof input.position === "number" && Number.isFinite(input.position)
      ? Math.max(0, Math.trunc(input.position))
      : turn.inputPosition;
    const next: T = {
      ...turn,
      clientRequestId: turn.clientRequestId ?? input.clientRequestId,
      inputId: turn.inputId ?? input.inputId,
      generationId: turn.generationId ?? input.generationId,
      inputState: nextState,
      inputPosition: position,
      inputAcceptedAt: turn.inputAcceptedAt ?? input.acceptedAt,
      inputReason: stateAdvances && input.reason !== undefined ? input.reason : turn.inputReason,
      streaming: nextStreaming,
      ...(stateAdvances && INPUT_STATE_ORDER[input.state] === 4 ? { stopError: undefined } : {}),
    };
    const unchanged =
      next.clientRequestId === turn.clientRequestId &&
      next.inputId === turn.inputId &&
      next.generationId === turn.generationId &&
      next.inputState === turn.inputState &&
      next.inputPosition === turn.inputPosition &&
      next.inputAcceptedAt === turn.inputAcceptedAt &&
      next.inputReason === turn.inputReason &&
      next.streaming === turn.streaming &&
      next.stopError === turn.stopError;
    return unchanged ? turn : next;
  });
}

/** The slice of {@link Turn} the route-frame reducer reads. Exported so the frame
 *  discipline is testable without React. */
export interface RouteFrameTurn {
  seq: number;
  streaming: boolean;
  route?: RouteAttribution;
}

/** The slice of Turn used by the canonical event attachment reducer. */
export interface SessionEventTurn {
  seq: number;
  streaming: boolean;
  sessionEvents: SessionEvent[];
}

function numericSessionTurnId(value: SessionEvent["turnId"]): number | null {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Attach one canonical runtime event to its chat exchange.
 *
 * A numeric turnId first targets the matching Turn.seq, including a late event
 * for a historical turn. If a client reloaded and only knows seq 0, or its
 * current streaming turn predates a newer server counter, the latest turn may be
 * rebound and adopts that counter. Unstamped events may fall back only to the
 * latest streaming/reloaded turn; a settled identified turn is never guessed.
 */
export function applySessionEvent<T extends SessionEventTurn>(turns: T[], event: SessionEvent): T[] {
  if (turns.length === 0 || !isSessionEvent(event)) return turns;
  const turnId = numericSessionTurnId(event.turnId);
  let index = -1;
  if (turnId !== null) {
    for (let candidate = turns.length - 1; candidate >= 0; candidate -= 1) {
      if (turns[candidate].seq === turnId) {
        index = candidate;
        break;
      }
    }
  }

  let adoptTurnId = false;
  if (index === -1) {
    const latestIndex = turns.length - 1;
    const latest = turns[latestIndex];
    if (turnId === null) {
      if (!latest.streaming && latest.seq !== 0) return turns;
    } else if (latest.seq === 0 || (latest.streaming && turnId > latest.seq)) {
      adoptTurnId = latest.seq !== turnId;
    } else {
      return turns;
    }
    index = latestIndex;
  }

  const target = turns[index];
  const sessionEvents = mergeSessionEvents(target.sessionEvents, [event]);
  if (sessionEvents === target.sessionEvents && !adoptTurnId) return turns;
  const copy = turns.slice();
  copy[index] = {
    ...target,
    ...(adoptTurnId && turnId !== null ? { seq: turnId } : {}),
    sessionEvents,
  };
  return copy;
}

/** Change only the trailing exchange's live/settled presentation. This is used
 * by both the HTTP `hello.busy` rebind and Web replay's `turn active` signal. */
export function applyTurnActive<T extends { streaming: boolean }>(turns: T[], active: boolean): T[] {
  if (turns.length === 0) return turns;
  const index = turns.length - 1;
  if (turns[index].streaming === active) return turns;
  const copy = turns.slice();
  copy[index] = { ...turns[index], streaming: active };
  return copy;
}

function canonicalResponseCandidates(events: SessionEvent[]): string[] {
  const candidates: string[] = [];
  for (const event of events) {
    if (event.role !== "assistant") continue;
    const text = sessionEventText(event);
    if (text.trim()) candidates.push(text);
    for (const block of event.blocks) {
      if (block.type === "error" && typeof block.text === "string" && block.text.trim()) {
        candidates.push(block.text);
      } else if (block.type === "turn_end" && typeof block.result === "string" && block.result.trim()) {
        candidates.push(block.result);
      }
    }
  }
  return candidates;
}

/** Latest canonical response/error text, including the authoritative result on
 * a typed turn boundary when no final assistant envelope survived. */
export function canonicalAssistantReply(events: SessionEvent[]): string {
  return canonicalResponseCandidates(events).at(-1) ?? "";
}

/** A successful typed turn boundary is the runtime's final answer authority. It
 * outranks the parallel legacy accumulator, which may still contain a streamed
 * draft or the channel's empty-reply fallback. Error/cancelled boundaries do not
 * use this override: their differing durable fallback remains useful context. */
function canonicalSuccessfulTerminalReply(events: SessionEvent[]): string {
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const event = events[eventIndex];
    if (event.role !== "assistant") continue;
    for (let blockIndex = event.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = event.blocks[blockIndex];
      if (
        block.type === "turn_end" &&
        block.status === "completed" &&
        typeof block.result === "string" &&
        block.result.trim()
      ) {
        return block.result;
      }
    }
  }
  return "";
}

interface AssistantTextTurn {
  assistant: string;
  sessionEvents: SessionEvent[];
}

/** Text used by copy, TTS, composer adornments, and completion callbacks. A
 * successful typed terminal result is authoritative; otherwise real legacy TUI
 * prose remains primary and canonical-only recovery supplies empty accumulators. */
export function resolvedAssistantText(turn: AssistantTextTurn): string {
  const terminal = canonicalSuccessfulTerminalReply(turn.sessionEvents);
  if (terminal) return sanitizeAssistantBadges(terminal).text;
  const legacy = sanitizeAssistantText(turn.assistant).text;
  if (legacy.trim()) return legacy;
  return sanitizeAssistantBadges(canonicalAssistantReply(turn.sessionEvents)).text;
}

export function resolvedAssistantRaw(turn: AssistantTextTurn): string {
  const terminal = canonicalSuccessfulTerminalReply(turn.sessionEvents);
  if (terminal) return terminal;
  return sanitizeAssistantText(turn.assistant).text.trim()
    ? turn.assistant
    : canonicalAssistantReply(turn.sessionEvents);
}

/** A done/error reply can be more complete than the canonical activity retained
 * before it. Keep it below the timeline unless canonical text already says the
 * same thing, avoiding both hidden failures and duplicate successful replies. */
export function legacyAssistantFallback(assistant: string, events: SessionEvent[]): string {
  const legacy = sanitizeAssistantText(assistant).text;
  if (!legacy.trim()) return "";
  if (canonicalSuccessfulTerminalReply(events)) return "";
  const duplicated = canonicalResponseCandidates(events).some(
    (candidate) => sanitizeAssistantBadges(candidate).text.trim() === legacy.trim()
  );
  return duplicated ? "" : legacy;
}

export function liveSessionAnnouncement(events: SessionEvent[], fallback: string): string {
  const toolNames = new Map<string, string>();
  for (const event of events) {
    for (const block of event.blocks) {
      if (block.type === "tool_use" && block.toolUseId) toolNames.set(block.toolUseId, block.name?.trim() || "Tool");
    }
  }
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const blocks = events[eventIndex].blocks;
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      const blockName = typeof block.name === "string" ? block.name.trim() : "";
      const tool = block.toolUseId ? (toolNames.get(block.toolUseId) ?? blockName) || "Tool" : blockName || "Tool";
      if (block.type === "permission_request") {
        const permissionName =
          (typeof block.displayName === "string" ? block.displayName.trim() : "") ||
          blockName ||
          "tool";
        if (block.status === "cancelled") return `Permission request for ${permissionName} cancelled.`;
        if (block.status === "resolved") {
          if (block.decision === "deny") return `Permission denied for ${permissionName}.`;
          if (block.decision === "allow_always") return `Permission always allowed for ${permissionName}.`;
          if (block.decision === "allow_once") return `Permission allowed once for ${permissionName}.`;
          return `Permission request for ${permissionName} resolved.`;
        }
        return `Permission requested for ${permissionName}.`;
      }
      if (block.type === "error") return "Turn failed.";
      if (block.type === "turn_end") {
        if (block.status === "cancelled") return "Turn cancelled.";
        if (block.status === "error" || block.status === "failed") return "Turn failed.";
        return "Response complete.";
      }
      if (block.type === "tool_result") return `${tool} ${block.isError ? "failed" : "completed"}.`;
      if (block.type === "tool_progress") return `${tool} is running.`;
      if (block.type === "tool_use") return `${tool} started.`;
      if (block.type === "thinking") return "Thinking.";
      if (block.type === "text" && block.text?.trim()) return "Response updating.";
    }
  }
  const hint = fallback.replace(/\s+/g, " ").trim().slice(0, 80);
  return hint ? `Working: ${hint}` : "Working.";
}

function hasCanonicalTurnEnd(events: SessionEvent[]): boolean {
  return events.some((event) => event.blocks.some((block) => block.type === "turn_end"));
}

/** Bind an authoritative active signal to a restored trailing exchange. Partial
 * canonical prose does not make that exchange settled. If the latest exchange
 * already has a durable final reply/boundary, the signal describes a new hidden
 * turn and must not revive history. */
function rebindActiveTurn(turns: Turn[], assistantSnapshot = ""): Turn[] {
  if (turns.length === 0) {
    return [{ id: nextId(), user: "", assistant: assistantSnapshot, streaming: true, hideUser: true, seq: 0, sessionEvents: [] }];
  }
  const last = turns.at(-1)!;
  if (last.streaming) {
    if (!assistantSnapshot.trim() || last.assistant === assistantSnapshot) return turns;
    const copy = turns.slice();
    copy[copy.length - 1] = { ...last, assistant: assistantSnapshot };
    return copy;
  }
  if (last.assistant.trim() || hasCanonicalTurnEnd(last.sessionEvents)) {
    return [...turns, { id: nextId(), user: "", assistant: assistantSnapshot, streaming: true, hideUser: true, seq: 0, sessionEvents: [] }];
  }
  const copy = applyTurnActive(turns, true);
  if (!assistantSnapshot.trim()) return copy;
  copy[copy.length - 1] = { ...copy.at(-1)!, assistant: assistantSnapshot };
  return copy;
}

/**
 * Attach one `route` frame to the turn it belongs to.
 *
 * Two bugs live here and both are load-bearing:
 *
 *  • MERGE, never replace. The gateway emits `route` TWICE - once as soon as
 *    `preRoute` resolves (`pending: true`, so badges appear ~1s in) and once
 *    folded into `done`. A blind write would let the second frame erase whatever
 *    the first one knew (and vice versa).
 *  • DROP a stale frame. The old handler wrote unconditionally to
 *    `copy[copy.length - 1]`, so a frame that arrived after the next turn had
 *    started stamped its routing onto the WRONG bubble. A frame whose `turnSeq`
 *    is older than the current turn's is discarded outright - "fall back to the
 *    last turn" is exactly the misattribution bug.
 *
 * An UNSTAMPED frame (no `turnSeq`) still lands on the latest turn: dev-env's
 * `/claude/stream` speaks the same event shape without a per-send counter, and
 * dropping there would make the rail permanently dark rather than merely
 * imprecise.
 */
export function applyRouteFrame<T extends RouteFrameTurn>(turns: T[], frame: RouteAttribution): T[] {
  if (turns.length === 0) return turns;
  const idx = turns.length - 1;
  const last = turns[idx];
  const seq = typeof frame.turnSeq === "number" && Number.isFinite(frame.turnSeq) ? Math.trunc(frame.turnSeq) : null;
  if (seq !== null && seq !== last.seq) {
    if (seq < last.seq) return turns; // stale - the turn it describes is already history
    // NEWER than anything this client sent. Two ways to get here: this component
    // re-mounted mid-conversation (thread switch) and restarted its local counter
    // while the transport kept counting, or another device sent into the same
    // thread. Adopt it only onto a turn that is genuinely still streaming - the
    // re-mount case - and drop it otherwise.
    if (!last.streaming) return turns;
  }
  const merged: RouteAttribution = { ...(last.route ?? {}), ...frame };
  // `pending` describes the LATEST frame, not the accumulated turn: the done frame
  // omits it, and a merge that kept it would leave every settled turn "pending".
  if (frame.pending !== true) delete merged.pending;
  const copy = turns.slice();
  copy[idx] = { ...last, route: merged, ...(seq !== null ? { seq } : {}) };
  return copy;
}

// AskUserQuestion picker → tappable option buttons (D28). Pure + exported so the
// render contract (one button per option, disabled-after-answer, no emoji,
// 44px targets via .cc-question-opt) is unit-testable without a DOM. Only the
// first question of a multi-question tool call is rendered/answerable.
export function QuestionBlock({
  q,
  answered,
  answering,
  error,
  active = true,
  onSelect,
  onOther,
}: {
  q: ToolQuestion;
  answered?: string;
  answering?: boolean;
  error?: string;
  active?: boolean;
  onSelect: (label: string) => void;
  onOther: (text: string) => void;
}) {
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const locked = !active || Boolean(answered) || Boolean(answering);
  const title = q.header?.trim() || q.question?.trim() || "Choose an option";
  const showSub = Boolean(q.question?.trim()) && q.question.trim() !== title;
  return (
    <div className="cc-question" role="group" aria-label={title}>
      <div className="cc-question-title">{title}</div>
      {showSub && <div className="cc-question-sub">{q.question}</div>}
      <div className="cc-question-opts">
        {q.options.map((o) => (
          <button
            key={o.label}
            type="button"
            className={`cc-question-opt${answered === o.label ? " cc-question-opt-chosen" : ""}`}
            disabled={locked}
            aria-pressed={answered === o.label}
            onClick={() => onSelect(o.label)}
          >
            <span className="cc-question-opt-label">{o.label}</span>
            {o.description && <span className="cc-question-opt-desc">{o.description}</span>}
          </button>
        ))}
        {!locked && !otherOpen && (
          <button type="button" className="cc-question-other" onClick={() => setOtherOpen(true)}>
            Other...
          </button>
        )}
      </div>
      {!locked && otherOpen && (
        <div className="cc-question-otherrow">
          <input
            className="cc-question-otherinput"
            value={otherText}
            placeholder="Type your answer"
            autoFocus
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && otherText.trim()) {
                e.preventDefault();
                onOther(otherText.trim());
              }
            }}
          />
          <button
            type="button"
            className="cc-question-othersend"
            disabled={!otherText.trim()}
            onClick={() => otherText.trim() && onOther(otherText.trim())}
          >
            Send
          </button>
        </div>
      )}
      {answered && <div className="cc-user cc-question-answer">{answered}</div>}
      {!active && !answered && (
        <div className="cc-question-inactive">This question is no longer active and cannot be answered.</div>
      )}
      {active && error && <div className="cc-question-error" role="alert">{error}</div>}
    </div>
  );
}

function InputLifecycleStatus({
  turn,
  elapsed,
  hint,
  onRetryStop,
}: {
  turn: Turn;
  elapsed: number;
  hint: string;
  onRetryStop: () => void;
}) {
  const state = turn.inputState;
  if (!state) return null;
  const label: Record<ChatInputState, string> = {
    queued: "Queued",
    starting: "Starting",
    running: "Working",
    stopping: "Stopping",
    settled: "Complete",
    stopped: "Stopped",
    failed: "Failed",
  };
  const active = state === "starting" || state === "running" || state === "stopping";
  const detail = state === "queued" && typeof turn.inputPosition === "number"
    ? `Position ${turn.inputPosition}`
    : turn.inputReason || (active ? hint : "");
  return (
    <div className={`cc-lifecycle cc-lifecycle-${state}`} data-input-state={state}>
      <span className="cc-lifecycle-mark" aria-hidden="true">
        {active ? <span className="cc-working-dots"><i /><i /><i /></span> : null}
      </span>
      <span className="cc-lifecycle-label">{label[state]}</span>
      {active && <span className="cc-lifecycle-time">{fmtElapsed(elapsed)}</span>}
      {detail && <span className="cc-lifecycle-detail" title={detail}>{detail}</span>}
      {turn.stopError && turn.generationId && (state === "starting" || state === "running") && (
        <span className="cc-lifecycle-stoperror">
          <span>Stop failed: {turn.stopError}</span>
          <button type="button" onClick={onRetryStop}>Retry stop</button>
        </span>
      )}
    </div>
  );
}

// ── Toolbar feature flags (all default OFF so web-channel is unaffected) ──
// dev-env opts in via <ClaudeChat features={{ model, effort, theme, voice }} />.
export interface ChatFeatures {
  /** Model selector (Opus/Sonnet/Haiku) - switches the live session via /model. */
  model?: boolean;
  /** Effort/thinking-level selector - prepends a thinking directive to the next message. */
  effort?: boolean;
  /** Light/dark/system theme toggle for the chat surface. */
  theme?: boolean;
  /** Read-aloud + push-to-talk via the host's same-origin /voice proxy. */
  voice?: boolean;
  /**
   * Autonomous toggle (GARRISON-UNIFY-V1 D21) - a toolbar chip; when pressed,
   * every send carries meta.autonomous = true (the explicit D8 marker); the
   * gateway registers significant work as a run card and replies with the
   * card link. Default OFF; only the web channel opts in.
   */
  autonomous?: boolean;
  /**
   * The Turn Rail: per-turn attribution badges plus per-dimension pin dropdowns
   * (target / duty+level / model / effort / account / project), a `Route` toolbar
   * chip that opens the in-flight rail, and the `Stop` + `Stop & change` pair.
   * Default OFF, so a host that does not pass `routeOptions` / `onPinChange`
   * keeps exactly the previous chat (dev-env still gets the legacy routing chip).
   */
  routing?: boolean;
}

// Model picks. Selecting one submits `/model <id>` into the Claude Code TUI,
// which drives its model picker live; the status line then reflects the change
// through the existing `status` event (no extra wiring). Ids track the current
// Claude Code model aliases; the short aliases also work if an id is rejected.
const MODELS: { id: string; label: string }[] = [
  { id: "claude-opus-4-8", label: "Opus" },
  { id: "claude-sonnet-4-6", label: "Sonnet" },
  { id: "claude-haiku-4-5", label: "Haiku" },
];

// Effort / thinking levels. MECHANISM: Claude Code escalates its thinking budget
// on trigger phrases in the prompt ("think" < "think hard" < "ultrathink"). We
// prepend the chosen directive to the user's next message at send time. "Normal"
// prepends nothing. The choice persists in localStorage and shows active; it is
// a per-message modifier, not a session setting, so it survives reconnects.
const EFFORTS: { id: string; label: string; directive: string }[] = [
  { id: "normal", label: "Normal", directive: "" },
  { id: "think", label: "Think", directive: "think" },
  { id: "think-hard", label: "Think hard", directive: "think hard" },
  { id: "ultrathink", label: "Ultrathink", directive: "ultrathink" },
];
const LS_EFFORT = "garrison.chat.effort";

function readEffort(): string {
  try {
    const v = localStorage.getItem(LS_EFFORT);
    if (v && EFFORTS.some((e) => e.id === v)) return v;
  } catch {}
  return "normal";
}

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "Default",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  bypassPermissions: "Bypass",
  unknown: "-",
};
const SWITCHABLE: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

let uid = 0;
const nextId = () => `t${Date.now()}_${uid++}`;
const nextClientRequestId = () => {
  try {
    const generated = globalThis.crypto?.randomUUID?.();
    if (generated) return generated;
  } catch {
    /* deterministic local fallback below */
  }
  return `chat-${Date.now()}-${uid++}`;
};

// m:ss elapsed for the working indicator (e.g. 7 → "0:07", 75 → "1:15").
function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// SVG icons for the theme toggle (no emoji, per house rule). Mirrors the
// dev-env terminal toggle's sun / moon / monitor set.
const THEME_ICONS: { mode: ChatThemeMode; label: string; icon: React.ReactNode }[] = [
  {
    mode: "light",
    label: "Light",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <line x1="8" y1="1" x2="8" y2="2.8" /><line x1="8" y1="13.2" x2="8" y2="15" />
          <line x1="1" y1="8" x2="2.8" y2="8" /><line x1="13.2" y1="8" x2="15" y2="8" />
          <line x1="3.1" y1="3.1" x2="4.3" y2="4.3" /><line x1="11.7" y1="11.7" x2="12.9" y2="12.9" />
          <line x1="12.9" y1="3.1" x2="11.7" y2="4.3" /><line x1="4.3" y1="11.7" x2="3.1" y2="12.9" />
        </g>
      </svg>
    ),
  },
  {
    mode: "dark",
    label: "Dark",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" fill="currentColor" />
      </svg>
    ),
  },
  {
    mode: "system",
    label: "System",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="8.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <line x1="5.5" y1="13.5" x2="10.5" y2="13.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
];

// Kept exported from this module for source compatibility; the canonical
// transport contract owns the shape now because it also carries clientRequestId.
export type ChatSendMeta = TransportChatSendMeta;
type ContextAwareSend = ChatTransport["sendMessage"];

// A file the user pasted/dropped/picked into the composer, mid-upload or done.
// `path` is null until the upload settles; `previewUrl` (image paste only) is
// an objectURL revoked on removal/send so it never leaks.
interface PendingAttachment {
  id: string;
  name: string;
  path: string | null;
  uploading: boolean;
  error: string | null;
  previewUrl: string | null;
}

// Pure decision used by `send`: build the optional per-send meta from the
// current opaque context/mode, or return undefined when BOTH are absent so a
// context-unaware transport is invoked with exactly one argument (its previous
// behavior). Exported for hermetic unit testing of the threading contract.
export function buildSendMeta(
  context: unknown,
  mode: string | undefined,
  autonomous?: boolean,
  routing?: TurnRouting | null
): ChatSendMeta | undefined {
  const hasContext = context !== undefined && context !== null;
  const hasMode = typeof mode === "string" && mode.trim().length > 0;
  const hasAutonomous = autonomous === true;
  // A pin with no value is not a pin: `{ effort: null }` means "stop pinning
  // effort", and shipping it would make every send carry a meta object (and, via
  // the orchestrator transport, a `routing` key in the gateway body) even though
  // the user pinned nothing. The back-compat contract is that a plain send stays
  // exactly `{message, channel:"web"}`.
  const pinned = compactRouting(routing);
  if (!hasContext && !hasMode && !hasAutonomous && !pinned) return undefined;
  const meta: ChatSendMeta = {};
  if (hasContext) meta.context = context;
  if (hasMode) meta.mode = (mode as string).trim();
  if (hasAutonomous) meta.autonomous = true;
  if (pinned) meta.routing = pinned;
  return meta;
}

/** Strip empty pins. Returns undefined when nothing is pinned, so callers can use
 *  it directly as an "is anything pinned?" test. Exported for the rail's tests. */
export function compactRouting(routing?: TurnRouting | null): TurnRouting | undefined {
  if (!routing) return undefined;
  const out: TurnRouting = {};
  let any = false;
  for (const [key, value] of Object.entries(routing)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      const v = value.trim();
      if (!v) continue;
      (out as Record<string, unknown>)[key] = v;
      any = true;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      (out as Record<string, unknown>)[key] = Math.trunc(value);
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Live handles a composer adornment can use to DRIVE the chat (not rebuild it).
 * Passed only to the FUNCTION form of `composerAdornment`; the plain-ReactNode
 * form never sees it, so existing callers are unaffected. Used by the web
 * channel's voice conversation controls (S6b) to submit a transcribed utterance
 * as a real turn and read each settled reply aloud.
 */
export interface ComposerAdornmentApi {
  /** Submit `text` as a real chat turn and return its browser-owned correlation
   * id when the transport supports durable input lifecycle. */
  send: (text: string) => string | null;
  /** True while a turn is in flight. */
  busy: boolean;
  /** True while generated work is active or queued. Voice adornments should
   * keep their state mounted, but refuse a NEW idle capture until this clears;
   * an already-running conversation may still expose its Stop control and wait
   * for/read the correlated reply. False for legacy transports. */
  queueLocked: boolean;
  /** The latest SETTLED assistant reply, or null while streaming/empty. Its `id`
   *  changes once per completed turn, so an adornment can react to each reply. */
  lastReply: { id: string; text: string; clientRequestId?: string } | null;
}

export interface ClaudeChatProps {
  transport: ChatTransport;
  /**
   * Optional slot rendered at the left of the composer (e.g. voice controls).
   * Accepts a plain node OR a function that receives {@link ComposerAdornmentApi}
   * so the adornment can send turns / observe replies. Function form is additive -
   * the node form behaves exactly as before.
   */
  composerAdornment?: React.ReactNode | ((api: ComposerAdornmentApi) => React.ReactNode);
  /** Optional title shown in the header. */
  title?: string;
  /**
   * Composer placeholder. Defaults to the full "Message Claude…  (/ for commands)".
   * Narrow surfaces (the web channel on a phone, where the composer row also
   * carries voice/mic/attach buttons) pass a short one so the hint is not clipped
   * mid-word inside a ~180px field.
   */
  placeholder?: string;
  /**
   * Opt-in toolbar features. ALL DEFAULT OFF - omitting this prop (as
   * web-channel does) yields exactly the previous chat. dev-env passes
   * { model, effort, theme, voice }.
   */
  features?: ChatFeatures;
  /**
   * OPAQUE context a host fitting hands the chat (a card, a Dev Env session, …).
   * This component does NOT interpret it - it is threaded verbatim to the
   * transport's send as `meta.context`. Absent → exactly the previous behavior.
   */
  context?: unknown;
  /**
   * OPAQUE mode string a host fitting hands the chat (e.g. a souls face). Passed
   * through to the transport's send as `meta.mode`; never interpreted here.
   */
  mode?: string;
  /**
   * An opening message to AUTO-SEND once, on mount, as if the user had typed it -
   * so a host can have the operative start proactively (e.g. Kanban Discuss seeds
   * a "James, analyse this card…" kickoff). Absent → exactly the previous behavior
   * (the chat waits for the user). Sent exactly once per mount.
   */
  initialMessage?: string;
  /**
   * When set with `initialMessage`, the auto-sent opening message primes the operative
   * but its user bubble is NOT shown - the transcript starts with the operative's reply.
   * Used by Discuss so the user sees James's question, not the instruction prompt.
   */
  initialMessageHidden?: boolean;
  /**
   * Prior transcript to seed the view on mount (a persisted conversation thread).
   * Each entry is one completed exchange; `hideUser` hides that exchange's user bubble
   * (a reopened Discuss hides its first turn - the kickoff). Absent → the chat starts
   * empty (exactly the previous behavior). A host that supports multiple threads
   * re-mounts the component with a fresh `key` + the selected thread's history to switch.
   */
  initialHistory?: {
    user: string;
    assistant: string;
    /** Durable canonical activity already associated with this exchange. */
    sessionEvents?: SessionEvent[];
    hideUser?: boolean;
    /** The persisted attribution for that exchange's reply (threads.mjs keeps a
     *  whitelisted `route` per assistant message). Carried onto the Turn so the
     *  badges survive a reload and the 10s thread poll's re-mount. */
    route?: RouteAttribution;
    /** The pins that were in force when that exchange was sent. */
    overrides?: TurnRouting;
    /** Durable orchestrated-input state. Queued/running prompts remain visible
     * and correctly bound after a remount instead of being inferred as settled. */
    input?: ChatInputReceipt;
  }[];
  /**
   * Fires once per turn when its assistant reply has fully settled (non-empty),
   * so a host can PERSIST the exchange into a thread store. Absent → nothing is
   * persisted (previous behavior). Never fires for an empty/aborted turn.
   */
  onTurnComplete?: (exchange: { user: string; assistant: string }) => void;
  /**
   * SSE endpoint that streams this conversation's rich Claude transcript
   * (collapsible thinking, tool calls, inline images the plain-text chat drops).
   * When set, the header shows a Chat/Transcript toggle; absent → no toggle
   * (exactly the previous chat). The web channel passes
   * `/api/session-stream?thread=<id>`.
   */
  transcriptUrl?: string;
  /**
   * Opt in to opening the rich activity journal when a turn becomes busy. The
   * default is false so existing embedders keep the current Chat-first surface;
   * a host with durable transcript linkage (such as web-channel) can enable it.
   * The user can still switch back to Chat while the turn is running.
   */
  autoShowTranscript?: boolean;
  /**
   * Stable key for persisting the UNSENT composer draft (typed text + settled
   * attachments) across a re-mount. A multi-thread host re-mounts the component
   * with a fresh `key` when switching threads (see `initialHistory`), which would
   * otherwise drop whatever the user was typing/attaching in the thread they left.
   * Pass the thread id here and the draft is mirrored to sessionStorage under it, so
   * a re-mount restores that thread's own draft. Absent → no persistence (exactly
   * the previous behavior).
   */
  draftKey?: string;
  /**
   * The pins currently in force for the next message (conversation-sticky, so the
   * HOST owns persistence - it survives a reload and follows the user across
   * devices). Treated as the initial/authoritative value: a change made in the
   * rail is applied locally at once AND reported via {@link onPinChange}, and a
   * new value arriving on this prop (a fresh read of the thread) re-syncs the rail.
   */
  routing?: TurnRouting | null;
  /**
   * The rail's menu vocabulary (targets / duties+levels / efforts / accounts /
   * projects, plus per-dimension "why you can't pin this" reasons). Fetched by the
   * HOST from its own same-origin `GET /api/route-options` proxy - this package
   * never fetches, so it stays origin-agnostic. Absent → the rail is read-only.
   */
  routeOptions?: RailOptions | null;
  /** Fires with the full new pin set whenever the user changes one, for the host
   *  to persist. Never called for a no-op change. */
  onPinChange?: (routing: TurnRouting) => void;
  /**
   * Open the routed runtime's OWN session transcript (the per-message `transcript`
   * badge). The host wires this to its existing session-stream view; absent → the
   * badge renders inert with that reason rather than lying about being clickable.
   */
  onOpenTranscript?: (sessionId: string) => void;
  /** Target for the rail's "Composition defaults live in Muster" row. Must be
   *  same-origin or already host-rewritten - the browser is almost never on the
   *  Garrison box, so an absolute loopback URL would be a dead link. */
  musterUrl?: string;
}

export function ClaudeChat({ transport, composerAdornment, title, placeholder, features, context, mode, initialMessage, initialMessageHidden, initialHistory, onTurnComplete, transcriptUrl, autoShowTranscript = false, draftKey, routing, routeOptions, onPinChange, onOpenTranscript, musterUrl }: ClaudeChatProps) {
  const feat = features ?? {};
  const railOn = Boolean(feat.routing);
  // Seed from a persisted thread's transcript when the host provides one. Computed
  // once per mount (switching threads re-mounts with a fresh key). Kept in a memo
  // so persistedRef below can mark the LAST seeded turn as already-persisted - else
  // the persist effect would re-append the restored history on every open.
  const seededTurns = useMemo<Turn[]>(
    () =>
      (initialHistory ?? []).map((h) => ({
        id: nextId(),
        user: h.user,
        assistant: h.assistant,
        streaming: h.input ? isActiveInputState(h.input.state) : false,
        hideUser: h.hideUser,
        // Restored turns are not turns THIS mount sent, so they carry seq 0 and a
        // stamped frame can never be mis-attached to one of them.
        seq: 0,
        sessionEvents: mergeSessionEvents([], h.sessionEvents ?? []),
        route: h.route,
        overrides: h.overrides,
        clientRequestId: h.input?.clientRequestId,
        inputId: h.input?.inputId,
        generationId: h.input?.generationId,
        inputState: h.input?.state,
        inputPosition: h.input?.position,
        inputReason: h.input?.reason,
        inputAcceptedAt: h.input?.acceptedAt,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [turns, setTurns] = useState<Turn[]>(seededTurns);
  // Lifecycle callbacks can be followed by a click in the same browser task,
  // before React has removed a stale Retry button. Record terminal coordinates
  // synchronously at event receipt so that stale handler can never call Stop or
  // paint the terminal turn active again.
  const terminalCoordinatesRef = useRef(new Set(
    seededTurns
      .filter((turn) => turn.inputState && INPUT_STATE_ORDER[turn.inputState] === 4)
      .flatMap(generatedCoordinateKeys)
  ));
  const rememberTerminalCoordinate = useCallback((coordinate: GeneratedTurnCoordinate) => {
    for (const key of generatedCoordinateKeys(coordinate)) terminalCoordinatesRef.current.add(key);
  }, []);
  const isRememberedTerminalCoordinate = useCallback((coordinate: GeneratedTurnCoordinate) => (
    generatedCoordinateKeys(coordinate).some((key) => terminalCoordinatesRef.current.has(key))
  ), []);
  const [status, setStatus] = useState<ClaudeStatus>({ rows: [], mode: "unknown", contextPct: null, model: null });
  const generatedMode = transport.inputLifecycle === true;
  const [legacyBusy, setLegacyBusy] = useState(false);
  const generatedWork = generatedMode && turns.some((turn) => isPendingInputState(turn.inputState));
  const activeGeneratedTurn = generatedMode
    ? turns.find((turn) => isActiveInputState(turn.inputState)) ?? null
    : null;
  const busy = generatedMode ? generatedWork : legacyBusy;
  const generatedWorkRef = useRef(generatedWork);
  generatedWorkRef.current = generatedWork;
  const [turnAnnouncement, setTurnAnnouncement] = useState("");
  const announcedBusyRef = useRef(false);
  const [conn, setConn] = useState<"open" | "closed" | "reconnecting">("reconnecting");
  const [screen, setScreen] = useState<string[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [input, setInput] = useState(() => loadDraftText(draftKey));
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [menuIdx, setMenuIdx] = useState(0);
  // ── Attachments (paste / drop / pick a file) — gated on the transport
  // actually exposing uploadFile; generated queue mode locks attachment admission
  // while any input is active/queued because the legacy attachment store is one
  // global slot rather than a per-input snapshot. ──
  const hasAttachmentTransport = typeof transport.uploadFile === "function";
  const attachmentLocked = generatedMode && generatedWork;
  const canAttach = hasAttachmentTransport && !attachmentLocked;
  const [attachments, setAttachments] = useState<PendingAttachment[]>(() => loadDraftAttachments(draftKey));
  const attachmentsRef = useRef<PendingAttachment[]>(attachments);
  attachmentsRef.current = attachments;
  // Mirror the unsent draft (text + settled attachments) to sessionStorage under
  // `draftKey` so a thread-switch re-mount restores it instead of dropping it. A
  // send clears both, which this effect then persists as an empty draft (removed).
  useEffect(() => {
    saveDraft(draftKey, input, attachments);
  }, [draftKey, input, attachments]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Additive host choice: once a busy turn has a journal URL, reveal the rich
  // activity automatically. This follows busy's false→true transition; a user
  // who switches back to Chat during that turn is not immediately overridden.
  useEffect(() => {
    if (autoShowTranscript && transcriptUrl && busy) setShowTranscript(true);
  }, [autoShowTranscript, transcriptUrl, busy]);

  const uploadOne = useCallback(
    (file: File) => {
      const id = nextId();
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      setAttachments((prev) => [...prev, { id, name: file.name || "pasted-image.png", path: null, uploading: true, error: null, previewUrl }]);
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
        transport
          .uploadFile!({ name: file.name || "pasted-image.png", mime: file.type || "application/octet-stream", base64 })
          .then((up) => {
            setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, path: up.path, uploading: false } : a)));
          })
          .catch((err) => {
            setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, uploading: false, error: err?.message ?? "upload failed" } : a)));
          });
      };
      reader.onerror = () => {
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, uploading: false, error: "read failed" } : a)));
      };
      reader.readAsDataURL(file);
    },
    [transport]
  );

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      if (!canAttach) return;
      Array.from(files).forEach(uploadOne);
    },
    [canAttach, uploadOne]
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const found = prev.find((a) => a.id === id);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const onComposerPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!canAttach) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        handleFiles(files);
      }
    },
    [canAttach, handleFiles]
  );

  const onComposerDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (canAttach && e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    },
    [canAttach, handleFiles]
  );
  // D21: the Autonomous toggle (feature-gated; default off). A ref mirrors the
  // state so the send callback reads the CURRENT value without re-binding.
  const [autonomousOn, setAutonomousOn] = useState(false);
  const autonomousRef = useRef(false);
  useEffect(() => { autonomousRef.current = autonomousOn; }, [autonomousOn]);

  // ── Turn Rail pins (opt-in). The HOST persists them (conversation-sticky, so
  // they follow the user across devices); we keep a local mirror so a tap paints
  // immediately instead of waiting for a round-trip, and re-sync whenever the
  // prop actually changes value (a fresh thread read). ──
  const [pins, setPins] = useState<TurnRouting>(() => compactRouting(routing) ?? {});
  const pinsRef = useRef<TurnRouting>(pins);
  pinsRef.current = pins;
  const routingPropKey = JSON.stringify(compactRouting(routing) ?? {});
  useEffect(() => {
    // Compare by VALUE: the host re-renders with a fresh object on every poll, and
    // an identity-keyed effect would clobber a pin the user just set locally.
    if (JSON.stringify(pinsRef.current) === routingPropKey) return;
    setPins(JSON.parse(routingPropKey) as TurnRouting);
  }, [routingPropKey]);
  /** Pins changed while a turn was in flight - they apply to the NEXT turn, and the
   *  rail says so rather than pretending the running turn re-routed. */
  const [pendingPins, setPendingPins] = useState<PinField[]>([]);
  /** The rail is mounted while busy or while anything is pinned; this opens it on
   *  demand (the `Route` chip, and `Stop & change`). */
  const [railOpen, setRailOpen] = useState(false);
  /** After `Stop & change` the sent text is back in the composer and Send becomes
   *  Resend. NOTHING auto-resends - the user chooses when, having changed routing. */
  const [resendArmed, setResendArmed] = useState(false);
  /** Live tool activity from a routed runtime (`activity` frames), shown in the
   *  working indicator: "Working 0:42 - Edit". */
  const [activity, setActivity] = useState("");
  /** Monotonic per-send counter; see {@link applyRouteFrame}. */
  const turnSeqRef = useRef(0);
  /** The text of the turn in flight, so `Stop & change` can put it back. */
  const inFlightTextRef = useRef("");
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // ── Theme (opt-in). Mirrors the dev-env terminal toggle: shared LS key, so
  // flipping either re-themes the other. When the feature is off the root
  // carries no data-theme attribute and the CSS falls back to its fixed dark
  // look (web-channel unchanged). ──
  const themeOn = Boolean(feat.theme);
  const [themeMode, setThemeMode] = useState<ChatThemeMode>(() => getChatMode());
  const [scheme, setScheme] = useState<"light" | "dark">(() => resolvedChatScheme());
  useEffect(() => {
    if (!themeOn) return;
    const off = subscribeChatTheme(() => {
      setThemeMode(getChatMode());
      setScheme(resolvedChatScheme());
    });
    return off;
  }, [themeOn]);

  // Host-aware link rewriting needs the port->tailnet-serve map; fetch it once
  // (shared across instances) and re-render so baked loopback links (e.g. a
  // Kanban card URL) upgrade to their reachable form. An empty map (no tailscale
  // serve / local dev) is fine - the renderer falls back to a host rebind.
  const [, setHostMapReady] = useState(false);
  useEffect(() => {
    let alive = true;
    loadHostMap().then(() => { if (alive) setHostMapReady(true); });
    return () => { alive = false; };
  }, []);

  // ── Effort / thinking level (opt-in). Persisted; prepended at send time. ──
  const effortOn = Boolean(feat.effort);
  const [effort, setEffort] = useState<string>(() => readEffort());
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const pickEffort = useCallback((id: string) => {
    setEffort(id);
    try { localStorage.setItem(LS_EFFORT, id); } catch {}
  }, []);

  // ── Voice (opt-in). Discovers availability via the host's /voice/health
  // proxy; gates all controls on it. ──
  const voiceOn = Boolean(feat.voice);
  const voiceClient = useMemo<VoiceClient | null>(
    () => (voiceOn ? createVoiceClient(transport.base ?? "") : null),
    [voiceOn, transport]
  );
  const [voiceHealth, setVoiceHealth] = useState<VoiceHealth>({ available: false });
  const [readAloud, setReadAloud] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Playback state for read-aloud. `speaking` stays true for the whole playback
  // SESSION (including while paused) so the transport controls remain mounted;
  // `paused` distinguishes the two. `loading` covers the TTS round-trip, which
  // can take seconds - without it the button looks dead after the click.
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  /** Turn id currently being read aloud (null = none / auto-read of the last turn). */
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  /** Last voice failure, surfaced to the user instead of being swallowed. */
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recBusyRef = useRef(false);
  const voiceMountedRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const lastSpokenRef = useRef<string>("");

  useEffect(() => {
    if (!voiceOn || !voiceClient) return;
    let cancelled = false;
    const probe = () => voiceClient.health().then((h) => { if (!cancelled) setVoiceHealth(h); }).catch(() => {});
    void probe();
    const id = window.setInterval(probe, 15000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [voiceOn, voiceClient]);

  const voiceUsable = voiceOn && voiceHealth.available && voiceHealth.keyConfigured !== false;

  // ── Copy-last-response ──
  const [copied, setCopied] = useState(false);

  // ── Working indicator: a live elapsed timer while the turn is busy, so the
  // user gets unmistakable "it's working" feedback (modeled on leading chat
  // UIs). Resets to 0 each turn; ticks once a second only while busy. ──
  const [elapsed, setElapsed] = useState(0);
  const activeTimerKey = generatedMode
    ? (activeGeneratedTurn?.generationId ?? activeGeneratedTurn?.inputId ?? activeGeneratedTurn?.clientRequestId ?? "")
    : (busy ? "legacy-active" : "");
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy, activeTimerKey]);

  // A compact activity hint pulled from the PTY status line (e.g.
  // "esc to interrupt · 2.1k tokens"). Absent on the orchestrator transport
  // (no status rows) → the indicator degrades to dots + "Working" + elapsed.
  const workingHint = useMemo(() => {
    // A live `activity` frame beats the scraped status line: it is the actual tool
    // the routed runtime is running right now ("Edit"), and on the orchestrator
    // transport there are no status rows at all.
    if (activity) return activity;
    const row = [...status.rows].reverse().find((r) => /esc to interrupt|tokens/i.test(r));
    if (!row) return "";
    // Prefer the parenthetical tail "(esc to interrupt · N tokens)" so the hint
    // doesn't echo the activity verb already implied by the WORKING label.
    const paren = /\(([^)]*(?:interrupt|tokens)[^)]*)\)/i.exec(row);
    if (paren) return paren[1].trim().slice(0, 80);
    const tail = row.includes("…") ? row.split("…").pop() : row;
    return (tail || "").replace(/^[\s*✻✶✳·•]+/, "").trim().slice(0, 80);
  }, [status.rows, activity]);

  // ── Per-message copy (copy-on-hover under a completed assistant turn). ──
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyMsg = useCallback((id: string, text: string) => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1300);
    });
  }, []);

  // ── Delegated copy for code blocks (their Copy buttons live inside
  // dangerouslySetInnerHTML markdown, so they can't carry React handlers). One
  // listener on the scroll container handles every block's button. ──
  const onCodeCopyClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest?.(".cc-codecopy") as HTMLButtonElement | null;
    if (!btn) return;
    const block = btn.closest(".cc-codeblock");
    const code = block?.querySelector("pre code")?.textContent ?? "";
    if (!code) return;
    void writeClipboard(code).then((ok) => {
      if (!ok) return;
      btn.textContent = "Copied";
      window.setTimeout(() => { if (btn.isConnected) btn.textContent = "Copy"; }, 1300);
    });
  }, []);

  // Reflect the latest assistant text into the most recent turn's assistant slot.
  // A reply arriving with NO local transcript (this client mounted or reloaded
  // while a turn was already running server-side) is REBOUND to a fresh turn
  // instead of dropped, so a reconnecting client picks the stream back up.
  const applyAssistant = useCallback((text: string) => {
    setTurns((prev) => {
      if (prev.length === 0) {
        return [{ id: nextId(), user: "", assistant: text, streaming: true, hideUser: true, seq: 0, sessionEvents: [] }];
      }
      const last = prev[prev.length - 1];
      if (last.assistant === text) return prev;
      const copy = prev.slice();
      copy[copy.length - 1] = { ...last, assistant: text };
      return copy;
    });
  }, []);

  useEffect(() => {
    const off = transport.connect((ev: ChatEvent) => {
      switch (ev.type) {
        case "hello": {
          setStatus(ev.status);
          setScreen(ev.screen ?? []);
          if (generatedMode) break;
          setLegacyBusy(ev.busy);
          // Rebind a reloaded client: when the operative already has a reply on
          // screen (possibly still streaming) and this client has no transcript,
          // seed a turn from the hello snapshot instead of showing an empty chat.
          const helloAssistant = typeof ev.assistant === "string" ? ev.assistant : "";
          if (ev.busy) {
            setTurns((prev) => rebindActiveTurn(prev, helloAssistant));
          } else if (helloAssistant.trim()) {
            setTurns((prev) => prev.length > 0
              ? prev
              : [{ id: nextId(), user: "", assistant: helloAssistant, streaming: false, hideUser: true, seq: 0, sessionEvents: [] }]);
          }
          break;
        }
        case "assistant":
          if (generatedMode) {
            setTurns((prev) => applyGeneratedTurn(prev, ev, (turn) =>
              turn.assistant === ev.text ? turn : { ...turn, assistant: ev.text }
            ));
          } else {
            applyAssistant(ev.text);
          }
          break;
        case "session_event":
          setTurns((prev) => {
            if (generatedMode) {
              return applyGeneratedTurn(prev, ev, (turn) => {
                const sessionEvents = mergeSessionEvents(turn.sessionEvents, [ev.event]);
                return sessionEvents === turn.sessionEvents ? turn : { ...turn, sessionEvents };
              });
            }
            const base = prev.length > 0
              ? prev
              : [{ id: nextId(), user: "", assistant: "", streaming: true, hideUser: true, seq: 0, sessionEvents: [] }];
            return applySessionEvent(base, ev.event);
          });
          break;
        case "status":
          setStatus({ rows: ev.rows, mode: ev.mode, contextPct: ev.contextPct, model: ev.model });
          break;
        case "turn":
          // Generated lifecycle events are authoritative. A legacy `turn:false`
          // from an older stream must never settle whichever queued turn is last.
          if (generatedMode) break;
          setLegacyBusy(ev.active);
          // The activity hint describes the turn that just ended; keeping it would
          // leave a stale tool name under the next "Working" indicator.
          setActivity("");
          setTurns((prev) => {
            if (ev.active) return rebindActiveTurn(prev);
            return applyTurnActive(prev, false);
          });
          break;
        case "screen":
          setScreen(ev.lines);
          break;
        case "tool": {
          // Attach an AskUserQuestion to the current (streaming) turn → tappable
          // option buttons. Ignore other tools and malformed payloads.
          if (ev.name !== "AskUserQuestion" || !Array.isArray(ev.questions) || ev.questions.length === 0) break;
          setTurns((prev) => {
            if (generatedMode) {
              return applyGeneratedTurn(prev, ev, (turn) => ({
                ...turn,
                question: { toolUseId: ev.tool_use_id, questions: ev.questions },
              }));
            }
            if (prev.length === 0) return prev;
            const copy = prev.slice();
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = { ...last, question: { toolUseId: ev.tool_use_id, questions: ev.questions } };
            return copy;
          });
          break;
        }
        case "route": {
          // Merge into the turn this frame belongs to (and drop it if that turn is
          // already history) - see applyRouteFrame for why both halves matter.
          const { type: _type, inputId: _inputId, generationId: _generationId, ...attribution } = ev;
          setTurns((prev) => generatedMode
            ? applyGeneratedTurn(prev, ev, (turn) => ({
                ...turn,
                route: { ...(turn.route ?? {}), ...attribution },
              }))
            : applyRouteFrame(prev, attribution));
          break;
        }
        case "activity": {
          // Tool activity from a routed runtime. The non-primary lanes emit their
          // whole reply at the end, so without this the conversation sat silent for
          // minutes; it feeds the working indicator's (previously always-empty on
          // this transport) hint slot.
          if (ev.kind !== "tool" && ev.kind !== "thinking") break;
          const name = typeof ev.name === "string" ? ev.name.trim() : "";
          // Thinking is prose, so it gets more room than a tool name and is
          // marked so the hint reads "thinking: <line>" rather than looking like
          // a tool called <line>.
          if (name) {
            const nextActivity = ev.kind === "thinking" ? `thinking: ${name.slice(0, 72)}` : name.slice(0, 40);
            if (generatedMode) {
              setTurns((prev) => applyGeneratedTurn(prev, ev, (turn) => ({ ...turn, activity: nextActivity })));
            } else {
              setActivity(nextActivity);
            }
          }
          break;
        }
        case "input": {
          if (INPUT_STATE_ORDER[ev.state] === 4) rememberTerminalCoordinate(ev);
          setTurns((prev) => {
            const next = applyInputLifecycle(prev, ev);
            if (INPUT_STATE_ORDER[ev.state] !== 4) return next;
            return applyGeneratedTurn(next, ev, (turn) => ({
              ...turn,
              ...(ev.state === "failed" ? { answered: undefined } : {}),
              answering: false,
              questionError: undefined,
            }));
          });
          setTurnAnnouncement(inputLifecycleAnnouncement(ev));
          break;
        }
        case "connection":
          setConn(ev.state);
          break;
        case "error":
          if (generatedMode) {
            rememberTerminalCoordinate(ev);
            setTurns((prev) => applyGeneratedTurn(prev, ev, (turn) => ({
              ...turn,
              assistant: `_error: ${ev.message}_`,
              streaming: false,
              inputState: "failed",
              inputReason: ev.message,
              activity: "",
              stopError: undefined,
              answered: undefined,
              answering: false,
              questionError: undefined,
            })));
            setTurnAnnouncement(inputLifecycleAnnouncement({ state: "failed", reason: ev.message }));
          } else {
            // Surface as an assistant note on the latest turn.
            applyAssistant(`_error: ${ev.message}_`);
          }
          break;
      }
    });
    return off;
  }, [transport, applyAssistant, generatedMode, rememberTerminalCoordinate]);

  useEffect(() => {
    transport.fetchCommands().then(setCommands).catch(() => setCommands([]));
  }, [transport]);

  // Auto-scroll when pinned to bottom.
  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, busy]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const slashQuery = useMemo(() => {
    const m = /^\/([\w:-]*)$/.exec(input.trim());
    return m ? m[1].toLowerCase() : null;
  }, [input]);

  const filtered = useMemo(() => {
    if (slashQuery === null) return [];
    return commands
      .filter((c) => c.name.toLowerCase().includes(slashQuery))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(slashQuery) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(slashQuery) ? 0 : 1;
        return ap - bp || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  }, [commands, slashQuery]);

  useEffect(() => setMenuIdx(0), [slashQuery]);

  // Keep the latest opaque context/mode in refs so `send` stays stable while
  // always forwarding the current values. Both default to undefined → the meta
  // arg is omitted entirely and transports see exactly the old single-arg call.
  const contextRef = useRef<unknown>(context);
  contextRef.current = context;
  const modeRef = useRef<string | undefined>(mode);
  modeRef.current = mode;

  // A send fired (via Enter) while an attachment is still uploading is DEFERRED,
  // not dropped: the intended text is stashed here and re-fired by the effect
  // below once no upload is in flight, so "type + paste + Enter fast" still
  // carries the image instead of silently sending textless and then piggybacking
  // the attachment onto the user's next unrelated message.
  const pendingSendRef = useRef<{ text: string; opts?: { hideUser?: boolean } } | null>(null);

  const send = useCallback(
    (text: string, opts?: { hideUser?: boolean }): string | null => {
      if (generatedMode && generatedWorkRef.current && attachmentsRef.current.length > 0) {
        setTurnAnnouncement("Attachments cannot be queued while another message is pending.");
        return null;
      }
      // Hold the turn until every in-flight upload settles (resolved or errored),
      // so its path is present when we build the attachment suffix.
      if (attachmentsRef.current.some((a) => a.uploading)) {
        pendingSendRef.current = { text, opts };
        setInput("");
        return null;
      }
      const t = text.trim();
      const ready = attachmentsRef.current.filter((a) => a.path && !a.uploading);
      const attachmentSuffix = ready.length
        ? `\n\n${ready.length === 1 ? "Attached file" : "Attached files"}:\n${ready.map((a) => `- ${a.path}`).join("\n")}`
        : "";
      const full = `${t}${attachmentSuffix}`.trim();
      if (!full) return null;
      // Effort directive (Think / Think hard / Ultrathink) is prepended to the
      // wire text only - the transcript shows what the user actually typed
      // (attachments included, since they're user-visible content).
      const dir = effortOn ? EFFORTS.find((e) => e.id === effortRef.current)?.directive ?? "" : "";
      const wire = dir ? `${dir}\n\n${full}` : full;
      const sentPins = railOn ? compactRouting(pinsRef.current) : undefined;
      const clientRequestId = generatedMode ? nextClientRequestId() : undefined;
      const optimisticState: ChatInputState | undefined = generatedMode
        ? (generatedWorkRef.current ? "queued" : "starting")
        : undefined;
      if (generatedMode) generatedWorkRef.current = true;
      inFlightTextRef.current = full;
      setTurns((prev) => {
        const optimisticPosition = optimisticState === "queued"
          ? prev.filter((turn) => turn.inputState === "queued").length + 1
          : undefined;
        return [...prev, {
          id: nextId(),
          user: full,
          assistant: "",
          streaming: generatedMode ? isActiveInputState(optimisticState) : true,
          hideUser: opts?.hideUser,
          seq: ++turnSeqRef.current,
          sessionEvents: [],
          overrides: sentPins,
          clientRequestId,
          inputState: optimisticState,
          inputPosition: optimisticPosition,
        }];
      });
      if (!generatedMode) {
        setLegacyBusy(true);
        setActivity("");
      } else if (optimisticState) {
        setTurnAnnouncement(inputLifecycleAnnouncement({ state: optimisticState }));
      }
      // The pins have now reached a turn, so they stop reading "applies next turn".
      setPendingPins([]);
      setResendArmed(false);
      pinnedRef.current = true;
      // Pass opaque context/mode as an optional second arg ONLY when present, so
      // a context-unaware transport (createHttpTransport) is called exactly as
      // before. The transport decides whether to read `meta`.
      const baseMeta = buildSendMeta(contextRef.current, modeRef.current, feat.autonomous ? autonomousRef.current : undefined, sentPins);
      const meta: ChatSendMeta | undefined = generatedMode
        ? { ...(baseMeta ?? {}), clientRequestId }
        : baseMeta;
      const sendFn = transport.sendMessage as ContextAwareSend;
      const p = meta ? sendFn(wire, meta) : sendFn(wire);
      if (generatedMode && clientRequestId) {
        p.then((receipt) => {
          if (!isChatInputReceipt(receipt)) return;
          setTurns((prev) => applyInputLifecycle(prev, receipt));
          setTurnAnnouncement(inputLifecycleAnnouncement(receipt));
        }).catch((error) => {
          const reason = error instanceof Error ? error.message : String(error ?? "input admission failed");
          rememberTerminalCoordinate({ clientRequestId });
          setTurns((prev) => applyGeneratedTurn(prev, { clientRequestId }, (turn) => ({
            ...turn,
            streaming: false,
            inputState: "failed",
            inputReason: reason,
          })));
          setTurnAnnouncement(inputLifecycleAnnouncement({ state: "failed", reason }));
        });
      } else {
        p.catch(() => {});
      }
      setInput("");
      if (generatedMode) taRef.current?.focus();
      if (ready.length) {
        const sentIds = new Set(ready.map((a) => a.id));
        ready.forEach((a) => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
        setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
      }
      return clientRequestId ?? null;
    },
    [transport, effortOn, railOn, feat.autonomous, generatedMode, rememberTerminalCoordinate]
  );

  // Fire a deferred send once every upload has settled. Clearing the ref before
  // the call keeps this from re-queuing (the re-entrant send sees no uploads and
  // proceeds through the normal path).
  useEffect(() => {
    if (!pendingSendRef.current) return;
    if (attachments.some((a) => a.uploading)) return;
    const queued = pendingSendRef.current;
    pendingSendRef.current = null;
    send(queued.text, queued.opts);
  }, [attachments, send]);

  // Auto-send the opening message ONCE on mount, when a host provided one - so the
  // operative can start proactively (Kanban Discuss seeds a "James, analyse this
  // card…" kickoff). A ref guards against React's double-invoke (StrictMode) and a
  // changing `send` identity, so it fires exactly once per mount.
  const kickedRef = useRef(false);
  useEffect(() => {
    if (kickedRef.current) return;
    const msg = (initialMessage ?? "").trim();
    if (!msg) return;
    kickedRef.current = true;
    send(msg, { hideUser: initialMessageHidden });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  // Submit a slash command line into the live TUI WITHOUT a transcript turn.
  // Used for /model <id>, /compact, /clear. Falls back to sendMessage when the
  // transport predates sendCommand.
  const runCommand = useCallback(
    (line: string) => {
      const fn = transport.sendCommand ?? transport.sendMessage;
      fn.call(transport, line).catch(() => {});
    },
    [transport]
  );

  const switchModel = useCallback(
    (id: string) => {
      // Optimistically reflect in the status line until the TUI repaints it.
      setStatus((s) => ({ ...s, model: id }));
      runCommand(`/model ${id}`);
    },
    [runCommand]
  );

  // Copy the most recent assistant response to the clipboard.
  const copyLast = useCallback(async () => {
    const last = [...turns].reverse().find((t) => resolvedAssistantText(t).trim());
    if (!last) return;
    const cleanText = resolvedAssistantText(last);
    // Only flash "Copied" when the write actually succeeded (writeClipboard
    // resolves false on a missing API or a rejected write).
    if (await writeClipboard(cleanText)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  }, [turns]);

  // ── Voice: speak a message's text via the /voice/tts proxy. Playback is a
  // real transport (play / pause / resume / stop), not a fire-and-forget: a
  // long reply read aloud has to be pausable. One <audio> at a time - starting a
  // new read tears the previous one down (and revokes its object URL). ──
  const teardownAudio = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      a.onended = null;
      a.onerror = null;
      try { a.pause(); } catch { /* already detached */ }
    }
    audioRef.current = null;
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const speak = useCallback(
    async (text: string, turnId?: string) => {
      if (!voiceClient || !text.trim()) return;
      teardownAudio();
      setVoiceError(null);
      setTtsLoading(true);
      setSpeaking(true);
      setPaused(false);
      setSpeakingId(turnId ?? null);
      try {
        const blob = await voiceClient.tts(text);
        if (!voiceMountedRef.current) return;
        const urlObj = URL.createObjectURL(blob);
        audioUrlRef.current = urlObj;
        const audio = new Audio(urlObj);
        audioRef.current = audio;
        const finish = () => {
          if (audioRef.current !== audio) return; // superseded by a newer read
          teardownAudio();
          setSpeaking(false);
          setPaused(false);
          setSpeakingId(null);
        };
        audio.onended = finish;
        audio.onerror = () => { setVoiceError("Playback failed"); finish(); };
        await audio.play();
        setTtsLoading(false);
      } catch (err) {
        setTtsLoading(false);
        setSpeaking(false);
        setPaused(false);
        setSpeakingId(null);
        teardownAudio();
        // An autoplay block (no user gesture) and an upstream TTS failure are
        // different problems - say which one happened rather than going quiet.
        const name = (err as { name?: string } | null)?.name;
        setVoiceError(
          name === "NotAllowedError"
            ? "Playback blocked by the browser - press Read aloud again"
            : `Read-aloud failed: ${(err as Error)?.message ?? "unknown error"}`.slice(0, 120)
        );
      }
    },
    [voiceClient, teardownAudio]
  );

  const stopSpeaking = useCallback(() => {
    teardownAudio();
    setSpeaking(false);
    setPaused(false);
    setTtsLoading(false);
    setSpeakingId(null);
  }, [teardownAudio]);

  // Pause / resume the current read-aloud. No-op before the audio element
  // exists (still fetching the TTS) - the button shows a loading state then.
  const togglePause = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().then(() => setPaused(false)).catch(() => setPaused(true));
    } else {
      a.pause();
      setPaused(true);
    }
  }, []);

  // Persist each COMPLETED exchange into the host's thread store (when wired).
  // Mirrors the read-aloud settle gate: fire once per turn, only after the
  // assistant reply has fully landed and is non-empty (never for an empty/aborted
  // turn). The id guard makes it idempotent across the streaming re-renders.
  // Seeded from the LAST restored turn's id so the persist effect never re-appends
  // history that was loaded from the store (which would duplicate on every open).
  const persistedRef = useRef<Set<string>>(new Set(seededTurns.map((turn) => turn.id)));
  const onTurnCompleteRef = useRef(onTurnComplete);
  onTurnCompleteRef.current = onTurnComplete;

  // Auto-read each new COMPLETED assistant turn when read-aloud is on.
  const latestTurn = turns.length ? turns[turns.length - 1] : null;
  const latestAssistant = generatedMode ? (activeGeneratedTurn ?? latestTurn) : latestTurn;
  const latestSettledAssistant = generatedMode
    ? [...turns].reverse().find((turn) =>
        !turn.streaming &&
        (!turn.inputState || turn.inputState === "settled" || turn.inputState === "stopped" || turn.inputState === "failed") &&
        resolvedAssistantText(turn).trim().length > 0
      ) ?? null
    : latestTurn;
  useEffect(() => {
    if (generatedMode) return;
    if (busy) {
      announcedBusyRef.current = true;
      setTurnAnnouncement(liveSessionAnnouncement(latestAssistant?.sessionEvents ?? [], workingHint));
    } else if (announcedBusyRef.current) {
      announcedBusyRef.current = false;
      setTurnAnnouncement("Response complete.");
    }
  }, [busy, latestAssistant?.sessionEvents, workingHint, generatedMode]);
  // The latest SETTLED reply, exposed to a function-form composerAdornment (S6b
  // voice) so it can read replies aloud. Null while streaming/empty; `id` changes
  // once per completed turn.
  const settledReply = useMemo<ComposerAdornmentApi["lastReply"]>(() => {
    if (!latestSettledAssistant || latestSettledAssistant.streaming) return null;
    const text = resolvedAssistantText(latestSettledAssistant).trim();
    return text
      ? {
          id: latestSettledAssistant.id,
          text,
          ...(latestSettledAssistant.clientRequestId ? { clientRequestId: latestSettledAssistant.clientRequestId } : {}),
        }
      : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSettledAssistant?.id, latestSettledAssistant?.assistant, latestSettledAssistant?.sessionEvents, latestSettledAssistant?.streaming]);
  useEffect(() => {
    const cb = onTurnCompleteRef.current;
    if (!cb || !latestSettledAssistant || latestSettledAssistant.streaming) return;
    const assistant = resolvedAssistantRaw(latestSettledAssistant).trim();
    if (!assistant) return;
    if (persistedRef.current.has(latestSettledAssistant.id)) return;
    persistedRef.current.add(latestSettledAssistant.id);
    cb({ user: latestSettledAssistant.user, assistant });
  }, [latestSettledAssistant?.id, latestSettledAssistant?.assistant, latestSettledAssistant?.sessionEvents, latestSettledAssistant?.streaming]);
  useEffect(() => {
    if (!readAloud || !voiceUsable || !latestSettledAssistant) return;
    if (latestSettledAssistant.streaming) return;
    const text = resolvedAssistantText(latestSettledAssistant).trim();
    if (!text || text === lastSpokenRef.current) return;
    lastSpokenRef.current = text;
    void speak(text, latestSettledAssistant.id);
  }, [readAloud, voiceUsable, latestSettledAssistant?.id, latestSettledAssistant?.assistant, latestSettledAssistant?.sessionEvents, latestSettledAssistant?.streaming, speak]);

  // ── Voice: push-to-talk. Record from the mic; on stop, POST to /voice/stt
  // and drop the transcript into the composer for review/edit. ──
  const startRecording = useCallback(async () => {
    // recBusyRef is a SYNCHRONOUS guard set before the await - the `recording`
    // state flips only after getUserMedia resolves, so two rapid clicks would
    // otherwise both pass and the second would orphan the first recorder/stream
    // (leaking a live mic). The ref stays set through the active recording and
    // clears on stop / bail / error.
    if (!voiceClient || recBusyRef.current || generatedWorkRef.current) return;
    // getUserMedia exists only in a secure context (https / localhost). Over a
    // plain-http LAN origin `navigator.mediaDevices` is undefined and the old
    // code threw a TypeError into an empty catch - the button did nothing, with
    // no explanation. Say so instead.
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Microphone needs a secure context (https or localhost)");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setVoiceError("This browser has no MediaRecorder - recording is unavailable");
      return;
    }
    recBusyRef.current = true;
    setVoiceError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!voiceMountedRef.current || generatedWorkRef.current) {
        // Unmounted or generated work began while the permission prompt was
        // pending: release the mic and bail before constructing the recorder.
        stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
        recBusyRef.current = false;
        return;
      }
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recBusyRef.current = false;
        if (!voiceMountedRef.current) return; // unmounted - don't touch state/network
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (!blob.size) {
          setVoiceError("Nothing was recorded - check the microphone input");
          return;
        }
        setTranscribing(true);
        try {
          const transcript = await voiceClient.stt(blob);
          if (!voiceMountedRef.current) return;
          if (transcript.trim()) {
            setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
            taRef.current?.focus();
          } else {
            setVoiceError("No speech detected in the recording");
          }
        } catch (err) {
          if (voiceMountedRef.current) {
            setVoiceError(`Transcription failed: ${(err as Error)?.message ?? "unknown error"}`.slice(0, 140));
          }
        } finally {
          if (voiceMountedRef.current) setTranscribing(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (err) {
      recBusyRef.current = false;
      setRecording(false);
      // The failure that actually bit us: an iframe without `allow="microphone"`
      // rejects getUserMedia with NotAllowedError before any prompt is shown, so
      // the click looked like a dead button. Name the cause.
      const name = (err as { name?: string } | null)?.name;
      setVoiceError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone blocked - allow mic access for this page (and reload)"
          : name === "NotFoundError"
            ? "No microphone found on this device"
            : `Microphone error: ${(err as Error)?.message ?? "unknown"}`.slice(0, 140)
      );
    }
  }, [voiceClient]);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") { try { rec.stop(); } catch {} }
  }, []);

  // Release the microphone if the chat pane unmounts mid-recording (dev-env can
  // swap ChatPane for the Terminal view, or switch sessions, while recording).
  // Without this the MediaRecorder + mic tracks would keep the mic open.
  useEffect(() => {
    return () => {
      voiceMountedRef.current = false;
      recBusyRef.current = false;
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") { try { rec.stop(); } catch {} }
      streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch {} });
      streamRef.current = null;
      // Kill any in-flight read-aloud too - a pane swap must not leave audio
      // playing into a view the user has left (and must not leak the blob URL).
      const a = audioRef.current;
      if (a) { a.onended = null; a.onerror = null; try { a.pause(); } catch {} }
      audioRef.current = null;
      if (audioUrlRef.current) { URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = null; }
    };
  }, []);

  const pickCommand = useCallback(
    (c: SlashCommand) => {
      const next = `/${c.name}${c.argumentHint ? " " : ""}`;
      setInput(next);
      taRef.current?.focus();
    },
    []
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashQuery !== null && filtered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMenuIdx((i) => Math.min(filtered.length - 1, i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMenuIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          pickCommand(filtered[menuIdx]);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          // If the input is exactly a slash query with a highlighted command
          // that takes an argument, fill it; otherwise send.
          const exact = filtered.find((c) => `/${c.name}` === input.trim());
          if (!exact && filtered[menuIdx]?.argumentHint) {
            e.preventDefault();
            pickCommand(filtered[menuIdx]);
            return;
          }
        }
      }
      // IME-safe Enter to send (Shift+Enter = newline). On coarse pointers we
      // keep Enter as newline and rely on the Send button.
      const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
      if (e.key === "Enter" && !e.shiftKey && !(e as any).isComposing && !coarse) {
        e.preventDefault();
        send(input);
      }
    },
    [slashQuery, filtered, menuIdx, input, send, pickCommand]
  );

  const onSetMode = useCallback(
    async (mode: PermissionMode) => {
      try {
        const r = await transport.setMode(mode);
        setStatus((s) => ({ ...s, mode: r.mode }));
      } catch {
        /* ignore */
      }
    },
    [transport]
  );

  // Answer an AskUserQuestion for a turn (a tapped option label or free text). The
  // chosen value renders as the user's message and the buttons disable; the gateway
  // drives the live TUI picker and the reply continues streaming into the same turn.
  const answerQuestion = useCallback(
    (turn: Turn, toolUseId: string, choice: { label?: string; text?: string }) => {
      const generatedQuestion = Boolean(turn.inputState);
      const active = generatedQuestion
        ? isActiveInputState(turn.inputState) && !isRememberedTerminalCoordinate(turn)
        : turn.streaming;
      if (!active) return;
      const turnId = turn.id;
      const chosen = choice.label ?? choice.text ?? "";
      setTurns((prev) => prev.map((t) => (
        t.id === turnId && t.question?.toolUseId === toolUseId
          ? { ...t, answered: chosen, answering: true, questionError: undefined }
          : t
      )));
      const fn = transport.answerQuestion;
      if (!fn) {
        setTurns((prev) => prev.map((t) => (
          t.id === turnId && t.question?.toolUseId === toolUseId
            ? {
                ...t,
                answered: undefined,
                answering: false,
                questionError: "Could not send the answer. Please try again.",
              }
            : t
        )));
        return;
      }
      Promise.resolve(fn.call(transport, { toolUseId, ...choice }))
        .then(() => setTurns((prev) => prev.map((t) => (
          t.id === turnId && t.question?.toolUseId === toolUseId
            ? { ...t, answering: false, questionError: undefined }
            : t
        ))))
        .catch(() => setTurns((prev) => prev.map((t) => (
          t.id === turnId && t.question?.toolUseId === toolUseId
            ? {
                ...t,
                answered: undefined,
                answering: false,
                questionError: "Could not send the answer. Please try again.",
              }
            : t
        ))));
    },
    [transport, isRememberedTerminalCoordinate]
  );

  // ── Turn Rail: pin a dimension for the NEXT message ──
  // A pin never re-routes the turn already in flight (preRoute has resolved and the
  // model may already hold context), so a change made while busy is recorded and
  // the badge says "applies next turn".
  const applyPin = useCallback(
    (patch: PinPatch) => {
      const next: TurnRouting = { ...pinsRef.current };
      const touched: PinField[] = [];
      for (const [key, value] of Object.entries(patch)) {
        const field = key as PinField;
        const before = (next as Record<string, unknown>)[field];
        if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
          if (before === undefined) continue;
          delete (next as Record<string, unknown>)[field];
        } else {
          const clean = typeof value === "string" ? value.trim() : Math.trunc(value);
          if (before === clean) continue;
          (next as Record<string, unknown>)[field] = clean;
        }
        touched.push(field);
      }
      if (!touched.length) return; // a no-op tap must not bump the host's store
      const compact = compactRouting(next) ?? {};
      setPins(compact);
      if (busy) setPendingPins((prev) => [...new Set([...prev, ...touched])]);
      onPinChange?.(compact);
    },
    [busy, onPinChange]
  );

  const requestGeneratedStop = useCallback(async (turn: Turn, restore: boolean) => {
    // A Retry control can race a terminal lifecycle frame. Guard before any
    // optimistic mutation or interrupt call so a stale handler cannot resurrect
    // a failed/completed turn as `stopping`.
    if (
      !turn.generationId ||
      (turn.inputState !== "starting" && turn.inputState !== "running") ||
      isRememberedTerminalCoordinate(turn)
    ) return;
    const coordinate: GeneratedTurnCoordinate = {
      clientRequestId: turn.clientRequestId,
      inputId: turn.inputId,
      generationId: turn.generationId,
    };
    setTurns((prev) => applyGeneratedTurn(prev, coordinate, (current) => ({
      ...current,
      inputState: "stopping",
      streaming: true,
      stopError: undefined,
    })));
    setTurnAnnouncement("Stopping current response.");
    try {
      await transport.interrupt({ generationId: turn.generationId });
      if (restore) {
        // Existing queued Turns are untouched. A later manual send appends this
        // restored text at the tail; nothing is auto-sent or reordered.
        setInput(turn.user);
        setResendArmed(true);
        setRailOpen(true);
        taRef.current?.focus();
      }
    } catch (error) {
      // The runtime may settle while the interrupt request is still in flight.
      // Its terminal lifecycle is authoritative; do not replace its announcement
      // with a stale "retry available" failure after that point.
      if (isRememberedTerminalCoordinate(coordinate)) return;
      const message = (error instanceof Error ? error.message : String(error ?? "stop failed"))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160) || "stop failed";
      setTurns((prev) => applyGeneratedTurn(prev, coordinate, (current) => {
        const terminal = current.inputState === "settled" || current.inputState === "stopped" || current.inputState === "failed";
        return terminal ? current : {
          ...current,
          inputState: "running",
          streaming: true,
          stopError: message,
        };
      }));
      setTurnAnnouncement(`Stop failed: ${message}. Retry is available.`);
    }
  }, [transport, isRememberedTerminalCoordinate]);

  const stopTurn = useCallback(() => {
    if (generatedMode) {
      if (activeGeneratedTurn) void requestGeneratedStop(activeGeneratedTurn, false);
      return;
    }
    transport.interrupt().catch(() => {});
  }, [transport, generatedMode, activeGeneratedTurn, requestGeneratedStop]);

  /** Cancel, put the sent text back in the composer, open the rail, and swap Send
   *  for Resend. Deliberately does NOT resend: the whole point is to change
   *  something first. */
  const stopAndChange = useCallback(() => {
    if (generatedMode) {
      if (activeGeneratedTurn) void requestGeneratedStop(activeGeneratedTurn, true);
      return;
    }
    stopTurn();
    const text = inFlightTextRef.current;
    if (text) {
      setInput(text);
      setResendArmed(true);
    }
    setRailOpen(true);
    taRef.current?.focus();
  }, [stopTurn, generatedMode, activeGeneratedTurn, requestGeneratedStop]);

  // The Stop button has promised `title="Stop (Esc)"` since it was written and
  // Escape never did anything. Bind it for real, scoped to this chat: dev-env
  // mounts terminals beside the chat pane, and Escape inside an xterm must not
  // interrupt the chat's turn. An open rail menu swallows Escape first
  // (preventDefault + stopPropagation), so dismissing a menu never cancels a turn.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const root = rootRef.current;
      const target = e.target;
      const inside = root && target instanceof Node && root.contains(target);
      const loose = target === document.body || target === document.documentElement;
      if (!inside && !loose) return;
      stopTurn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, stopTurn]);

  const hasPins = Object.keys(pins).length > 0;
  const showFlightRail = railOn && (busy || hasPins || railOpen);
  // The flight rail's right-hand slot: the live elapsed time and the Stop pair
  // while busy; otherwise a way to put the rail away again.
  const generatedStopDisabled = !activeGeneratedTurn?.generationId || activeGeneratedTurn.inputState === "stopping";
  const generatedStopLabel = activeGeneratedTurn?.inputState === "stopping"
    ? "Stopping…"
    : activeGeneratedTurn?.stopError
      ? "Retry stop"
      : "Stop";
  const flightRailEnd = generatedMode && busy ? (
    activeGeneratedTurn ? (
      <>
        <span className="cc-railtime" title="Elapsed on this turn">{fmtElapsed(elapsed)}</span>
        <button
          type="button"
          className="cc-stop cc-railstop"
          onClick={stopTurn}
          disabled={generatedStopDisabled}
          aria-busy={activeGeneratedTurn.inputState === "stopping"}
          title={!activeGeneratedTurn.generationId ? "Stop is available once the response starts" : "Stop this response (Esc)"}
        >
          <span className="cc-stopsq" /> {generatedStopLabel}
        </button>
        <button
          type="button"
          className="cc-stop cc-railstop cc-railstop-change"
          onClick={stopAndChange}
          disabled={generatedStopDisabled}
          title="Stop this response, restore its message, and append any manual resend after the existing queue"
        >
          Stop &amp; change
        </button>
      </>
    ) : <span className="cc-railqueued">Queued</span>
  ) : busy ? (
    <>
      <span className="cc-railtime" title="Elapsed on this turn">{fmtElapsed(elapsed)}</span>
      <button type="button" className="cc-stop cc-railstop" onClick={stopTurn} title="Stop (Esc)">
        <span className="cc-stopsq" /> Stop
      </button>
      <button
        type="button"
        className="cc-stop cc-railstop cc-railstop-change"
        onClick={stopAndChange}
        title="Stop, put your message back in the composer, and change the routing before you resend"
      >
        Stop &amp; change
      </button>
    </>
  ) : railOpen && !hasPins ? (
    <button type="button" className="cc-railclose" onClick={() => setRailOpen(false)} title="Hide the routing rail">
      Close
    </button>
  ) : null;

  return (
    <div className="cc-root" ref={rootRef} data-theme={themeOn ? scheme : undefined}>
      <div className="cc-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {turnAnnouncement}
      </div>
      <header className="cc-header">
        <span className="cc-title">{title ?? "Claude"}</span>
        <span className={`cc-conn cc-conn-${conn}`} title={`connection: ${conn}`} />
        <span className="cc-spacer" />
        {status.model && <span className="cc-model" title="Active model">{status.model}</span>}
        {status.contextPct != null && <span className="cc-ctx">{status.contextPct}% ctx</span>}
        {themeOn && (
          <div className="cc-theme" role="group" aria-label="Chat theme">
            {THEME_ICONS.map((opt) => (
              <button
                key={opt.mode}
                type="button"
                className={themeMode === opt.mode ? "cc-theme-active" : ""}
                aria-pressed={themeMode === opt.mode}
                title={`${opt.label} theme`}
                aria-label={`${opt.label} theme`}
                onClick={() => { setChatMode(opt.mode); setThemeMode(opt.mode); setScheme(resolvedChatScheme()); }}
              >
                {opt.icon}
              </button>
            ))}
          </div>
        )}
        {transcriptUrl && (
          <button
            className="cc-rawtoggle"
            onClick={() => setShowTranscript((v) => !v)}
            title="Show the rich transcript (thinking, tool calls, images)"
          >
            {showTranscript ? "Chat" : "Transcript"}
          </button>
        )}
        <button className="cc-rawtoggle" onClick={() => setShowRaw((v) => !v)} title="Show raw terminal">
          {showRaw ? "Hide raw" : "Raw"}
        </button>
      </header>

      <div className="cc-scroll" ref={scrollRef} onScroll={onScroll} onClick={onCodeCopyClick}>
        {showTranscript && transcriptUrl ? (
          <SessionStream url={transcriptUrl} live={busy} announceLiveUpdates={false} />
        ) : (
        <>
        {turns.length === 0 && (
          <div className="cc-empty">Send a message to begin · type / for commands and skills</div>
        )}
        {turns.map((t) => {
          // Clean the scraped reply for display: drop TUI noise (tool-activity
          // counters, thinking blocks) and lift the router status badge out of the
          // prose into a compact chip. Cheap + pure, so per-render is fine.
          const clean = sanitizeAssistantText(t.assistant);
          const hasCanonicalActivity = hasVisibleSessionActivity(t.sessionEvents);
          const legacyFallback = hasCanonicalActivity ? legacyAssistantFallback(t.assistant, t.sessionEvents) : "";
          const actionText = resolvedAssistantText(t);
          const turnWorkingHint = generatedMode ? (t.activity ?? "") : workingHint;
          // Prefer the STRUCTURED runtime attribution the gateway sends on the
          // settled turn (runtime/model/tier); fall back to the model-emitted
          // "[route: …]" text badge lifted into clean.meta when it is absent.
          // The Turn Rail supersedes the chip when the host opted in AND this turn
          // actually carries attribution; the chip stays as the fallback for a
          // pre-migration persisted turn, a lane that reports nothing, and dev-env
          // (which passes no `routing` feature).
          const displayRoute = rewriteRouteForHost(t.route, hostCtx());
          const showRail = railOn && Boolean(displayRoute);
          const structuredChip = displayRoute ? routeChipFromAttribution(displayRoute) : null;
          const metaLabel = routeChipLabel(clean.meta);
          const metaTitle = clean.meta.route
            ? `routed via ${clean.meta.route}${clean.meta.rule ? ` · rule ${clean.meta.rule}` : ""}${clean.meta.profile ? ` · ${clean.meta.profile} profile` : ""}`
            : undefined;
          const routeLabel = structuredChip?.label ?? metaLabel;
          const routeTitle = structuredChip ? structuredChip.title : metaTitle;
          return (
          <div className="cc-turn" key={t.id}>
            {/* `hideUser` is not the only way a turn has no ask to show: a
                persisted history entry can carry an empty `user` string (a
                scheduler/automation turn that was never typed by anyone). Those
                rendered as a bare empty bubble - a stray coloured rectangle
                above every such reply. Gate on the CONTENT too. */}
            {!t.hideUser && t.user.trim() !== "" && <div className="cc-user">{t.user}</div>}
            {/* `t.route` joins the gate: a carded or cancelled turn can settle with
                NO prose at all, and its rail (card / stopped / transcript badges) is
                then the only record the user gets. */}
            {(clean.text || hasCanonicalActivity || t.streaming || t.question || t.route || t.inputState || t.stopError) && (
              <div className="cc-assistant">
                {t.inputState && (
                  <InputLifecycleStatus
                    turn={t}
                    elapsed={isActiveInputState(t.inputState) ? elapsed : 0}
                    hint={turnWorkingHint}
                    onRetryStop={() => { if (t.generationId) void requestGeneratedStop(t, false); }}
                  />
                )}
                {hasCanonicalActivity ? (
                  <SessionEventTimeline
                    events={t.sessionEvents}
                    live={t.streaming}
                    renderMarkdown={renderAssistantMarkdown}
                    permissionGenerationId={isActiveInputState(t.inputState) ? t.generationId : undefined}
                    onPermissionDecision={transport.answerPermission
                      ? (answer) => {
                          if (
                            !isActiveInputState(t.inputState) ||
                            !t.generationId ||
                            answer.generationId !== t.generationId ||
                            isRememberedTerminalCoordinate(t)
                          ) {
                            return Promise.reject(new Error("permission request is no longer active"));
                          }
                          return transport.answerPermission!(answer);
                        }
                      : undefined}
                  />
                ) : (
                  <div className="cc-md" dangerouslySetInnerHTML={{ __html: renderChatMarkdown(clean.text || "") }} />
                )}
                {legacyFallback && (
                  <div
                    className="cc-md cc-canonical-fallback"
                    dangerouslySetInnerHTML={{ __html: renderChatMarkdown(legacyFallback) }}
                  />
                )}
                {/* Streaming cursor once prose is arriving. */}
                {!hasCanonicalActivity && t.streaming && clean.text && <span className="cc-cursor" aria-hidden="true" />}
                {/* Rich "working" indicator before any prose lands (while James is
                    only doing tool activity, clean.text is empty → show this, not the
                    raw scrape): animated dots + label + live elapsed + activity hint. */}
                {!t.inputState && !hasCanonicalActivity && t.streaming && !clean.text && (
                  <div className="cc-working">
                    <span className="cc-working-dots"><i /><i /><i /></span>
                    <span className="cc-working-label">Working</span>
                    <span className="cc-working-time">{fmtElapsed(elapsed)}</span>
                    {turnWorkingHint && (
                      <>
                        <span className="cc-working-sep" aria-hidden="true">-</span>
                        <span className="cc-working-hint" title={turnWorkingHint}>{turnWorkingHint}</span>
                      </>
                    )}
                  </div>
                )}
                {/* AskUserQuestion → tappable option buttons (D28). Renders the first
                    question of the tool call; answered via the answer path. */}
                {t.question && t.question.questions[0] && (
                  <QuestionBlock
                    q={t.question.questions[0]}
                    answered={t.answered}
                    answering={t.answering}
                    error={t.questionError}
                    active={t.inputState ? isActiveInputState(t.inputState) : t.streaming}
                    onSelect={(label) => answerQuestion(t, t.question!.toolUseId, { label })}
                    onOther={(text) => answerQuestion(t, t.question!.toolUseId, { text })}
                  />
                )}
                {/* Per-message actions: copy (always) + read-aloud (voice) + a subtle
                    routing chip (replaces the inline "[route: …]" badge). */}
                {actionText.trim() && !t.streaming && (
                  <div className="cc-msgactions">
                    <button
                      type="button"
                      className="cc-msgcopy"
                      title="Copy this response"
                      onClick={() => copyMsg(t.id, actionText)}
                    >
                      {copiedId === t.id ? "Copied" : "Copy"}
                    </button>
                    {feat.voice && voiceUsable && (() => {
                      // The same button is play / pause / resume for THIS message:
                      // once it is the one being read, clicking toggles playback
                      // rather than restarting the whole reply from the top.
                      const isThis = speakingId === t.id;
                      const playing = isThis && !paused && !ttsLoading;
                      const label = !isThis
                        ? "Read this response aloud"
                        : ttsLoading
                          ? "Preparing audio"
                          : paused
                            ? "Resume reading"
                            : "Pause reading";
                      return (
                        <button
                          type="button"
                          className={`cc-speak${isThis ? " cc-speak-active" : ""}`}
                          title={label}
                          aria-label={label}
                          aria-pressed={isThis}
                          onClick={() => (isThis ? togglePause() : void speak(actionText, t.id))}
                        >
                          {playing ? (
                            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                              <rect x="4" y="3" width="3" height="10" fill="currentColor" />
                              <rect x="9" y="3" width="3" height="10" fill="currentColor" />
                            </svg>
                          ) : isThis && paused ? (
                            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M5 3l8 5-8 5z" fill="currentColor" />
                            </svg>
                          ) : (
                            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M8 2 4.5 5H2v6h2.5L8 14z" fill="currentColor" />
                              <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.7a6 6 0 0 1 0 8.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                            </svg>
                          )}
                        </button>
                      );
                    })()}
                    {!showRail && routeLabel && (
                      <span
                        className={`cc-routechip${structuredChip ? " cc-routechip-rich" : ""}`}
                        title={routeTitle}
                      >
                        {routeLabel}
                      </span>
                    )}
                  </div>
                )}
                {/* The settled rail sits OUTSIDE the `clean.text.trim() && !t.streaming`
                    gate on purpose: that double gate is why routing was invisible
                    while a turn streamed and on a tool-only turn. Read-only - the
                    flight rail in the composer is the editor, so a past turn's
                    record can never be mistaken for a live control. */}
                {showRail && (
                  <AttributionRail
                    variant="settled"
                    route={displayRoute}
                    pins={t.overrides}
                    label="Run context for this reply"
                    onOpenTranscript={onOpenTranscript}
                  />
                )}
              </div>
            )}
          </div>
          );
        })}
        </>
        )}
        {showRaw && (
          <pre className="cc-raw">{screen.join("\n")}</pre>
        )}
      </div>

      <div className="cc-statusstrip" title="Claude Code status line">
        {status.rows.length > 0 ? status.rows.map((r, i) => <div key={i} className="cc-statusrow">{r}</div>) : <div className="cc-statusrow cc-dim">no status</div>}
      </div>

      {/* Permission modes only exist when the transport actually reports one (a
          live PTY). On the orchestrator transport `mode` stays "unknown", and the
          row rendered four permanently-disabled buttons - dead chrome eating a
          strip of the composer area. No mode, no row. */}
      {status.mode !== "unknown" && (
        <div className="cc-modes">
          {SWITCHABLE.map((m) => (
            <button
              key={m}
              className={`cc-mode ${status.mode === m ? "cc-mode-active" : ""}`}
              onClick={() => onSetMode(m)}
              title={`Switch to ${MODE_LABELS[m]} mode`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      )}

      {(feat.model || feat.effort || feat.voice || feat.autonomous || feat.routing) && (
        <div className="cc-toolbar">
          {feat.model && (
            <div className="cc-tool-group" role="group" aria-label="Model">
              <span className="cc-tool-label">Model</span>
              {MODELS.map((m) => {
                const active = (status.model ?? "").toLowerCase().includes(m.label.toLowerCase());
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`cc-chip ${active ? "cc-chip-active" : ""}`}
                    title={`Switch to ${m.label} (${m.id})`}
                    onClick={() => switchModel(m.id)}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          )}
          {feat.effort && (
            <div className="cc-tool-group" role="group" aria-label="Thinking effort">
              <span className="cc-tool-label">Effort</span>
              {EFFORTS.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`cc-chip ${effort === e.id ? "cc-chip-active" : ""}`}
                  title={e.directive ? `Prepend "${e.directive}" to your next message` : "No extra thinking directive"}
                  onClick={() => pickEffort(e.id)}
                >
                  {e.label}
                </button>
              ))}
            </div>
          )}
          {railOn && (
            <button
              type="button"
              className={`cc-chip ${showFlightRail ? "cc-chip-active" : ""}`}
              aria-pressed={showFlightRail}
              title="Pin the target, duty, model, effort, account or project for your next message"
              onClick={() => setRailOpen((v) => !v)}
            >
              Route
            </button>
          )}
          <span className="cc-tool-spacer" />
          {feat.autonomous && (
            <button
              type="button"
              className={`cc-chip ${autonomousOn ? "cc-chip-active" : ""}`}
              aria-pressed={autonomousOn}
              title={autonomousOn
                ? "Autonomous ON: sends register a run card on the board; the reply carries the card link"
                : "Autonomous OFF: messages run interactively. Turn on to register the work as an autonomous run card"}
              onClick={() => setAutonomousOn((v) => !v)}
            >
              Autonomous
            </button>
          )}
          <button
            type="button"
            className="cc-chip"
            title="Compact the conversation (frees context)"
            onClick={() => runCommand("/compact")}
          >
            Compact
          </button>
          <button
            type="button"
            className="cc-chip"
            title="Copy the last response"
            disabled={!turns.some((t) => resolvedAssistantText(t).trim())}
            onClick={() => void copyLast()}
          >
            {copied ? "Copied" : "Copy last"}
          </button>
          {feat.voice && (
            <button
              type="button"
              className={`cc-chip ${readAloud ? "cc-chip-active" : ""} ${speaking && !paused ? "cc-chip-pulse" : ""}`}
              disabled={!voiceUsable}
              aria-pressed={readAloud}
              title={
                voiceUsable
                  ? readAloud ? "Auto-read is on - click to turn it off" : "Read each new response aloud"
                  : "Voice fitting not running"
              }
              onClick={() => {
                const next = !readAloud;
                setReadAloud(next);
                if (!next) stopSpeaking();
              }}
            >
              <svg className="cc-ico" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 2 4.5 5H2v6h2.5L8 14z" fill="currentColor" />
                {voiceUsable && (
                  <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.7a6 6 0 0 1 0 8.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                )}
              </svg>
              Read aloud
            </button>
          )}
          {/* Playback transport - only while a read-aloud is actually running, so
              the toolbar doesn't carry dead controls. Pause/Resume is the control
              a long reply needs; Stop ends the read without turning auto-read off. */}
          {feat.voice && voiceUsable && (speaking || ttsLoading) && (
            <div className="cc-playback" role="group" aria-label="Read-aloud playback">
              <button
                type="button"
                className={`cc-chip ${paused ? "" : "cc-chip-active"}`}
                disabled={ttsLoading}
                title={ttsLoading ? "Preparing audio" : paused ? "Resume reading" : "Pause reading"}
                onClick={togglePause}
              >
                {ttsLoading ? (
                  <>
                    <span className="cc-playback-spin" aria-hidden="true" />
                    Preparing
                  </>
                ) : paused ? (
                  <>
                    <svg className="cc-ico" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M5 3l8 5-8 5z" fill="currentColor" />
                    </svg>
                    Resume
                  </>
                ) : (
                  <>
                    <svg className="cc-ico" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                      <rect x="4" y="3" width="3" height="10" fill="currentColor" />
                      <rect x="9" y="3" width="3" height="10" fill="currentColor" />
                    </svg>
                    Pause
                  </>
                )}
              </button>
              <button type="button" className="cc-chip" title="Stop reading" onClick={stopSpeaking}>
                <svg className="cc-ico" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" />
                </svg>
                Stop
              </button>
            </div>
          )}
        </div>
      )}

      <div className="cc-composer">
        {/* The flight rail: live badges for the turn in flight plus the pin
            dropdowns, mounted while busy, while anything is pinned, or on demand
            from the toolbar's Route chip. */}
        {showFlightRail && (
          <AttributionRail
            variant="flight"
            route={rewriteRouteForHost(latestAssistant?.route, hostCtx())}
            pins={pins}
            pendingFields={pendingPins}
            options={routeOptions ?? undefined}
            onPin={applyPin}
            onOpenTranscript={onOpenTranscript}
            label="Run context for your next message"
            musterUrl={musterUrl}
          >
            {flightRailEnd}
          </AttributionRail>
        )}
        {slashQuery !== null && filtered.length > 0 && (
          <div className="cc-slashmenu">
            {filtered.map((c, i) => (
              <button
                key={c.name}
                className={`cc-slashitem ${i === menuIdx ? "cc-slashitem-active" : ""}`}
                onMouseEnter={() => setMenuIdx(i)}
                onClick={() => pickCommand(c)}
              >
                <span className="cc-slashname">/{c.name}<span className={`cc-badge cc-badge-${c.source}`}>{c.source}</span></span>
                <span className="cc-slashdesc">{c.description || c.argumentHint || ""}</span>
              </button>
            ))}
          </div>
        )}
        {feat.voice && voiceError && (
          <div className="cc-voiceerr" role="status">
            <span className="cc-voiceerr-msg">{voiceError}</span>
            <button
              type="button"
              className="cc-voiceerr-x"
              aria-label="Dismiss voice error"
              onClick={() => setVoiceError(null)}
            >
              ×
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="cc-attachments">
            {attachments.map((a) => (
              <div key={a.id} className={`cc-attachment-chip${a.error ? " cc-attachment-chip-error" : ""}`} title={a.error ?? a.name}>
                {a.previewUrl ? (
                  <img src={a.previewUrl} alt="" className="cc-attachment-thumb" />
                ) : (
                  <svg className="cc-attachment-icon" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4 2h6l3 3v9H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  </svg>
                )}
                <span className="cc-attachment-name">{a.name}</span>
                {a.uploading && <span className="cc-mic-spin" aria-hidden="true" />}
                {a.error && <span className="cc-attachment-err" aria-hidden="true">!</span>}
                <button
                  type="button"
                  className="cc-attachment-x"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => removeAttachment(a.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className={`cc-composerrow${dragOver ? " cc-composerrow-dragover" : ""}`}
          onDragOver={(e) => { if (canAttach) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onComposerDrop}
        >
          {typeof composerAdornment === "function"
            ? composerAdornment({ send: (text: string) => send(text), busy, queueLocked: generatedWork, lastReply: settledReply })
            : composerAdornment}
          {hasAttachmentTransport && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="cc-hidden-file-input"
                onChange={(e) => {
                  if (e.target.files?.length) handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                className="cc-mic"
                disabled={attachmentLocked}
                aria-label="Attach a file"
                title={attachmentLocked ? "Attachments are unavailable while messages are pending" : "Attach a file"}
                onClick={() => fileInputRef.current?.click()}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M11 4.5 5.8 9.7a2.2 2.2 0 0 0 3.1 3.1L14 7.7a3.6 3.6 0 1 0-5.1-5.1L3.8 7.7a5 5 0 0 0 7.1 7.1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </>
          )}
          {feat.voice && (
            <button
              type="button"
              className={`cc-mic ${recording ? "cc-mic-rec" : ""} ${transcribing ? "cc-mic-busy" : ""}`}
              disabled={!voiceUsable || transcribing || (generatedWork && !recording)}
              aria-pressed={recording}
              title={
                !voiceUsable
                  ? "Voice fitting not running"
                  : generatedWork && !recording
                    ? "Voice input is unavailable while messages are pending"
                  : transcribing
                    ? "Transcribing…"
                    : recording
                      ? "Stop recording and transcribe"
                      : "Talk - record then transcribe into the composer"
              }
              onClick={() => (recording ? stopRecording() : void startRecording())}
            >
              {transcribing ? (
                <span className="cc-mic-spin" aria-hidden="true" />
              ) : recording ? (
                <span className="cc-mic-dot" aria-hidden="true" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="currentColor" />
                  <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              )}
            </button>
          )}
          <textarea
            ref={taRef}
            className="cc-input"
            value={input}
            placeholder={placeholder ?? "Message Claude…  (/ for commands)"}
            aria-label={`Message ${title ?? "Claude"}`}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onComposerPaste}
          />
          {generatedMode ? (
            <>
              {activeGeneratedTurn && !showFlightRail && (
                <button
                  type="button"
                  className="cc-stop"
                  onClick={stopTurn}
                  disabled={generatedStopDisabled}
                  aria-busy={activeGeneratedTurn.inputState === "stopping"}
                  title={!activeGeneratedTurn.generationId ? "Stop is available once the response starts" : "Stop this response (Esc)"}
                >
                  <span className="cc-stopsq" /> {generatedStopLabel}
                </button>
              )}
              <button
                type="button"
                className="cc-send"
                onClick={() => send(input)}
                disabled={(!input.trim() && !attachments.some((a) => a.path)) || attachments.some((a) => a.uploading) || (attachmentLocked && attachments.length > 0)}
                title={generatedWork
                  ? "Append this message after the existing queue"
                  : resendArmed
                    ? "Resend the stopped message"
                    : "Send"}
              >
                {generatedWork ? "Queue" : resendArmed ? "Resend" : "Send"}
              </button>
            </>
          ) : busy && !showFlightRail ? (
            // Classic single Stop for a host without the rail (dev-env): with the
            // rail mounted the Stop pair lives at its right-hand end instead, so the
            // two are never on screen at once.
            <button type="button" className="cc-stop" onClick={stopTurn} title="Stop (Esc)">
              <span className="cc-stopsq" /> Stop
            </button>
          ) : busy ? null : (
            <button
              type="button"
              className="cc-send"
              onClick={() => send(input)}
              disabled={(!input.trim() && !attachments.some((a) => a.path)) || attachments.some((a) => a.uploading)}
              title={resendArmed ? "Resend the stopped message with your new routing" : "Send"}
            >
              {resendArmed ? "Resend" : "Send"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
