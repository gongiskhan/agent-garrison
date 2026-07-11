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
import type { ChatEvent, ChatTransport, ClaudeStatus, PermissionMode, SlashCommand, ToolQuestion } from "./transport";
import {
  getChatMode,
  resolvedChatScheme,
  setChatMode,
  subscribeChatTheme,
  type ChatThemeMode,
} from "./chat-theme";
import { createVoiceClient, type VoiceClient, type VoiceHealth } from "./voice";
import { sanitizeAssistantText, routeChipLabel } from "./sanitize";

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

// Escape text destined for HTML element content (used for the code fallback and
// the language label). Mirrors escapeAttr but for text nodes.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
md.use({
  renderer: {
    // Neutralize RAW HTML in the assistant stream. The parsed markdown is
    // injected via dangerouslySetInnerHTML, and marked does NOT sanitize, so a
    // reply carrying `<img src=x onerror=…>` or `<script>` (e.g. the Operative
    // relaying a fetched page / a produced document / third-party content) would
    // otherwise become active DOM. Escaping the raw-HTML token keeps it visible
    // as text. Block AND inline HTML tokens both route through this method.
    html({ text }: { text: string }) {
      return escapeHtml(text);
    },
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
          body = escapeHtml(text);
        }
      } else {
        body = escapeHtml(text);
      }
      const label = escapeHtml(language || "text");
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

interface Turn {
  id: string;
  user: string;
  assistant: string;
  streaming: boolean;
  /** Hide the user bubble for this turn (e.g. a host kickoff that primes the operative
   *  but shouldn't be shown as a chat message — the reply still renders normally). */
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
}

// AskUserQuestion picker → tappable option buttons (D28). Pure + exported so the
// render contract (one button per option, disabled-after-answer, no emoji,
// 44px targets via .cc-question-opt) is unit-testable without a DOM. Only the
// first question of a multi-question tool call is rendered/answerable.
export function QuestionBlock({
  q,
  answered,
  answering,
  onSelect,
  onOther,
}: {
  q: ToolQuestion;
  answered?: string;
  answering?: boolean;
  onSelect: (label: string) => void;
  onOther: (text: string) => void;
}) {
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherText, setOtherText] = useState("");
  const locked = Boolean(answered) || Boolean(answering);
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
    </div>
  );
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
  /**
   * Autonomous toggle (GARRISON-UNIFY-V1 D21) - a toolbar chip; when pressed,
   * every send carries meta.autonomous = true (the explicit D8 marker); the
   * gateway registers significant work as a run card and replies with the
   * card link. Default OFF; only the web channel opts in.
   */
  autonomous?: boolean;
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

// Optional per-send metadata a host fitting can attach to every turn. GENERIC
// by design: `context` is an OPAQUE blob and `mode` an opaque string — this
// component never inspects either. A transport that wants them reads a second
// `meta` argument on sendMessage; transports that don't (createHttpTransport)
// ignore it, so default behavior is byte-for-byte unchanged.
export interface ChatSendMeta {
  context?: unknown;
  mode?: string;
  /** D21/D8: the explicit autonomous marker (the toolbar chip). */
  autonomous?: boolean;
}
type ContextAwareSend = (text: string, meta?: ChatSendMeta) => Promise<void>;

// Pure decision used by `send`: build the optional per-send meta from the
// current opaque context/mode, or return undefined when BOTH are absent so a
// context-unaware transport is invoked with exactly one argument (its previous
// behavior). Exported for hermetic unit testing of the threading contract.
export function buildSendMeta(context: unknown, mode: string | undefined, autonomous?: boolean): ChatSendMeta | undefined {
  const hasContext = context !== undefined && context !== null;
  const hasMode = typeof mode === "string" && mode.trim().length > 0;
  const hasAutonomous = autonomous === true;
  if (!hasContext && !hasMode && !hasAutonomous) return undefined;
  const meta: ChatSendMeta = {};
  if (hasContext) meta.context = context;
  if (hasMode) meta.mode = (mode as string).trim();
  if (hasAutonomous) meta.autonomous = true;
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
  /**
   * An opening message to AUTO-SEND once, on mount, as if the user had typed it —
   * so a host can have the operative start proactively (e.g. Kanban Discuss seeds
   * a "James, analyse this card…" kickoff). Absent → exactly the previous behavior
   * (the chat waits for the user). Sent exactly once per mount.
   */
  initialMessage?: string;
  /**
   * When set with `initialMessage`, the auto-sent opening message primes the operative
   * but its user bubble is NOT shown — the transcript starts with the operative's reply.
   * Used by Discuss so the user sees James's question, not the instruction prompt.
   */
  initialMessageHidden?: boolean;
  /**
   * Prior transcript to seed the view on mount (a persisted conversation thread).
   * Each entry is one completed exchange; `hideUser` hides that exchange's user bubble
   * (a reopened Discuss hides its first turn — the kickoff). Absent → the chat starts
   * empty (exactly the previous behavior). A host that supports multiple threads
   * re-mounts the component with a fresh `key` + the selected thread's history to switch.
   */
  initialHistory?: { user: string; assistant: string; hideUser?: boolean }[];
  /**
   * Fires once per turn when its assistant reply has fully settled (non-empty),
   * so a host can PERSIST the exchange into a thread store. Absent → nothing is
   * persisted (previous behavior). Never fires for an empty/aborted turn.
   */
  onTurnComplete?: (exchange: { user: string; assistant: string }) => void;
}

