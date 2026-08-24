// Web Channel UI - the ONE generic, context-driven chat surface, now with a
// SESSIONS sidebar: persisted per-conversation threads you can move between and
// whose history is restored on open.
//
// Two surfaces, chosen by the URL:
//   • Threaded conversations (DEFAULT - the bare URL the Garrison sidebar embeds,
//     and host-opened Discuss links carrying thread/context/mode/kickoff) -
//     @garrison/claude-chat on the orchestrator path (/api/chat → gateway
//     /chat/stream) wrapped in a sessions sidebar. The most recent thread
//     auto-opens; each turn is persisted SERVER-SIDE into its thread (server.mjs
//     tees the exchange on the upstream `done` event), so reopening shows the
//     history and a mid-turn navigation never loses the exchange.
//   • Rich session console (explicit ?console=1) - the same component against
//     the gateway's live /claude/* PTY surface. The session test interface.
//
// The channel stays generic: a `thread` is an OPAQUE key + optional title a host
// (Kanban / Automations) puts on the query string. The channel never interprets
// it - it just persists turns under it and lists them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Marked } from "marked";
import {
  ClaudeChat,
  createHttpTransport,
  SessionStream,
  type ChatInputReceipt,
  type ComposerAdornmentApi,
  type RailOptions,
  type RouteAttribution,
  type SessionEvent,
  type TurnRouting,
} from "@garrison/claude-chat";
import { createOrchestratorTransport } from "./orchestrator-transport";
import { VoiceConversation } from "./voice-conversation";
import { RemoteShellWorkbench } from "./remote-shell-workbench";
import { enablePush, pushState, registerServiceWorker, onNotification, type PushState } from "./push-client";

// The streaming voice surface (S6b): hands-free conversation mode + push-to-talk,
// rendered into ClaudeChat's composer via the function-form adornment so it can
// send transcribed turns and read replies aloud. This SUPERSEDES the component's
// built-in batch voice (feature `voice`) in the web channel - we omit that
// feature so there is a single, streaming mic rather than two.
function voiceAdornment(api: ComposerAdornmentApi) {
  return (
    <VoiceConversation
      send={api.send}
      busy={api.busy}
      queueLocked={api.queueLocked}
      lastReply={api.lastReply}
    />
  );
}

// A private marked instance for the brief PREVIEW (kept separate from the chat's).
const briefMd = new Marked({ breaks: true, gfm: true });

// Pull the absolute brief path out of the Discuss context a host handed us. The
// context arrives as a JSON string (decodeContext) or an already-parsed object; the
// host (Kanban / Automations) sets `briefAbsPath` to the brief file's absolute path.
// Returns undefined when absent - the Brief button then simply doesn't show.
function extractBriefPath(ctx: unknown): string | undefined {
  if (!ctx) return undefined;
  let obj: any = ctx;
  if (typeof ctx === "string") {
    try { obj = JSON.parse(ctx); } catch { return undefined; }
  }
  if (obj && typeof obj === "object" && typeof obj.briefAbsPath === "string" && obj.briefAbsPath.trim()) {
    return obj.briefAbsPath.trim();
  }
  return undefined;
}
// claude-chat.css is concatenated into web-channel.css by ui/build.mjs.

// ── Generic context/source/thread from the URL ─────────────────────────────
function decodeContext(raw: string | null): unknown {
  if (!raw) return undefined;
  if (typeof atob === "function" && typeof btoa === "function") {
    try {
      const bytes = atob(raw);
      if (btoa(bytes) === raw) {
        try { return decodeURIComponent(escape(bytes)); } catch { return bytes; }
      }
    } catch {
      /* not base64 - forward verbatim */
    }
  }
  return raw;
}

interface UrlState {
  context: unknown;
  source: string | undefined;
  kickoff: string | undefined;
  thread: string | undefined;
  title: string | undefined;
  /** The DEPTH the host asked for on a discuss thread (kanban-loop's buildDiscussUrl
   *  sends the card's own level). Undefined for a host that sends none, which is a
   *  level 1 conversation. A bare integer in the query string, not base64. */
  level: number | undefined;
  returnUrl: string | undefined;
  returnLabel: string | undefined;
  /** Explicit ?console=1 - mount the raw PTY session console instead of the
   *  threaded surface. */
  console: boolean;
}

// Return to whatever page the user came from (the board / Automations), robust across
// every access mode - the web channel is reached at its OWN port (127.0.0.1:27083), via
// Garrison's /embed proxy (127.0.0.1:27777), or over the tailnet, and the host's URL
// differs in each. history.back() returns to the previous page regardless of its URL,
// so we never guess a route (an earlier version hard-coded "/embed/kanban-loop", which
// 404'd → SPA-fell-back to the default console when opened directly on :27083). Prefer the
// TOP window when it's same-origin (Garrison embed); fall back to this window (direct
// access - the common case) if the top is cross-origin or is this window.
function goBackToHost(): void {
  let w: Window = window;
  try {
    if (window.top && window.top !== window.self && typeof window.top.location.href === "string") {
      w = window.top;
    }
  } catch {
    w = window; // cross-origin top - can't drive it; use our own history
  }
  w.history.back();
}

function readUrl(): UrlState {
  if (typeof window === "undefined") {
    return { context: undefined, source: undefined, kickoff: undefined, thread: undefined, title: undefined, level: undefined, returnUrl: undefined, returnLabel: undefined, console: false };
  }
  const q = new URLSearchParams(window.location.search);
  const sourceRaw = q.get("source");
  const kickoffRaw = decodeContext(q.get("kickoff"));
  const kickoff = typeof kickoffRaw === "string" && kickoffRaw.trim() ? kickoffRaw : undefined;
  const threadRaw = decodeContext(q.get("thread"));
  const thread = typeof threadRaw === "string" && threadRaw.trim() ? threadRaw.trim() : undefined;
  const titleRaw = decodeContext(q.get("title"));
  const title = typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim() : undefined;
  const returnUrlRaw = decodeContext(q.get("returnUrl"));
  const returnUrl = typeof returnUrlRaw === "string" && returnUrlRaw.trim() ? returnUrlRaw.trim() : undefined;
  const returnLabelRaw = decodeContext(q.get("returnLabel"));
  const returnLabel = typeof returnLabelRaw === "string" && returnLabelRaw.trim() ? returnLabelRaw.trim() : undefined;
  const levelRaw = (q.get("level") || "").trim();
  const level = /^[1-9]$/.test(levelRaw) ? Number(levelRaw) : undefined;
  return {
    context: decodeContext(q.get("context")),
    source: sourceRaw && sourceRaw.trim() ? sourceRaw.trim() : undefined,
    kickoff,
    thread,
    title,
    level,
    returnUrl,
    returnLabel,
    console: q.get("console") === "1",
  };
}

// ── Thread types + API ──────────────────────────────────────────────────────
/** A configured remote-shell transport, relayed from the fitting. */
export interface RemoteShellTransport {
  name: string;
  label: string;
  via: string;
  tmuxSession: string;
  cwd: string;
  routingTarget?: string | null;
}

interface ThreadMeta {
  id: string;
  title: string;
  source: string;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  /** ISO time a still-running turn started, or null/absent when idle. Server-owned
   *  and in-memory: a turn outlives the tab, so on reopen this is the ONLY thing
   *  that distinguishes "still working" from "finished" - persisted history stays
   *  empty until the turn settles. */
  runningSince?: string | null;
  pendingInputCount?: number;
  inputRevision?: number;
  /** Sparse remote-shell binding (threads whose context carries one): which
   *  transport the thread's terminal attaches, plus the routing target its
   *  chat turns pin. Server-derived from the thread context. */
  remoteShell?: { transport: string; target?: string } | null;
}
interface ThreadInput extends ChatInputReceipt {
  message?: string;
  turnSeq?: number;
}
interface ThreadMessage {
  role: "user" | "assistant";
  text: string;
  ts?: string;
  /** Optional durable turn/session coordinates. Current settled assistant rows
   * normally carry these through route, but accepting them directly keeps older
   * and recovery-produced thread files attachable without guessing. */
  turnId?: string | null;
  sessionId?: string | null;
  /** The run context of an assistant reply, persisted per message by threads.mjs
   *  (contract §10). Carried onto the seeded Turn so the rail's badges survive a
   *  reload AND the 10s poll's re-mount - the in-memory Turn.route did not. */
  route?: RouteAttribution;
  /** The pins that were in force when a user message was sent. */
  overrides?: TurnRouting;
}
interface Thread extends ThreadMeta {
  mode: string | null;
  context?: unknown;
  /** The conversation-sticky pins (contract §13). Server-owned, so a pin follows the
   *  user across devices over the tailnet; null when nothing is pinned. */
  routing?: TurnRouting | null;
  messages: ThreadMessage[];
  /** Canonical, revision-merged activity retained independently of the lossy
   * user/assistant text projection. */
  sessionEvents?: ThreadSessionEvent[];
  /** Append-only Claude session chain; a resume can mint a new id. */
  sessionIds?: string[];
  /** Backward-compatible latest-id pointer retained by the server. */
  claudeSessionId?: string | null;
  /** Durable inputs not yet terminal, ordered active-first then FIFO queue. */
  pendingInputs?: ThreadInput[];
  /** Bounded terminal lifecycle receipts. These reattach exact failed/stopped
   * coordinates on reload; they never resurrect completed work. */
  inputReceipts?: ThreadInput[];
}

