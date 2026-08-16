// The web channel's orchestrator transport: a fetch-streamed ChatTransport over
// the gateway path (/api/chat -> gateway /chat/stream). Split out of main.tsx so
// it is unit-testable without mounting the React app (main.tsx has top-level
// createRoot side effects). Behavior is unchanged from the inline version plus:
//   - the `tool` SSE event (AskUserQuestion) is surfaced as a ChatEvent so the
//     chat renders tappable option buttons;
//   - answerQuestion posts the tap back to /api/chat/answer, where the gateway
//     drives the live TUI picker;
//   - the run-context wiring of the 2026-07-25 contract: the pinned `routing`
//     intent + a monotonic `turnSeq` ride the request body, the widened `route`
//     frame (emitted TWICE - pre-turn `pending` then folded into `done`) and the
//     `activity` frame are surfaced as ChatEvents, and `interrupt()` is a real
//     POST /api/chat/interrupt instead of the no-op that made Stop a lie.

import { isSessionEvent, type FailureInfo, type FailureKind } from "@garrison/claude-chat/journal";
import { ChatTransportError } from "@garrison/claude-chat/transport";
import type {
  ChatEvent,
  ChatInputReceipt,
  ChatInterruptRequest,
  ChatInterruptResult,
  ChatTransport,
  ChatSendMeta,
  PermissionAnswer,
  QuestionAnswer,
  RouteAttribution,
} from "@garrison/claude-chat";

const INPUT_STATES = new Set(["queued", "starting", "running", "stopping", "settled", "stopped", "failed"]);
const ADMISSION_MAX_ATTEMPTS = 4;
const ADMISSION_RETRY_BASE_MS = 100;
const RESUME_MAX_RETRIES = 4;
const RESUME_RETRY_BASE_MS = 250;
const FAILURE_SOURCES = new Set(["assistant", "result", "runtime", "session", "transport", "system", "gateway", "web"]);
const FAILURE_KINDS = new Set<FailureKind>([
  "authentication", "authorization", "billing", "rate_limit", "overloaded",
  "invalid_request", "not_found", "limit", "execution", "runtime", "transport",
  "routing", "protocol", "permission", "unknown",
]);

function cleanFailureInfo(value: unknown): FailureInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const source = typeof raw.source === "string" && FAILURE_SOURCES.has(raw.source) ? raw.source : null;
  const kind = typeof raw.kind === "string" && FAILURE_KINDS.has(raw.kind as FailureKind)
    ? raw.kind as FailureKind
    : null;
  const code = typeof raw.code === "string" && raw.code.trim() ? raw.code.trim().slice(0, 200) : "";
  const text = typeof raw.text === "string" && raw.text.trim() ? raw.text.trim().slice(0, 1_000) : "";
  if (!source || !kind || !code || !text || typeof raw.retryable !== "boolean") return null;
  const out: FailureInfo = { source: source as FailureInfo["source"], kind, code, text, retryable: raw.retryable };
  if (typeof raw.requestId === "string" && raw.requestId.trim()) out.requestId = raw.requestId.trim().slice(0, 512);
  if (typeof raw.httpStatus === "number" && Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599) {
    out.httpStatus = raw.httpStatus;
  }
  if (typeof raw.retryAt === "number" && Number.isFinite(raw.retryAt) && raw.retryAt > 0) out.retryAt = raw.retryAt;
  return out;
}

function failureFromPayload(data: Record<string, unknown>, fallback: FailureInfo): FailureInfo {
  return cleanFailureInfo(data.failure) ?? cleanFailureInfo(data) ?? fallback;
}

