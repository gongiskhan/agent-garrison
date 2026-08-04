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

import type { ChatEvent, ChatTransport, ChatSendMeta, QuestionAnswer, RouteAttribution } from "@garrison/claude-chat";

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
  /** Fires after the live endpoint closes cleanly (the settled reply is on disk). */
  onResumeSettled?: () => void;
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
  let resumeController: AbortController | null = null;
  // Monotonic per-send turn number (contract §5). ClaudeChat keeps its OWN 1-based
  // counter (Turn.seq) in the same order and DROPS a frame stamped older than the
  // turn it would land on, so the two are a convention: bump this exactly once per
  // send or a late frame silently attributes the wrong bubble.
  let turnSeq = 0;

  interface StreamState {
    seq: number;
    acc: string;
    sawReply: boolean;
    settled: boolean;
  }

  const newStreamState = (seq: number): StreamState => ({ seq, acc: "", sawReply: false, settled: false });

  const handleEvent = (state: StreamState, name: string, dataRaw: string) => {
    let data: any = {};
    try { data = dataRaw ? JSON.parse(dataRaw) : {}; } catch { /* ignore */ }
    if (name === "chunk" && typeof data.text === "string") {
      // PTY lanes re-emit the whole visible answer after a reflow. Preserve the
      // wire's replace flag during replay and run the exact same accumulator here.
      if (data.replace) state.acc = data.text;
      else state.acc += data.text;
      state.sawReply = true;
      listener?.({ type: "assistant", text: state.acc });
    } else if (name === "tool") {
      listener?.({ type: "tool", ...data } as ChatEvent);
    } else if (name === "route") {
      // A resumed turn targets the persisted trailing user exchange (seq 0), not
      // whatever turnSeq another browser originally placed on the wire. Restamping
      // here prevents route frames being dropped or attached to later history.
      const ev = routeEventFrom(data, state.seq);
      if (ev) listener?.(ev);
    } else if (name === "activity") {
      if (data.kind === "thinking") {
        const text = typeof data.text === "string" ? data.text.trim() : "";
        listener?.({ type: "activity", kind: "thinking", name: text || "thinking…" });
      } else if (typeof data.name === "string" && data.name) {
        listener?.({
          type: "activity",
          kind: "tool",
          name: data.name,
          ...(typeof data.id === "string" && data.id ? { id: data.id } : {}),
        });
      }
    } else if (name === "done") {
      if (typeof data.reply === "string" && data.reply.trim()) {
        state.acc = data.reply;
        state.sawReply = true;
        listener?.({ type: "assistant", text: state.acc });
      }
      if (!state.sawReply) {
        listener?.({ type: "assistant", text: "_The operative returned an empty reply. Try sending again._" });
      }
      const routeEv = routeEventFrom(data, state.seq);
      if (routeEv) listener?.(routeEv);
      state.settled = true;
      listener?.({ type: "turn", active: false });
    } else if (name === "error") {
      state.settled = true;
      listener?.({ type: "error", message: String(data.error ?? "stream error") });
      listener?.({ type: "turn", active: false });
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
        for (const line of block.split(/\r?\n/)) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") name = value.trim();
          else if (field === "data") data.push(value);
        }
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

  const resume = async () => {
    if (resumeStarted || !threadId) return;
    resumeStarted = true;
    const controller = new AbortController();
    resumeController = controller;
    const state = newStreamState(turnSeq); // restored history uses seq 0
    listener?.({ type: "turn", active: true });
    options.onResumeState?.(true);
    let shouldRefresh = false;
    try {
      await loadHostMap();
      const res = await fetch(`${b}/threads/${encodeURIComponent(threadId)}/live`, {
        method: "GET",
        headers: { accept: "text/event-stream" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (res.ok && res.body) {
        await readEventStream(res, state);
        shouldRefresh = true;
      } else if (res.status === 404) {
        // The turn settled between the thread read and this GET. Refresh history;
        // do not render a fake error bubble for a benign race.
        shouldRefresh = true;
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") shouldRefresh = true;
    } finally {
      if (resumeController === controller) resumeController = null;
      if (!controller.signal.aborted) {
        if (!state.settled) listener?.({ type: "turn", active: false });
        options.onResumeState?.(false);
        if (shouldRefresh) options.onResumeSettled?.();
      }
    }
  };

  const send: (text: string, meta?: ChatSendMeta) => Promise<void> = async (text, meta) => {
    const state = newStreamState(++turnSeq);
    const payload: Record<string, unknown> = { message: text };
    if (threadId) payload.thread = threadId;
    if (meta?.context !== undefined && meta.context !== null) payload.context = meta.context;
    if (typeof meta?.mode === "string" && meta.mode.trim()) {
      payload.mode = meta.mode.trim();
      // Discuss/design chat is lightweight and deliberately avoids extended thinking.
      payload.classification = { taskType: "other", tier: "T0-trivial" };
    }
    if (meta?.autonomous === true) payload.autonomous = true;
    if (meta?.routing && typeof meta.routing === "object" && Object.keys(meta.routing).length > 0) {
      payload.routing = meta.routing;
    }
    payload.turnSeq = state.seq;
    await loadHostMap();
    try {
      const res = await fetch(`${b}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(payload),
      });
      if (!res.ok || !res.body) {
        listener?.({ type: "error", message: `chat ${res.status}` });
        listener?.({ type: "turn", active: false });
        return;
      }
      await readEventStream(res, state);
      if (!state.settled) listener?.({ type: "turn", active: false });
    } catch (err: any) {
      listener?.({ type: "error", message: String(err?.message ?? "chat stream failed") });
      listener?.({ type: "turn", active: false });
    }
  };

  return {
    base: b,
    connect(onEvent) {
      listener = onEvent;
      onEvent({ type: "connection", state: "open" });
      if (options.resumeOnConnect) void resume();
      return () => {
        options.onResumeState?.(false);
        if (resumeController) resumeStarted = false;
        resumeController?.abort();
        resumeController = null;
        listener = null;
        onEvent({ type: "connection", state: "closed" });
      };
    },
    resume,
    sendMessage: send as ChatTransport["sendMessage"],
    async sendKey() { /* no key surface on the orchestrator channel */ },
    async setMode(mode) { return { mode, reached: false }; },
    async interrupt() {
      // Real cancel (contract §9). The gateway keys its in-flight turns by the
      // session id it was handed, which for a channel turn is the THREAD id; the
      // web-channel proxy does that mapping, so the client sends what it actually
      // knows. A 404 ("no-active-turn") is SUCCESS as far as the UI is concerned -
      // the turn settled between the tap and the request - so nothing here throws.
      await fetch(`${b}/chat/interrupt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(threadId ? { thread: threadId } : {}),
      }).catch(() => {});
    },
    async answerQuestion(answer: QuestionAnswer) {
      // POST the tap back to the gateway (via the web-channel /api/chat/answer
      // proxy); the gateway maps the label to an option index and drives the picker.
      await fetch(`${b}/chat/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_id: threadId,
          tool_use_id: answer.toolUseId,
          ...(answer.label !== undefined ? { label: answer.label } : {}),
          ...(answer.text !== undefined ? { text: answer.text } : {}),
          ...(answer.dismiss ? { dismiss: true } : {}),
        }),
      }).catch(() => {});
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