type ThreadHistorySnapshot = Pick<
  Thread,
  "messages" | "sessionEvents" | "pendingInputs" | "inputReceipts" | "inputRevision"
>;

const messageRevisionRow = (message: ThreadMessage) => [
  message.role,
  message.ts ?? null,
  message.turnId ?? null,
  message.sessionId ?? null,
  message.text,
  message.route ?? null,
  message.overrides ?? null,
];

const eventRevisionRow = (event: ThreadSessionEvent) => [
  event.id,
  event.revision ?? null,
  event.order ?? null,
  event.ts ?? null,
  event.turnId ?? null,
  event.sessionId ?? null,
  event.generationId ?? null,
];

const inputRevisionRow = (input: ThreadInput) => [
  input.inputId,
  input.clientRequestId,
  input.state,
  input.generationId ?? null,
  input.position ?? null,
  input.acceptedAt ?? null,
  input.reason ?? null,
  input.failure ?? null,
  input.message ?? null,
];

const stringCoordinate = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** A Discuss kickoff is an admission, not merely a transcript row. The browser
 * can reload after that admission was durably receipted but before either text
 * row was committed, so every lifecycle coordinate (and its monotonic revision)
 * is evidence that this is no longer a pristine thread. */
export function shouldArmDiscussKickoff(
  thread: Pick<Thread, "messages" | "pendingInputs" | "inputReceipts" | "inputRevision"> | null | undefined,
): boolean {
  // A missing snapshot is not proof of a fresh thread. Fail closed so a
  // transient GET/JSON/network failure cannot replay an already-admitted host
  // kickoff. A verified empty durable snapshot will arm it on the next load.
  if (!thread) return false;
  return (thread.messages?.length ?? 0) === 0 &&
    (thread.pendingInputs?.length ?? 0) === 0 &&
    (thread.inputReceipts?.length ?? 0) === 0 &&
    !(typeof thread.inputRevision === "number" && thread.inputRevision > 0);
}

/** Lightweight durable-history identity used by idle/replay refreshes. Canonical
 * snapshots can advance in place (same array length, higher revision), so message
 * count alone is not a completeness signal. Event payload bytes/images stay out
 * of this key; accepted durable replacements are revisioned by contract. */
export function threadHistoryRevision(thread: ThreadHistorySnapshot): string {
  const messages = (thread.messages ?? []).map(messageRevisionRow);
  const events = (thread.sessionEvents ?? []).map(eventRevisionRow);
  const inputs = [...(thread.inputReceipts ?? []), ...(thread.pendingInputs ?? [])].map(inputRevisionRow);
  return JSON.stringify([messages, events, thread.inputRevision ?? 0, inputs]);
}

function hasRevisionOutsidePaintedInputs<T>(
  currentRows: readonly T[],
  freshRows: readonly T[],
  revisionRow: (row: T) => unknown,
  coordinate: (row: T) => string | null,
  paintedInputIds: ReadonlySet<string>,
): boolean {
  const current = new Map<string, T[]>();
  for (const row of currentRows) {
    const key = JSON.stringify(revisionRow(row));
    const matches = current.get(key) ?? [];
    matches.push(row);
    current.set(key, matches);
  }
  for (const row of freshRows) {
    const key = JSON.stringify(revisionRow(row));
    const matches = current.get(key);
    if (matches?.length) {
      matches.pop();
      continue;
    }
    const inputId = coordinate(row);
    if (!inputId || !paintedInputIds.has(inputId)) return true;
  }
  // Durable rows normally only append or revise. A disappearance is equally a
  // reason to reconcile unless it belongs to the exact input just painted (for
  // example, its pending receipt moving into the bounded terminal receipt set).
  for (const matches of current.values()) {
    for (const row of matches) {
      const inputId = coordinate(row);
      if (!inputId || !paintedInputIds.has(inputId)) return true;
    }
  }
  return false;
}

export function shouldRemountAfterResume(
  current: ThreadHistorySnapshot,
  fresh: ThreadHistorySnapshot,
  recovery: boolean,
  paintedInputIds: readonly string[] = [],
  paintedClientRequestIds: readonly string[] = [],
): boolean {
  if (threadHistoryRevision(fresh) === threadHistoryRevision(current)) return false;
  if (recovery) return true;

  const painted = new Set(paintedInputIds.map((inputId) => inputId.trim()).filter(Boolean));
  const currentInputs = [...(current.inputReceipts ?? []), ...(current.pendingInputs ?? [])];
  const freshInputs = [...(fresh.inputReceipts ?? []), ...(fresh.pendingInputs ?? [])];
  // The request id is owned before admission awaits its host receipt. Resolve it
  // through the fresh snapshot so an immediate completion cannot race the
  // sendMessage return that normally adds the input id directly.
  const paintedRequests = new Set(
    paintedClientRequestIds.map((clientRequestId) => clientRequestId.trim()).filter(Boolean),
  );
  for (const input of freshInputs) {
    if (paintedRequests.has(input.clientRequestId)) painted.add(input.inputId);
  }
  return hasRevisionOutsidePaintedInputs(
    current.messages ?? [],
    fresh.messages ?? [],
    messageRevisionRow,
    (message) => stringCoordinate(message.turnId),
    painted,
  ) || hasRevisionOutsidePaintedInputs(
    current.sessionEvents ?? [],
    fresh.sessionEvents ?? [],
    eventRevisionRow,
    (event) => stringCoordinate(event.turnId),
    painted,
  ) || hasRevisionOutsidePaintedInputs(
    currentInputs,
    freshInputs,
    inputRevisionRow,
    (input) => stringCoordinate(input.inputId),
    painted,
  );
}

/** The durable store enriches the shared rendering vocabulary with ordering and
 * thread/session coordinates. The event blocks themselves remain the shared
 * SessionEvent shape. */
interface ThreadSessionEvent extends SessionEvent {
  turnId?: string | null;
  sessionId?: string | null;
  order?: number;
  revision?: number;
}

/** One completed exchange as ClaudeChat seeds it, with the run context attached to
 *  the reply it describes. */
interface HistoryExchange {
  user: string;
  assistant: string;
  hideUser?: boolean;
  route?: RouteAttribution;
  overrides?: TurnRouting;
  sessionEvents?: ThreadSessionEvent[];
  input?: ChatInputReceipt;
}

// The Turn Rail's menu vocabulary, read from the web-channel's OWN same-origin
// proxy: this fitting serves its own origin, so it can neither call Garrison's Next
// /api/* nor be handed a machine-local gateway URL. Shape mirrors the gateway's
// GET /route/options one-for-one (plus the proxy's `sources` flags, read below).
//
// This is the PACKAGE's RailOptions, not a local copy: the rail consumes what we
// pass, so a hand-rolled structural twin would silently drift from the component
// that renders it the moment either side gains a field.
type RouteOptions = RailOptions;

