// Web Channel UI — the ONE generic, context-driven chat surface.
//
// By default it mounts the shared @garrison/claude-chat component against the
// gateway's rich /claude/* surface (proxied as /api/claude/*) — exactly as
// before. When a fitting hands the channel an opaque `context` blob and/or a
// `mode` via the URL query (?mode=james&context=<base64-or-url-encoded JSON>),
// it switches to a context-aware transport that relays turns through the
// orchestrator path (/api/chat → gateway /chat/stream) carrying that context +
// mode VERBATIM. The channel never inspects context/mode — fittings hand it
// context and it adapts; it knows nothing about Kanban, Dev Env, or souls.
//
// Read-aloud is enabled (features.voice) and degrades gracefully when the voice
// fitting is absent. Markdown (incl. links to produced docs/artifacts) renders
// via the component's `marked` pipeline.

import { createRoot } from "react-dom/client";
import {
  ClaudeChat,
  createHttpTransport,
  type ChatEvent,
  type ChatTransport,
  type ChatSendMeta,
} from "@garrison/claude-chat";
// claude-chat.css is concatenated into web-channel.css by ui/build.mjs.

// ── Generic context/mode from the URL ──────────────────────────────────────
// `context` is OPAQUE to this channel: a blob a fitting put on the query string.
// We un-wrap the TRANSPORT encoding only (URLSearchParams already URL-decodes; a
// fitting may additionally base64-wrap a blob to survive the query string) and
// forward the result VERBATIM. We never JSON-parse it, never inspect its shape —
// the channel knows nothing about what the value means; downstream decodes it.
function decodeContext(raw: string | null): unknown {
  if (!raw) return undefined;
  // Un-wrap a base64 transport layer iff it round-trips (so we don't corrupt a
  // value that merely looks base64-ish). Otherwise forward the url-decoded string.
  if (typeof atob === "function" && typeof btoa === "function") {
    try {
      const decoded = atob(raw);
      if (btoa(decoded) === raw) return decoded; // genuine base64 wrapper → unwrap
    } catch {
      /* not base64 — fall through and forward verbatim */
    }
  }
  return raw; // opaque, forwarded verbatim
}

function readUrlContext(): { context: unknown; mode: string | undefined } {
  if (typeof window === "undefined") return { context: undefined, mode: undefined };
  const q = new URLSearchParams(window.location.search);
  const modeRaw = q.get("mode");
  return {
    context: decodeContext(q.get("context")),
    mode: modeRaw && modeRaw.trim() ? modeRaw.trim() : undefined,
  };
}

// ── Context-aware transport (orchestrator path) ─────────────────────────────
// Used only when the page carries context/mode. Each turn opens a one-shot SSE
// against /api/chat ({message, context, mode}); chunk/done events are surfaced
// as assistant updates. Slash commands / status line are not part of the
// orchestrator channel surface, so those transport methods are inert no-ops
// (the component degrades: no status, no command menu). The default rich
// transport (below) is used when there is no context/mode, so the PTY-mode
// experience is unchanged.
function createOrchestratorTransport(base = "/api"): ChatTransport {
  const b = base.replace(/\/$/, "");
  let listener: ((ev: ChatEvent) => void) | null = null;
  let acc = ""; // accumulates the streaming reply for the current turn

  const send: (text: string, meta?: ChatSendMeta) => Promise<void> = async (text, meta) => {
    acc = "";
    const payload: Record<string, unknown> = { message: text };
    if (meta?.context !== undefined && meta.context !== null) payload.context = meta.context;
    if (typeof meta?.mode === "string" && meta.mode.trim()) payload.mode = meta.mode.trim();

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
    // Minimal SSE reader: split on blank lines, parse `event:`/`data:`.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const handleEvent = (name: string, dataRaw: string) => {
      let data: any = {};
      try { data = dataRaw ? JSON.parse(dataRaw) : {}; } catch { /* ignore */ }
      if (name === "chunk" && typeof data.text === "string") {
        acc += data.text;
        listener?.({ type: "assistant", text: acc });
      } else if (name === "done") {
        if (typeof data.reply === "string" && data.reply && !acc) {
          listener?.({ type: "assistant", text: data.reply });
        }
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
    // Stream closed without an explicit done/error — settle the turn.
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
    async interrupt() { /* no interrupt surface on the orchestrator channel */ },
    async fetchCommands() { return []; },
  };
}

const { context, mode } = readUrlContext();
const contextDriven = context !== undefined || mode !== undefined;

// Rich PTY surface by default (unchanged); orchestrator path when context/mode
// are supplied. Both forward voice through the same same-origin /api/voice/*.
const transport = contextDriven
  ? createOrchestratorTransport("/api")
  : createHttpTransport("/api");

function App() {
  return (
    <ClaudeChat
      transport={transport}
      title="Operative"
      features={{ voice: true }}
      context={context}
      mode={mode}
    />
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
