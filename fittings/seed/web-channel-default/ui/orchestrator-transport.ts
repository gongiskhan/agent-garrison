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
export function createOrchestratorTransport(base = "/api", threadId?: string): ChatTransport {
  const b = base.replace(/\/$/, "");
  let listener: ((ev: ChatEvent) => void) | null = null;
  let acc = "";
  // Monotonic per-send turn number (contract §5). ClaudeChat keeps its OWN 1-based
  // counter (Turn.seq) in the same order and DROPS a frame stamped older than the
  // turn it would land on, so the two are a convention: bump this exactly once per
  // send or a late frame silently attributes the wrong bubble.
  let turnSeq = 0;

  const send: (text: string, meta?: ChatSendMeta) => Promise<void> = async (text, meta) => {
    acc = "";
    const seq = ++turnSeq;
    const payload: Record<string, unknown> = { message: text };
    if (threadId) payload.thread = threadId;
    if (meta?.context !== undefined && meta.context !== null) payload.context = meta.context;
    if (typeof meta?.mode === "string" && meta.mode.trim()) {
      payload.mode = meta.mode.trim();
      // A mode-carrying turn is an interactive Discuss/design chat (Kanban / Automations
      // open these with mode=james). These must NOT use extended thinking: the router
      // otherwise classifies a "design a process" prompt as standard-tier → Sonnet with
      // `/effort medium`, and extended thinking on that content trips Anthropic's
      // usage-policy classifier (a hard AUP refusal on every Discuss turn). Pin the turn
      // to the no-thinking trivial tier - Discuss is lightweight by design, and the
      // gateway honors this classification hint (routeHintsFromBody). Ad-hoc threaded
      // chats carry no mode and are left to auto-classify as before.
      payload.classification = { taskType: "other", tier: "T0-trivial" };
    }
    // meta.autonomous has ALWAYS been produced by buildSendMeta (the D21 chip) and
    // was silently dropped right here - live proof that this seam loses any key it
    // does not name, with no error anywhere. Forwarded now, and pinned by a test
    // alongside `routing` so the next key added upstream cannot rot the same way.
    if (meta?.autonomous === true) payload.autonomous = true;
    // The pinned run context for this turn (contract §3):
    //   ChatSendMeta.routing -> body.routing -> hints.routing -> applyTurnOverride.
    // Already compacted by buildSendMeta/compactRouting, so an all-empty pin set
    // never reaches the wire and a plain send keeps the pinned back-compat body.
    if (meta?.routing && typeof meta.routing === "object" && Object.keys(meta.routing).length > 0) {
      payload.routing = meta.routing;
    }
    payload.turnSeq = seq;
    // The serve table decides whether a card link is reachable from this client, and
    // the frames are rewritten inline as they arrive, so it has to be resolved BEFORE
    // the stream opens. Shared + cached + never rejecting, so this is one extra
    // same-origin GET on the first send of the page and a no-op after that.
    await loadHostMap();

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
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawReply = false;
    const handleEvent = (name: string, dataRaw: string) => {
      let data: any = {};
      try { data = dataRaw ? JSON.parse(dataRaw) : {}; } catch { /* ignore */ }
      if (name === "chunk" && typeof data.text === "string") {
        // `replace` marks a full re-emit after a screen reflow (not a delta) - REPLACE
        // the accumulator rather than appending, so a reflow doesn't duplicate the whole
        // reply into the stream (the kilobytes-of-repeated-text bug).
        if (data.replace) acc = data.text;
        else acc += data.text;
        sawReply = true;
        listener?.({ type: "assistant", text: acc });
      } else if (name === "tool") {
        // AskUserQuestion → tappable buttons. Forward the wire payload verbatim
        // (name / tool_use_id / questions) as a ChatEvent.
        listener?.({ type: "tool", ...data } as ChatEvent);
      } else if (name === "route") {
        // The PRE-TURN frame (contract §4): the gateway emits it the moment preRoute
        // resolves, ~1s in, carrying `pending: true`. Forwarded as its own event -
        // the consumer merges the later done-frame over it, so this is a refinable
        // first draft of the badge row, never the final word.
        const ev = routeEventFrom(data, seq);
        if (ev) listener?.(ev);
      } else if (name === "activity") {
        // Tool activity from a routed runtime (§12). The non-primary lanes used to
        // stream nothing at all, leaving the conversation silent for minutes; this
        // feeds the working indicator's hint ("Working 0:42 - Edit").
        if (typeof data.name === "string" && data.name) {
          listener?.({
            type: "activity",
            kind: "tool",
            name: data.name,
            ...(typeof data.id === "string" && data.id ? { id: data.id } : {}),
          });
        }
      } else if (name === "done") {
        // The done event carries the AUTHORITATIVE final reply (the settled scrape).
        // Prefer it whenever present: the streamed chunks are a live preview that can
        // still carry transient reflow artifacts, while done.reply is the clean result.
        if (typeof data.reply === "string" && data.reply.trim()) {
          acc = data.reply;
          sawReply = true;
          listener?.({ type: "assistant", text: acc });
        }
        // The turn settled but produced nothing - surface it instead of silently
        // doing nothing (the old failure mode), so the user can retry.
        if (!sawReply) {
          listener?.({ type: "assistant", text: "_The operative returned an empty reply. Try sending again._" });
        }
        // The settled turn's FULL run context: the legacy route/runtime/model/tier
        // fields plus every field the 2026-07-25 contract added (duty, level, phase,
        // skill, via, account + accountSource, project + projectPath, card + cardUrl,
        // sessionId + transcriptPath, stoppedByUser + stoppedReason, and the applied /
        // rejected override bookkeeping). Emitted BEFORE idling the turn so the UI can
        // attach it to the just-finished reply.
        const routeEv = routeEventFrom(data, seq);
        if (routeEv) listener?.(routeEv);
        listener?.({ type: "turn", active: false });
      } else if (name === "error") {
        listener?.({ type: "error", message: String(data.error ?? "stream error") });
        listener?.({ type: "turn", active: false });
      }
    };
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let name = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (name !== "message" || data) handleEvent(name, data);
      }
    }
    listener?.({ type: "turn", active: false });
  };

  return {
    base: b,
    connect(onEvent) {
      listener = onEvent;
      onEvent({ type: "connection", state: "open" });
      return () => { listener = null; onEvent({ type: "connection", state: "closed" }); };
    },
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