function retryDelay(baseMs: number, retry: number, ceilingMs = 2_000): number {
  return Math.min(baseMs * (2 ** Math.max(0, retry - 1)), ceilingMs);
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cleanChatInputReceipt(value: unknown): ChatInputReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const clientRequestId = typeof input.clientRequestId === "string" ? input.clientRequestId.trim() : "";
  const inputId = typeof input.inputId === "string" ? input.inputId.trim() : "";
  const state = typeof input.state === "string" && INPUT_STATES.has(input.state)
    ? input.state as ChatInputReceipt["state"]
    : null;
  if (!clientRequestId || !inputId || !state) return null;
  const generationId = typeof input.generationId === "string" && input.generationId.trim()
    ? input.generationId.trim()
    : undefined;
  const position = typeof input.position === "number" && Number.isInteger(input.position) && input.position >= 0
    ? input.position
    : undefined;
  return {
    clientRequestId,
    inputId,
    state,
    ...(generationId ? { generationId } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(typeof input.acceptedAt === "string" ? { acceptedAt: input.acceptedAt.slice(0, 64) } : {}),
    ...(typeof input.reason === "string" ? { reason: input.reason.slice(0, 200) } : {}),
    ...(cleanFailureInfo(input.failure) ? { failure: cleanFailureInfo(input.failure)! } : {}),
  };
}

// ── Run-context frame normalisation (contract §1) ──────────────────────────
// The NEW attribution fields. Copied by PRESENCE, never with `?? null`: the badge
// model reads `account: null` as "ran on this box's own Claude login" and an ABSENT
// account as "this lane cannot report one", so defaulting a missing field to null
// would invent a fact. (The 11 pre-existing fields keep their `?? null` defaults -
// their consumers, and tests/web-channel-orchestrator-transport.test.ts, already
// depend on `effortApplied: null` meaning "unverified".)
const ROUTE_FIELDS = [
  "duty",
  "level",
  "phase",
  "flow",
  "phasesOff",
  "classifierSkipped",
  "skill",
  "via",
  "account",
  "accountSource",
  "project",
  "projectPath",
  "card",
  "cardUrl",
  "sessionId",
  "transcriptPath",
  "stoppedByUser",
  "stoppedReason",
  "overridesApplied",
  "overridesRejected",
  "pending",
  "sessionDisposition",
  "sessionBoundaryReason",
  "sessionEpoch",
  "spawnSignature",
] as const;

// Four fields were on the wire in snake_case long before this contract named them
// in camelCase, and the gateway still emits those spellings on `done`. Accept both;
// an explicit camelCase key wins (same rule as the server's attributionFromFrame).
const ROUTE_ALIASES: Record<string, (typeof ROUTE_FIELDS)[number]> = {
  session_id: "sessionId",
  transcript_path: "transcriptPath",
  stopped_by_user: "stoppedByUser",
  stopped_reason: "stoppedReason",
};

// ── Host-reachable card links ──────────────────────────────────────────────
// `cardUrl` arrives as the board's LOOPBACK url (127.0.0.1:<board port>) and the
// user is almost never on the Garrison box: rendered as-is the card badge is a dead
// link, and over the HTTPS tailnet a plain-http one at that. Rebind it for THIS
// client through the same-origin /host-map serve table (localPort -> https tailnet
// base) - the same table and the same algorithm as the chat's link renderer
// (packages/claude-chat/src/host-rewrite.ts). Duplicated rather than imported
// because that module is deliberately copied per bundle boundary (own-port fittings
// install independently and cannot import each other's source); only the URL rule
// is needed here, not the file-path helpers.
const LOOPBACK = /^(https?:\/\/)(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i;
let serveMap: Record<string, string> = {};
let hostMapPromise: Promise<void> | null = null;

function loadHostMap(): Promise<void> {
  if (!hostMapPromise) {
    hostMapPromise = fetch("/host-map")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.map && typeof d.map === "object") serveMap = d.map as Record<string, string>;
      })
      .catch(() => {});
  }
  return hostMapPromise;
}

/** A url the CURRENT client can actually open, or "" when none exists (page is
 *  HTTPS and the only rebind would be plain http - mixed content, blocked). The
 *  badge model treats "" as "no href", so the card badge stays a fact without
 *  pretending to be a link. */
function reachableUrl(raw: string): string {
  if (!raw || !LOOPBACK.test(raw)) return raw;
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const protocol = typeof window !== "undefined" ? window.location.protocol : "";
  // The client IS on the box (local dev): the loopback url is directly reachable.
  if (!hostname || hostname === "127.0.0.1" || hostname === "localhost") return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const base = serveMap[String(port)];
  if (base) {
    try {
      const b = new URL(base);
      u.protocol = b.protocol;
      u.host = b.host; // host carries the tailnet serve port
      return u.toString();
    } catch {
      /* malformed serve entry - fall through to the host rebind */
    }
  }
  const rebound = raw.replace(LOOPBACK, `$1${hostname}`);
  if (protocol === "https:" && rebound.startsWith("http://")) return "";
  return rebound;
}

/**
 * One `route` ChatEvent out of a gateway `route` / `done` payload, or null when the
 * payload carries no attribution at all (a plain reply must not produce an empty
 * badge row). `turnSeq` is stamped from OUR send counter, not from the echo: the
 * consumer drops a frame stamped older than the turn it would land on, so the
 * number has to be the one this client counted.
 */
