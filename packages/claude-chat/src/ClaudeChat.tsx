import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import type { ChatEvent, ChatTransport, ClaudeStatus, PermissionMode, SlashCommand } from "./transport";
import {
  getChatMode,
  resolvedChatScheme,
  setChatMode,
  subscribeChatTheme,
  type ChatThemeMode,
} from "./chat-theme";
import { createVoiceClient, type VoiceClient, type VoiceHealth } from "./voice";

marked.setOptions({ breaks: true, gfm: true });

// Escape a value before it goes into an HTML attribute (the rendered markdown is
// injected via dangerouslySetInnerHTML, so an unescaped href/title could break out
// of the attribute or inject markup).
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Allow ONLY safe link targets. Active-content schemes (javascript:, data:,
// vbscript:, file:, …) are rejected so a produced document / an injected reply
// cannot smuggle a script payload through the chat's markdown renderer. Relative,
// root-relative (incl. the translated /fitting/… path), anchor, query, and
// protocol-relative links are allowed, plus the http/https/mailto/tel schemes.
function isSafeHref(url: string): boolean {
  const u = url.trim();
  if (u === "") return false;
  if (/^(?:\/|#|\?|\.\/|\.\.\/)/.test(u)) return true; // relative / anchor / query
  if (/^\/\//.test(u)) return true;                     // protocol-relative //host
  return /^(?:https?:|mailto:|tel:)/i.test(u);          // explicit safe schemes only
}

// Generic link handling for rendered assistant markdown. Content-agnostic (no
// kanban / dev-env knowledge):
//   1. `garrison://<fitting-id>/<rest>` cross-fitting links → `/fitting/<id>/<rest>`
//      (the UI-contract-v2 translation), so a produced doc/artifact link the
//      Operative emits is a real, clickable link, never shown raw.
//   2. http(s) links open in a new tab (rel=noopener) so following a produced
//      document doesn't tear down the live chat.
//   3. UNSAFE schemes (javascript:/data:/…) are NOT linkified — the text is kept,
//      the dangerous href is dropped. href/title are HTML-attribute-escaped.
// Additive: only the <a> attributes change; link text/structure is untouched, so
// dev-env's existing rendering is unaffected (and safer).
marked.use({
  renderer: {
    link({ href, title, tokens }: { href: string; title?: string | null; tokens: any[] }) {
      const text = this.parser.parseInline(tokens);
      let url = href || "";
      const g = /^garrison:\/\/([^/]+)\/?(.*)$/.exec(url);
      if (g) {
        url = `/fitting/${g[1]}${g[2] ? `/${g[2]}` : ""}`;
      }
      // Drop the link (keep the text) for any non-allowlisted/active-content scheme.
      if (!isSafeHref(url)) return text;
      const attrs = /^https?:\/\//i.test(url) || /^\/\//.test(url)
        ? ` target="_blank" rel="noopener noreferrer"`
        : "";
      const t = title ? ` title="${escapeAttr(title)}"` : "";
      return `<a href="${escapeAttr(url)}"${t}${attrs}>${text}</a>`;
    },
  },
});

interface Turn {
  id: string;
  user: string;
  assistant: string;
  streaming: boolean;
}

// ── Toolbar feature flags (all default OFF so web-channel is unaffected) ──
// dev-env opts in via <ClaudeChat features={{ model, effort, theme, voice }} />.
export interface ChatFeatures {
  /** Model selector (Opus/Sonnet/Haiku) — switches the live session via /model. */
  model?: boolean;
  /** Effort/thinking-level selector — prepends a thinking directive to the next message. */
  effort?: boolean;
  /** Light/dark/system theme toggle for the chat surface. */
  theme?: boolean;
  /** Read-aloud + push-to-talk via the host's same-origin /voice proxy. */
  voice?: boolean;
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
  unknown: "—",
};
const SWITCHABLE: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

let uid = 0;
const nextId = () => `t${Date.now()}_${uid++}`;

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

// Optional per-send metadata a host fitting can attach to every turn. GENERIC
// by design: `context` is an OPAQUE blob and `mode` an opaque string — this
// component never inspects either. A transport that wants them reads a second
// `meta` argument on sendMessage; transports that don't (createHttpTransport)
// ignore it, so default behavior is byte-for-byte unchanged.
export interface ChatSendMeta {
  context?: unknown;
  mode?: string;
}
type ContextAwareSend = (text: string, meta?: ChatSendMeta) => Promise<void>;

// Pure decision used by `send`: build the optional per-send meta from the
// current opaque context/mode, or return undefined when BOTH are absent so a
// context-unaware transport is invoked with exactly one argument (its previous
// behavior). Exported for hermetic unit testing of the threading contract.
export function buildSendMeta(context: unknown, mode: string | undefined): ChatSendMeta | undefined {
  const hasContext = context !== undefined && context !== null;
  const hasMode = typeof mode === "string" && mode.trim().length > 0;
  if (!hasContext && !hasMode) return undefined;
  const meta: ChatSendMeta = {};
  if (hasContext) meta.context = context;
  if (hasMode) meta.mode = (mode as string).trim();
  return meta;
}

export interface ClaudeChatProps {
  transport: ChatTransport;
  /** Optional slot rendered at the left of the composer (e.g. voice controls). */
  composerAdornment?: React.ReactNode;
  /** Optional title shown in the header. */
  title?: string;
  /**
   * Opt-in toolbar features. ALL DEFAULT OFF — omitting this prop (as
   * web-channel does) yields exactly the previous chat. dev-env passes
   * { model, effort, theme, voice }.
   */
  features?: ChatFeatures;
  /**
   * OPAQUE context a host fitting hands the chat (a card, a Dev Env session, …).
   * This component does NOT interpret it — it is threaded verbatim to the
   * transport's send as `meta.context`. Absent → exactly the previous behavior.
   */
  context?: unknown;
  /**
   * OPAQUE mode string a host fitting hands the chat (e.g. a souls face). Passed
   * through to the transport's send as `meta.mode`; never interpreted here.
   */
  mode?: string;
}

export function ClaudeChat({ transport, composerAdornment, title, features, context, mode }: ClaudeChatProps) {
  const feat = features ?? {};
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<ClaudeStatus>({ rows: [], mode: "unknown", contextPct: null, model: null });
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<"open" | "closed" | "reconnecting">("reconnecting");
  const [screen, setScreen] = useState<string[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [input, setInput] = useState("");
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [menuIdx, setMenuIdx] = useState(0);
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
  const [speaking, setSpeaking] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recBusyRef = useRef(false);
  const voiceMountedRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
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

  // Reflect the latest assistant text into the most recent turn's assistant slot.
  const applyAssistant = useCallback((text: string) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
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
        case "hello":
          setStatus(ev.status);
          setBusy(ev.busy);
          setScreen(ev.screen ?? []);
          break;
        case "assistant":
          applyAssistant(ev.text);
          break;
        case "status":
          setStatus({ rows: ev.rows, mode: ev.mode, contextPct: ev.contextPct, model: ev.model });
          break;
        case "turn":
          setBusy(ev.active);
          if (!ev.active) {
            setTurns((prev) => prev.map((t, i) => (i === prev.length - 1 ? { ...t, streaming: false } : t)));
          }
          break;
        case "screen":
          setScreen(ev.lines);
          break;
        case "connection":
          setConn(ev.state);
          break;
        case "error":
          // Surface as an assistant note on the latest turn.
          applyAssistant(`_error: ${ev.message}_`);
          break;
      }
    });
    return off;
  }, [transport, applyAssistant]);

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

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      // Effort directive (Think / Think hard / Ultrathink) is prepended to the
      // wire text only — the transcript shows what the user actually typed.
      const dir = effortOn ? EFFORTS.find((e) => e.id === effortRef.current)?.directive ?? "" : "";
      const wire = dir ? `${dir}\n\n${t}` : t;
      setTurns((prev) => [...prev, { id: nextId(), user: t, assistant: "", streaming: true }]);
      setBusy(true);
      pinnedRef.current = true;
      // Pass opaque context/mode as an optional second arg ONLY when present, so
      // a context-unaware transport (createHttpTransport) is called exactly as
      // before. The transport decides whether to read `meta`.
      const meta = buildSendMeta(contextRef.current, modeRef.current);
      const sendFn = transport.sendMessage as ContextAwareSend;
      const p = meta ? sendFn(wire, meta) : sendFn(wire);
      p.catch(() => {});
      setInput("");
    },
    [transport, effortOn]
  );

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
    const last = [...turns].reverse().find((t) => t.assistant.trim());
    if (!last) return;
    try {
      await navigator.clipboard?.writeText(last.assistant);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }, [turns]);

  // ── Voice: speak a single message's text via the /voice/tts proxy. ──
  const speak = useCallback(
    async (text: string) => {
      if (!voiceClient || !text.trim()) return;
      try {
        setSpeaking(true);
        const blob = await voiceClient.tts(text);
        const urlObj = URL.createObjectURL(blob);
        if (audioRef.current) { try { audioRef.current.pause(); } catch {} }
        const audio = new Audio(urlObj);
        audioRef.current = audio;
        audio.onended = () => { setSpeaking(false); URL.revokeObjectURL(urlObj); };
        audio.onerror = () => { setSpeaking(false); URL.revokeObjectURL(urlObj); };
        await audio.play();
      } catch {
        setSpeaking(false);
      }
    },
    [voiceClient]
  );

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) { try { audioRef.current.pause(); } catch {} }
    setSpeaking(false);
  }, []);

  // Auto-read each new COMPLETED assistant turn when read-aloud is on.
  const latestAssistant = turns.length ? turns[turns.length - 1] : null;
  useEffect(() => {
    if (!readAloud || !voiceUsable || !latestAssistant) return;
    if (latestAssistant.streaming) return;
    const text = latestAssistant.assistant.trim();
    if (!text || text === lastSpokenRef.current) return;
    lastSpokenRef.current = text;
    void speak(text);
  }, [readAloud, voiceUsable, latestAssistant?.assistant, latestAssistant?.streaming, speak]);

  // ── Voice: push-to-talk. Record from the mic; on stop, POST to /voice/stt
  // and drop the transcript into the composer for review/edit. ──
  const startRecording = useCallback(async () => {
    // recBusyRef is a SYNCHRONOUS guard set before the await — the `recording`
    // state flips only after getUserMedia resolves, so two rapid clicks would
    // otherwise both pass and the second would orphan the first recorder/stream
    // (leaking a live mic). The ref stays set through the active recording and
    // clears on stop / bail / error.
    if (!voiceClient || recBusyRef.current) return;
    recBusyRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!voiceMountedRef.current) {
        // Unmounted while the permission prompt was pending — release the mic
        // and bail before constructing/starting the recorder.
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
        if (!voiceMountedRef.current) return; // unmounted — don't touch state/network
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (!blob.size) return;
        try {
          const transcript = await voiceClient.stt(blob);
          if (transcript) {
            setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
            taRef.current?.focus();
          }
        } catch {
          /* stt failed — leave composer untouched */
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      recBusyRef.current = false;
      setRecording(false);
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

  return (
    <div className="cc-root" data-theme={themeOn ? scheme : undefined}>
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
        <button className="cc-rawtoggle" onClick={() => setShowRaw((v) => !v)} title="Show raw terminal">
          {showRaw ? "Hide raw" : "Raw"}
        </button>
      </header>

      <div className="cc-scroll" ref={scrollRef} onScroll={onScroll}>
        {turns.length === 0 && <div className="cc-empty">Send a message to start. Type / for commands and skills.</div>}
        {turns.map((t) => (
          <div className="cc-turn" key={t.id}>
            <div className="cc-user">{t.user}</div>
            {(t.assistant || t.streaming) && (
              <div className="cc-assistant">
                <div className="cc-md" dangerouslySetInnerHTML={{ __html: marked.parse(t.assistant || "") as string }} />
                {t.streaming && !t.assistant && <span className="cc-typing">…</span>}
                {feat.voice && voiceUsable && t.assistant.trim() && !t.streaming && (
                  <button
                    type="button"
                    className="cc-speak"
                    title="Read this response aloud"
                    aria-label="Read this response aloud"
                    onClick={() => void speak(t.assistant)}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 2 4.5 5H2v6h2.5L8 14z" fill="currentColor" />
                      <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.3 3.7a6 6 0 0 1 0 8.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {showRaw && (
          <pre className="cc-raw">{screen.join("\n")}</pre>
        )}
      </div>

      <div className="cc-statusstrip" title="Claude Code status line">
        {status.rows.length > 0 ? status.rows.map((r, i) => <div key={i} className="cc-statusrow">{r}</div>) : <div className="cc-statusrow cc-dim">no status</div>}
      </div>

      <div className="cc-modes">
        {SWITCHABLE.map((m) => (
          <button
            key={m}
            className={`cc-mode ${status.mode === m ? "cc-mode-active" : ""}`}
            disabled={status.mode === "unknown"}
            onClick={() => onSetMode(m)}
            title={`Switch to ${MODE_LABELS[m]} mode`}
          >
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>

      {(feat.model || feat.effort || feat.voice) && (
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
          <span className="cc-tool-spacer" />
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
            disabled={!turns.some((t) => t.assistant.trim())}
            onClick={() => void copyLast()}
          >
            {copied ? "Copied" : "Copy last"}
          </button>
          {feat.voice && (
            <button
              type="button"
              className={`cc-chip ${readAloud ? "cc-chip-active" : ""} ${speaking ? "cc-chip-pulse" : ""}`}
              disabled={!voiceUsable}
              aria-pressed={readAloud}
              title={
                voiceUsable
                  ? speaking ? "Speaking — click to stop auto-read" : "Read each new response aloud"
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
        </div>
      )}

      <div className="cc-composer">
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
        <div className="cc-composerrow">
          {composerAdornment}
          {feat.voice && (
            <button
              type="button"
              className={`cc-mic ${recording ? "cc-mic-rec" : ""}`}
              disabled={!voiceUsable}
              aria-pressed={recording}
              title={
                voiceUsable
                  ? recording ? "Stop recording and transcribe" : "Talk — record then transcribe into the composer"
                  : "Voice fitting not running"
              }
              onClick={() => (recording ? stopRecording() : void startRecording())}
            >
              {recording ? (
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
            placeholder="Message Claude…  (/ for commands)"
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button className="cc-stop" onClick={() => transport.interrupt().catch(() => {})} title="Stop (Esc)">
              <span className="cc-stopsq" /> Stop
            </button>
          ) : (
            <button className="cc-send" onClick={() => send(input)} disabled={!input.trim()} title="Send">
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