async function apiListThreads(): Promise<ThreadMeta[]> {
  try {
    const r = await fetch("/api/threads", { cache: "no-store" });
    const d = await r.json();
    return Array.isArray(d.threads) ? d.threads : [];
  } catch { return []; }
}
async function apiGetThread(id: string, signal?: AbortSignal): Promise<Thread | null> {
  try {
    const r = await fetch(`/api/threads/${encodeURIComponent(id)}`, { cache: "no-store", signal });
    if (!r.ok) return null;
    const d = await r.json();
    return d.thread ?? null;
  } catch { return null; }
}
async function apiEnsureThread(payload: { id?: string; title?: string; source?: string; context?: unknown }): Promise<Thread | null> {
  try {
    const r = await fetch("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    return d.thread ?? null;
  } catch { return null; }
}
async function apiDelete(id: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}
// Autosave, no Save button (house rule): every rail tap PUTs the whole pin set.
export async function apiSetRouting(id: string, routing: TurnRouting): Promise<TurnRouting> {
  const response = await fetch(`/api/threads/${encodeURIComponent(id)}/routing`, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ routing }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : `routing save ${response.status}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("routing save returned an invalid confirmation");
  }
  const stored = body.routing;
  if (stored === null) return {};
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error("routing save did not confirm the stored pins");
  }
  return stored as TurnRouting;
}

const asArray = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

// GET /api/route-options → the rail's menus. `?refresh=1` bypasses the proxy's 10s
// cache, used when the user comes back to the tab having just started the board or
// the session (a 10s-stale "nothing available" reads as a broken UI).
// Exported (like toHistory below) purely so the option/degradation mapping is
// unit-testable - this module mounts itself, so a test drives it through stubs.
export async function apiRouteOptions(refresh: boolean): Promise<RouteOptions | null> {
  try {
    const r = await fetch(`/api/route-options${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || typeof d !== "object") return null;
    // Per-DIMENSION honesty. An empty list from a side that did not answer is not
    // "you have no options", it is "that service is not running" - the rail renders
    // the reason on inert rows instead of offering pins nothing would honor.
    const sources = (d.sources ?? {}) as { gateway?: boolean; board?: boolean };
    const unavailable: NonNullable<RouteOptions["unavailable"]> = {};
    if (sources.gateway === false) {
      const why = "the gateway is not answering - start the session to pin routing";
      unavailable.target = why;
      unavailable.model = why;
      unavailable.effort = why;
      unavailable.duty = why;
      unavailable.account = why;
      // The run-plan menus come from the compiled policy, which only the gateway
      // process holds - so they are unavailable for the same reason and must say so
      // rather than rendering as three empty dropdowns.
      unavailable.tier = why;
      unavailable.flow = why;
      unavailable.phasesOff = why;
    }
    if (sources.board === false) {
      unavailable.project = "the kanban board is not running - it is where the project list comes from";
    }
    return {
      targets: asArray<NonNullable<RouteOptions["targets"]>[number]>(d.targets),
      duties: asArray<NonNullable<RouteOptions["duties"]>[number]>(d.duties),
      efforts: asArray<string>(d.efforts),
      accounts: asArray<NonNullable<RouteOptions["accounts"]>[number]>(d.accounts),
      projects: asArray<string>(d.projects),
      tiers: asArray<string>(d.tiers),
      tierDefinitions:
        d.tierDefinitions && typeof d.tierDefinitions === "object" && !Array.isArray(d.tierDefinitions)
          ? (d.tierDefinitions as Record<string, string>)
          : null,
      flows: asArray<NonNullable<RouteOptions["flows"]>[number]>(d.flows),
      phaseCatalog: asArray<string>(d.phaseCatalog),
      defaultFlow: typeof d.defaultFlow === "string" ? d.defaultFlow : null,
      ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
    };
  } catch { return null; }
}

// Pair a flat role/text transcript into the {user, assistant} exchanges the chat
// component seeds from. Robust to a trailing unanswered user turn. The run context
// travels with the pair: `route` (what RAN) comes off the assistant message,
// `overrides` (what was ASKED for) off the user message that provoked it, and both
// land on the exchange so ClaudeChat can seed the turn's badges.
export function toHistory(
  messages: ThreadMessage[],
  sessionEvents: ThreadSessionEvent[] = [],
  pendingInputs: ThreadInput[] = []
): HistoryExchange[] {
  interface HistorySlot {
    exchange: HistoryExchange;
    startTs: number | null;
    endTs: number | null;
    turnId: string | null;
    sessionId: string | null;
    events: ThreadSessionEvent[];
  }
  const slots: HistorySlot[] = [];
  const asTimestamp = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string" || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const asCoordinate = (value: unknown): string | null => {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed || null;
  };
  const messageTurnId = (message: ThreadMessage | null): string | null =>
    asCoordinate(message?.turnId ?? (message?.role === "assistant" ? message.route?.turnSeq : null));
  const pushSlot = (user: ThreadMessage | null, assistant: ThreadMessage | null): number => {
    const route = assistant?.route;
    const exchange: HistoryExchange = {
      user: user?.text ?? "",
      assistant: assistant?.text ?? "",
      ...(route ? { route } : {}),
      ...(user?.overrides ? { overrides: user.overrides } : {}),
    };
    const userTs = asTimestamp(user?.ts);
    const assistantTs = asTimestamp(assistant?.ts);
    slots.push({
      exchange,
      startTs: userTs ?? assistantTs,
      endTs: assistantTs ?? userTs,
      turnId: asCoordinate(assistant?.turnId ?? user?.turnId ?? route?.turnSeq),
      sessionId: asCoordinate(assistant?.sessionId ?? user?.sessionId ?? route?.sessionId),
      events: [],
    });
    return slots.length - 1;
  };
  const attachAssistant = (index: number, assistant: ThreadMessage) => {
    const slot = slots[index];
    const route = assistant.route;
    slot.exchange = {
      ...slot.exchange,
      assistant: assistant.text,
      ...(route ? { route } : {}),
    };
    const assistantTs = asTimestamp(assistant.ts);
    if (slot.startTs === null) slot.startTs = assistantTs;
    slot.endTs = assistantTs ?? slot.endTs;
    slot.turnId = messageTurnId(assistant) ?? slot.turnId;
    slot.sessionId = asCoordinate(assistant.sessionId ?? route?.sessionId) ?? slot.sessionId;
  };
  const keyedUsers = new Map<string, number[]>();
  let pendingLegacyUser: number | null = null;
  for (const m of messages ?? []) {
    if (m.role === "user") {
      const index = pushSlot(m, null);
      const turnId = messageTurnId(m);
      if (turnId) {
        const waiting = keyedUsers.get(turnId) ?? [];
        waiting.push(index);
        keyedUsers.set(turnId, waiting);
      } else {
        pendingLegacyUser = index;
      }
    } else if (m.role === "assistant") {
      const turnId = messageTurnId(m);
      if (turnId) {
        const waiting = keyedUsers.get(turnId);
        const index = waiting?.shift();
        if (waiting?.length === 0) keyedUsers.delete(turnId);
        if (index !== undefined) attachAssistant(index, m);
        else if (pendingLegacyUser !== null) {
          // Before durable input ids, only the assistant's route carried a
          // browser-local turnSeq. Preserve that legacy adjacency fallback when
          // the user itself has no coordinate; an explicitly keyed user never
          // reaches this branch, so external unkeyed notices remain isolated.
          attachAssistant(pendingLegacyUser, m);
          pendingLegacyUser = null;
        }
        else pushSlot(null, m);
      } else if (pendingLegacyUser !== null) {
        attachAssistant(pendingLegacyUser, m);
        pendingLegacyUser = null;
      } else {
        pushSlot(null, m);
      }
    }
  }
  const attachPendingInputs = () => {
    for (const input of Array.isArray(pendingInputs) ? pendingInputs : []) {
      if (!input || typeof input.inputId !== "string" || typeof input.clientRequestId !== "string") continue;
      const receipt: ChatInputReceipt = {
        clientRequestId: input.clientRequestId,
        inputId: input.inputId,
        state: input.state,
        ...(input.position !== undefined ? { position: input.position } : {}),
        ...(input.generationId ? { generationId: input.generationId } : {}),
        ...(input.acceptedAt ? { acceptedAt: input.acceptedAt } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.failure ? { failure: input.failure } : {}),
      };
      const existing = slots.find((slot) => slot.turnId === input.inputId);
      if (existing) {
        existing.exchange.input = receipt;
        continue;
      }
      if (typeof input.message !== "string") continue;
      slots.push({
        exchange: { user: input.message, assistant: "", input: receipt },
        startTs: asTimestamp(input.acceptedAt),
        endTs: asTimestamp(input.acceptedAt),
        turnId: input.inputId,
        sessionId: null,
        events: [],
      });
    }
  };
  if (slots.length === 0 || !Array.isArray(sessionEvents) || sessionEvents.length === 0) {
    attachPendingInputs();
    return slots.map((slot) => slot.exchange);
  }

  // First retain turn groups as the server stored them. A page reload can reset
  // turnSeq while the Claude session stays alive, so equal coordinates split again
  // when canonical order resets; revisions of the same event id stay together.
  interface EventGroup {
    events: ThreadSessionEvent[];
    turnId: string | null;
    sessionId: string | null;
    ts: number | null;
    lastOrder: number | null;
    lastId: string | null;
  }
  const groups: EventGroup[] = [];
  for (const event of sessionEvents) {
    if (!event || typeof event !== "object") continue;
    const turnId = asCoordinate(event.turnId);
    const sessionId = asCoordinate(event.sessionId);
    const order = typeof event.order === "number" && Number.isFinite(event.order) ? event.order : null;
    const id = asCoordinate(event.id);
    const previous = groups.at(-1);
    const sameCoordinate = Boolean(
      previous && previous.turnId === turnId && previous.sessionId === sessionId
    );
    const orderReset = Boolean(
      previous && order !== null && previous.lastOrder !== null && order <= previous.lastOrder && id !== previous.lastId
    );
    const startsUserTurn = event.role === "user" && event.toolResultsOnly !== true;
    let group = previous;
    if (!group || !sameCoordinate || orderReset || startsUserTurn) {
      group = { events: [], turnId, sessionId, ts: null, lastOrder: null, lastId: null };
      groups.push(group);
    }
    group.events.push(event);
    const eventTs = asTimestamp(event.ts);
    if (eventTs !== null && (group.ts === null || eventTs < group.ts)) group.ts = eventTs;
    group.lastOrder = order;
    group.lastId = id;
  }

  let sequenceCursor = 0;
  const byTimestamp = (candidates: number[], ts: number | null): number | null => {
    if (ts === null) return null;
    const timed = candidates
      .map((index) => ({ index, at: slots[index].startTs ?? slots[index].endTs }))
      .filter((entry): entry is { index: number; at: number } => entry.at !== null);
    if (timed.length === 0) return null;
    const before = timed.filter((entry) => entry.at <= ts);
    if (before.length > 0) return before.reduce((best, entry) => entry.at >= best.at ? entry : best).index;
    return timed.reduce((best, entry) => Math.abs(entry.at - ts) < Math.abs(best.at - ts) ? entry : best).index;
  };
  const bySequence = (candidates: number[]): number => {
    const atOrAfter = candidates.filter((index) => index >= sequenceCursor);
    const pool = atOrAfter.length > 0 ? atOrAfter : candidates;
    const empty = pool.find((index) => slots[index].events.length === 0);
    return empty ?? pool[pool.length - 1] ?? 0;
  };

  for (const group of groups) {
    const all = slots.map((_slot, index) => index);
    let candidates = all;
    if (group.turnId !== null) {
      const sameTurn = all.filter((index) => slots[index].turnId === group.turnId);
      if (sameTurn.length > 0) candidates = sameTurn;
    }
    // Browser-local turn counters can repeat after reload, while one SDK session
    // can span turns (and can also roll to a new id inside one turn). Time is
    // therefore the discriminator inside an explicit turn-coordinate set;
    // session id is only a no-time fallback, never a key that can force a live
    // group onto an older answered exchange.
    const timedIndex = byTimestamp(candidates, group.ts);
    const sameSession = group.sessionId === null
      ? []
      : candidates.filter((index) => slots[index].sessionId === group.sessionId);
    const index = timedIndex ?? bySequence(sameSession.length > 0 ? sameSession : candidates);
    slots[index].events.push(...group.events);
    sequenceCursor = Math.max(sequenceCursor, index);
  }

  attachPendingInputs();
  return slots.map(({ exchange, events }) => events.length > 0 ? { ...exchange, sessionEvents: events } : exchange);
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diff = now - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