function routeEventFrom(data: Record<string, unknown>, turnSeq: number): (ChatEvent & { type: "route" }) | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(data, key);
  const legacy: RouteAttribution = {
    route: (data.route as string) ?? null,
    runtime: (data.runtime as string) ?? null,
    provider: (data.provider as string) ?? null,
    model: (data.model as string) ?? null,
    effort: (data.effort as string) ?? null,
    effortApplied: typeof data.effortApplied === "boolean" ? data.effortApplied : null,
    taskType: (data.taskType as string) ?? null,
    tier: (data.tier as string) ?? null,
    ruleId: (data.ruleId as string) ?? null,
    profile: (data.profile as string) ?? null,
    honored: typeof data.honored === "boolean" ? data.honored : null,
  };
  const extra: Record<string, unknown> = {};
  for (const [wire, field] of Object.entries(ROUTE_ALIASES)) {
    if (has(wire) && !has(field)) extra[field] = data[wire];
  }
  for (const field of ROUTE_FIELDS) {
    if (has(field)) extra[field] = data[field];
  }
  if (typeof extra.cardUrl === "string") extra.cardUrl = reachableUrl(extra.cardUrl);
  // Nothing resolved and nothing reported: stay silent rather than render a row of
  // omitted badges. A single explicitly-null NEW field still counts as reported -
  // "skill: none" and "machine login" are facts the rail is meant to show.
  const said = Object.values(legacy).some((v) => v !== null) || Object.keys(extra).length > 0;
  if (!said) return null;
  return { type: "route", ...legacy, ...(extra as RouteAttribution), turnSeq };
}

// `threadId` identifies the conversation this transport serves; it rides every
// POST /api/chat body so the SERVER can persist the exchange into the thread when
// the upstream `done` event arrives (survives navigation/tab-close mid-turn).
export interface OrchestratorTransportOptions {
  /** Reopen the server-owned live stream as soon as ClaudeChat connects. */
  resumeOnConnect?: boolean;
  /** Lets the thread host suppress history polling while replay/follow is active. */
  onResumeState?: (active: boolean) => void;
  /** Durable snapshot coordinates used to detect a settle/claim handoff that
   * happened between thread hydration and the resume-list request. */
  initialInputRevision?: number;
  initialInputIds?: readonly string[];
  /**
   * Fires when the durable parent snapshot should be refreshed. A painted live
   * terminal does not require child-history recovery; races, rejected admissions,
   * and malformed/unavailable resume state do.
   */
  onResumeSettled?: (result: { recovery: boolean }) => void;
}

export interface ResumableChatTransport extends ChatTransport {
  /** Replay buffered runtime events, then follow until that turn settles. */
  resume(): Promise<void>;
}