export function ClaudeChat({ transport, composerAdornment, title, features, context, mode, initialMessage, initialMessageHidden, initialHistory, onTurnComplete }: ClaudeChatProps) {
  const feat = features ?? {};
  // Seed from a persisted thread's transcript when the host provides one. Computed
  // once per mount (switching threads re-mounts with a fresh key). Kept in a memo
  // so persistedRef below can mark the LAST seeded turn as already-persisted — else
  // the persist effect would re-append the restored history on every open.
  const seededTurns = useMemo<Turn[]>(
    () => (initialHistory ?? []).map((h) => ({ id: nextId(), user: h.user, assistant: h.assistant, streaming: false, hideUser: h.hideUser })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [turns, setTurns] = useState<Turn[]>(seededTurns);
  const [status, setStatus] = useState<ClaudeStatus>({ rows: [], mode: "unknown", contextPct: null, model: null });
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<"open" | "closed" | "reconnecting">("reconnecting");
  const [screen, setScreen] = useState<string[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [input, setInput] = useState("");
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [menuIdx, setMenuIdx] = useState(0);
  // D21: the Autonomous toggle (feature-gated; default off). A ref mirrors the
  // state so the send callback reads the CURRENT value without re-binding.
  const [autonomousOn, setAutonomousOn] = useState(false);
  const autonomousRef = useRef(false);
  useEffect(() => { autonomousRef.current = autonomousOn; }, [autonomousOn]);
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
  const [transcribing, setTranscribing] = useState(false);
  // Playback state for read-aloud. `speaking` stays true for the whole playback
  // SESSION (including while paused) so the transport controls remain mounted;
  // `paused` distinguishes the two. `loading` covers the TTS round-trip, which
  // can take seconds — without it the button looks dead after the click.
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
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // A compact activity hint pulled from the PTY status line (e.g.
  // "esc to interrupt · 2.1k tokens"). Absent on the orchestrator transport
  // (no status rows) → the indicator degrades to dots + "Working" + elapsed.
  const workingHint = useMemo(() => {
    const row = [...status.rows].reverse().find((r) => /esc to interrupt|tokens/i.test(r));
    if (!row) return "";
    // Prefer the parenthetical tail "(esc to interrupt · N tokens)" so the hint
    // doesn't echo the activity verb already implied by the WORKING label.
    const paren = /\(([^)]*(?:interrupt|tokens)[^)]*)\)/i.exec(row);
    if (paren) return paren[1].trim().slice(0, 80);
    const tail = row.includes("…") ? row.split("…").pop() : row;
    return (tail || "").replace(/^[\s*✻✶✳·•]+/, "").trim().slice(0, 80);
  }, [status.rows]);

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
        return [{ id: nextId(), user: "", assistant: text, streaming: true, hideUser: true }];
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
          setBusy(ev.busy);
          setScreen(ev.screen ?? []);
          // Rebind a reloaded client: when the operative already has a reply on
          // screen (possibly still streaming) and this client has no transcript,
          // seed a turn from the hello snapshot instead of showing an empty chat.
          const helloAssistant = typeof ev.assistant === "string" ? ev.assistant : "";
          if (helloAssistant.trim()) {
            const stillStreaming = ev.busy;
            setTurns((prev) =>
              prev.length > 0
                ? prev
                : [{ id: nextId(), user: "", assistant: helloAssistant, streaming: stillStreaming, hideUser: true }]
            );
          }
          break;
        }
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
        case "tool": {
          // Attach an AskUserQuestion to the current (streaming) turn → tappable
          // option buttons. Ignore other tools and malformed payloads.
          if (ev.name !== "AskUserQuestion" || !Array.isArray(ev.questions) || ev.questions.length === 0) break;
          setTurns((prev) => {
            if (prev.length === 0) return prev;
            const copy = prev.slice();
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = { ...last, question: { toolUseId: ev.tool_use_id, questions: ev.questions } };
            return copy;
          });
          break;
        }
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
    (text: string, opts?: { hideUser?: boolean }) => {
      const t = text.trim();
      if (!t) return;
      // Effort directive (Think / Think hard / Ultrathink) is prepended to the
      // wire text only — the transcript shows what the user actually typed.
      const dir = effortOn ? EFFORTS.find((e) => e.id === effortRef.current)?.directive ?? "" : "";
      const wire = dir ? `${dir}\n\n${t}` : t;
      setTurns((prev) => [...prev, { id: nextId(), user: t, assistant: "", streaming: true, hideUser: opts?.hideUser }]);
      setBusy(true);
      pinnedRef.current = true;
      // Pass opaque context/mode as an optional second arg ONLY when present, so
      // a context-unaware transport (createHttpTransport) is called exactly as
      // before. The transport decides whether to read `meta`.
      const meta = buildSendMeta(contextRef.current, modeRef.current, feat.autonomous ? autonomousRef.current : undefined);
      const sendFn = transport.sendMessage as ContextAwareSend;
      const p = meta ? sendFn(wire, meta) : sendFn(wire);
      p.catch(() => {});
      setInput("");
    },
    [transport, effortOn]
  );

  // Auto-send the opening message ONCE on mount, when a host provided one — so the
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
    const last = [...turns].reverse().find((t) => sanitizeAssistantText(t.assistant).text.trim());
    if (!last) return;
    const cleanText = sanitizeAssistantText(last.assistant).text;
    // Only flash "Copied" when the write actually succeeded (writeClipboard
    // resolves false on a missing API or a rejected write).
    if (await writeClipboard(cleanText)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  }, [turns]);

  // ── Voice: speak a message's text via the /voice/tts proxy. Playback is a
  // real transport (play / pause / resume / stop), not a fire-and-forget: a
  // long reply read aloud has to be pausable. One <audio> at a time — starting a
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
        // different problems — say which one happened rather than going quiet.
        const name = (err as { name?: string } | null)?.name;
        setVoiceError(
          name === "NotAllowedError"
            ? "Playback blocked by the browser — press Read aloud again"
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
  // exists (still fetching the TTS) — the button shows a loading state then.
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
  const persistedRef = useRef<string>(seededTurns.length ? seededTurns[seededTurns.length - 1].id : "");
  const onTurnCompleteRef = useRef(onTurnComplete);
  onTurnCompleteRef.current = onTurnComplete;

  // Auto-read each new COMPLETED assistant turn when read-aloud is on.
  const latestAssistant = turns.length ? turns[turns.length - 1] : null;
  useEffect(() => {
    const cb = onTurnCompleteRef.current;
    if (!cb || !latestAssistant || latestAssistant.streaming) return;
    const assistant = latestAssistant.assistant.trim();
    if (!assistant) return;
    if (persistedRef.current === latestAssistant.id) return;
    persistedRef.current = latestAssistant.id;
    cb({ user: latestAssistant.user, assistant: latestAssistant.assistant });
  }, [latestAssistant?.id, latestAssistant?.assistant, latestAssistant?.streaming]);
  useEffect(() => {
    if (!readAloud || !voiceUsable || !latestAssistant) return;
    if (latestAssistant.streaming) return;
    const text = sanitizeAssistantText(latestAssistant.assistant).text.trim();
    if (!text || text === lastSpokenRef.current) return;
    lastSpokenRef.current = text;
    void speak(text, latestAssistant.id);
  }, [readAloud, voiceUsable, latestAssistant?.id, latestAssistant?.assistant, latestAssistant?.streaming, speak]);

  // ── Voice: push-to-talk. Record from the mic; on stop, POST to /voice/stt
  // and drop the transcript into the composer for review/edit. ──
  const startRecording = useCallback(async () => {
    // recBusyRef is a SYNCHRONOUS guard set before the await — the `recording`
    // state flips only after getUserMedia resolves, so two rapid clicks would
    // otherwise both pass and the second would orphan the first recorder/stream
    // (leaking a live mic). The ref stays set through the active recording and
    // clears on stop / bail / error.
    if (!voiceClient || recBusyRef.current) return;
    // getUserMedia exists only in a secure context (https / localhost). Over a
    // plain-http LAN origin `navigator.mediaDevices` is undefined and the old
    // code threw a TypeError into an empty catch — the button did nothing, with
    // no explanation. Say so instead.
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setVoiceError("Microphone needs a secure context (https or localhost)");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setVoiceError("This browser has no MediaRecorder — recording is unavailable");
      return;
    }
    recBusyRef.current = true;
    setVoiceError(null);
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
        if (!blob.size) {
          setVoiceError("Nothing was recorded — check the microphone input");
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
          ? "Microphone blocked — allow mic access for this page (and reload)"
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
      // Kill any in-flight read-aloud too — a pane swap must not leave audio
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
    (turnId: string, toolUseId: string, choice: { label?: string; text?: string }) => {
      const chosen = choice.label ?? choice.text ?? "";
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, answered: chosen, answering: true } : t)));
      const fn = transport.answerQuestion;
      if (!fn) {
        setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, answering: false } : t)));
        return;
      }
      Promise.resolve(fn.call(transport, { toolUseId, ...choice }))
        .catch(() => {})
        .finally(() => setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, answering: false } : t))));
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

      <div className="cc-scroll" ref={scrollRef} onScroll={onScroll} onClick={onCodeCopyClick}>
        {turns.length === 0 && (
          <div className="cc-empty">Send a message to begin · type / for commands and skills</div>
        )}
        {turns.map((t) => {
          // Clean the scraped reply for display: drop TUI noise (tool-activity
          // counters, thinking blocks) and lift the router status badge out of the
          // prose into a compact chip. Cheap + pure, so per-render is fine.
          const clean = sanitizeAssistantText(t.assistant);
          const routeLabel = routeChipLabel(clean.meta);
          const routeTitle = clean.meta.route
            ? `routed via ${clean.meta.route}${clean.meta.rule ? ` · rule ${clean.meta.rule}` : ""}${clean.meta.profile ? ` · ${clean.meta.profile} profile` : ""}`
            : undefined;
          return (
          <div className="cc-turn" key={t.id}>
            {!t.hideUser && <div className="cc-user">{t.user}</div>}
            {(clean.text || t.streaming || t.question) && (
              <div className="cc-assistant">
                <div className="cc-md" dangerouslySetInnerHTML={{ __html: md.parse(clean.text || "") as string }} />
                {/* Streaming cursor once prose is arriving. */}
                {t.streaming && clean.text && <span className="cc-cursor" aria-hidden="true" />}
                {/* Rich "working" indicator before any prose lands (while James is
                    only doing tool activity, clean.text is empty → show this, not the
                    raw scrape): animated dots + label + live elapsed + activity hint. */}
                {t.streaming && !clean.text && (
                  <div className="cc-working" role="status" aria-live="polite">
                    <span className="cc-working-dots"><i /><i /><i /></span>
                    <span className="cc-working-label">Working</span>
                    <span className="cc-working-time">{fmtElapsed(elapsed)}</span>
                    {workingHint && <span className="cc-working-hint" title={workingHint}>{workingHint}</span>}
                  </div>
                )}
                {/* AskUserQuestion → tappable option buttons (D28). Renders the first
                    question of the tool call; answered via the answer path. */}
                {t.question && t.question.questions[0] && (
                  <QuestionBlock
                    q={t.question.questions[0]}
                    answered={t.answered}
                    answering={t.answering}
                    onSelect={(label) => answerQuestion(t.id, t.question!.toolUseId, { label })}
                    onOther={(text) => answerQuestion(t.id, t.question!.toolUseId, { text })}
                  />
                )}
                {/* Per-message actions: copy (always) + read-aloud (voice) + a subtle
                    routing chip (replaces the inline "[route: …]" badge). */}
                {clean.text.trim() && !t.streaming && (
                  <div className="cc-msgactions">
                    <button
                      type="button"
                      className="cc-msgcopy"
                      title="Copy this response"
                      onClick={() => copyMsg(t.id, clean.text)}
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
                          onClick={() => (isThis ? togglePause() : void speak(clean.text, t.id))}
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
                    {routeLabel && (
                      <span className="cc-routechip" title={routeTitle}>{routeLabel}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          );
        })}
        {showRaw && (
          <pre className="cc-raw">{screen.join("\n")}</pre>
        )}
      </div>

      <div className="cc-statusstrip" title="Claude Code status line">
        {status.rows.length > 0 ? status.rows.map((r, i) => <div key={i} className="cc-statusrow">{r}</div>) : <div className="cc-statusrow cc-dim">no status</div>}
      </div>

      {/* Permission modes only exist when the transport actually reports one (a
          live PTY). On the orchestrator transport `mode` stays "unknown", and the
          row rendered four permanently-disabled buttons — dead chrome eating a
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

      {(feat.model || feat.effort || feat.voice || feat.autonomous) && (
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
            disabled={!turns.some((t) => t.assistant.trim())}
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
                  ? readAloud ? "Auto-read is on — click to turn it off" : "Read each new response aloud"
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
          {/* Playback transport — only while a read-aloud is actually running, so
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
        <div className="cc-composerrow">
          {composerAdornment}
          {feat.voice && (
            <button
              type="button"
              className={`cc-mic ${recording ? "cc-mic-rec" : ""} ${transcribing ? "cc-mic-busy" : ""}`}
              disabled={!voiceUsable || transcribing}
              aria-pressed={recording}
              title={
                !voiceUsable
                  ? "Voice fitting not running"
                  : transcribing
                    ? "Transcribing…"
                    : recording
                      ? "Stop recording and transcribe"
                      : "Talk — record then transcribe into the composer"
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