// ── Brief editor (view + edit the Discuss brief markdown) ────────────────────
// A slide-over panel over the chat. Loads the brief from the confined /api/brief
// endpoint (GET by absolute path), lets the user edit it as markdown (with a Preview
// toggle), and saves back (PUT). Handles the "no brief written yet" case - Save
// creates the file. The path is the host-provided absolute briefAbsPath.
function BriefPanel({ path: briefPath, onClose }: { path: string; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [exists, setExists] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setError(null);
    fetch(`/api/brief?path=${encodeURIComponent(briefPath)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.error) setError(String(d.error));
        else { setContent(typeof d.content === "string" ? d.content : ""); setExists(Boolean(d.exists)); }
        setLoaded(true);
        setDirty(false);
      })
      .catch((e) => { if (alive) { setError(String(e)); setLoaded(true); } });
    return () => { alive = false; };
  }, [briefPath]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/brief", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: briefPath, content }),
      });
      const d = await r.json();
      if (d?.error) setError(String(d.error));
      else { setSaved(true); setDirty(false); setExists(true); window.setTimeout(() => setSaved(false), 1600); }
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  }, [briefPath, content]);

  const base = briefPath.split("/").pop() || "brief.md";
  return (
    <div className="wc-brief" role="dialog" aria-label="Brief">
      <div className="wc-brief-head">
        <span className="wc-brief-title">Brief<span className="wc-brief-file" title={briefPath}>{base}</span></span>
        <div className="wc-brief-modes" role="group" aria-label="View mode">
          <button type="button" className={mode === "edit" ? "wc-brief-mode-active" : ""} onClick={() => setMode("edit")}>Edit</button>
          <button type="button" className={mode === "preview" ? "wc-brief-mode-active" : ""} onClick={() => setMode("preview")}>Preview</button>
        </div>
        <button type="button" className="wc-brief-close" onClick={onClose} aria-label="Close brief">×</button>
      </div>
      <div className="wc-brief-body">
        {!loaded ? (
          <div className="wc-brief-loading">Loading…</div>
        ) : mode === "edit" ? (
          <textarea
            className="wc-brief-editor"
            value={content}
            spellCheck={false}
            onChange={(e) => { setContent(e.target.value); setDirty(true); }}
            placeholder={exists ? "" : "No brief written yet - type here to create it, then Save."}
          />
        ) : (
          <div className="wc-brief-preview cc-md" dangerouslySetInnerHTML={{ __html: briefMd.parse(content.trim() || "_(empty brief)_") as string }} />
        )}
      </div>
      <div className="wc-brief-foot">
        {error ? <span className="wc-brief-err">{error}</span>
          : saved ? <span className="wc-brief-ok">Saved</span>
          : dirty ? <span className="wc-brief-dirty">Unsaved changes</span>
          : <span className="wc-brief-dim">{exists ? "Up to date" : "Not created yet"}</span>}
        <span className="wc-brief-spacer" />
        <button type="button" className="wc-brief-save" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

/** Where the wide-layout session list remembers whether it was open. */
const SESSIONS_OPEN_KEY = "wc.sessions.open";

// ── Threaded app (sidebar + chat) ───────────────────────────────────────────
// "Still working" banner for a turn that was already running when this view
// mounted (reopened tab / navigated back). Counts up from the server-reported
// start so the elapsed time is the TURN's, not this component's.
function ResumedWorkingNotice({ since }: { since: string }) {
  const started = useMemo(() => {
    const t = Date.parse(since);
    return Number.isNaN(t) ? Date.now() : t;
  }, [since]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - started) / 1000));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className="wc-resumed">
      <span className="wc-resumed-dot" aria-hidden />
      <span>Still working on this conversation</span>
      <span className="wc-resumed-clock">{clock}</span>
      <span className="wc-resumed-hint">the reply lands here when it finishes</span>
    </div>
  );
}


// ── Sticky project ──────────────────────────────────────────────────────────
// The LAST explicitly pinned project follows the user onto NEW conversations
// (personal included) until they clear the pin. Deliberately client-side and
// per-device: a sticky default is a convenience, not routing truth — the pin it
// applies is a normal thread pin the rail shows and can clear.
const STICKY_PROJECT_KEY = "garrison.web.stickyProject";

function rememberStickyProject(prev: TurnRouting | null, next: TurnRouting): void {
  try {
    const before = typeof prev?.project === "string" ? prev.project : null;
    const after = typeof next?.project === "string" ? next.project : null;
    if (after) window.localStorage.setItem(STICKY_PROJECT_KEY, after);
    else if (before && !after) window.localStorage.removeItem(STICKY_PROJECT_KEY);
  } catch { /* storage unavailable - stickiness is best-effort */ }
}

/** Apply the remembered project to a PRISTINE thread (no history, no explicit
 *  routing). Remote-shell threads are exempt: their work runs on another
 *  machine, where a local project cwd would be a lie. */
async function applyStickyProject(thread: Thread | null): Promise<TurnRouting | null> {
  if (!thread) return null;
  try {
    const sticky = window.localStorage.getItem(STICKY_PROJECT_KEY);
    if (!sticky) return null;
    if ((thread.messages?.length ?? 0) > 0) return null;
    if (thread.routing && typeof thread.routing.project === "string") return null;
    const ctx = thread.context as { remoteShell?: unknown } | undefined;
    if (ctx?.remoteShell) return null;
    return await apiSetRouting(thread.id, { ...(thread.routing ?? {}), project: sticky });
  } catch {
    return null;
  }
}

function ThreadedApp({ url }: { url: UrlState }) {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The WIDE-layout session list, independent of the narrow drawer above.
  // Collapsed by default (the list is navigation, not the work) and sticky: a
  // preference you set once should survive the next visit, so it is read from
  // localStorage at init rather than reset to the default on every mount.
  const [listOpen, setListOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SESSIONS_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(SESSIONS_OPEN_KEY, listOpen ? "1" : "0");
    } catch {
      /* private mode / storage disabled - the toggle still works for this visit */
    }
  }, [listOpen]);
  const [briefOpen, setBriefOpen] = useState(false);
  // Bumped to re-mount BriefPanel (re-fetch fresh content) when the brief changes on disk.
  const [briefReloadKey, setBriefReloadKey] = useState(0);
  // Last-observed brief content, to detect a NEW write after a turn. undefined = not yet
  // baselined; null = checked & absent; string = last-seen content.
  const lastBriefRef = useRef<string | null | undefined>(undefined);
  // The kickoff is auto-sent only for a FRESH thread opened from a host (Discuss),
  // never when reopening a thread that already has history or when switching.
  const [kickoffFor, setKickoffFor] = useState<string | null>(null);
  // The Turn Rail's pins for the open conversation, adopted from the thread on open
  // and written straight back on every change. Held here rather than read off
  // activeThread on every render so a local tap is never undone by the idle poll's
  // (older) copy of the thread.
  const [pins, setPins] = useState<TurnRouting | null>(null);
  const [routeOptions, setRouteOptions] = useState<RouteOptions | null>(null);
  // The routed runtime's own session, opened from a turn's `transcript` badge (§12):
  // the spawned session is not a separate place, it is a drill-down on the bubble it
  // produced.
  const [transcriptSession, setTranscriptSession] = useState<string | null>(null);
  const openThreadEpochRef = useRef(0);
  const openThreadAbortRef = useRef<AbortController | null>(null);
  const activityEpochRef = useRef(0);
  // Remote-shell surface: the configured transports (empty when the fitting is
  // absent — the section simply doesn't render), and the fitting-side session
  // id backing the ACTIVE thread's terminal pane.
  const [rshTransports, setRshTransports] = useState<RemoteShellTransport[]>([]);
  const [rshSessionId, setRshSessionId] = useState<string | null>(null);
  const [rshError, setRshError] = useState<string | null>(null);

  // The active thread's remote-shell binding, read from its opaque context.
  // A STRING, not an object: the 10s idle poll replaces activeThread (and so
  // the context object's identity) every tick — an object here would retrigger
  // the attach effect below each poll, tearing down and re-creating the
  // session/WS ten times a minute with a visible pane gap during each POST.
  const activeRshTransport = useMemo(() => {
    const ctx = activeThread?.context as { remoteShell?: { transport?: unknown } } | undefined;
    return typeof ctx?.remoteShell?.transport === "string" ? ctx.remoteShell.transport : null;
  }, [activeThread?.context]);

  useEffect(() => {
    let alive = true;
    void fetch("/api/remote-shell/transports")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (alive && Array.isArray(data?.transports)) setRshTransports(data.transports); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Opening a remote-shell thread (re)ensures its fitting-side session — an
  // idempotent attach that also revives it after a Garrison restart.
  useEffect(() => {
    setRshSessionId(null);
    setRshError(null);
    if (!activeRshTransport) return;
    let alive = true;
    void fetch("/api/remote-shell/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transport: activeRshTransport })
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) { setRshError(data?.error || `remote shell unavailable (${r.status})`); return; }
        setRshSessionId(data?.session?.id ?? null);
      })
      .catch((err) => { if (alive) setRshError(err instanceof Error ? err.message : String(err)); });
    return () => { alive = false; };
  }, [activeRshTransport]);

  const refreshList = useCallback(async (expectedEpoch = activityEpochRef.current) => {
    const list = await apiListThreads();
    if (expectedEpoch !== activityEpochRef.current) return false;
    setThreads(list);
    return true;
  }, []);

  const openThread = useCallback(async (id: string, opts?: { kickoff?: boolean }) => {
    const epoch = ++openThreadEpochRef.current;
    openThreadAbortRef.current?.abort();
    const controller = new AbortController();
    openThreadAbortRef.current = controller;
    const t = await apiGetThread(id, controller.signal);
    if (controller.signal.aborted || epoch !== openThreadEpochRef.current) return;
    // Do not mount a writable empty chat for an unverified durable thread. A
    // transient GET/JSON/network failure is not an empty history; keeping the
    // prior verified thread (or the loading surface on first open) prevents a
    // new admission from hiding its existing messages and pending work.
    if (!t) {
      setKickoffFor(null);
      return;
    }
    setActiveId(id);
    setActiveThread(t);
    setPins(t?.routing ?? null);
    setTranscriptSession(null);
    setKickoffFor(opts?.kickoff && shouldArmDiscussKickoff(t) ? id : null);
    setSidebarOpen(false);
  }, []);

  useEffect(() => () => openThreadAbortRef.current?.abort(), []);

  // One options read per mount, revalidated when the tab regains focus (the user was
  // just in Muster, or has only now started the board). A failed read leaves the rail
  // READ-ONLY - an options fetch must never be able to block the chat.
  useEffect(() => {
    let alive = true;
    const load = (refresh: boolean) => {
      void apiRouteOptions(refresh).then((o) => { if (alive && o) setRouteOptions(o); });
    };
    load(false);
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => { alive = false; window.removeEventListener("focus", onFocus); };
  }, []);

  const savePins = useCallback(async (next: TurnRouting) => {
    rememberStickyProject(pins, next);
    if (!activeId) {
      setPins(next);
      return;
    }
    const confirmed = await apiSetRouting(activeId, next);
    setPins(confirmed);
  }, [activeId, pins]);

  // One slide-over at a time: the brief editor and the session transcript occupy the
  // same panel slot, and stacking them just hides one behind the other.
  const openTranscript = useCallback((sessionId: string) => {
    setBriefOpen(false);
    setTranscriptSession(sessionId);
  }, []);

  // First load: open the host-provided thread (Discuss), else the most recent,
  // else a fresh ad-hoc conversation.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const list = await apiListThreads();
      if (!alive) return;
      setThreads(list);
      if (url.thread) {
        const ensured = await apiEnsureThread({
          id: url.thread,
          title: url.title,
          source: url.source === "discuss" || Boolean(url.kickoff) ? "discuss" : "chat",
          context: url.context,
        });
        if (!alive) return;
        const id = ensured?.id ?? url.thread;
        if (url.source === "discuss" || Boolean(url.kickoff)) {
          // Pin the duty always; the level only DEFAULTS to 1. A card that reached
          // Discuss through the clarity gate can be level 2+, and forcing 1 here
          // silently demoted it back to a light chat.
          await apiSetRouting(id, { duty: "discuss", level: url.level ?? 1 });
        }
        await openThread(id, { kickoff: Boolean(url.kickoff) });
      } else if (url.context !== undefined || url.source !== undefined || url.kickoff !== undefined) {
        // Context-driven but no stable key → a fresh ad-hoc thread carrying it.
        const ensured = await apiEnsureThread({
          title: url.title,
          source: url.source === "discuss" || Boolean(url.kickoff) ? "discuss" : "chat",
          context: url.context,
        });
        if (!alive) return;
        if (ensured) {
          if (url.source === "discuss" || Boolean(url.kickoff)) {
            await apiSetRouting(ensured.id, { duty: "discuss", level: url.level ?? 1 });
          }
          await openThread(ensured.id, { kickoff: Boolean(url.kickoff) });
        }
      } else if (list.length > 0) {
        await openThread(list[0].id);
      } else {
        const ensured = await apiEnsureThread({ source: "chat" });
        if (!alive) return;
        if (ensured) await openThread(ensured.id);
      }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newChat = useCallback(async () => {
    const ensured = await apiEnsureThread({ source: "chat" });
    if (ensured) {
      await applyStickyProject(ensured);
      await openThread(ensured.id);
      await refreshList();
    }
  }, [openThread, refreshList]);

  // One-step remote-shell entry ("CSG work"): a stable thread per transport,
  // carrying the binding in its context and pinning the transport's routing
  // target (once) so chat-lane turns delegate to the remote agent.
  const openRemoteShell = useCallback(async (t: RemoteShellTransport) => {
    const ensured = await apiEnsureThread({
      id: `remote-shell-${t.name}`,
      title: t.label || t.name,
      source: "remote-shell",
      context: { remoteShell: { transport: t.name, ...(t.routingTarget ? { target: t.routingTarget } : {}) } }
    });
    if (!ensured) return;
    if (t.routingTarget && !ensured.routing?.target) {
      await apiSetRouting(ensured.id, { ...(ensured.routing ?? {}), target: t.routingTarget });
    }
    await openThread(ensured.id);
    await refreshList();
  }, [openThread, refreshList]);

  const selectThread = useCallback(async (id: string) => {
    if (id === activeId) { setSidebarOpen(false); return; }
    await openThread(id);
  }, [activeId, openThread]);

  const removeThread = useCallback(async (id: string, e: React.SyntheticEvent) => {
    e.stopPropagation();
    const deleted = await apiDelete(id);
    const list = await apiListThreads();
    setThreads(list);
    if (!deleted) return;
    if (id === activeId) {
      if (list.length > 0) await openThread(list[0].id);
      else await newChat();
    }
  }, [activeId, openThread, newChat]);

  // Persistence is SERVER-SIDE: server.mjs handleChat tees each exchange into the
  // thread when the upstream `done` event arrives (the transport sends the thread
  // id on every POST /api/chat), so a mid-turn navigation or tab close never loses
  // it. On turn completion the client only refreshes the session list metadata.
  // Server-side appends land in the thread file without a client turn — the run
  // engine posts a card's outcome back to its originating thread (kanban
  // notify-origin). Poll the open thread while idle and, when its durable messages
  // or canonical event revisions advance, bump historyRev so ClaudeChat re-mounts
  // with the fresh transcript. Suppressed mid-turn (a re-mount would orphan the streaming
  // reply), with a 20-minute expiry so a lost turn can't mute feedback forever.
  const busyRef = useRef(false);
  const busySinceRef = useRef(0);
  const recoveryPendingRef = useRef<string | null>(null);
  const [historyRev, setHistoryRev] = useState(0);
  // Matches the 600px composer breakpoint in styles.css. Tracked live so a
  // rotate/resize swaps the placeholder without a reload.
  const [narrowComposer, setNarrowComposer] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 600px)");
    const apply = () => setNarrowComposer(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const onTurnSettled = useCallback(async () => {
    // Generated FIFO activity owns the authoritative sidebar count. A reply can
    // settle while the next admission/follower is already active; committing a
    // list snapshot from that overlap could briefly re-enable Delete on a live
    // thread. The transport's post-cleanup refresh will reconcile once idle.
    if (busyRef.current) return;
    const activityEpoch = activityEpochRef.current;
    await refreshList(activityEpoch);
  }, [refreshList]);
  useEffect(() => {
    if (!activeId) return;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (busyRef.current && Date.now() - busySinceRef.current < 20 * 60_000) return;
      const activityEpoch = activityEpochRef.current;
      const fresh = await apiGetThread(activeId);
      if (!fresh || busyRef.current || activityEpoch !== activityEpochRef.current) return;
      setActiveThread((current) => {
        if (!current || fresh.id !== current.id) return current;
        if (threadHistoryRevision(fresh) !== threadHistoryRevision(current)) {
          setHistoryRev((r) => r + 1);
        }
        // Even without transcript growth, runningSince/session metadata may have
        // settled and the parent notice must stop reflecting stale state.
        return fresh;
      });
    };
    const timer = window.setInterval(() => { void tick(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [activeId]);

  const history = useMemo(() => {
    if (!activeThread) return [] as HistoryExchange[];
    return toHistory(
      activeThread.messages,
      activeThread.sessionEvents,
      [...(activeThread.inputReceipts ?? []), ...(activeThread.pendingInputs ?? [])]
    );
  }, [activeThread]);
  // Show a prominent Back button for a host-opened Discuss (Kanban / Automations set a
  // returnLabel). Clicking it returns to the page the user came from via history.back().
  const backLabel = url.returnLabel && url.returnLabel.trim()
    ? url.returnLabel.trim()
    : (url.returnUrl ? "Back" : undefined);
  const ctx = activeThread?.context ?? url.context;
  // The Discuss brief's absolute path (host-provided) - enables the Brief editor.
  const briefPath = useMemo(() => extractBriefPath(ctx), [ctx]);

  // Baseline the brief when the active Discuss changes (don't auto-open on mount); close
  // the panel on thread switch.
  useEffect(() => {
    lastBriefRef.current = undefined;
    setBriefOpen(false);
    if (!briefPath) return;
    let alive = true;
    fetch(`/api/brief?path=${encodeURIComponent(briefPath)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (alive && d && !d.error) lastBriefRef.current = d.exists ? (typeof d.content === "string" ? d.content : "") : null; })
      .catch(() => {});
    return () => { alive = false; };
  }, [briefPath]);

  // After a turn settles, re-check the brief; if the Discuss duty just wrote or updated it, auto-open
  // the editor and re-mount it so it shows the fresh content.
  const checkBriefAfterTurn = useCallback(async () => {
    if (!briefPath) return;
    try {
      const r = await fetch(`/api/brief?path=${encodeURIComponent(briefPath)}`, { cache: "no-store" });
      const d = await r.json();
      if (!d || d.error || !d.exists) return;
      const content = typeof d.content === "string" ? d.content : "";
      if (lastBriefRef.current === undefined) { lastBriefRef.current = content; return; }
      if (content !== lastBriefRef.current) {
        lastBriefRef.current = content;
        setBriefReloadKey((k) => k + 1);
        setBriefOpen(true);
        setTranscriptSession(null); // same panel slot - see openTranscript
      }
    } catch { /* best effort - auto-open is a convenience */ }
  }, [briefPath]);

  const kickoff = activeId && kickoffFor === activeId ? url.kickoff : undefined;
  // Retire the kickoff the moment it has been handed over. ClaudeChat's own
  // guard (kickedRef) only fires once per MOUNT, and `key` re-mounts it every
  // time historyRev advances — which the idle poll and refreshAfterResume both
  // do as soon as the kickoff's own turn lands. Leaving kickoffFor set therefore
  // re-sent the opening message after every reply, forever: an unusable Discuss
  // that answered the same prompt over and over. Child effects run before parent
  // effects, so ClaudeChat has already sent by the time this clears.
  useEffect(() => {
    if (kickoff) setKickoffFor(null);
  }, [kickoff]);
  const refreshAfterResume = useCallback(async ({
    recovery,
    paintedInputIds,
    paintedClientRequestIds,
  }: {
    recovery: boolean;
    paintedInputIds: readonly string[];
    paintedClientRequestIds: readonly string[];
  }) => {
    if (!activeId) return;
    if (recovery) recoveryPendingRef.current = activeId;
    const activityEpoch = activityEpochRef.current;
    const [fresh, list] = await Promise.all([apiGetThread(activeId), apiListThreads()]);
    if (!fresh || busyRef.current || activityEpoch !== activityEpochRef.current) return;
    const needsRecovery = recovery || recoveryPendingRef.current === activeId;
    setThreads(list);
    setActiveThread((current) => {
      if (!current || current.id !== fresh.id) return current;
      // A normal follower terminal was already reduced into ClaudeChat. Keep that
      // component mounted so an in-flight spoken reply, focus, and local controls
      // survive the durable metadata refresh. Missed/empty/malformed replay and
      // durable coordinates owned by another client rebuild child history from
      // disk; exact inputs painted by this transport do not.
      if (shouldRemountAfterResume(
        current,
        fresh,
        needsRecovery,
        paintedInputIds,
        paintedClientRequestIds,
      )) {
        setHistoryRev((r) => r + 1);
      }
      if (recoveryPendingRef.current === activeId) recoveryPendingRef.current = null;
      return fresh;
    });
  }, [activeId]);
  // One transport per open thread (ClaudeChat re-mounts on activeId anyway), so
  // every send carries the thread id the server persists under. sendMessage is
  // wrapped to mark the turn busy — the idle poll must never re-mount the chat
  // while a reply is streaming. A reopened running thread asks the SAME transport
  // to replay/follow its server-owned event journal; no second event reducer exists.
  const transport = useMemo(() => {
    const resumedSince = activeThread?.runningSince ?? null;
    const hasPendingInputs = Boolean(activeThread?.pendingInputs?.length);
    // Inputs already present at hydration are painted by resume; inputs admitted
    // through this exact transport are painted by its follower. This closure is
    // intentionally per transport/thread so a different browser's input can
    // never be mistaken for a locally reconciled turn.
    const paintedInputIds = new Set(
      (activeThread?.pendingInputs ?? []).map((input) => input.inputId),
    );
    const paintedClientRequestIds = new Set(
      (activeThread?.pendingInputs ?? []).map((input) => input.clientRequestId),
    );
    const t = createOrchestratorTransport("/api", activeId ?? undefined, {
      resumeOnConnect: hasPendingInputs,
      initialInputRevision: activeThread?.inputRevision,
      initialInputIds: activeThread?.pendingInputs?.map((input) => input.inputId) ?? [],
      onResumeState(active) {
        activityEpochRef.current += 1;
        busyRef.current = active;
        if (active) {
          if (activeId) {
            setThreads((current) => current.map((thread) => thread.id === activeId
              ? {
                  ...thread,
                  pendingInputCount: Math.max(1, thread.pendingInputCount ?? 0),
                  runningSince: thread.runningSince ?? new Date().toISOString(),
                }
              : thread));
          }
          const started = Date.parse(resumedSince ?? "");
          busySinceRef.current = Number.isFinite(started) ? started : Date.now();
        }
      },
      onResumeSettled(result) {
        void refreshAfterResume({
          ...result,
          paintedInputIds: [...paintedInputIds],
          paintedClientRequestIds: [...paintedClientRequestIds],
        });
      },
    });
    const sendMessage = t.sendMessage;
    t.sendMessage = async (message, meta) => {
      if (meta?.clientRequestId?.trim()) paintedClientRequestIds.add(meta.clientRequestId.trim());
      const receipt = await sendMessage(message, meta);
      if (receipt?.inputId) paintedInputIds.add(receipt.inputId);
      return receipt;
    };
    return t;
  }, [activeId, activeThread?.runningSince, activeThread?.inputRevision, refreshAfterResume]);

  return (
    <div className={`wc-shell${sidebarOpen ? " wc-shell--open" : ""}${listOpen ? "" : " wc-shell--rail"}`}>
      <button
        className="wc-sidebar-toggle"
        aria-label={sidebarOpen ? "Hide sessions" : "Show sessions"}
        onClick={() => setSidebarOpen((v) => !v)}
        title="Sessions"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        </svg>
      </button>
      <aside className="wc-sidebar" aria-label="Sessions">
        <div className="wc-sidebar-head">
          <button
            className="wc-sidebar-collapse"
            aria-expanded={listOpen}
            aria-label={listOpen ? "Collapse sessions" : "Expand sessions"}
            title={listOpen ? "Collapse sessions" : "Expand sessions"}
            onClick={() => setListOpen((v) => !v)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </button>
          <span className="wc-sidebar-title">Sessions</span>
          <button className="wc-new" onClick={newChat} title="Start a new conversation">+ New</button>
        </div>
        <div className="wc-thread-list">
          {threads.length === 0 && <div className="wc-empty-list">No conversations yet</div>}
          {threads.map((t) => {
            const deleteDisabled = (t.pendingInputCount ?? 0) > 0;
            return (
              <div key={t.id} className={`wc-thread${t.id === activeId ? " wc-thread--active" : ""}`}>
                <button
                  type="button"
                  className="wc-thread-open"
                  onClick={() => selectThread(t.id)}
                  title={t.title}
                >
                  <span className="wc-thread-main">
                    <span className="wc-thread-title">{t.title || "New conversation"}</span>
                    <span className="wc-thread-meta">
                      {t.source && t.source !== "chat" && <span className="wc-thread-src">{t.source}</span>}
                      {t.runningSince ? (
                        <span className="wc-thread-src">Working</span>
                      ) : deleteDisabled ? (
                        <span className="wc-thread-src">{t.pendingInputCount} queued</span>
                      ) : null}
                      <span className="wc-thread-when">{fmtWhen(t.updatedAt)}</span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="wc-thread-del"
                  aria-label={deleteDisabled ? "Conversation has pending messages" : "Delete conversation"}
                  disabled={deleteDisabled}
                  title={deleteDisabled ? "Finish or stop pending messages before deleting" : "Delete"}
                  onClick={(e) => { void removeThread(t.id, e); }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {rshTransports.length > 0 && (
          <div className="wc-rsh-rail">
            <div className="wc-rsh-rail-title">Remote shells</div>
            {rshTransports.map((t) => (
              <button
                key={t.name}
                type="button"
                className="wc-rsh-entry"
                onClick={() => { void openRemoteShell(t); }}
                title={`Attach ${t.label || t.name} (${t.via})`}
              >
                <span className="wc-rsh-entry-label">{t.label || t.name}</span>
                <span className="wc-rsh-entry-via">{t.via}</span>
              </button>
            ))}
          </div>
        )}
      </aside>
      <div className="wc-sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      <main className="wc-main">
        {(backLabel || briefPath) && (
          <div className="wc-backbar">
            {backLabel && (
              <button
                type="button"
                className="wc-back"
                onClick={goBackToHost}
                title={`Return to ${backLabel}`}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {backLabel}
              </button>
            )}
            <span className="wc-backbar-spacer" />
            {briefPath && (
              <button
                type="button"
                className={`wc-briefbtn${briefOpen ? " wc-briefbtn-active" : ""}`}
                onClick={() => { setBriefOpen((v) => !v); setTranscriptSession(null); }}
                title="View or edit the brief"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 2h6l3 3v9H4z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  <path d="M6 7h4M6 9.5h4M6 12h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                Brief
              </button>
            )}
          </div>
        )}
        {briefOpen && briefPath && <BriefPanel key={`${briefPath}:${briefReloadKey}`} path={briefPath} onClose={() => setBriefOpen(false)} />}
        {transcriptSession && (
          <div className="wc-xscript" role="dialog" aria-label="Session transcript">
            <div className="wc-xscript-head">
              <span className="wc-xscript-title">
                Session
                <span className="wc-xscript-id" title={transcriptSession}>{transcriptSession}</span>
              </span>
              <button
                type="button"
                className="wc-xscript-close"
                onClick={() => setTranscriptSession(null)}
                aria-label="Close session transcript"
              >
                ×
              </button>
            </div>
            <div className="wc-xscript-body">
              <SessionStream url={`/api/session-stream?session=${encodeURIComponent(transcriptSession)}`} />
            </div>
          </div>
        )}
        {/* A compact elapsed-time anchor for a resumed turn. The chat below also
            replays and follows every buffered live frame; this notice is context,
            no longer the only sign of activity. */}
        {activeThread?.runningSince ? <ResumedWorkingNotice since={activeThread.runningSince} /> : null}
        {activeRshTransport && rshError && <div className="wc-rsh-error">Remote shell: {rshError}</div>}
        {(() => {
          const rshTransport = activeRshTransport
            ? rshTransports.find((t) => t.name === activeRshTransport) ?? null
            : null;
          const chat = loading || !activeId ? (
          <div className="wc-loading">Loading…</div>
        ) : (
          <ClaudeChat
            key={`${activeId}:${historyRev}`}
            draftKey={activeId ?? undefined}
            transport={transport}
            title="Session"
            /* The phone composer row also carries voice, mic and attach, leaving
               the field ~180px - the full hint truncates mid-word there. */
            placeholder={activeRshTransport ? "Send to the remote agent — it lands in the console" : narrowComposer ? "Message…" : undefined}
            composerAdornment={voiceAdornment}
            context={ctx}
            initialMessage={kickoff}
            initialHistory={history}
            onTurnComplete={() => { void onTurnSettled(); void checkBriefAfterTurn(); }}
            transcriptUrl={activeId ? `/api/session-stream?thread=${encodeURIComponent(activeId)}` : undefined}
            // The Turn Rail (contract §13). `voice` stays OFF - the streaming mic in
            // the composer adornment supersedes the component's batch voice - so
            // `routing` is what brings the toolbar (and its Route chip) into the web
            // channel at all. `musterUrl` is deliberately NOT passed: Muster is a
            // Garrison route on ANOTHER origin, and a machine-local absolute URL is
            // exactly what a remote client cannot follow.
            features={{ routing: true }}
            routing={pins}
            routeOptions={routeOptions}
            onPinChange={savePins}
            onOpenTranscript={openTranscript}
          />
        );
          if (activeRshTransport && rshSessionId) {
            return (
              <RemoteShellWorkbench
                sessionId={rshSessionId}
                transport={rshTransport}
                title={activeThread?.title || rshTransport?.label || "Remote shell"}
                messageCount={activeThread?.messages?.length ?? 0}
                hasActivity={Boolean(activeThread?.runningSince) || (activeThread?.pendingInputs?.length ?? 0) > 0}
              >
                {chat}
              </RemoteShellWorkbench>
            );
          }
          return chat;
        })()}
      </main>
    </div>
  );
}

// ── Mount ───────────────────────────────────────────────────────────────────
// The threaded surface is the DEFAULT (the bare URL the Garrison sidebar embeds
// gets the sessions sidebar + persisted history); the raw PTY console needs an
// explicit ?console=1. Host-opened Discuss links (thread/context/mode/kickoff)
// mount the threaded surface as before.
const url = readUrl();
const threaded = !url.console;


/**
 * Notification enrolment. Deliberately a floating pill rather than a settings
 * page: the permission request MUST come from a user gesture, so it needs a
 * tappable thing, and on iOS it must be tapped inside the installed PWA.
 *
 * States are distinct on purpose - "needs-install" is the iOS case where the
 * browser has no Push API at all until the app is on the Home Screen, and
 * showing "unsupported" there would be wrong and unactionable.
 */
export function PushNotice({
  text,
  kind = "notice",
  onDismiss,
}: {
  text: string;
  kind?: "notice" | "toast";
  onDismiss: () => void;
}) {
  return (
    <div className={kind === "toast" ? "wc-push-toast" : "wc-push-notice"} role="status">
      <span>{text}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={kind === "toast" ? "Dismiss notification" : "Dismiss notification notice"}
      >
        ×
      </button>
    </div>
  );
}

// Dismissing a push notice is a decision, and a decision must survive the tab.
// The dismissal was plain component state, so an installed PWA with
// notifications deliberately blocked re-showed "Notifications blocked" on
// EVERY launch - a permanent nag with an X that never stuck. Persist per
// notice kind, so a future genuine state change (e.g. needs-install after a
// reinstall) still gets its one showing.
const PUSH_NOTICE_DISMISSED_PREFIX = "garrison.web.pushNoticeDismissed.";
function pushNoticeDismissed(kind: string): boolean {
  try { return localStorage.getItem(PUSH_NOTICE_DISMISSED_PREFIX + kind) === "1"; } catch { return false; }
}
function rememberPushNoticeDismissed(kind: string) {
  try { localStorage.setItem(PUSH_NOTICE_DISMISSED_PREFIX + kind, "1"); } catch { /* private mode - session-only dismissal */ }
}

/**
 * Keep the fixed bottom-left pills clear of the composer.
 *
 * They were pinned to the viewport bottom, which is exactly where the composer
 * lives. On a phone the composer is full width, so "Notifications blocked …"
 * covered the message box AND its Send button outright - the primary control of
 * the app, unusable until the pill was dismissed. The composer's height is not a
 * constant (rail rows, attachment chips, a grown textarea), so measure it and
 * publish it as the offset every pill sits above.
 */
function useComposerInset(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    let observed: Element | null = null;
    let size: ResizeObserver | null = null;
    let frame = 0;
    let published = -1;

    const publish = () => {
      frame = 0;
      const composer = document.querySelector(".cc-composer");
      // The chat REMOUNTS (hydration, thread switch, settle). A ResizeObserver
      // bound to the old node then reports a detached element frozen at height
      // 0 and never fires again, which is how the pill ended up back on top of
      // the composer. Re-resolve the node, don't just watch the first one.
      if (composer !== observed) {
        size?.disconnect();
        observed = composer;
        size = composer ? new ResizeObserver(schedule) : null;
        if (composer && size) size.observe(composer);
      }
      const height = composer ? Math.round(composer.getBoundingClientRect().height) : 0;
      if (height === published) return;
      published = height;
      root.style.setProperty("--wc-composer-inset", `${height}px`);
    };
    // Streaming rewrites the transcript constantly; coalesce to one measure per
    // frame so the DOM watcher below stays free.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(publish); };

    publish();
    const tree = new MutationObserver(schedule);
    tree.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      tree.disconnect();
      size?.disconnect();
      window.removeEventListener("resize", schedule);
      root.style.removeProperty("--wc-composer-inset");
    };
  }, [active]);
}

function PushEnroller() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState(false);

  useEffect(() => {
    void registerServiceWorker().then(() => pushState().then(setState));
    // Render pushes that arrive while the app is focused: the OS usually
    // suppresses the system banner in that case, so without this an incoming
    // notification is invisible exactly when you are looking at the app.
    return onNotification((payload) => {
      setToast(`${payload.title ?? "Garrison"}: ${payload.body ?? ""}`.trim());
      window.setTimeout(() => setToast(null), 8000);
    });
  }, []);

  const onEnable = async () => {
    setBusy(true);
    const res = await enablePush();
    setBusy(false);
    setToast(res.ok ? "Notifications enabled on this device." : res.reason ?? "Could not enable notifications.");
    window.setTimeout(() => setToast(null), 8000);
    setState(await pushState());
  };

  const pill = (text: string, onClick?: () => void) => (
    <button type="button" className="wc-push-pill" onClick={onClick} disabled={busy || !onClick}>
      {busy ? "Enabling…" : text}
    </button>
  );

  const showsPill = Boolean(
    (state === "prompt") ||
    toast ||
    (!noticeDismissed && state === "needs-install" && !pushNoticeDismissed("needs-install")) ||
    (!noticeDismissed && state === "denied" && !pushNoticeDismissed("denied"))
  );
  useComposerInset(showsPill);

  return (
    <>
      {state === "prompt" && pill("Enable notifications", onEnable)}
      {!noticeDismissed && state === "needs-install" && !pushNoticeDismissed("needs-install") && (
        <PushNotice
          text="Add to Home Screen to enable notifications"
          onDismiss={() => { rememberPushNoticeDismissed("needs-install"); setNoticeDismissed(true); }}
        />
      )}
      {!noticeDismissed && state === "denied" && !pushNoticeDismissed("denied") && (
        <PushNotice
          text="Notifications blocked — enable them in browser settings"
          onDismiss={() => { rememberPushNoticeDismissed("denied"); setNoticeDismissed(true); }}
        />
      )}
      {toast && (
        <PushNotice kind="toast" text={toast} onDismiss={() => setToast(null)} />
      )}
    </>
  );
}

function App() {
  // Presence heartbeat (GARRISON-UNIFY-V1 S14, D34): POST /power-heartbeat
  // (same-origin relay to the Power fitting) every 60s, ONLY while visible AND
  // interacted-with in the last 5 minutes. Unconditional first hook so the
  // conditional ThreadedApp/ClaudeChat return below cannot skip it.
  useEffect(() => {
    let lastInput = Date.now();
    const markInput = () => { lastInput = Date.now(); };
    window.addEventListener("pointerdown", markInput, { passive: true });
    window.addEventListener("keydown", markInput, { passive: true });
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastInput > 5 * 60_000) return;
      void fetch("/power-heartbeat", { method: "POST" }).catch(() => {});
    };
    const t = window.setInterval(beat, 60_000);
    beat();
    return () => {
      window.clearInterval(t);
      window.removeEventListener("pointerdown", markInput);
      window.removeEventListener("keydown", markInput);
    };
  }, []);

  // Selecting text copies it. Reading a reply and wanting a snippet of it is the
  // single most common thing done in this surface, and on a phone the native
  // copy affordance is a long-press away.
  //
  // Bound to the END of a selection gesture (pointerup / touch end / keyboard
  // release), never to `selectionchange`: that fires on every character as a
  // drag grows and would write the clipboard dozens of times per selection.
  // Staying inside the gesture also keeps the write inside the user-activation
  // window that the async clipboard API requires.
  useEffect(() => {
    // The composer and any other field own their own selection - copying there
    // would fight the user's edit, and the value is already theirs.
    const inEditable = (node: Node | null): boolean => {
      const el = node instanceof Element ? node : node?.parentElement ?? null;
      return Boolean(el?.closest("input, textarea, [contenteditable='true']"));
    };

    let lastCopied = "";
    const copySelection = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString().trim();
      // A stray click clears to "" and a click-through re-fires with the same
      // range; neither should touch the clipboard.
      if (!text || text === lastCopied) return;
      if (inEditable(sel.anchorNode) || inEditable(sel.focusNode)) return;
      lastCopied = text;
      // navigator.clipboard needs a SECURE context. The channel is reachable over
      // plain http at a tailnet/LAN address, where it is simply absent, so fall
      // back to the legacy path rather than throwing and copying nothing.
      const legacy = () => {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.setAttribute("readonly", "");
          ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          // Restore the user's visible selection, which ta.select() stole.
          sel.removeAllRanges();
        } catch {
          /* clipboard unavailable - selection still works normally */
        }
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(legacy);
      } else {
        legacy();
      }
    };

    // Defer one frame: on pointerup the selection is not always committed yet.
    const onEnd = () => window.setTimeout(copySelection, 0);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("keyup", onEnd);
    return () => {
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("keyup", onEnd);
    };
  }, []);

  if (threaded) return (<><ThreadedApp url={url} /><PushEnroller /></>);
  // Explicit ?console=1: the rich session console (live PTY surface).
  return (
    <>
      <ClaudeChat
        transport={createHttpTransport("/api", { uploads: true })}
        title="Shared session console"
        composerAdornment={voiceAdornment}
      />
      <PushEnroller />
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