export function createOrchestratorTransport(
  base = "/api",
  threadId?: string,
  options: OrchestratorTransportOptions = {}
): ResumableChatTransport {
  const b = base.replace(/\/$/, "");
  let listener: ((ev: ChatEvent) => void) | null = null;
  let resumeStarted = false;
  let connectionEpoch = 0;
  let connected = false;
  let activeReported = false;
  let resumeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeRetryCount = 0;
  let refreshPending = false;
  let recoveryRequired = false;
  const followers = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const pendingRequests = new Set<AbortController>();
  const isCurrentConnection = (epoch: number) => connected && epoch === connectionEpoch;
  const flushResumeSettlement = (epoch: number) => {
    if (
      !refreshPending ||
      !isCurrentConnection(epoch) ||
      followers.size > 0 ||
      pendingRequests.size > 0
    ) return;
    const recovery = recoveryRequired;
    refreshPending = false;
    recoveryRequired = false;
    options.onResumeSettled?.({ recovery });
  };
  const requestResumeSettlement = (epoch: number, recovery: boolean) => {
    refreshPending = true;
    recoveryRequired ||= recovery;
    flushResumeSettlement(epoch);
  };
  const reportActivity = () => {
    const active = connected && (pendingRequests.size > 0 || followers.size > 0);
    if (active === activeReported) return;
    activeReported = active;
    options.onResumeState?.(active);
  };
  const clearResumeRetry = () => {
    if (resumeRetryTimer !== null) clearTimeout(resumeRetryTimer);
    resumeRetryTimer = null;
  };
  const scheduleResumeRetry = (epoch: number) => {
    if (!isCurrentConnection(epoch) || resumeRetryTimer !== null || resumeRetryCount >= RESUME_MAX_RETRIES) return;
    resumeRetryCount += 1;
    resumeRetryTimer = setTimeout(() => {
      resumeRetryTimer = null;
      if (!isCurrentConnection(epoch)) return;
      resumeStarted = false;
      void resume();
    }, retryDelay(RESUME_RETRY_BASE_MS, resumeRetryCount));
  };
  // Monotonic per-send turn number (contract §5). ClaudeChat keeps its OWN 1-based
  // counter (Turn.seq) in the same order and DROPS a frame stamped older than the
  // turn it would land on, so the two are a convention: bump this exactly once per
  // send or a late frame silently attributes the wrong bubble.
  let turnSeq = 0;

  interface StreamState {
    epoch: number;
    seq: number;
    generated: boolean;
    clientRequestId?: string;
    inputId?: string;
    generationId?: string;
    acc: string;
    sawReply: boolean;
    settled: boolean;
    paintedTerminal: boolean;
    paintedTerminalStatus?: "completed" | "error" | "cancelled";
    terminalConflict: boolean;
    seenIds: Set<string>;
  }

  const newStreamState = (seq: number, input?: Partial<ChatInputReceipt>, epoch = connectionEpoch): StreamState => ({
    epoch,
    seq,
    generated: Boolean(input?.inputId || input?.clientRequestId),
    clientRequestId: input?.clientRequestId,
    inputId: input?.inputId,
    generationId: input?.generationId,
    acc: "",
    sawReply: false,
    settled: false,
    paintedTerminal: false,
    terminalConflict: false,
    seenIds: new Set(),
  });

  const frameCoordinate = (state: StreamState, data: Record<string, unknown>) => {
    if (typeof data.inputId === "string" && data.inputId.trim()) state.inputId = data.inputId;
    if (typeof data.generationId === "string" && data.generationId.trim()) state.generationId = data.generationId;
    return {
      ...(state.inputId ? { inputId: state.inputId } : {}),
      ...(state.generationId ? { generationId: state.generationId } : {}),
    };
  };

  const handleEvent = (state: StreamState, name: string, dataRaw: string) => {
    if (!isCurrentConnection(state.epoch)) return;
    let data: any = {};
    try { data = dataRaw ? JSON.parse(dataRaw) : {}; } catch { /* ignore */ }
    const coordinate = frameCoordinate(state, data);
    if (name === "input") {
      const input = cleanChatInputReceipt(data);
      if (!input) return;
      state.clientRequestId = input.clientRequestId;
      state.inputId = input.inputId;
      if (input.generationId) state.generationId = input.generationId;
      if (input.state === "settled" || input.state === "stopped" || input.state === "failed") {
        const receiptStatus = input.state === "settled" ? "completed" : input.state === "stopped" ? "cancelled" : "error";
        if (state.paintedTerminalStatus && state.paintedTerminalStatus !== receiptStatus) state.terminalConflict = true;
        state.settled = true;
      }
      listener?.({ ...input, type: "input" });
      return;
    }
    // A named terminal frame latches the visible outcome. Keep accepting the
    // authoritative input receipt above, but ignore any late socket/proxy frames
    // that would otherwise repaint a completed generation as failed.
    if (state.settled) return;
    if (name === "open") return;
    if (name === "chunk" && typeof data.text === "string") {
      // PTY lanes re-emit the whole visible answer after a reflow. Preserve the
      // wire's replace flag during replay and run the exact same accumulator here.
      if (data.replace) state.acc = data.text;
      else state.acc += data.text;
      state.sawReply = true;
      listener?.({ type: "assistant", text: state.acc, ...coordinate });
    } else if (name === "tool") {
      listener?.({ type: "tool", ...data, ...coordinate } as ChatEvent);
    } else if (name === "session_event") {
      // The payload is already the channel-neutral canonical event. A live send
      // forwards the parsed object itself without spreading or selecting fields;
      // replay changes only its turn coordinate so the restored synthetic turn
      // owns it just as it owns replayed route frames.
      if (!isSessionEvent(data)) return;
      const terminalBlock = data.blocks.find((block) => block.type === "turn_end");
      if (terminalBlock?.type === "turn_end") {
        state.paintedTerminal = true;
        if (terminalBlock.status === "completed" || terminalBlock.status === "error" || terminalBlock.status === "cancelled") {
          state.paintedTerminalStatus = terminalBlock.status;
        }
      }
      listener?.({ type: "session_event", event: data, ...coordinate } as unknown as ChatEvent);
    } else if (name === "route") {
      // A resumed turn targets the persisted trailing user exchange (seq 0), not
      // whatever turnSeq another browser originally placed on the wire. Restamping
      // here prevents route frames being dropped or attached to later history.
      const ev = routeEventFrom(data, state.seq);
      if (ev) listener?.({ ...ev, ...coordinate });
    } else if (name === "activity") {
      if (data.kind === "thinking") {
        const text = typeof data.text === "string" ? data.text.trim() : "";
        listener?.({ type: "activity", kind: "thinking", name: text || "thinking…", ...coordinate });
      } else if (typeof data.name === "string" && data.name) {
        listener?.({
          type: "activity",
          kind: "tool",
          name: data.name,
          ...(typeof data.id === "string" && data.id ? { id: data.id } : {}),
          ...coordinate,
        });
      }
    } else if (name === "done") {
      if (typeof data.reply === "string" && data.reply.trim()) {
        state.acc = data.reply;
        state.sawReply = true;
        listener?.({ type: "assistant", text: state.acc, ...coordinate });
      }
      if (!state.sawReply && !state.paintedTerminal) {
        listener?.({ type: "assistant", text: "_The operative returned an empty reply. Try sending again._", ...coordinate });
      }
      const routeEv = routeEventFrom(data, state.seq);
      if (routeEv) listener?.({ ...routeEv, ...coordinate });
      state.settled = true;
      if (!state.generated) listener?.({ type: "turn", active: false });
    } else if (name === "error") {
      if (state.paintedTerminalStatus && state.paintedTerminalStatus !== "error") state.terminalConflict = true;
      state.settled = true;
      const failure = failureFromPayload(data, {
        source: "transport",
        kind: "transport",
        code: "stream_error",
        text: typeof data.error === "string" ? data.error.slice(0, 1_000) : "The response stream failed.",
        retryable: false,
      });
      listener?.({ type: "error", failure, message: failure.text, ...coordinate });
      if (!state.generated) listener?.({ type: "turn", active: false });
    }
  };

  // Runtime-neutral SSE reader: both the original POST and the replay/follow GET
  // feed their named events through handleEvent, so ordering and reducers cannot
  // drift. Accepts CRLF, split network chunks and multi-line data fields.
  const readEventStream = async (res: Response, state: StreamState) => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const drain = () => {
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buf))) {
        const block = buf.slice(0, boundary.index);
        buf = buf.slice(boundary.index + boundary[0].length);
        let name = "message";
        const data: string[] = [];
        let frameId = "";
        for (const line of block.split(/\r?\n/)) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") name = value.trim();
          else if (field === "data") data.push(value);
          else if (field === "id") frameId = value.trim();
        }
        if (frameId && state.seenIds.has(frameId)) continue;
        if (frameId) state.seenIds.add(frameId);
        if (name !== "message" || data.length > 0) handleEvent(state, name, data.join("\n"));
      }
    };
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      drain();
    }
    buf += decoder.decode();
    drain();
  };

  // A clean byte-stream EOF is not a successful turn unless a named `done` or
  // `error` frame settled it first. Surface the break as assistant-visible text
  // before clearing busy; Web's completion callback can then release its polling
  // guard and hydrate the server's durable failure note instead of waiting for the
  // 20-minute lost-turn expiry. The server normally emits this error itself; this
  // is the client-side fallback for a proxy/network truncation.
  const settleUnexpectedEof = (state: StreamState) => {
    if (state.settled) return;
    if (!state.generated) {
      state.settled = true;
      const failure: FailureInfo = {
        source: "transport",
        kind: "protocol",
        code: "stream_ended_without_terminal",
        text: "The response stream ended without a completion event.",
        retryable: true,
      };
      listener?.({ type: "error", failure, message: failure.text });
      listener?.({ type: "turn", active: false });
      return;
    }
    listener?.({
      type: "connection",
      state: "reconnecting",
      ...(state.inputId ? { inputId: state.inputId } : {}),
      ...(state.generationId ? { generationId: state.generationId } : {}),
    });
  };

  const followInput = (input: ChatInputReceipt, epoch = connectionEpoch): Promise<void> => {
    if (!threadId || !isCurrentConnection(epoch)) return Promise.resolve();
    const existing = followers.get(input.inputId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const state = newStreamState(turnSeq, input, epoch);
    const promise = (async () => {
      let shouldRefresh = false;
      let recovery = true;
      try {
        await loadHostMap();
        while (!controller.signal.aborted && isCurrentConnection(epoch) && !state.settled) {
          try {
            const res = await fetch(
              `${b}/threads/${encodeURIComponent(threadId)}/inputs/${encodeURIComponent(input.inputId)}/live`,
              {
                method: "GET",
                headers: { accept: "text/event-stream" },
                cache: "no-store",
                signal: controller.signal,
              }
            );
            if (res.status === 404 || res.status === 409) {
              shouldRefresh = true;
              break;
            }
            if (!res.ok || !res.body) throw new Error(`input live ${res.status}`);
            await readEventStream(res, state);
            if (!state.settled) settleUnexpectedEof(state);
          } catch (err: any) {
            if (err?.name === "AbortError" || controller.signal.aborted || !isCurrentConnection(epoch)) break;
            settleUnexpectedEof(state);
          }
          if (!state.settled && !controller.signal.aborted && isCurrentConnection(epoch)) {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
        if (state.settled) {
          shouldRefresh = true;
          recovery = !state.paintedTerminal || state.terminalConflict;
        }
      } finally {
        const current = followers.get(input.inputId);
        if (current?.controller === controller) followers.delete(input.inputId);
        reportActivity();
        if (!controller.signal.aborted && isCurrentConnection(epoch) && shouldRefresh) {
          requestResumeSettlement(epoch, recovery);
        }
      }
    })();
    followers.set(input.inputId, { controller, promise });
    reportActivity();
    return promise;
  };

  const resume = async () => {
    if (resumeStarted || !threadId || !connected) return;
    clearResumeRetry();
    resumeStarted = true;
    const epoch = connectionEpoch;
    const controller = new AbortController();
    pendingRequests.add(controller);
    reportActivity();
    let retryable = false;
    let shouldRefresh = false;
    try {
      const res = await fetch(`${b}/threads/${encodeURIComponent(threadId)}/inputs`, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!isCurrentConnection(epoch)) return;
      if (!res.ok) {
        retryable = true;
        shouldRefresh = true;
        return;
      }
      const body = await res.json().catch(() => null);
      const hasInputArray = Array.isArray(body?.inputs);
      const inputs: ChatInputReceipt[] = hasInputArray
        ? body.inputs.map(cleanChatInputReceipt).filter((input: ChatInputReceipt | null): input is ChatInputReceipt => input !== null)
        : [];
      if (!hasInputArray || inputs.length !== body.inputs.length) {
        retryable = true;
        shouldRefresh = true;
      }
      if (hasInputArray) {
        const responseRevision = typeof body.inputRevision === "number" &&
          Number.isInteger(body.inputRevision) && body.inputRevision >= 0
          ? body.inputRevision
          : null;
        const initialRevision = typeof options.initialInputRevision === "number" &&
          Number.isInteger(options.initialInputRevision) && options.initialInputRevision >= 0
          ? options.initialInputRevision
          : null;
        const expectedIds = new Set(options.initialInputIds ?? []);
        const returnedIds = new Set(inputs.map((input: ChatInputReceipt) => input.inputId));
        const membershipChanged = expectedIds.size > 0 &&
          (expectedIds.size !== returnedIds.size || [...expectedIds].some((id) => !returnedIds.has(id)));
        if ((responseRevision !== null && initialRevision !== null && responseRevision !== initialRevision) || membershipChanged) {
          shouldRefresh = true;
          recoveryRequired = true;
        }
      }
      if (inputs.length === 0) {
        shouldRefresh = true;
        return;
      }
      for (const input of inputs) {
        if (!isCurrentConnection(epoch)) return;
        listener?.({ type: "input", ...input });
        void followInput(input, epoch);
      }
    } catch (err: any) {
      if (err?.name !== "AbortError" && isCurrentConnection(epoch)) {
        retryable = true;
        shouldRefresh = true;
      }
    } finally {
      pendingRequests.delete(controller);
      if (retryable) {
        resumeStarted = false;
        scheduleResumeRetry(epoch);
      } else if (isCurrentConnection(epoch)) {
        resumeRetryCount = 0;
      }
      reportActivity();
      if (shouldRefresh && isCurrentConnection(epoch)) requestResumeSettlement(epoch, true);
      else flushResumeSettlement(epoch);
    }
  };

  const send: ChatTransport["sendMessage"] = async (text, meta) => {
    const state = newStreamState(++turnSeq);
    const payload: Record<string, unknown> = { message: text };
    if (threadId) payload.thread = threadId;
    if (meta?.context !== undefined && meta.context !== null) payload.context = meta.context;
    if (meta?.autonomous === true) payload.autonomous = true;
    if (meta?.routing && typeof meta.routing === "object" && Object.keys(meta.routing).length > 0) {
      payload.routing = meta.routing;
    }
    payload.turnSeq = state.seq;
    if (threadId && typeof meta?.clientRequestId === "string" && meta.clientRequestId.trim()) {
      const clientRequestId = meta.clientRequestId.trim();
      const epoch = connectionEpoch;
      if (!isCurrentConnection(epoch)) throw new Error("chat transport is disconnected");
      const controller = new AbortController();
      pendingRequests.add(controller);
      reportActivity();
      delete payload.thread;
      delete payload.context;
      payload.clientRequestId = clientRequestId;
      const requestBody = JSON.stringify(payload);
      let admitted = false;
      try {
        await loadHostMap();
        if (!isCurrentConnection(epoch)) throw new Error("chat transport disconnected during admission");
        let receipt: ChatInputReceipt | null = null;
        for (let attempt = 1; attempt <= ADMISSION_MAX_ATTEMPTS; attempt += 1) {
          if (!isCurrentConnection(epoch) || controller.signal.aborted) {
            throw new Error("chat transport disconnected during admission");
          }
          let res: Response;
          try {
            res = await fetch(`${b}/threads/${encodeURIComponent(threadId)}/inputs`, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: requestBody,
              signal: controller.signal,
            });
          } catch (err: any) {
            if (err?.name === "AbortError") throw err;
            if (controller.signal.aborted || !isCurrentConnection(epoch)) {
              throw new Error("chat transport disconnected during admission");
            }
            if (attempt === ADMISSION_MAX_ATTEMPTS) {
              throw new ChatTransportError({
                source: "transport",
                kind: "transport",
                code: "input_admission_uncertain",
                text: `Input admission could not be confirmed after ${attempt} attempts.`,
                retryable: true,
              });
            }
            await waitForRetry(retryDelay(ADMISSION_RETRY_BASE_MS, attempt), controller.signal);
            continue;
          }
          const body = await res.json().catch(() => null);
          if (!res.ok) {
            const failure = failureFromPayload(body && typeof body === "object" ? body as Record<string, unknown> : {}, {
              source: "web",
              kind: res.status === 429 ? "limit" : "invalid_request",
              code: res.status === 429 ? "web_input_queue_full" : `input_admission_${res.status}`,
              text: typeof body?.error === "string" ? body.error.slice(0, 1_000) : `The input was rejected (${res.status}).`,
              retryable: res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500,
              httpStatus: res.status,
            });
            throw new ChatTransportError(failure);
          }
          const cleanInput = cleanChatInputReceipt(body?.input);
          if (cleanInput?.clientRequestId === clientRequestId) {
            receipt = cleanInput;
            break;
          }
          // A 2xx without the exact durable receipt is indistinguishable from a
          // response body lost in transit. Re-posting the SAME id is safe because
          // admission is idempotent and returns the original receipt as duplicate.
          if (attempt === ADMISSION_MAX_ATTEMPTS) {
            throw new ChatTransportError({
              source: "transport",
              kind: "protocol",
              code: "input_admission_receipt_invalid",
              text: `Input admission could not be confirmed after ${attempt} attempts.`,
              retryable: true,
            });
          }
          await waitForRetry(retryDelay(ADMISSION_RETRY_BASE_MS, attempt), controller.signal);
        }
        if (!receipt) throw new ChatTransportError({
          source: "transport",
          kind: "protocol",
          code: "input_admission_receipt_missing",
          text: "Input admission could not be confirmed.",
          retryable: true,
        });
        if (!isCurrentConnection(epoch)) throw new Error("chat transport disconnected during admission");
        admitted = true;
        listener?.({ ...receipt, type: "input" });
        void followInput(receipt, epoch);
        return receipt;
      } finally {
        pendingRequests.delete(controller);
        reportActivity();
        if (!admitted && isCurrentConnection(epoch)) requestResumeSettlement(epoch, true);
        else flushResumeSettlement(epoch);
      }
    }
    try {
      await loadHostMap();
      const res = await fetch(`${b}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        const failure = failureFromPayload(body && typeof body === "object" ? body as Record<string, unknown> : {}, {
          source: "web",
          kind: res.status >= 500 ? "transport" : "invalid_request",
          code: `chat_http_${res.status}`,
          text: typeof body?.error === "string" ? body.error.slice(0, 1_000) : `The chat request failed (${res.status}).`,
          retryable: res.status === 408 || res.status === 429 || res.status >= 500,
          httpStatus: res.status,
        });
        listener?.({ type: "error", failure, message: failure.text });
        listener?.({ type: "turn", active: false });
        return;
      }
      await readEventStream(res, state);
      settleUnexpectedEof(state);
    } catch (err: any) {
      const failure: FailureInfo = err instanceof ChatTransportError
        ? err.failure
        : {
            source: "transport" as const,
            kind: "transport",
            code: "chat_transport_failed",
            text: String(err?.message ?? "The chat stream failed.").slice(0, 1_000),
            retryable: true,
          };
      listener?.({ type: "error", failure, message: failure.text });
      listener?.({ type: "turn", active: false });
    }
  };

  return {
    base: b,
    ...(threadId ? { inputLifecycle: true as const } : {}),
    connect(onEvent) {
      const epoch = ++connectionEpoch;
      connected = true;
      clearResumeRetry();
      resumeRetryCount = 0;
      listener = onEvent;
      onEvent({ type: "connection", state: "open" });
      if (options.resumeOnConnect) void resume();
      return () => {
        if (!isCurrentConnection(epoch)) return;
        connected = false;
        connectionEpoch += 1;
        clearResumeRetry();
        resumeRetryCount = 0;
        for (const controller of pendingRequests) controller.abort();
        pendingRequests.clear();
        resumeStarted = false;
        for (const follower of followers.values()) follower.controller.abort();
        followers.clear();
        reportActivity();
        listener = null;
        onEvent({ type: "connection", state: "closed" });
      };
    },
    resume,
    sendMessage: send as ChatTransport["sendMessage"],
    async sendKey() { /* no key surface on the orchestrator channel */ },
    async setMode(mode) { return { mode, reached: false }; },
    async interrupt(request?: ChatInterruptRequest): Promise<void | ChatInterruptResult> {
      if (!threadId) {
        await fetch(`${b}/chat/interrupt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        return;
      }
      if (!request?.generationId) throw new Error("generationId is required to stop this response");
      const res = await fetch(`${b}/threads/${encodeURIComponent(threadId)}/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generationId: request.generationId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `interrupt ${res.status}`);
      return {
        generationId: request.generationId,
        state: "stopping",
        ...(typeof body?.inputId === "string" ? { inputId: body.inputId } : {}),
      };
    },
    async answerQuestion(answer: QuestionAnswer) {
      // POST the tap back to the gateway (via the web-channel /api/chat/answer
      // proxy); the gateway maps the label to an option index and drives the picker.
      const res = await fetch(`${b}/chat/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: threadId,
          tool_use_id: answer.toolUseId,
          ...(answer.label !== undefined ? { label: answer.label } : {}),
          ...(answer.text !== undefined ? { text: answer.text } : {}),
          ...(answer.dismiss ? { dismiss: true } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : `question answer ${res.status}`);
      }
    },
    async answerPermission(answer: PermissionAnswer) {
      if (!threadId) throw new Error("a thread is required to answer a permission request");
      const res = await fetch(
        `${b}/threads/${encodeURIComponent(threadId)}/permissions/${encodeURIComponent(answer.requestId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ generationId: answer.generationId, decision: answer.decision }),
        }
      );
      if (!res.ok) throw new Error(`permission ${res.status}`);
    },
    async fetchCommands() { return []; },
    async uploadFile(file) {
      // POSTs to /api/attachments, which the web-channel server proxies to the
      // gateway's POST /attachments (saves the bytes to disk, returns the path
      // Claude reads back via the Read tool — no inline base64 image blocks).
      const res = await fetch(`${b}/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, content_base64: file.base64 }),
      });
      if (!res.ok) throw new Error(`attachments ${res.status}`);
      const j = await res.json().catch(() => ({}));
      return { path: String(j.path ?? ""), bytes: typeof j.bytes === "number" ? j.bytes : undefined };
    },
  };
}
