// Jarvis Agentic OS — voice-first HUD.
//
// Visual layer (GraphCore particle orb + ReportOverlay) is reused from the
// Fable jarvis-hud reference. The voice + transport logic is the Garrison-native path:
// hands-free voice session → Silero VAD (local, in-browser, @ricky0123/vad-web)
// segments speech → SMART ENDPOINTING (eager /api/voice/stt + adaptive grace
// window sized by the transcript's eot_prob; resumed speech merges into the
// same turn) decides the real end of turn → /api/chat (gateway → Orchestrator)
// → reply read aloud via /api/voice/tts. Press once (Space or tap the core) to
// arm the session; then just talk — a genuine end of turn sends (mid-thought
// pauses don't), and the session re-arms itself between turns until you press
// again to stop.
// The central core pulses to the live audio through a real AnalyserNode RMS.

import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { MicVAD } from "@ricky0123/vad-web";
import { marked } from "marked";
import DOMPurify from "dompurify";
import GraphCore, { type CoreMode } from "./cores/GraphCore";
import ReportOverlay from "./ReportOverlay";
import DiffOverlay from "./DiffOverlay";
import KanbanOverlay from "./KanbanOverlay";
import SearchOverlay from "./SearchOverlay";
import SearchDock from "./SearchDock";
import YouTubeWidget, { parseYtMarker, type YtPlay } from "./YouTubeWidget";
import InfoDock, { InfoOverlay, parseInfoMarker, type InfoWidgetState } from "./InfoWidgets";
import MusicWidget, { type MusicState } from "./MusicWidget";
import AmbientMode, { type AmbientData } from "./AmbientMode";
import { parseKanbanIntent, type KanbanIntent } from "./kanban-intent";
import { parseSessionIntent, type SessionIntent } from "./session-intent";
import { resolveKanbanCardUrl } from "./deep-link";
import { classifyStandbyUtterance, isStopPhrase } from "./voice-phrases";
import { normalizeNumbersPt } from "./speakable-numbers";
import { EP_DEFAULTS, graceWindowMs, coerceEpCfg, type EpCfg } from "./endpointing";

marked.setOptions({ gfm: true, breaks: true });
// Render an assistant reply's markdown to HTML for the transcript. Content is the
// local operative's own output (single-user, localhost), so we render directly.
function renderMarkdown(s: string): string {
  // Assistant replies can relay untrusted external content (fetched pages, email
  // via connectors); marked v14 doesn't sanitize, so DOMPurify the HTML before it
  // reaches dangerouslySetInnerHTML.
  try { return DOMPurify.sanitize(marked.parse(s || "", { async: false }) as string); }
  catch { return DOMPurify.sanitize(s || ""); }
}

// ── helpers ────────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// Encode a mono Float32 PCM buffer (the speech segment Silero VAD hands back at
// 16 kHz) as a 16-bit WAV blob. faster-whisper (PyAV) on the /stt endpoint
// decodes WAV directly, so we ship the VAD's exact segment with no re-recording.
function float32ToWavBlob(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);  // PCM fmt chunk size
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (sr * blockAlign)
  view.setUint16(32, 2, true);   // block align
  view.setUint16(34, 16, true);  // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// ── smart endpointing ────────────────────────────────────────────────────────
// Silero's speechEnd is only a TENTATIVE end of turn. The real decision:
// tentative end → transcribe EAGERLY (overlaps the wait, so a confirmed end
// adds ~no latency) → size a grace window from how finished the words sound
// (eot_prob from the voice server: high = short wait, low = long mid-thought
// tolerance) → only when the window expires with no resumed speech does the
// turn send. Resuming within the window MERGES into the same turn.
// Knobs come from the composition via /api/endpointing; defaults must match
// scripts/server.mjs handleEndpointing.
// Barge-in (full-duplex): the VAD keeps running while Jarvis thinks AND speaks.
// The browser's echo cancellation (getUserMedia echoCancellation:true, with the
// TTS playing in the same page = reference signal available) is the first
// defense against self-interruption; the second is the confirmation gate:
// Silero's onSpeechStart while busy only OPENS a barge-in candidate — it is
// confirmed after bargein_confirm_ms IF the speech is still going; a short
// AEC-residue burst ends first (onVADMisfire / early speechEnd) and cancels it.
// NB: gate lives on onSpeechStart/onVADMisfire because vad-web 0.0.30 declares
// onFrameProcessed in its types but its runtime NEVER calls it (verified:
// dist/index.js has zero references), so a per-frame counter silently does
// nothing. bargein_confirm_ms: 0 disables barge-in entirely.
// EpCfg type, EP_DEFAULTS, graceWindowMs and coerceEpCfg live in ./endpointing
// (pure + unit-tested).

// Standby wake/stop phrase logic lives in ./voice-phrases (pure + unit-tested):
// in standby every VAD segment is still transcribed locally and only an utterance
// addressing Jarvis wakes the session; anything else is dropped without reaching
// the orchestrator. Works wherever the browser+mic are (incl. a LAN/remote box).
// Silence (s) stitched between merged segments so whisper hears the pause the
// speaker actually made (helps punctuation; keeps words from running together).
const MERGE_GAP_S = 0.24;

function concatSegments(segs: Float32Array[], sampleRate = 16000): Float32Array {
  if (segs.length === 1) return segs[0];
  const gap = Math.floor(sampleRate * MERGE_GAP_S);
  const total = segs.reduce((n, s) => n + s.length, 0) + gap * (segs.length - 1);
  const out = new Float32Array(total);
  let off = 0;
  for (const seg of segs) {
    out.set(seg, off);
    off += seg.length + gap; // the gap stays zero-filled
  }
  return out;
}

// The TTS endpoint streams a "growing WAV" whose header carries PLACEHOLDER chunk
// sizes (RIFF + data = 0x7FFFFFFF, i.e. ~2 GB) because the length isn't known when
// the header is written. Chrome tolerates that in decodeAudioData; iOS Safari does
// NOT — it fails/returns silence. Rewrite the RIFF + data sizes to the real byte
// length so the decode is valid everywhere. Mutates + returns the same buffer.
function fixWavChunkSizes(buf: ArrayBuffer): ArrayBuffer {
  if (buf.byteLength < 44) return buf;
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x52494646 /* "RIFF" */ || dv.getUint32(8, false) !== 0x57415645 /* "WAVE" */) return buf;
  dv.setUint32(4, buf.byteLength - 8, true); // RIFF chunk size = filesize - 8
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = dv.getUint32(off, false);
    const sz = dv.getUint32(off + 4, true);
    if (id === 0x64617461 /* "data" */) { dv.setUint32(off + 4, buf.byteLength - (off + 8), true); break; }
    if (sz > buf.byteLength) break; // bogus/placeholder size on a non-data chunk — stop
    off += 8 + sz + (sz & 1);
  }
  return buf;
}

type SttResult = { ok: boolean; transcript: string; eot: number | null; detail?: string };

// getUserMedia/MediaRecorder need a secure context. localhost counts; a LAN IP
// over plain http does not (use the Fitting's tls_cert/tls_key there).
function micCaptureAllowed(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof window.MediaRecorder !== "undefined"
  );
}

function parseSseEvent(raw: string): { event: string; data: any } | null {
  let event = "message";
  let dataText = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataText += (dataText ? "\n" : "") + line.slice(5).trim();
  }
  if (!dataText) return { event, data: null };
  try { return { event, data: JSON.parse(dataText) }; }
  catch { return { event, data: dataText }; }
}

// Clean text shown to the user. Removes the orchestrator's load-bearing control
// tokens ([orchestrator-active], [gateway-route:…], [delegated] — they must stay
// in the model's reply but never be displayed/spoken) and the tool-call / TUI
// echoes the PTY screen-scrape leaks into a Soul's reply (e.g.
// `Web Search("…") ⎿ Did 1 search in 5s`). URLs are kept here (visible on screen).
// The model's self-written search-card digest: a `[card] …` line at the end of
// a web-search reply. Extracted for the docked card, stripped everywhere else.
const CARD_RE = /^[ \t]*\[card\][ \t]*(.+)$/im;
// Play-in-HUD marker: `[youtube] <url — título>` on a "toca X" reply opens the
// embedded player widget. Extracted at done, stripped from chat and speech.
const YT_RE = /^[ \t]*\[youtube\][ \t]*(.+)$/im;
// Info-widget markers: `[agenda] {json}` / `[emails] {json}` / `[board] {json}`
// open the Calendar / Gmail / Trello card on the right flank (see InfoWidgets).
const INFO_RE = /^[ \t]*\[(agenda|emails|board)\][ \t]*(\{.+\})[ \t]*$/im;
// Dev-kanban fallback trigger. Deliberately NARROW: the HUD's own feed is the
// kanban-loop DEV board (Backlog/Plan/Implement…), which is the wrong data for
// a personal-Trello question — those must come via the model's [board] marker
// (only the orchestrator can read Trello). "kanban" is the one word that
// unambiguously means the dev board in this house.
const TRELLO_Q_RE = /\bkanban\b/i;

function stripMarkers(s: string): string {
  return (s || "")
    .replace(/\[orchestrator-active\]/gi, "")
    .replace(/\[gateway-route:[^\]]*\]/gi, "")
    .replace(/\[delegated\]/gi, "")
    .replace(/^[ \t]*\[card\][^\n]*$/gim, "")
    .replace(/^[ \t]*\[youtube\][^\n]*$/gim, "")
    .replace(/^[ \t]*\[(?:agenda|emails|board)\][^\n]*$/gim, "")
    // tool-call invocations + result framing leaked from the Claude Code TUI
    .replace(/\b(?:Web\s*Search|WebFetch|Bash|Read|Write|Edit|Grep|Glob|Task)\s*\([^)]*\)/gi, "")
    .replace(/\bDid \d+ search(?:es)? in \d+(?:\.\d+)?\s*s\b/gi, "")
    .replace(/[⎿└├│─╰╭╮╯┌┐┘┴┬┤┼▌▐]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Speakable form: strip everything that reads terribly aloud — markdown
// formatting, fenced code / file-trees, emojis, citation lists, URLs — leaving
// just the prose. The on-screen text (stripMarkers) keeps the full markdown.
// Long answers are capped to a sentence boundary with a spoken pointer to the
// screen, so structured replies (a file tree, a code dump) become a short spoken
// summary instead of Jarvis reading every "#", "/" and "*".
const SPEAK_CAP = 700;
function toSpeakable(s: string): string {
  let t = stripMarkers(s)
    .replace(/```[\s\S]*?```/g, " ")                      // fenced code / file trees → drop
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/\n*\s*Sources?\s*:[\s\S]*$/i, "")           // trailing citations block
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")            // md image/link → label
    .replace(/`([^`]+)`/g, "$1")                          // inline code → text
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")                   // heading hashes
    .replace(/^\s*>\s?/gm, "")                            // blockquotes
    .replace(/^\s*[-*+•]\s+/gm, "")                       // bullet markers
    .replace(/^\s*\d+\.\s+/gm, "")                        // numbered list markers
    .replace(/(\*\*|__|\*|_|~~)/g, "")                    // bold/italic/strike
    .replace(/\|/g, " ")                                  // table pipes
    // emojis & dingbats & arrows & box-drawing
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{27FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")                    // bare urls
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  // Amounts and separator-grouped numbers → PT words ("€100.000" would be read
  // "cem, zero, zero, zero" by the local TTS; it becomes "cem mil euros").
  t = normalizeNumbersPt(t);
  if (t.length > SPEAK_CAP) {
    const cut = t.slice(0, SPEAK_CAP);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
    t = (stop > 200 ? cut.slice(0, stop + 1) : cut).trim() + " … o resto está no ecrã.";
  }
  return t;
}

// Extra silence (ms) held AFTER a spoken sentence before the next one starts,
// on TOP of the per-sentence pause the voice server already appends. A blank
// line (paragraph / topic change) gets the longer beat; a single line break a
// shorter one. Tune to taste.
const PARA_GAP_MS = 320;
const LINE_GAP_MS = 150;

// Pull COMPLETE sentences from `text` starting at index `from` — a sentence ends
// at . ! ? … (optionally a closing quote/bracket) plus whitespace, so a still-
// growing final sentence stays buffered until its terminator streams in (or the
// turn's `done` flush). Lets TTS speak sentence-by-sentence as the model streams,
// instead of waiting for the whole reply. Each sentence carries the extra pause
// (gapMs) implied by the whitespace that ended it — a blank line after the
// sentence means a topic change, so it breathes longer. Returns the sentences +
// advanced cursor.
function takeSentences(text: string, from: number): { sentences: { text: string; gapMs: number }[]; cursor: number } {
  const re = /[.!?…]+[)\]"'”’»]?(\s+)/g;
  re.lastIndex = Math.max(0, from);
  const sentences: { text: string; gapMs: number }[] = [];
  let cursor = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const piece = text.slice(cursor, end).trim();
    const sep = m[1] || "";
    const newlines = (sep.match(/\n/g) || []).length;
    const gapMs = newlines >= 2 ? PARA_GAP_MS : newlines === 1 ? LINE_GAP_MS : 0;
    if (piece) sentences.push({ text: piece, gapMs });
    cursor = end;
  }
  return { sentences, cursor };
}

type Turn = { id: string; role: "user" | "assistant" | "error"; content: string };
type Callout = { id: string; label: string; content: string };
type Activity = { id: string; tool: string; detail: string };
// One web search in the current turn. Lifecycle: centre overlay (typing) →
// `leaving` (fly-right exit) → `docked` (SearchDock card tethered to the orb).
// `summary` is the 1–2 line digest of the turn's ANSWER, stamped at `done`;
// undefined = this turn's card (awaiting its answer), "" = never fill (the
// turn ended without one — keeps later turns from backfilling old cards).
type SearchRun = { id: string; query: string; fetches: string[]; docked: boolean; leaving: boolean; summary?: string };

// Workspace panel data (right flank) — read-only repo/session state polled from
// /api/project, /api/sessions and /api/worktrees every WORKSPACE_POLL_MS.
type Commit = { hash: string; subject: string; when: string; author: string };
type Pr = { number: number; title: string; state: string; url: string; branch: string };
type ProjectState = {
  available: boolean; root?: string; name?: string | null;
  activeSource?: "session" | "last" | "env" | "none";
  branch?: string | null;
  ahead?: number | null; behind?: number | null; remoteUrl?: string | null;
  commits?: Commit[]; prs?: Pr[]; branches?: string[]; changed?: number;
};
type SessionRow = { session_id: string; soul: string; status: string; mode?: string };
type WorktreeRow = { id?: string; branch?: string; title?: string; path?: string };
// The dev-env Fitting's real, independently-running Claude Code sessions — the
// ones the switcher lists, creates, and commands by id (see /api/dev-sessions).
type DevSession = {
  id: string;
  title?: string | null;
  branch?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  lastStatus?: string;
  claudePty?: { state?: string; busy?: boolean };
  // Whether the dev-env drives this session's Claude PTY. Only sessions it
  // opened/spawned carry a running PTY (`state === "running"`); hook-autocreated
  // "external" ones (a Claude started in a terminal / by the orchestrator / by
  // the HUD itself) are observed via status hooks only — the dev-env has no PTY
  // to type into, so `/instruct` returns 409. These flags let the switcher show
  // "commandable" vs "observed" honestly instead of listing dead targets.
  external?: boolean;
  openedInDevEnv?: boolean;
  source?: string;
};
type OperativeState = {
  gateway: { ok: boolean; mode?: string | null; uptimeMs?: number | null; sessions?: number | null; channels?: number | null };
  voice: { ok: boolean; ready?: boolean };
  souls: string[]; skills: string[]; commands: string[];
};
const WORKSPACE_POLL_MS = 25_000;

// Tasks panel data (right flank) — the kanban board mirrored via /api/kanban.
// Polled faster than the workspace: running cards advance quickly, so a stale
// status line reads as Jarvis being out of the loop.
type KanbanCard = {
  id: string; title: string; list: string; listTitle: string;
  status: string; statusLine: string; runningSince: string | null; updated: string | null;
};
type KanbanState = {
  available: boolean;
  boardUrl?: string;
  tailnetUrl?: string | null;
  counts?: { total: number; running: number; attention: number };
  cards?: KanbanCard[];
};
const KANBAN_POLL_MS = 10_000;

// Deep-link host resolution lives in ./deep-link (pure + unit-tested). `here` is
// the page host; wrap it so call sites stay terse.
const cardHref = (k: KanbanState | null, cardId: string) =>
  resolveKanbanCardUrl(k, cardId, typeof window !== "undefined" ? window.location.hostname : "");

// Dev action dock — canned prompts fired at the Operative through the normal
// /api/chat path (spoken + written like any turn). The label is what shows in
// the transcript; the prompt is what the orchestrator actually receives.
const DOCK_ACTIONS: { label: string; prompt: string }[] = [
  { label: "estado", prompt: "Faz um ponto de situação rápido: em que estás a trabalhar agora, que sessões estão ativas, e qual é o próximo passo." },
  { label: "typecheck", prompt: "Corre `npm run typecheck` no agent-garrison e diz-me se está limpo. Se houver erros, resume-os por ficheiro." },
  { label: "testes", prompt: "Corre `npm test` no agent-garrison e resume o resultado: quantos passaram, quantos falharam, e as falhas mais relevantes." },
  { label: "git", prompt: "Resume o estado do git no agent-garrison: branch atual, ficheiros alterados por commitar, e o que sugeres fazer a seguir." },
  { label: "review", prompt: "Faz uma code review rápida do diff atual (working tree) do agent-garrison: aponta bugs prováveis e melhorias, por ordem de severidade." },
  { label: "continua", prompt: "Continua o trabalho onde ficaste. Se não houver nada pendente, diz o que recomendas fazer a seguir." }
];

// "2h 39m" from ms — for the gateway uptime row.
function fmtUptime(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// A soul with a running gateway session is live (sessions register as
// "engineer" or "soul-engineer" depending on the spawn path).
function soulIsLive(name: string, sessions: SessionRow[]): boolean {
  return sessions.some((s) => s.soul === name || s.soul === `soul-${name}`);
}

// The dev-session switcher polls faster than the workspace panel: the whole
// point is watching sessions run concurrently, so a stale busy dot reads as
// Jarvis being out of the loop.
const DEVSESSION_POLL_MS = 4_000;

// Stuck-open guard: the longest a single Silero speech segment may stay open
// before the watchdog FLUSHES it (hands the buffered audio to the turn pipeline
// and keeps listening — see flushOpenSegment). This is non-destructive: if the
// user is still mid-sentence they simply merge into the same turn, so the cap is
// a chunk boundary, NOT a cut-off. A natural pause fires onSpeechEnd and resets
// this clock long before 20s; only a never-closing segment (noise/echo, or truly
// unbroken speech) reaches it. Kept generous so the rare boundary rarely lands
// inside a real word.
const MAX_OPEN_SPEECH_MS = 20_000;

// Short human label for a dev session (title / project / branch, else a short id).
function devSessionName(s: DevSession): string {
  return (s.title || s.projectName || s.branch || s.id.slice(0, 8)) as string;
}
// A stable, distinguishing id token. Sessions in the same repo/branch with no
// title all render an identical name; this 4-char tag makes each row unique so
// "which session is which" is answerable at a glance.
function devSessionTag(s: DevSession): string {
  return s.id.slice(0, 4);
}
// A dev session is actively working if its Claude PTY is busy or its last hook
// status says so — either way the switcher shows a lit dot (proves concurrency).
function devSessionWorking(s: DevSession): boolean {
  return s.lastStatus === "working" || s.claudePty?.busy === true;
}
// Commandable = the dev-env holds a running Claude PTY we can type into. Only
// these accept `/instruct`; everything else is observed read-only (see the
// DevSession flags above and the dev-env's handleInstruct 409 path).
function devSessionCommandable(s: DevSession): boolean {
  return s.claudePty?.state === "running";
}

// The gateway proxies worktrees to the dev-env Fitting; shapes vary by source
// (bare array vs {worktrees}/{items}). Normalise defensively — an unknown shape
// just means the section stays hidden.
function normalizeWorktrees(data: any): WorktreeRow[] {
  const arr = Array.isArray(data) ? data : Array.isArray(data?.worktrees) ? data.worktrees : Array.isArray(data?.items) ? data.items : [];
  return arr.filter((w: any) => w && typeof w === "object");
}

// Friendly verb for a tool name in the "now" feed; falls back to a normalised
// form of the raw name (MCP tools arrive as `mcp__<server>__<tool>`).
const TOOL_VERB: Record<string, string> = {
  WebSearch: "search web", WebFetch: "fetch page", Bash: "shell",
  Read: "read", Write: "write", Edit: "edit", NotebookEdit: "edit notebook",
  Grep: "search code", Glob: "find files", Task: "delegate", ToolSearch: "find tool",
  talk_to: "delegate", list_active_sessions: "check sessions",
};
function toolVerb(name: string): string {
  const bare = name.replace(/^mcp__[^_]+__/, "").replace(/^mcp__/, "");
  return (
    TOOL_VERB[name] ||
    TOOL_VERB[bare] ||
    bare.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_+/g, " ").toLowerCase().trim()
  );
}

// Reply-verbosity dial (bottom-left bar): the chosen level rides along as a
// bracketed directive appended to the outgoing message (hidden from the shown
// turn, same trick as the barge-in note). "média" is the prompt's default —
// no directive. Spoken replies stay brief regardless; the dial governs the
// WRITTEN answer on screen.
const VERBOSITY: Array<{ key: string; label: string; directive: string }> = [
  { key: "minima", label: "mínima", directive: "responde no mínimo absoluto — uma frase curta, só o facto essencial, sem contexto" },
  { key: "curta", label: "curta", directive: "responde de forma curta: 1–2 frases, sem detalhe além do pedido" },
  { key: "media", label: "média", directive: "" },
  { key: "detalhada", label: "detalhada", directive: "responde de forma detalhada no ecrã — contexto, números e passos relevantes (a fala continua breve)" },
  { key: "maxima", label: "máxima", directive: "responde de forma extremamente detalhada e completa no ecrã — tudo o que for relevante, bem estruturado (a fala continua breve)" },
];
const VERBOSITY_LS_KEY = "jarvis.verbosity";
function loadVerbosity(): number {
  try {
    const v = Number(localStorage.getItem(VERBOSITY_LS_KEY));
    return Number.isInteger(v) && v >= 0 && v < VERBOSITY.length ? v : 2;
  } catch { return 2; }
}

// Keep at most 3 docked searches — FIFO, the 4th replaces the oldest — so the
// dock always shows the last few questions without ever growing past three.
function capDocked(arr: SearchRun[]): SearchRun[] {
  let excess = arr.filter((s) => s.docked).length - 3;
  return excess > 0 ? arr.filter((s) => !(s.docked && excess-- > 0)) : arr;
}

// 1–2 line digest of a reply for a docked search card: markdown stripped, first
// sentence(s) up to ~160 chars. The card clamps to 2 lines; this keeps the cut
// on a sentence boundary when one lands early enough.
function answerSummary(md: string): string {
  const t = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+•]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= 160) return t;
  const cut = t.slice(0, 160);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return stop > 60 ? cut.slice(0, stop + 1) : cut.trimEnd() + "…";
}

// Hostname for a WebFetch detail (a URL, possibly truncated by the gateway to
// 60 chars). URL parse first; fall back to a lenient regex. "" if unrecoverable.
function hostOf(urlish: string): string {
  const s = urlish.trim();
  try {
    return new URL(s).hostname.replace(/^www\./, "");
  } catch {
    const m = s.match(/^(?:https?:\/\/)?([^/\s?#]+)/i);
    return m ? m[1].replace(/^www\./, "") : "";
  }
}

// ── component ────────────────────────────────────────────────────────────────

function App() {
  const [mode, setModeRaw] = useState<CoreMode>("idle");
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  // Wake word armed server-side (from the /api/voice/events hello) — extra
  // signal only; the browser-side standby wake (WAKE_RE) works regardless.
  const [wakeArmed, setWakeArmed] = useState(false);
  // Standby: session armed but dormant — the mic + VAD stay live, every
  // utterance is transcribed locally, and only "hey jarvis…" wakes it.
  const [standby, setStandbyRaw] = useState(false);
  const [sessionOn, setSessionOnRaw] = useState(false);
  // Mic muted: the session stays armed but the VAD stops listening to the room,
  // so side-conversations / other people don't trigger a turn. Space (push-to-
  // talk) opens the mic for a single utterance and it re-mutes afterwards.
  const [micMuted, setMicMutedRaw] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [callouts, setCallouts] = useState<Callout[]>([]);
  const [report, setReport] = useState<{ path: string; content: string } | null>(null);
  const [diff, setDiff] = useState<{ title: string; patch: string; truncated?: boolean } | null>(null);
  // Card deep-link opened INSIDE the HUD (board iframe overlay) instead of a new tab.
  const [boardUrl, setBoardUrl] = useState<string | null>(null);
  // Live "what Jarvis is doing" — tool calls of the current turn, newest last.
  const [activity, setActivity] = useState<Activity[]>([]);
  // In-HUD YouTube player, opened by the `[youtube]` marker on a "toca X" turn.
  const [ytPlay, setYtPlay] = useState<YtPlay | null>(null);
  // Ambient mode (idle smart-display): opens after AMBIENT_AFTER_MS with no
  // interaction while the session sits in "idle" and no overlay is up; any
  // pointer/key/voice activity dismisses it. Data fetched on open + refreshed
  // every 5 min while visible.
  const [ambientOn, setAmbientOn] = useState(false);
  const [ambientData, setAmbientData] = useState<AmbientData | null>(null);
  const [ambientTickAt, setAmbientTickAt] = useState(0);
  const lastActivityRef = useRef(Date.now());
  const ambientOnRef = useRef(false);
  useEffect(() => { ambientOnRef.current = ambientOn; }, [ambientOn]);
  // Delay before auto-entering ambient — served by /api/ui-config (the
  // fitting's ambient_after_s; 0 = never auto-enter, voice command still works).
  const ambientAfterMsRef = useRef(3 * 60_000);
  useEffect(() => {
    fetch("/api/ui-config").then((r) => (r.ok ? r.json() : null)).then((c) => {
      if (c && typeof c.ambient_after_s === "number") {
        ambientAfterMsRef.current = c.ambient_after_s * 1000;
      }
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const bump = () => {
      lastActivityRef.current = Date.now();
      if (ambientOnRef.current) setAmbientOn(false);
    };
    let lastMove = 0;
    const onMove = () => { const t = Date.now(); if (t - lastMove > 2000) { lastMove = t; bump(); } };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("keydown", bump);
    window.addEventListener("pointermove", onMove);
    const tick = setInterval(() => {
      if (ambientOnRef.current) return;
      if (ambientAfterMsRef.current <= 0) return; // 0 = auto-entry disabled
      if (modeRef.current !== "idle") { lastActivityRef.current = Date.now(); return; }
      if (Date.now() - lastActivityRef.current < ambientAfterMsRef.current) return;
      setAmbientOn(true);
    }, 15_000);
    // test hook: window.__jarvisAmbient(true|false)
    (window as any).__jarvisAmbient = (on: boolean) => setAmbientOn(Boolean(on));
    return () => {
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("keydown", bump);
      window.removeEventListener("pointermove", onMove);
      clearInterval(tick);
      delete (window as any).__jarvisAmbient;
    };
  }, []);
  // Speaking/working while ambient is up (a voice turn started) → dismiss.
  useEffect(() => { if (mode !== "idle" && ambientOnRef.current) setAmbientOn(false); }, [mode]);
  // Fetch data on open + 5-min refresh while visible.
  useEffect(() => {
    if (!ambientOn) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/ambient");
        if (res.ok && alive) setAmbientData(await res.json());
      } catch { /* cards simply stay hidden */ }
      if (alive) setAmbientTickAt(Date.now() + 5 * 60_000); // real: next data refresh
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [ambientOn]);
  // Spotify now-playing: polls /api/music; the widget shows itself whenever
  // something is playing (or paused mid-track) and hides when playback stops.
  // `musicDismissed` lets the × silence it until the TRACK changes.
  const [music, setMusic] = useState<MusicState | null>(null);
  const [musicDismissed, setMusicDismissed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        if (!document.hidden) {
          const res = await fetch("/api/music");
          const data = res.ok ? await res.json() : { available: false };
          if (alive) setMusic(data);
        }
      } catch { /* widget simply stays hidden */ }
      if (alive) timer = setTimeout(poll, 10_000);
    };
    poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);
  const musicCmd = useCallback(async (action: "pause" | "resume" | "next" | "previous") => {
    try {
      await fetch("/api/music/cmd", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const res = await fetch("/api/music");
      if (res.ok) setMusic(await res.json());
    } catch { /* voice remains the fallback control */ }
  }, []);
  // Info widget (Calendar / Gmail / Trello card), opened by [agenda]/[emails]/
  // [board] markers. Choreography mirrors the search reveal: centre-stage
  // overlay first (infoCenter, rows cascading while the answer is spoken),
  // then a fly-right exit (infoLeaving) into the docked card (infoWidget),
  // which persists across turns until × or replaced.
  const [infoWidget, setInfoWidget] = useState<InfoWidgetState | null>(null);
  const [infoCenter, setInfoCenter] = useState<InfoWidgetState | null>(null);
  const [infoLeaving, setInfoLeaving] = useState(false);
  const dockInfo = useCallback(() => {
    setInfoLeaving(true);
    setTimeout(() => {
      setInfoCenter((c) => {
        if (c) setInfoWidget(c);
        return null;
      });
      setInfoLeaving(false);
    }, 380);
  }, []);
  // Reply-verbosity dial (0..4, 2 = média/default). Ref mirrors state so `send`
  // reads the latest without re-wiring finalizeTurn.
  const [verbosity, setVerbosityRaw] = useState(loadVerbosity);
  const verbosityRef = useRef(verbosity);
  const setVerbosity = useCallback((v: number) => {
    verbosityRef.current = v;
    setVerbosityRaw(v);
    try { localStorage.setItem(VERBOSITY_LS_KEY, String(v)); } catch {}
  }, []);
  // Web-search reveal: each WebSearch becomes a SearchRun — a Google-style box
  // types the query centre-screen, then docks to the right flank tethered to
  // the orb (SearchDock). Docked cards PERSIST across turns (max 3, FIFO) so
  // the last few questions stay visible as a connected constellation.
  const [searches, setSearches] = useState<SearchRun[]>([]);
  // Retire the centre overlay into the dock: play the fly-right exit, then flip
  // to docked. Idempotent — safe to call per streamed chunk; the timer flip is
  // a no-op when nothing is leaving.
  const retireSearch = useCallback(() => {
    setSearches((prev) =>
      prev.some((s) => !s.docked && !s.leaving)
        ? prev.map((s) => (s.docked || s.leaving ? s : { ...s, leaving: true }))
        : prev,
    );
    setTimeout(() => {
      setSearches((prev) =>
        prev.some((s) => s.leaving)
          ? capDocked(prev.map((s) => (s.leaving ? { ...s, leaving: false, docked: true } : s)))
          : prev,
      );
    }, 380);
  }, []);
  // Workspace panel (right flank): repo state + live gateway lists. Errors keep
  // the last good state (a flaky poll must not blank the panel).
  const [project, setProject] = useState<ProjectState | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeRow[]>([]);
  // Dev-session switcher: the real multi-session engine (dev-env). `activeSessionId`
  // is the session voice/text commands are routed to; null = the orchestrator
  // (today's default). Refs shadow both so the voice handler / stream read the
  // latest without re-wiring finalizeTurn.
  const [devSessions, setDevSessions] = useState<DevSession[]>([]);
  const [devAvailable, setDevAvailable] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const devSessionsRef = useRef<DevSession[]>([]);
  useEffect(() => { devSessionsRef.current = devSessions; }, [devSessions]);
  const activeSessionRef = useRef<string | null>(null);
  useEffect(() => { activeSessionRef.current = activeSessionId; }, [activeSessionId]);
  // The assistant bubble the active session's rich stream replaces in place, and
  // the latest reply text (for speak-on-complete). Refs so the SSE handlers,
  // created once per active session, always see the current turn.
  const sessionBubbleRef = useRef<string | null>(null);
  const sessionReplyTextRef = useRef<string>("");
  const awaitingSessionReplyRef = useRef<boolean>(false);
  const [wsOpen, setWsOpen] = useState(true);
  // Operative panel (left flank): runtime health + agents/skills surface.
  const [operative, setOperative] = useState<OperativeState | null>(null);
  const [opOpen, setOpOpen] = useState(true);
  // Tasks panel (right flank): the kanban board, mirrored via /api/kanban. A ref
  // shadows it so the voice handler can read the latest board without being
  // re-created (and re-wiring finalizeTurn) on every poll.
  const [kanban, setKanban] = useState<KanbanState | null>(null);
  const [tasksOpen, setTasksOpen] = useState(true);
  // On a phone the flank rails cover the orb, so the sessions/actions/operative/
  // reports all live behind the ☰ toggle in a left-sliding drawer (the
  // .jarvis-drawer, mobile-only via CSS). Desktop ignores this — the rails there
  // are always shown by the media query. `closeDrawer` snaps it shut after any
  // in-drawer action so the orb + conversation come back into view.
  const [panelsOpen, setPanelsOpen] = useState(false);
  const closeDrawer = useCallback(() => setPanelsOpen(false), []);
  const kanbanRef = useRef<KanbanState | null>(null);
  useEffect(() => { kanbanRef.current = kanban; }, [kanban]);

  // Scrollable transcript: stick to the newest turn. We track whether the user
  // has deliberately scrolled up to read history (stickToBottomRef=false) and
  // only then hold position; otherwise every new line/turn auto-scrolls to the
  // end. This survives streaming (where the near-bottom gap grows mid-turn),
  // which a point-in-time near-bottom check missed.
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const onScroll = () => {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const modeRef = useRef<CoreMode>("idle");
  const setMode = useCallback((m: CoreMode) => { modeRef.current = m; setModeRaw(m); }, []);
  // Whether the hands-free voice session is armed (mirrored to a ref so the
  // VAD callbacks and key handlers read the live value without stale closures).
  const sessionOnRef = useRef(false);
  const setSessionOn = useCallback((v: boolean) => { sessionOnRef.current = v; setSessionOnRaw(v); }, []);
  const micMutedRef = useRef(false);
  const setMicMuted = useCallback((v: boolean) => { micMutedRef.current = v; setMicMutedRaw(v); }, []);
  // True only inside a push-to-talk window: muted, but the user deliberately
  // opened the mic for ONE utterance (Space/tap while muted). It's the ONLY
  // thing that distinguishes a wanted capture from the room being overheard, so
  // the capture choke-point (onTentativeEnd) can drop the latter. Muting is a
  // hard gate: while muted-and-not-PTT, no room audio ever becomes a turn —
  // independent of any VAD pause/resume race (full-duplex keeps the VAD live).
  const pttOpenRef = useRef(false);
  // Lightweight VAD telemetry for the on-screen ?debug readout — lets us see, on
  // a phone with no dev console, whether Silero fires speechStart/speechEnd at
  // all (endpointing) and what STT/eot came back. Refs only (no re-render churn).
  const vadDbgRef = useRef({ starts: 0, ends: 0, misfires: 0, sends: 0, lastStt: "", eot: -1, ttsOk: 0, ttsErr: 0 });
  const debugOn = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");
  const [dbgTick, setDbgTick] = useState(0);
  useEffect(() => {
    if (!debugOn) return;
    const t = window.setInterval(() => setDbgTick((n) => n + 1), 400);
    return () => window.clearInterval(t);
  }, [debugOn]);
  const standbyRef = useRef(false);
  const setStandby = useCallback((v: boolean) => { standbyRef.current = v; setStandbyRaw(v); }, []);

  // Audio analysis uses TWO separate analysers. Critical: the mic analyser is
  // NEVER connected to ctx.destination — routing the mic to the speakers would
  // feed it back and the STT would hear the user's own echo. Only the TTS
  // analyser sits in the playback path (→ destination). getLevel reads whichever
  // matches the current mode.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const ttsAnalyserRef = useRef<AnalyserNode | null>(null);
  // Uint8Array<ArrayBuffer> (not ArrayBufferLike) so getByteFrequencyData accepts it.
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const ttsSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  // iOS-reliable TTS playback: decode each sentence and play it through an
  // AudioBufferSourceNode (a MediaElementSource plays silent on mobile Safari).
  // ttsBufSrcRef holds the node currently sounding (so barge-in can stop it);
  // ttsGenRef is bumped on every stop to invalidate an in-flight fetch/decode;
  // ttsWiredRef guards the one-time analyser→destination connection.
  const ttsBufSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const ttsGenRef = useRef(0);
  const ttsWiredRef = useRef(false);
  // (audioUrlRef removed — TTS plays via /api/voice/tts URLs, never an object URL.)
  // Silero VAD instance + whether it is currently feeding frames to the model.
  // We pause it during a turn (think + speak) so it never captures Jarvis's own
  // TTS, and resume it when we return to idle.
  const vadRef = useRef<MicVAD | null>(null);
  const vadRunningRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sendingRef = useRef(false);
  // Smart-endpointing state: segments of the still-open turn accumulate here
  // while the adaptive grace window runs (see onTentativeEnd below).
  const pendingSegsRef = useRef<Float32Array[]>([]);
  const tentativeAtRef = useRef(0);             // when the tentative end fired
  // When Silero opened a speech segment (onSpeechStart set "listening") but has
  // NOT yet closed it (no onSpeechEnd). Continuous room noise / echo can hold the
  // speech probability above negativeSpeechThreshold so the redemption counter
  // never fills and onSpeechEnd never fires — the turn hangs in "listening"
  // forever. The stuck-open watchdog (below) uses this to force a recovery.
  const speechOpenAtRef = useRef<number | null>(null);
  const graceTimerRef = useRef<number | null>(null);
  const eagerSeqRef = useRef(0);                // invalidates stale eager STT
  const eagerSttRef = useRef<Promise<SttResult> | null>(null);
  const epCfgRef = useRef<EpCfg>({ ...EP_DEFAULTS });
  // Barge-in state: the abort handle of the in-flight /api/chat turn, whether
  // that abort was a barge-in (vs the 60s safety timeout), whether a confirmed
  // barge-in capture is in progress (lets its segment through the busy guard),
  // the sustained-speech frame counter, and what was actually SPOKEN aloud this
  // turn (finished sentences + the one playing) for the [interrupted] note.
  const chatAbortRef = useRef<AbortController | null>(null);
  const bargedRef = useRef(false);
  const bargeActiveRef = useRef(false);
  const bargeTimerRef = useRef<number | null>(null); // pending barge-in confirmation
  const spokenTextRef = useRef("");
  const speakingNowRef = useRef("");
  const interruptedRef = useRef<{ spoken: string; cut: boolean } | null>(null);
  // Wake word / standby: idle countdown back to standby, and late-defined
  // callbacks reachable from early-defined ones (stop phrase → stopSession).
  const wakeArmedRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);
  const stopSessionRef = useRef<(() => Promise<void>) | null>(null);
  // Sentence-level TTS queue: speak each sentence as soon as it is generated
  // (don't wait for the whole reply), playing them back-to-back. This overlaps
  // synth with generation so the first words come out ~as soon as the model
  // finishes the first sentence.
  // Each item carries an optional extra silence (ms) to hold AFTER it before the
  // next plays — a topic/paragraph change gets a longer beat than a plain
  // sentence, so a multi-part answer doesn't run together.
  const speakQueueRef = useRef<{ text: string; gapMs: number }[]>([]);
  const speakingRef = useRef(false);
  // Delegated Soul replies arrive asynchronously on the channel stream. The
  // stream is subscribed live (?live=1, no ring replay), so the only guard needed
  // is to not speak anything before the user has actually engaged.
  const hasInteractedRef = useRef(false);

  const getCtx = useCallback(() => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current!;
  }, []);

  // Lazily create an analyser into the given ref (shared 128-bin data buffer).
  const ensureAnalyser = useCallback((ref: { current: AnalyserNode | null }) => {
    if (!ref.current) {
      const an = getCtx().createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.7;
      ref.current = an;
      if (!analyserDataRef.current) analyserDataRef.current = new Uint8Array(new ArrayBuffer(an.frequencyBinCount));
    }
    return ref.current;
  }, [getCtx]);

  // Real audio envelope 0..1; reads the analyser matching the current mode.
  const getLevel = useCallback(() => {
    const data = analyserDataRef.current;
    const m = modeRef.current;
    const an = m === "listening" ? micAnalyserRef.current : m === "speaking" ? ttsAnalyserRef.current : null;
    if (!an || !data) return null;
    an.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = data[i] / 255; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / data.length) * 1.8);
  }, []);

  // discover the voice Fitting (local-voice / deepgram-voice) via the proxy
  useEffect(() => {
    fetch("/api/voice")
      .then((r) => r.json())
      .then((info) => setVoiceAvailable(Boolean(info?.available)))
      .catch(() => setVoiceAvailable(false));
  }, []);

  // Workspace panel poll: repo state + gateway lists, on mount then every
  // WORKSPACE_POLL_MS. Each fetch is independent and silent on failure.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      fetch("/api/project")
        .then((r) => r.json())
        .then((d) => { if (alive && d && typeof d.available === "boolean") setProject(d); })
        .catch(() => {});
      fetch("/api/sessions")
        .then((r) => r.json())
        .then((d) => { if (alive && Array.isArray(d?.sessions)) setSessions(d.sessions); })
        .catch(() => {});
      fetch("/api/worktrees")
        .then((r) => r.json())
        .then((d) => { if (alive) setWorktrees(normalizeWorktrees(d)); })
        .catch(() => {});
      fetch("/api/operative")
        .then((r) => r.json())
        .then((d) => { if (alive && d && typeof d === "object" && d.gateway) setOperative(d); })
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, WORKSPACE_POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  // One-shot dev-session refresh — shared by the fast poll and the create/switch
  // flows (so a freshly-created or newly-busy session shows up without waiting a
  // full poll interval). Silent on failure; toggles `devAvailable` so the switcher
  // hides cleanly when dev-env isn't stationed.
  const refreshDevSessions = useCallback(() => {
    fetch("/api/dev-sessions")
      .then((r) => r.json())
      .then((d) => {
        if (!d || typeof d !== "object") return;
        if (typeof d.available === "boolean") setDevAvailable(d.available);
        if (Array.isArray(d.sessions)) setDevSessions(d.sessions);
      })
      .catch(() => {});
  }, []);

  // Dev-session poll: faster than the workspace panel so the busy dots feel live
  // (a user watching two sessions run needs to SEE both working at once).
  useEffect(() => {
    refreshDevSessions();
    const timer = window.setInterval(refreshDevSessions, DEVSESSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshDevSessions]);

  // Clear a stale active session: if the selected one drops off the list (closed
  // elsewhere), fall back to the orchestrator rather than commanding a dead id.
  useEffect(() => {
    if (activeSessionId && devAvailable && !devSessions.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(null);
    }
  }, [devSessions, devAvailable, activeSessionId]);

  // One-shot kanban refresh — shared by the poll below and the create-card flow
  // (so a freshly-created card appears without waiting a full poll interval).
  const refreshKanban = useCallback(() => {
    fetch("/api/kanban")
      .then((r) => r.json())
      .then((d) => { if (d && typeof d.available === "boolean") setKanban(d); })
      .catch(() => {});
  }, []);

  // Tasks panel poll: the kanban board, on mount then every KANBAN_POLL_MS.
  useEffect(() => {
    refreshKanban();
    const timer = window.setInterval(refreshKanban, KANBAN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshKanban]);

  const pushCallout = useCallback((label: string, content: string) => {
    const id = genId("c");
    setCallouts((prev) => [...prev.slice(-2), { id, label, content }]);
    setTimeout(() => setCallouts((prev) => prev.filter((c) => c.id !== id)), 9000);
  }, []);

  // ── VAD pause/resume + turn end ──────────────────────────────────────────
  // Stop feeding mic frames to the VAD without releasing the mic (pauseStream is
  // a no-op below, so the stream + analyser stay live). pause() also resets the
  // model's state, which is what we want between turns.
  const pauseVad = useCallback(() => {
    if (vadRef.current && vadRunningRef.current) {
      vadRunningRef.current = false;
      console.debug("[vad] pause");
      try { void vadRef.current.pause(); } catch (e) { console.debug("[vad] pause err", e); }
    }
  }, []);
  const resumeVad = useCallback(() => {
    if (vadRef.current && sessionOnRef.current && !vadRunningRef.current) {
      vadRunningRef.current = true;
      console.debug("[vad] resume");
      try { void vadRef.current.start(); } catch (e) { console.debug("[vad] resume err", e); }
    }
  }, []);

  // Re-arm the VAD only when a turn is TRULY over: nothing still streaming from
  // the gateway, the speech queue is empty, and no sentence is currently playing.
  // Critical: the TTS queue drains and refills BETWEEN sentences of one reply, so
  // re-arming on every transient "queue empty" would resume the VAD mid-reply and
  // make it capture Jarvis's own voice — which then breaks the NEXT turn's
  // end-of-speech detection. This single gated check is the fix for that.
  const endTurnIfDone = useCallback(() => {
    if (sendingRef.current || speakingRef.current || speakQueueRef.current.length > 0) return;
    if (!sessionOnRef.current) { setMode("idle"); return; }
    // Muted: a push-to-talk utterance just finished — close the mic back up so
    // the room isn't heard again, and show the muted state (don't re-arm listen).
    if (micMutedRef.current) { pttOpenRef.current = false; pauseVad(); setMode("muted"); return; }
    // Standby: VAD keeps running (it feeds the wake check) but the core rests.
    if (standbyRef.current) { resumeVad(); setMode("idle"); return; }
    resumeVad(); setMode("listening");
  }, [resumeVad, pauseVad, setMode]);

  // TTS: ask the voice Fitting (same-origin proxy) to speak, route it through
  // the analyser so the core pulses, and return to idle when playback ends.
  // Play the next queued sentence. Each sentence streams progressively from the
  // GET TTS endpoint (one growing WAV → browser starts after the first audio
  // bytes). When the queue drains, return to idle.
  const playNextInQueue = useCallback(() => {
    const next = speakQueueRef.current.shift();
    if (next === undefined) {
      speakingRef.current = false;
      speakingNowRef.current = "";
      endTurnIfDone(); // re-arm only if the whole turn is done (not between sentences)
      return;
    }
    speakingRef.current = true;
    speakingNowRef.current = next.text; // for the [interrupted] note on barge-in
    setMode("speaking");
    // Advance to the next sentence EXACTLY ONCE per item. `heard` distinguishes a
    // full playback (counts toward the [interrupted] note + honours the trailing
    // gap) from a failure.
    let advanced = false;
    const proceed = (heard: boolean) => {
      if (advanced) return;
      advanced = true;
      speakingNowRef.current = "";
      if (heard) {
        spokenTextRef.current += (spokenTextRef.current ? " " : "") + next.text;
        if (next.gapMs > 0) { window.setTimeout(playNextInQueue, next.gapMs); return; }
      }
      playNextInQueue();
    };
    // Decode the whole sentence WAV and play it through an AudioBufferSourceNode.
    // This is the iOS-reliable path: on mobile Safari an <audio> routed through
    // createMediaElementSource plays SILENT and the context re-suspends; a
    // decoded BufferSource on a gesture-resumed context actually reaches the
    // speaker. Sentences are short, so buffering the whole clip is fine. A
    // generation counter (bumped by stopSpeech) drops a fetch/decode that a
    // barge-in cancelled mid-flight.
    const myGen = ++ttsGenRef.current;
    (async () => {
      try {
        const ctx = getCtx();
        await ctx.resume(); // iOS re-suspends aggressively — ensure running each time
        const resp = await fetch("/api/voice/tts?text=" + encodeURIComponent(next.text));
        if (!resp.ok) throw new Error("tts http " + resp.status);
        const bytes = await resp.arrayBuffer();
        if (myGen !== ttsGenRef.current) return; // stopped/barged while fetching
        const audioBuf = await ctx.decodeAudioData(fixWavChunkSizes(bytes.slice(0)));
        if (myGen !== ttsGenRef.current) return; // stopped/barged while decoding
        const an = ensureAnalyser(ttsAnalyserRef);
        if (!ttsWiredRef.current) { an.connect(ctx.destination); ttsWiredRef.current = true; }
        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(an); // → analyser → destination (orb pulses off the analyser)
        ttsBufSrcRef.current = src;
        vadDbgRef.current.ttsOk++;
        src.onended = () => { if (ttsBufSrcRef.current === src) ttsBufSrcRef.current = null; proceed(true); };
        src.start();
      } catch (e) {
        vadDbgRef.current.ttsErr++;
        console.error("[tts] play failed", e);
        proceed(false);
      }
    })();
  }, [setMode, getCtx, ensureAnalyser, endTurnIfDone]);

  // Enqueue a sentence and start playback if idle. gapMs is extra silence held
  // after this sentence (paragraph/topic change → longer beat).
  const enqueueSpeech = useCallback((text: string, gapMs = 0) => {
    const clean = toSpeakable(text || "");
    if (!clean || !voiceAvailable) return;
    speakQueueRef.current.push({ text: clean, gapMs });
    if (!speakingRef.current) playNextInQueue();
  }, [voiceAvailable, playNextInQueue]);

  // Stop any in-flight speech and clear the queue (new turn interrupts the old).
  const stopSpeech = useCallback(() => {
    speakQueueRef.current = [];
    speakingRef.current = false;
    speakingNowRef.current = "";
    ttsGenRef.current++; // invalidate any in-flight fetch/decode so it won't start
    const src = ttsBufSrcRef.current;
    if (src) { try { src.onended = null; src.stop(); } catch {} ttsBufSrcRef.current = null; }
    // legacy gesture-unlock element, if any — pause it too
    const audio = audioElRef.current;
    if (audio) { try { audio.pause(); } catch {} }
  }, []);

  // Cut the assistant NOW (barge-in, Space-press, mute-mid-reply): kill TTS,
  // cancel any in-flight generation (abort our SSE + tell the gateway to
  // interrupt the orchestrator turn — closing the SSE alone would NOT stop it
  // generating server-side), and remember what was actually heard so the next
  // user turn carries an [interrupted] note. The orchestrator's own history
  // keeps its full answer; the note tells it where the user stopped listening —
  // correction vs continuation is left entirely to the model. Returns whether
  // there was anything to cut.
  const cutAssistant = useCallback(() => {
    const busy = sendingRef.current || speakingRef.current || speakQueueRef.current.length > 0;
    if (!busy) return false;
    interruptedRef.current = { spoken: spokenTextRef.current.trim(), cut: Boolean(speakingNowRef.current) };
    stopSpeech();
    if (sendingRef.current) {
      bargedRef.current = true; // tells send()'s AbortError path this was a barge-in, not the timeout
      try { chatAbortRef.current?.abort(); } catch {}
      void fetch("/api/claude/interrupt", { method: "POST" }).catch(() => {});
    }
    // Mark the visible reply as interrupted (display only).
    setTurns((prev) => {
      const last = [...prev].reverse().find((t) => t.role === "assistant");
      if (!last || /\[interrompido\]/.test(last.content)) return prev;
      return prev.map((t) => t.id === last.id
        ? { ...t, content: (t.content ? t.content + "\n\n" : "") + "*[interrompido]*" } : t);
    });
    return true;
  }, [stopSpeech]);

  // Send a turn to the Operative through the gateway, stream the reply, then
  // read it aloud. Mirrors web-channel's /api/chat SSE handling.
  // shownAs (dock actions): what the transcript displays for the user turn —
  // the short button label instead of the full canned prompt.
  const send = useCallback(async (message: string, shownAs?: string) => {
    const msg = (message || "").trim();
    if (!msg || sendingRef.current) return;
    // Local intent: "modo ambiente" enters the idle smart-display immediately —
    // no round-trip to the orchestrator. Mode must stay idle or the ambient
    // auto-dismiss effect (mode !== idle) would kill it in the same tick.
    if (/\b(modo\s+(ambiente|descanso)|ecr[ãa]\s+de\s+descanso)\b/i.test(msg)) {
      setMode("idle");
      setAmbientOn(true);
      return;
    }
    sendingRef.current = true;
    hasInteractedRef.current = true; // from now on, async Soul replies are live
    stopSpeech(); // a new turn interrupts any in-flight speech
    // If this turn follows a barge-in, tell the model what the user actually
    // heard — its own history holds the FULL previous answer, so the note is
    // how it knows where the user stopped listening. Correction vs continuation
    // is the model's call, not the pipeline's. Shown turn stays the clean msg.
    let payload = msg;
    if (interruptedRef.current) {
      const { spoken, cut } = interruptedRef.current;
      interruptedRef.current = null;
      const tail = spoken.length > 180 ? "…" + spoken.slice(-180) : spoken;
      const heard = spoken
        ? `o utilizador ouviu apenas até: «${tail}»${cut ? " (cortada a meio de uma frase)" : ""}`
        : "o utilizador não chegou a ouvir nada da resposta";
      payload = `[interrupção de voz: a tua resposta anterior foi interrompida — ${heard}. A mensagem seguinte pode ser uma correção, um esclarecimento ou uma continuação; interpreta-a nesse contexto e não repitas o que já foi ouvido.]\n\n${msg}`;
    }
    // Verbosity dial: ride the chosen level along as a hidden directive ("média"
    // = prompt default, no directive). The shown turn stays the clean msg.
    const verbDir = VERBOSITY[verbosityRef.current]?.directive;
    if (verbDir) payload = `${payload}\n\n[formato da resposta: ${verbDir}]`;
    spokenTextRef.current = "";
    speakingNowRef.current = "";
    setActivity([]); // clear last turn's tool feed (docked searches persist)
    // Seal summary-less cards from previous turns ("" = never backfill), so the
    // coming reply only lands on THIS turn's searches.
    setSearches((prev) => prev.map((s) => (s.summary === undefined ? { ...s, summary: "" } : s)));
    setTurns((prev) => [...prev.slice(-6), { id: genId("u"), role: "user", content: shownAs || msg }]);
    setMode("working");
    const bubbleId = genId("a");
    setTurns((prev) => [...prev, { id: bubbleId, role: "assistant", content: "" }]);
    let assembled = "";
    let errored = false; // error paths re-arm on their own timer; finally must not double-arm
    // Pipelined TTS: speak each sentence the moment it completes, overlapping synth
    // with the model still generating, so the first words come out ~as the first
    // sentence lands instead of at `done`. The orchestrator is a thin router — a
    // delegation ack leads with `[delegated]` (before any prose), so once that
    // marker is seen we suppress all speech for this turn (the Soul's reply is
    // spoken via the channel stream). Because the marker leads, it is known before
    // the first sentence boundary, so a real direct answer never waits on it.
    let spokenCursor = 0;        // chars of `assembled` already handed to TTS
    let spokenChars = 0;         // total spoken length this turn (SPEAK_CAP guard)
    let delegated = false;       // turn is a delegation ack → never spoken
    let capped = false;          // SPEAK_CAP hit → pointer to screen spoken once
    // Safety net: if the orchestrator turn hangs (the PTY screen-scrape can miss a
    // turn's completion on tool-call turns), don't keep the UI stuck — abort after
    // 60s and recover. A delegated soul's reply still arrives on the channel
    // stream and is spoken independently.
    const ac = new AbortController();
    chatAbortRef.current = ac; // cutAssistant aborts this on barge-in
    const killer = window.setTimeout(() => ac.abort(), 60_000);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ message: payload }),
        signal: ac.signal
      });
      if (!res.ok || !res.body) {
        const text = res.body ? await res.text() : "";
        setTurns((prev) => prev.map((t) => t.id === bubbleId
          ? { ...t, role: "error", content: `gateway ${res.status}: ${text}` } : t));
        errored = true;
        setMode("error");
        sendingRef.current = false; // let the turn count as done so the re-arm fires
        setTimeout(() => { if (modeRef.current === "error") endTurnIfDone(); }, 2500);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const rawEvent = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const ev = parseSseEvent(rawEvent);
          if (!ev) continue;
          if (ev.event === "chunk" && typeof ev.data?.text === "string") {
            assembled += ev.data.text;
            // The answer is streaming — searching is over; dock the centre box
            // (it stays visible on the right while Jarvis reads the answer).
            retireSearch();
            setTurns((prev) => prev.map((t) => t.id === bubbleId
              ? { ...t, content: t.content + ev.data.text } : t));
            // Suppress speech the instant a delegation is detected (cut anything
            // already queued/playing as a belt-and-suspenders — in practice the
            // marker leads, so nothing has been spoken yet).
            if (!delegated && /\[delegated\]/i.test(assembled)) {
              delegated = true;
              stopSpeech();
            }
            // Speak each newly-completed sentence, up to the spoken-length cap.
            if (!delegated && spokenChars < SPEAK_CAP) {
              const { sentences, cursor } = takeSentences(assembled, spokenCursor);
              spokenCursor = cursor;
              for (const s of sentences) {
                if (spokenChars >= SPEAK_CAP) break;
                spokenChars += s.text.length;
                enqueueSpeech(s.text, s.gapMs);
              }
              if (spokenChars >= SPEAK_CAP && !capped) { capped = true; enqueueSpeech("O resto está no ecrã."); }
            }
          } else if (ev.event === "activity" && typeof ev.data?.tool === "string") {
            // a tool call from the Operative — show it live in the "now" feed.
            // ToolSearch is harness plumbing (loading tool schemas), not a
            // content action, so it's filtered out as noise.
            const tool = ev.data.tool as string;
            if (tool !== "ToolSearch") {
              const detail = typeof ev.data.detail === "string" ? ev.data.detail : "";
              setActivity((prev) => [...prev.slice(-4), { id: genId("act"), tool, detail }]);
              // Cinematic web-search reveal. Each WebSearch opens the Google box
              // typing its query (instantly docking any previous one — docked
              // searches persist across turns on the right flank, max 3 FIFO);
              // a WebFetch adds its host to the latest search's results.
              if (tool === "WebSearch" && detail) {
                setSearches((prev) => [
                  ...capDocked(prev.map((s) => ({ ...s, leaving: false, docked: true }))),
                  { id: genId("srch"), query: detail, fetches: [], docked: false, leaving: false },
                ]);
              } else if (tool === "WebFetch" && detail) {
                const host = hostOf(detail);
                if (host) {
                  setSearches((prev) =>
                    prev.length === 0 ? prev : prev.map((s, i) =>
                      i === prev.length - 1 ? { ...s, fetches: [...s.fetches, host].slice(-6) } : s,
                    ),
                  );
                }
              }
            }
          } else if (ev.event === "error") {
            // Seal this turn's cards without a summary (the turn has no answer).
            setSearches((prev) => prev.map((s) => (s.summary === undefined ? { ...s, summary: "" } : s)));
            setTurns((prev) => prev.map((t) => t.id === bubbleId
              ? { ...t, role: "error", content: t.content || (ev.data?.error ?? "error") } : t));
          } else if (ev.event === "done") {
            clearTimeout(killer); // turn completed; don't abort the lingering stream
            retireSearch(); // covers the chunkless path (no chunk event fired)
            const finalReply = typeof ev.data?.reply === "string" ? ev.data.reply : "";
            if (!assembled && finalReply) assembled = finalReply; // chunkless gateway path
            // Re-check on the RAW reply (covers the chunkless path, where no chunk
            // event ran the incremental detector above).
            delegated = delegated || /\[delegated\]/i.test(assembled);
            const finalContent = stripMarkers(assembled);
            // Stamp the answer digest onto this turn's search cards (undefined
            // summary = created this turn; older cards were sealed at send).
            // Prefer the model's own `[card] …` line (a REAL summary, prompted
            // for web-search turns); fall back to truncating the reply.
            if (finalContent) {
              const digest = assembled.match(CARD_RE)?.[1]?.trim() || answerSummary(finalContent);
              setSearches((prev) => prev.map((s) => (s.summary === undefined ? { ...s, summary: digest } : s)));
            }
            // `[youtube] url — título` → open (or swap) the in-HUD player.
            const ytPayload = assembled.match(YT_RE)?.[1];
            if (ytPayload) {
              const play = parseYtMarker(ytPayload);
              if (play) setYtPlay(play);
            }
            // `[agenda]/[emails]/[board] {json}` → centre-stage reveal (the
            // card animates over the orb while the reply is spoken, then docks).
            const infoMatch = assembled.match(INFO_RE);
            if (infoMatch) {
              const widget = parseInfoMarker(infoMatch[1].toLowerCase(), infoMatch[2]);
              if (widget) {
                setInfoLeaving(false);
                setInfoCenter(widget);
              }
            } else if (TRELLO_Q_RE.test(msg) && (kanbanRef.current?.cards?.length ?? 0) > 0) {
              // Deterministic Trello fallback: the model answered a board-ish
              // question without its [board] marker — build the widget from the
              // HUD's own kanban feed (same data the tarefas panel shows), so
              // the reveal never depends on prompt compliance.
              const byList = new Map<string, string[]>();
              for (const c of kanbanRef.current!.cards!) {
                const col = byList.get(c.listTitle) ?? [];
                if (col.length < 6) col.push(c.title);
                byList.set(c.listTitle, col);
              }
              const columns = [...byList].slice(0, 4).map(([name, cards]) => ({ name, cards }));
              if (columns.length) {
                setInfoLeaving(false);
                setInfoCenter({ kind: "board", data: { title: "Kanban", columns } });
              }
            }
            setTurns((prev) => prev.map((t) => t.id === bubbleId
              ? { ...t, content: stripMarkers(t.content || finalReply) } : t));
            if (finalContent) pushCallout("reply", finalContent);
            // Flush the tail not yet spoken incrementally: the final sentence (no
            // trailing whitespace to fire a boundary) or, on the chunkless path, the
            // whole reply. Delegation acks are shown, never spoken.
            if (!delegated && spokenChars < SPEAK_CAP) {
              const tail = assembled.slice(spokenCursor).trim();
              if (tail) { enqueueSpeech(tail); spokenChars += tail.length; }
              spokenCursor = assembled.length;
            }
            // re-arm is handled by `finally` (no TTS) or by playNextInQueue when
            // the TTS queue drains — never here, where sending is still true.
          }
        }
      }
    } catch (err: any) {
      errored = true;
      sendingRef.current = false;
      if (err?.name === "AbortError" && bargedRef.current) {
        // Voice barge-in: cutAssistant already killed TTS, told the gateway to
        // interrupt the orchestrator, and marked the bubble. The mic is already
        // capturing the correction — just tidy the partial text and get out.
        bargedRef.current = false;
        setTurns((prev) => prev.map((t) => t.id === bubbleId
          ? { ...t, content: stripMarkers(t.content) } : t));
      } else if (err?.name === "AbortError") {
        // Soft timeout: the orchestrator turn is slow/stuck. Recover the UI now;
        // a delegated soul's answer may still arrive on the channel stream.
        setTurns((prev) => prev.map((t) => t.id === bubbleId
          ? { ...t, content: stripMarkers(t.content) || "…(a processar; a resposta pode chegar pela voz)" } : t));
        setMode("idle");
        endTurnIfDone();
      } else {
        setTurns((prev) => prev.map((t) => t.id === bubbleId
          ? { ...t, role: "error", content: `network: ${err?.message || String(err)}` } : t));
        setMode("error");
        setTimeout(() => { if (modeRef.current === "error") endTurnIfDone(); }, 2500);
      }
    } finally {
      clearTimeout(killer);
      chatAbortRef.current = null;
      sendingRef.current = false;
      // Re-arm for the no-TTS success path; TTS replies re-arm via playNextInQueue,
      // error/abort paths re-arm themselves, so skip those here.
      if (!errored && !speakingRef.current && speakQueueRef.current.length === 0) endTurnIfDone();
    }
  }, [setMode, enqueueSpeech, stopSpeech, pushCallout, endTurnIfDone]);

  // ── hands-free voice session (Silero VAD + smart endpointing) ─────────────

  // Transcribe one (possibly merged) speech segment. Never rejects — failures
  // come back as { ok: false, detail } so every caller surfaces them the same
  // way (503 = engines warming, 502 = engine crashed, network = unreachable).
  const sttRequest = useCallback(async (audio: Float32Array): Promise<SttResult> => {
    try {
      const blob = float32ToWavBlob(audio, 16000);
      const res = await fetch("/api/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: blob });
      if (!res.ok) {
        const detail = res.status === 503
          ? "voice engine still warming up — try again in a second"
          : `speech-to-text failed (${res.status})`;
        return { ok: false, transcript: "", eot: null, detail };
      }
      const data = await res.json();
      return {
        ok: true,
        transcript: typeof data?.transcript === "string" ? data.transcript.trim() : "",
        eot: typeof data?.eot_prob === "number" ? data.eot_prob : null
      };
    } catch (e) {
      return { ok: false, transcript: "", eot: null, detail: `voice unreachable: ${(e as Error)?.message ?? e}` };
    }
  }, []);

  // Drop any half-decided turn (session stop, mute, push-to-talk cancel).
  const resetEndpointer = useCallback(() => {
    if (graceTimerRef.current !== null) { window.clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
    pendingSegsRef.current = [];
    speechOpenAtRef.current = null;
    eagerSeqRef.current++;
    eagerSttRef.current = null;
    bargeActiveRef.current = false;
    if (bargeTimerRef.current !== null) { window.clearTimeout(bargeTimerRef.current); bargeTimerRef.current = null; }
  }, []);

  // Flush a never-closing segment WITHOUT cutting the user off. Silero opened a
  // segment but hasn't closed it (continuous noise/echo, or a genuinely long
  // sentence with no ≥redemption pause) → no onSpeechEnd → no grace timer → the
  // turn hangs in "listening". Instead of resetting (which would discard the
  // audio and force a repeat), pause() — with submitUserSpeechOnPause — hands the
  // buffered audio over as an onSpeechEnd, so it flows through onTentativeEnd
  // (eager STT + adaptive grace) exactly like a natural pause. We then resume at
  // once: if the user is STILL talking, the next onSpeechStart MERGES into the
  // same open turn (pendingSegs > 0 → merge), so long speech is chunked-and-
  // joined, never truncated; if it was only noise, the chunk transcribes empty
  // and is dropped. Either way the freeze is broken and nothing is lost.
  const flushOpenSegment = useCallback(async () => {
    const vad = vadRef.current;
    if (!vad || !vadRunningRef.current) return;
    console.debug("[vad] stuck-open watchdog — flushing open segment, continuing to listen");
    speechOpenAtRef.current = null;
    try { await vad.pause(); } catch (e) { console.debug("[vad] flush pause err", e); }
    if (!sessionOnRef.current) { vadRunningRef.current = false; return; }
    try { await vad.start(); vadRunningRef.current = true; } catch (e) { console.debug("[vad] flush start err", e); }
  }, []);

  // Stuck-open watchdog: while a session is armed, once a second check whether a
  // speech segment has stayed open past MAX_OPEN_SPEECH_MS while still listening
  // and not otherwise busy. `speechOpenAtRef !== null` means a segment is CURRENTLY
  // open (it's cleared the moment onSpeechEnd fires), so this never fights the
  // grace window — it only fires for a segment Silero has failed to close.
  useEffect(() => {
    if (!sessionOn) return;
    const id = window.setInterval(() => {
      const openAt = speechOpenAtRef.current;
      if (openAt === null) return;
      if (modeRef.current !== "listening") return;                 // only a stuck LISTEN, not working/speaking
      if (micMutedRef.current && !pttOpenRef.current) return;       // muted room audio isn't a turn
      if (sendingRef.current || speakingRef.current || speakQueueRef.current.length > 0) return;
      if (performance.now() - openAt > MAX_OPEN_SPEECH_MS) void flushOpenSegment();
    }, 1000);
    return () => window.clearInterval(id);
  }, [sessionOn, flushOpenSegment]);

  // Standby transitions. enterStandby keeps the session (mic + VAD) alive but
  // dormant; exitStandby wakes it. Both are cheap — no mic/VAD teardown, so a
  // wake is instant instead of re-paying the getUserMedia + model spin-up.
  const enterStandby = useCallback(() => {
    if (!sessionOnRef.current || standbyRef.current) return;
    stopSpeech();
    resetEndpointer();
    // Drop any pending barge-in note: standby is a context boundary, so it must not
    // be prepended to whatever the user says after they later wake the session.
    interruptedRef.current = null;
    setStandby(true);
    setMode("idle");
  }, [stopSpeech, resetEndpointer, setStandby, setMode]);
  const exitStandby = useCallback((ack: boolean) => {
    setStandby(false);
    setMode("listening");
    if (ack) enqueueSpeech("Sim?"); // audible "I heard you" for a bare "hey jarvis"
  }, [setStandby, setMode, enqueueSpeech]);

  // Hybrid voice fast-path: a recognised kanban command (create a card / summarise
  // the board) is handled locally instead of going to the orchestrator — faster,
  // reliable, and works even when the operative isn't running. Speaks a short
  // confirmation and re-arms the session like any turn.
  const handleKanbanIntent = useCallback(async (intent: KanbanIntent) => {
    setMode("working");
    if (intent.kind === "summary") {
      const k = kanbanRef.current;
      const cards = k?.available ? (k.cards ?? []) : [];
      if (!cards.length) {
        enqueueSpeech("Não há tarefas no kanban de momento.");
      } else {
        const running = cards.filter((c) => c.status === "running");
        const attention = cards.filter((c) => c.status === "needs-attention");
        const parts = [`${k!.counts!.total} tarefa${k!.counts!.total === 1 ? "" : "s"} no total`];
        if (running.length) parts.push(`${running.length} a correr: ${running.slice(0, 3).map((c) => c.title).join(", ")}`);
        if (attention.length) parts.push(`${attention.length} a precisar de atenção`);
        enqueueSpeech(parts.join("; ") + ".");
        pushCallout("kanban", cards.map((c) => `• ${c.title} — ${c.statusLine}`).join("\n"));
      }
      endTurnIfDone();
      return;
    }
    if (intent.kind === "advance") {
      // Match a card by title fragment; only act on an unambiguous single hit.
      const cards = kanbanRef.current?.cards ?? [];
      const q = intent.query.toLowerCase();
      const hits = cards.filter((c) => c.title.toLowerCase().includes(q));
      if (hits.length === 0) {
        enqueueSpeech(`Não encontrei nenhum card com "${intent.query}".`);
      } else if (hits.length > 1) {
        enqueueSpeech(`Encontrei ${hits.length} cards com "${intent.query}". Sê mais específico.`);
      } else {
        const card = hits[0];
        try {
          const res = await fetch(`/api/kanban/cards/${card.id}/start`, { method: "POST" });
          const data = await res.json().catch(() => null);
          if (res.ok) { enqueueSpeech(`Avancei o card "${card.title}".`); refreshKanban(); }
          else enqueueSpeech(`Não consegui avançar o card: ${data?.error || "erro"}.`);
        } catch { enqueueSpeech("Não consegui avançar o card."); }
      }
      endTurnIfDone();
      return;
    }
    // create
    try {
      const res = await fetch("/api/kanban/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: intent.text })
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.card) {
        const title = data.card.title || intent.text;
        enqueueSpeech(`Criei o card "${title}" no backlog.`);
        const url = cardHref(kanbanRef.current, data.card.id);
        pushCallout("card criado", url ? `${title}\n\n${url}` : title);
        refreshKanban();
      } else {
        enqueueSpeech("Não consegui criar o card.");
        pushCallout("kanban", data?.error || "falha ao criar o card");
      }
    } catch {
      enqueueSpeech("Não consegui criar o card.");
    }
    endTurnIfDone();
  }, [setMode, enqueueSpeech, pushCallout, endTurnIfDone, refreshKanban]);

  // ── dev-session switcher: command a chosen session without touching others ────

  // Send a turn to ONE dev-env session by id. Unlike `send` (orchestrator SSE),
  // this writes into that session's Claude PTY via /instruct and lets the active-
  // session rich stream (below) mirror the reply. The other sessions keep running
  // untouched — that is the "sem interromper" guarantee.
  const sendToSession = useCallback(async (sessionId: string, message: string, shownAs?: string) => {
    const msg = (message || "").trim();
    if (!msg || sendingRef.current) return;
    sendingRef.current = true;
    hasInteractedRef.current = true;
    stopSpeech();
    const label = devSessionName(devSessionsRef.current.find((s) => s.id === sessionId) ?? ({ id: sessionId } as DevSession));
    const bubbleId = genId("a");
    sessionBubbleRef.current = bubbleId;
    sessionReplyTextRef.current = "";
    awaitingSessionReplyRef.current = true;
    setActivity([]);
    setTurns((prev) => [
      ...prev.slice(-6),
      { id: genId("u"), role: "user", content: shownAs || msg },
      { id: bubbleId, role: "assistant", content: "" }
    ]);
    setMode("working");
    try {
      const res = await fetch(`/api/dev-sessions/${encodeURIComponent(sessionId)}/instruct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg })
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        awaitingSessionReplyRef.current = false;
        setTurns((prev) => prev.map((t) => t.id === bubbleId
          ? { ...t, role: "error", content: `sessão ${label}: ${d?.error || res.status}` } : t));
        setMode("error");
        enqueueSpeech(`Não consegui enviar para a sessão ${label}.`);
        setTimeout(() => { if (modeRef.current === "error") endTurnIfDone(); }, 2000);
      } else {
        // The reply arrives on the active-session stream; refresh the list so the
        // session's busy dot lights immediately.
        refreshDevSessions();
      }
    } catch (err: any) {
      awaitingSessionReplyRef.current = false;
      setTurns((prev) => prev.map((t) => t.id === bubbleId
        ? { ...t, role: "error", content: `network: ${err?.message || String(err)}` } : t));
      setMode("error");
      setTimeout(() => { if (modeRef.current === "error") endTurnIfDone(); }, 2000);
    } finally {
      sendingRef.current = false;
    }
  }, [stopSpeech, setMode, enqueueSpeech, endTurnIfDone, refreshDevSessions]);

  // Route a turn: to the active dev session when one is selected, else to the
  // orchestrator (today's default). Every command site (voice, dock, text) goes
  // through here so "selected session B" means B receives everything.
  const dispatch = useCallback((message: string, shownAs?: string) => {
    const sid = activeSessionRef.current;
    if (sid) return sendToSession(sid, message, shownAs);
    return send(message, shownAs);
  }, [send, sendToSession]);

  // Debug/test hook: inject a turn through the EXACT voice pipeline (dispatch →
  // send → SSE → markers → widgets) from the console or Playwright. Lets us
  // verify the client pipeline headlessly — the HUD has no text input.
  useEffect(() => {
    (window as any).__jarvisSay = (text: string) => dispatch(text);
    return () => { delete (window as any).__jarvisSay; };
  }, [dispatch]);


  // Create a new dev-env session (button or voice). Defaults to the active
  // workspace project (server-side) unless a path is given; selects it on success.
  const createDevSession = useCallback(async (opts?: { path?: string; title?: string }): Promise<string | null> => {
    try {
      const res = await fetch("/api/dev-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts || {})
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.id) {
        setActiveSessionId(d.id);
        refreshDevSessions();
        enqueueSpeech("Sessão criada. Estás agora nela.");
        return d.id;
      }
      enqueueSpeech(`Não consegui criar a sessão${d?.error ? `: ${d.error}` : ""}.`);
    } catch {
      enqueueSpeech("Não consegui criar a sessão.");
    }
    return null;
  }, [enqueueSpeech, refreshDevSessions]);

  // Resolve a spoken query to a session: a 1-based index, else a name fragment
  // matched against project / branch / title. Returns null on no/ambiguous match.
  const resolveSession = useCallback((query: string): DevSession | null | "ambiguous" => {
    const list = devSessionsRef.current;
    if (!list.length) return null;
    const q = query.trim().toLowerCase();
    if (/^\d{1,2}$/.test(q)) return list[Number(q) - 1] ?? null;
    const hits = list.filter((s) =>
      [s.projectName, s.branch, s.title].some((f) => typeof f === "string" && f.toLowerCase().includes(q)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return "ambiguous";
    return null;
  }, []);

  // Hybrid fast-path for session voice commands (switch / create / back-to-
  // orchestrator), mirroring handleKanbanIntent.
  const handleSessionIntent = useCallback(async (intent: SessionIntent) => {
    if (intent.kind === "switch-off") {
      setActiveSessionId(null);
      enqueueSpeech("De volta ao orquestrador.");
      endTurnIfDone();
      return;
    }
    if (intent.kind === "create") {
      // A named project fragment picks an existing session's project dir; anything
      // else creates in the current workspace (server default).
      let projectPath: string | undefined;
      if (intent.project) {
        const match = resolveSession(intent.project);
        if (match && match !== "ambiguous" && match.projectPath) projectPath = match.projectPath;
      }
      await createDevSession(projectPath ? { path: projectPath } : undefined);
      endTurnIfDone();
      return;
    }
    // switch
    const found = resolveSession(intent.query);
    if (found === "ambiguous") {
      enqueueSpeech(`Há mais do que uma sessão com "${intent.query}". Sê mais específico.`);
    } else if (found) {
      setActiveSessionId(found.id);
      enqueueSpeech(`Agora na sessão ${devSessionName(found)}.`);
    } else {
      enqueueSpeech(`Não encontrei a sessão "${intent.query}".`);
    }
    endTurnIfDone();
  }, [enqueueSpeech, endTurnIfDone, createDevSession, resolveSession]);

  // Click a session row: select it, or deselect (→ orchestrator) if it's already
  // active. Silent — the visual "ativa" marker is the feedback.
  const toggleSession = useCallback((id: string) => {
    setActiveSessionId((cur) => (cur === id ? null : id));
  }, []);

  // The grace window expired with no resumed speech: the turn is real. Commit —
  // pause the VAD, take the eager transcript (usually already resolved; a fresh
  // STT only when the eager one was invalidated) and send.
  const finalizeTurn = useCallback(async () => {
    if (graceTimerRef.current !== null) { window.clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
    if (sendingRef.current || pendingSegsRef.current.length === 0) return;
    const segs = pendingSegsRef.current;
    pendingSegsRef.current = [];
    const eager = eagerSttRef.current;
    eagerSttRef.current = null;
    eagerSeqRef.current++; // a late eager .then must not re-arm the timer
    // Full duplex: the VAD is NOT paused here — it keeps listening through
    // thinking and speaking so the user can barge in. Segments captured while
    // busy are dropped by onTentativeEnd unless a barge-in was confirmed.
    setMode("working");
    const r = eager ? await eager : await sttRequest(concatSegments(segs));
    if (!r.ok) {
      // A silent drop reads as Jarvis ignoring you — surface it, then re-arm
      // so the next attempt Just Works. This is NOT the empty-transcript case
      // below (normal noise/silence), which stays quiet.
      console.error(`[jarvis] stt: ${r.detail}`);
      pushCallout("didn't catch that", r.detail ?? "speech-to-text failed");
      endTurnIfDone();
      return;
    }
    // Standby gate: dormant session → only an utterance addressing Jarvis wakes
    // it; everything else was room talk and is dropped here, never sent. The
    // rest of the wake utterance ("hey jarvis, que horas são?") is the first turn.
    if (standbyRef.current) {
      const res = classifyStandbyUtterance(r.transcript);
      if (res.kind === "ignore") { console.debug(`[wake] standby drop: "${r.transcript.trim().slice(0, 50)}"`); endTurnIfDone(); return; }
      // "jarvis, para de ouvir" while already dormant = stay dormant.
      if (res.kind === "stay-dormant") { endTurnIfDone(); return; }
      console.debug(`[wake] woke by voice — query="${res.query.slice(0, 50)}"`);
      exitStandby(!res.query);
      if (res.query) void dispatch(res.query);
      else endTurnIfDone();
      return;
    }
    // Stop phrase ("desliga", "para de ouvir", …) drops into standby; "hey
    // jarvis" wakes it again. Checked before send so the orchestrator never
    // sees the phrase as a turn.
    if (r.transcript && isStopPhrase(r.transcript)) {
      pushCallout("standby", "Em standby — diz “hey jarvis” para voltar.");
      enterStandby();
      return;
    }
    // loop-safety: drop empty / sub-word transcripts (a stray noise blip) —
    // quietly, so ambient noise never spams a callout.
    if (r.transcript && r.transcript.replace(/[^\p{L}\p{N}]+/gu, " ").trim().length >= 2) {
      // Hybrid fast-paths, checked before dispatch: a session command (switch /
      // create / back-to-orchestrator) or a kanban command is handled locally;
      // anything else is dispatched (active session or orchestrator).
      const sIntent = parseSessionIntent(r.transcript.trim());
      if (sIntent) { void handleSessionIntent(sIntent); return; }
      const intent = parseKanbanIntent(r.transcript.trim());
      if (intent) { void handleKanbanIntent(intent); return; }
      void dispatch(r.transcript);
    } else {
      endTurnIfDone(); // nothing usable → re-arm and keep listening
    }
  }, [setMode, sttRequest, dispatch, endTurnIfDone, pushCallout, enterStandby, exitStandby, handleKanbanIntent, handleSessionIntent]);

  // (Re)arm the end-of-turn decision timer.
  const armGraceTimer = useCallback((delayMs: number) => {
    if (graceTimerRef.current !== null) window.clearTimeout(graceTimerRef.current);
    graceTimerRef.current = window.setTimeout(() => { graceTimerRef.current = null; void finalizeTurn(); }, Math.max(0, delayMs));
  }, [finalizeTurn]);

  // Silero closed a segment — a TENTATIVE end of turn. The VAD keeps running
  // (so resumed speech is heard); STT starts immediately; the decision timer
  // starts at the maximum tolerance and is tightened once the transcript's
  // end-of-turn probability arrives. Complete-sounding speech sends after
  // ~endpoint_min_ms; a trailing "e…"/"quero que…" waits up to endpoint_max_ms.
  const onTentativeEnd = useCallback((audio: Float32Array) => {
    // Muted and NOT in a push-to-talk window → this is the room being overheard
    // (colleagues, background). Never let it become a request. This is the hard
    // guarantee behind M ("stop listening"): even though full-duplex keeps the
    // VAD live, a muted mic produces no turns. Drop the segment and bail before
    // any STT / grace-timer work.
    if (micMutedRef.current && !pttOpenRef.current) {
      console.debug("[mute] dropped overheard segment (muted, no push-to-talk)");
      return;
    }
    // Speech ended before the barge-in confirmation fired → too short to count
    // as talking over Jarvis; drop the candidate (the busy guard below then
    // discards the segment as echo/noise).
    if (bargeTimerRef.current !== null) {
      window.clearTimeout(bargeTimerRef.current);
      bargeTimerRef.current = null;
      console.debug("[barge] candidate dropped (speech ended before confirm)");
    }
    // While a turn is in flight or Jarvis is speaking, Silero still segments
    // whatever the (echo-cancelled) mic hears. Those segments are echo residue
    // or room noise UNLESS a barge-in was confirmed — the confirmed barge-in's
    // own segment is the user's correction and flows through.
    const busy = sendingRef.current || speakingRef.current || speakQueueRef.current.length > 0;
    if (busy && !bargeActiveRef.current) return;
    if (sendingRef.current) return; // barge-in teardown still settling — drop
    bargeActiveRef.current = false; // the barge-in segment is in; back to normal
    pendingSegsRef.current.push(audio);
    tentativeAtRef.current = performance.now();
    const seq = ++eagerSeqRef.current;
    const { minMs, maxMs } = epCfgRef.current;
    armGraceTimer(maxMs); // fallback decision even if STT is slow or fails
    const stt = sttRequest(concatSegments(pendingSegsRef.current));
    eagerSttRef.current = stt;
    void stt.then((r) => {
      if (seq !== eagerSeqRef.current) return; // user resumed / turn reset — stale
      vadDbgRef.current.sends++;
      vadDbgRef.current.lastStt = (r.ok ? r.transcript : (r.detail ?? "stt-fail")).slice(0, 40);
      vadDbgRef.current.eot = r.ok ? (r.eot ?? -1) : -1;
      const windowMs = graceWindowMs(r.ok ? r.eot : null, { minMs, maxMs });
      const elapsed = performance.now() - tentativeAtRef.current;
      console.debug(`[endpoint] eot=${r.eot} window=${Math.round(windowMs)}ms elapsed=${Math.round(elapsed)}ms text="${r.transcript.slice(0, 60)}"`);
      armGraceTimer(windowMs - elapsed);
    });
  }, [sttRequest, armGraceTimer]);

  // Sustained speech confirmed while Jarvis was thinking/speaking: the user is
  // talking over it. Cut everything and let the in-progress VAD segment flow
  // into a normal turn (bargeActive whitelists it through the busy guard).
  const triggerBargeIn = useCallback(() => {
    if (!cutAssistant()) return;
    bargeActiveRef.current = true;
    setMode("listening");
    // The barge-in's own segment is still open — track it for the watchdog too.
    speechOpenAtRef.current = performance.now();
    console.debug("[barge] confirmed — assistant cut, listening");
  }, [cutAssistant, setMode]);

  // Surface a problem the user can read (and report) instead of failing silent.
  const flashError = useCallback((label: string, msg: string) => {
    console.error(`[jarvis] ${label}: ${msg}`);
    pushCallout(label, msg);
    setMode("error");
    setTimeout(() => { if (modeRef.current === "error") setMode("idle"); }, 3500);
  }, [pushCallout, setMode]);

  // Build the VAD once, reusing the mic stream + AudioContext already obtained in
  // the click handler. Silero runs fully local in the browser (ONNX/WASM); the
  // model + worklet + ort runtime are served from the Fitting's dist/ (build.mjs).
  // Passing our own audioContext (already resumed under user activation) and a
  // pre-opened stream avoids the autoplay/gesture trap: the slow ~13 MB wasm load
  // happens AFTER the mic is live, so it can't consume the user-activation window.
  const ensureVad = useCallback(async (stream: MediaStream) => {
    if (vadRef.current) return vadRef.current;
    // Endpointing knobs from the composition (vad_redemption_ms /
    // endpoint_min_ms / endpoint_max_ms), fetched before the VAD is built
    // because redemptionMs is fixed at construction. Failure = defaults.
    try {
      const r = await fetch("/api/endpointing");
      if (r.ok) epCfgRef.current = coerceEpCfg(await r.json());
    } catch {}
    const vad = await MicVAD.new({
      model: "v5",
      baseAssetPath: "/",
      onnxWASMBasePath: "/",
      audioContext: getCtx(),
      // Single-threaded ort: avoids needing cross-origin isolation (no
      // SharedArrayBuffer / COOP+COEP headers required).
      ortConfig: (ort: any) => { try { ort.env.wasm.numThreads = 1; ort.env.logLevel = "error"; } catch {} },
      startOnLoad: false,
      // Keep Silero's proven default thresholds (positive 0.3 / negative 0.25).
      // Raising them — which I tried — breaks END detection: with room noise the
      // speech probability hovers above a high negativeSpeechThreshold, so the
      // redemption counter never fills and the turn never ends.
      // redemption is SEGMENTATION only now — the real end-of-turn decision is
      // the adaptive grace window on top (onTentativeEnd): eager STT + semantic
      // eot_prob size the wait, and resumed speech merges into the same turn.
      // So this can be short (hand segments over quickly) without causing the
      // old "850ms of silence = cut off mid-thought" behavior.
      redemptionMs: epCfgRef.current.redemptionMs,
      minSpeechMs: 250,
      positiveSpeechThreshold: 0.3,
      negativeSpeechThreshold: 0.25,
      // Let a manual pause() hand us the audio buffered so far as an onSpeechEnd
      // (instead of silently dropping it). The stuck-open watchdog relies on this
      // to FLUSH a never-closing segment into the normal turn pipeline and keep
      // listening — so genuine long speech is chunked-and-merged, never cut off.
      // Safe because every OTHER pause() is in a muted context, where
      // onTentativeEnd drops the flushed segment (verified: setMicMuted sets its
      // ref synchronously before pausing; standby never pauses).
      submitUserSpeechOnPause: true,
      // Reuse the ONE mic stream opened in startSession and keep it open across
      // turns: pauseStream is a no-op and resumeStream returns the same stream,
      // so pause/resume only toggles the worklet, never the mic.
      getStream: async () => stream,
      pauseStream: async () => {},
      resumeStream: async (s: MediaStream) => s,
      onSpeechStart: () => {
        vadDbgRef.current.starts++;
        console.debug("[vad] speechStart (mode=" + modeRef.current + ")");
        // Barge-in candidate: speech detected while Jarvis is thinking/speaking.
        // Don't act yet — a brief AEC-residue burst also trips speechStart. Arm
        // a confirmation timer instead: if the speech is STILL open after
        // bargein_confirm_ms (no misfire, no early end), it's the user talking
        // over Jarvis → cut everything. (onFrameProcessed would be cleaner but
        // vad-web 0.0.30 never calls it — see the EpCfg comment.)
        const { bargeinConfirmMs } = epCfgRef.current;
        const busy = sendingRef.current || speakingRef.current || speakQueueRef.current.length > 0;
        if (busy && !bargeActiveRef.current && bargeinConfirmMs > 0 && !micMutedRef.current) {
          if (bargeTimerRef.current !== null) window.clearTimeout(bargeTimerRef.current);
          bargeTimerRef.current = window.setTimeout(() => {
            bargeTimerRef.current = null;
            triggerBargeIn();
          }, bargeinConfirmMs);
          console.debug(`[barge] candidate — confirming in ${bargeinConfirmMs}ms`);
        }
        if (pendingSegsRef.current.length > 0) {
          // Resumed within the grace window → same turn (merge): kill the
          // pending decision; the next speechEnd re-transcribes the merged audio.
          if (graceTimerRef.current !== null) { window.clearTimeout(graceTimerRef.current); graceTimerRef.current = null; }
          eagerSeqRef.current++;
          eagerSttRef.current = null;
          console.debug("[endpoint] resumed — merging into open turn");
        }
        // Don't flash "listening" for room audio overheard while muted (only a
        // real push-to-talk window should light the core up).
        if (!sendingRef.current && modeRef.current !== "speaking" && (!micMutedRef.current || pttOpenRef.current)) {
          setMode("listening");
          // Mark this segment open so the stuck-open watchdog can recover if
          // Silero never hands us an onSpeechEnd for it.
          speechOpenAtRef.current = performance.now();
        }
      },
      onSpeechEnd: (audio: Float32Array) => { vadDbgRef.current.ends++; speechOpenAtRef.current = null; console.debug("[vad] speechEnd len=" + audio.length); onTentativeEnd(audio); },
      onVADMisfire: () => {
        vadDbgRef.current.misfires++;
        speechOpenAtRef.current = null;
        console.debug("[vad] misfire");
        // The speech burst was too short to be real — cancel any pending barge-in.
        if (bargeTimerRef.current !== null) {
          window.clearTimeout(bargeTimerRef.current);
          bargeTimerRef.current = null;
          console.debug("[barge] candidate dropped (misfire)");
        }
      }
    });
    vadRef.current = vad;
    return vad;
  }, [getCtx, setMode, onTentativeEnd, triggerBargeIn]);

  // Arm the hands-free session. The gesture-gated work (resume AudioContext, open
  // the mic) runs first, synchronously off the click, so it keeps user activation;
  // only then do we load + start the (slow) VAD.
  const startSession = useCallback(async () => {
    if (sessionOnRef.current) return;
    if (!voiceAvailable) { flashError("voice", "No voice Fitting — station local-voice"); return; }
    if (!micCaptureAllowed()) { flashError("mic", "Mic needs https or localhost"); return; }
    setSessionOn(true);
    setMicMuted(false); // fresh sessions start hands-free (unmuted)
    setStandby(false);
    setMode("listening");
    // iOS audio unlock — MUST run synchronously inside this session-start tap,
    // before any await. Mobile Safari keeps the AudioContext suspended and blocks
    // audio started outside a user gesture. Resume the context and play a 1-frame
    // silent BufferSource now, under the tap, so the async reply's BufferSource
    // (see playNextInQueue) actually reaches the speaker.
    try {
      const ctx = getCtx();
      void ctx.resume();
      const blip = ctx.createBufferSource();
      blip.buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      blip.connect(ctx.destination);
      blip.start(0);
    } catch {}
    let stream: MediaStream;
    try {
      await getCtx().resume(); // must happen under user activation
      stream = await navigator.mediaDevices.getUserMedia({
        // autoGainControl OFF: on mobile the AGC ramps gain up during pauses,
        // lifting the room-noise floor back over Silero's negativeSpeechThreshold
        // so the redemption counter never fills and onSpeechEnd never fires — the
        // turn is stuck "listening" forever. Echo-cancellation + noise-suppression
        // stay on (they HELP end-detection and stop Jarvis hearing its own TTS).
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false }
      });
      micStreamRef.current = stream;
      try {
        const src = getCtx().createMediaStreamSource(stream);
        // Mic → analyser ONLY (never to ctx.destination, or it would echo).
        src.connect(ensureAnalyser(micAnalyserRef));
        micSourceRef.current = src;
      } catch {}
    } catch (e: any) {
      setSessionOn(false);
      flashError("mic", `Mic blocked: ${e?.message || e}`);
      return;
    }
    try {
      const vad = await ensureVad(stream);
      vadRunningRef.current = true;
      await vad.start();
    } catch (e: any) {
      setSessionOn(false);
      try { stream.getTracks().forEach((t) => t.stop()); } catch {}
      flashError("vad", `VAD load failed: ${e?.message || e}`);
    }
  }, [voiceAvailable, ensureVad, getCtx, ensureAnalyser, setMode, setSessionOn, setMicMuted, setStandby, flashError]);

  // Disarm the session: tear down the VAD and fully release the mic (so the
  // browser's recording indicator goes off). The next start rebuilds it.
  const stopSession = useCallback(async () => {
    setSessionOn(false);
    setMicMuted(false);
    setStandby(false);
    resetEndpointer(); // drop any turn still inside its grace window
    vadRunningRef.current = false;
    try { await vadRef.current?.destroy(); } catch {}
    vadRef.current = null;
    try { micSourceRef.current?.disconnect(); } catch {}
    micSourceRef.current = null;
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    micStreamRef.current = null;
    stopSpeech();
    if (idleTimerRef.current !== null) { window.clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    setMode("idle");
  }, [setSessionOn, setMicMuted, setStandby, setMode, stopSpeech, resetEndpointer]);
  useEffect(() => { stopSessionRef.current = stopSession; }, [stopSession]);

  // Mute toggle (M key / the mute button): stop listening to the room without
  // ending the session. Only meaningful with a live session. Muting pauses the
  // VAD; unmuting resumes hands-free listening.
  const toggleMute = useCallback(() => {
    if (!sessionOnRef.current) return;
    // Mute ONLY stops listening — it never cuts an in-flight reply. If Jarvis is
    // mid-turn (working/speaking) when you mute, let it finish thinking and speak
    // its answer; endTurnIfDone lands it in "muted" when the reply is done, so the
    // mic stays off for whatever you say next. To actually cut a reply, use
    // Space / tap (barge-in) — that's a separate action from muting the room.
    const busy = modeRef.current === "working" || modeRef.current === "speaking";
    const next = !micMutedRef.current;
    setMicMuted(next);
    pttOpenRef.current = false;      // an explicit M press ends any push-to-talk window
    if (next) {
      setStandby(false);            // mute wins over standby
      resetEndpointer();
      pauseVad();                    // stop hearing the room (also disables barge-in)
      if (!busy) setMode("muted");   // don't clobber an in-flight turn's visual state
    } else {
      resumeVad();                   // start hearing the room again
      if (!busy) setMode("listening");
    }
  }, [pauseVad, resumeVad, setMicMuted, setMode, resetEndpointer, setStandby]);

  // Single press = toggle the session. While Jarvis is speaking, a press is a
  // barge-in: cut the reply off but keep the session armed. While MUTED, a press
  // is push-to-talk: open the mic for one utterance (endTurnIfDone re-mutes when
  // the turn finishes), or cancel a push-to-talk window that is still open.
  const onToggle = useCallback(() => {
    if (modeRef.current === "speaking" || modeRef.current === "working") {
      // Manual barge-in: cut TTS AND any in-flight generation (same path as
      // talking over Jarvis), then return to listening / muted / idle.
      if (!cutAssistant()) { if (modeRef.current === "working") return; }
      if (!sessionOnRef.current) { setMode("idle"); return; }
      if (micMutedRef.current) { setMode("muted"); }        // stay muted after interrupt
      else { resumeVad(); setMode("listening"); }
      return;
    }
    if (sessionOnRef.current) {
      if (micMutedRef.current) {
        // push-to-talk while muted: open for one utterance, or cancel if already open
        if (modeRef.current === "listening") { pttOpenRef.current = false; resetEndpointer(); pauseVad(); setMode("muted"); }
        else { pttOpenRef.current = true; resumeVad(); setMode("listening"); }
        return;
      }
      // standby: a press is "wake up and talk", mirroring muted push-to-talk —
      // stopping entirely is a press while ACTIVE (or just stay in standby).
      if (standbyRef.current) { exitStandby(false); return; }
      void stopSession();
      return;
    }
    void startSession();
  }, [cutAssistant, resumeVad, pauseVad, setMode, stopSession, startSession, resetEndpointer, exitStandby]);

  // Space toggles the session / push-to-talk; M mutes the mic (ignore auto-repeat
  // and typing fields). Esc closes the report overlay.
  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      return Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable));
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat || isTypingTarget(e.target) || report) return;
      if (e.code === "Space") { e.preventDefault(); onToggle(); }
      else if (e.key === "m" || e.key === "M") { e.preventDefault(); toggleMute(); }
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { setReport(null); setDiff(null); setBoardUrl(null); retireSearch(); dockInfo(); } };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [onToggle, toggleMute, report]);

  // ── wake word "hey jarvis" + hands-free standby ──────────────────────────

  // Inactivity standby: an ACTIVE session sitting in "listening" with nothing
  // happening counts down and drops to standby — mic stays live, but only
  // "hey jarvis" (checked on-device against the local transcript) wakes it.
  // The countdown resets on every mode change (each turn passes through
  // working/speaking, each of which clears it).
  useEffect(() => {
    if (idleTimerRef.current !== null) { window.clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    if (mode !== "listening" || !sessionOn || standby) return;
    const ms = epCfgRef.current.idleTimeoutMs;
    if (ms <= 0) return;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      // re-check liveness — anything in flight means "not idle"
      if (!sessionOnRef.current || sendingRef.current || speakingRef.current ||
          speakQueueRef.current.length > 0 || pendingSegsRef.current.length > 0) return;
      pushCallout("standby", "Em standby por inatividade — diz “hey jarvis” para voltar.");
      enterStandby();
    }, ms);
    return () => {
      if (idleTimerRef.current !== null) { window.clearTimeout(idleTimerRef.current); idleTimerRef.current = null; }
    };
  }, [mode, sessionOn, standby, pushCallout, enterStandby]);

  // Wake events: subscribe to the voice Fitting's /events (relayed same-origin).
  // "hello" reports whether the wake word is armed server-side; "wake" while the
  // session is OFF arms hands-free listening — while it's on, it's ignored (and
  // standby never plays TTS, so Jarvis can't wake itself). Reconnects while the
  // page is open so a voice-Fitting restart re-arms transparently.
  useEffect(() => {
    if (!voiceAvailable) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let retry: number | null = null;
    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/voice/events`);
      } catch { retry = window.setTimeout(connect, 5000); return; }
      ws.onmessage = (e) => {
        let w: any;
        try { w = JSON.parse(e.data); } catch { return; }
        if (w?.type === "hello") { wakeArmedRef.current = Boolean(w.wake); setWakeArmed(Boolean(w.wake)); return; }
        if (w?.type !== "wake") return;
        // Server-side detection (host mic). Session in standby → wake it; no
        // session → start one; active session → the mic is live anyway.
        if (sessionOnRef.current) {
          if (standbyRef.current) { pushCallout("hey jarvis", "A ouvir…"); exitStandby(true); }
          return;
        }
        // The browser blocks audio until the page has been interacted with at
        // least once; getUserMedia itself is fine (permission is persisted).
        const ctx = getCtx();
        void ctx.resume().catch(() => {}).then(() => {
          if (ctx.state !== "running") {
            pushCallout("hey jarvis", "Toca no ecrã uma vez para ativar o áudio desta página.");
            return;
          }
          pushCallout("hey jarvis", "A ouvir…");
          void startSession();
        });
      };
      ws.onclose = () => { if (!closed) retry = window.setTimeout(connect, 5000); };
      ws.onerror = () => { try { ws?.close(); } catch {} };
    };
    connect();
    return () => {
      closed = true;
      if (retry !== null) window.clearTimeout(retry);
      try { ws?.close(); } catch {}
      wakeArmedRef.current = false;
      setWakeArmed(false);
    };
  }, [voiceAvailable, getCtx, startSession, pushCallout, exitStandby]);

  // Channel stream: speak a delegated Soul's reply when it lands asynchronously
  // (the orchestrator only acked the delegation, marked [delegated], unspoken).
  // The orchestrator's own output comes via /api/chat, so it's ignored here.
  useEffect(() => {
    if (!voiceAvailable) return;
    let es: EventSource | null = null;
    try { es = new EventSource("/api/stream"); } catch { return; }
    const onEvent = (e: MessageEvent) => {
      let w: any;
      try { w = JSON.parse(e.data); } catch { return; }
      const soul = w?.soul;
      if (!soul || soul === "garrison-orchestrator") return; // orchestrator → /api/chat
      const ev = w?.event;
      if (ev?.type !== "assistant") return;
      const text = (ev.message?.content ?? [])
        .filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
      const clean = stripMarkers(text);
      if (!clean) return;
      if (!hasInteractedRef.current) return; // safety: nothing before the user engages
      setTurns((prev) => [...prev.slice(-6), { id: genId("a"), role: "assistant", content: clean }]);
      pushCallout(soul, clean);
      // Full duplex: the VAD stays live during the Soul's TTS too — echo is
      // handled by the browser AEC + the barge-in confirmation gate, and
      // stray segments are dropped by onTentativeEnd's busy guard.
      spokenTextRef.current = "";
      speakingNowRef.current = "";
      enqueueSpeech(clean); // drains → endTurnIfDone re-arms
    };
    es.addEventListener("event", onEvent as EventListener);
    return () => { try { es?.close(); } catch {} };
  }, [voiceAvailable, enqueueSpeech, pushCallout]);

  // Active dev-session mirror: while a session is selected, subscribe to its rich
  // stream (dev-env's screen observer). `assistant {text}` is the FULL current
  // reply (replace-in-place), `turn {active}` drives the orb + fires speech once
  // when a command we sent completes. One stream at a time; re-opens on switch.
  useEffect(() => {
    if (!activeSessionId) return;
    let es: EventSource | null = null;
    try { es = new EventSource(`/api/dev-sessions/${encodeURIComponent(activeSessionId)}/stream`); } catch { return; }
    const onAssistant = (e: MessageEvent) => {
      let d: any;
      try { d = JSON.parse(e.data); } catch { return; }
      const text = typeof d?.text === "string" ? stripMarkers(d.text) : "";
      sessionReplyTextRef.current = text;
      const id = sessionBubbleRef.current;
      if (id) setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, content: text } : t)));
    };
    const onTurn = (e: MessageEvent) => {
      let d: any;
      try { d = JSON.parse(e.data); } catch { return; }
      if (d?.active) { setMode("working"); return; }
      // Turn went idle. If it's the completion of a command we just sent, speak
      // the reply once and re-arm; a plain idle (e.g. right after switching) is
      // silent so we never re-speak a session's stale screen.
      if (awaitingSessionReplyRef.current) {
        awaitingSessionReplyRef.current = false;
        const reply = sessionReplyTextRef.current.trim();
        setMode("idle");
        if (reply) { pushCallout("sessão", reply); enqueueSpeech(reply); }
        else endTurnIfDone();
      } else {
        setMode("idle");
      }
    };
    es.addEventListener("assistant", onAssistant as EventListener);
    es.addEventListener("turn", onTurn as EventListener);
    return () => { try { es?.close(); } catch {} };
  }, [activeSessionId, setMode, enqueueSpeech, pushCallout, endTurnIfDone]);

  useEffect(() => () => {
    try { void vadRef.current?.destroy(); } catch {}
    try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch {}
    try { audioElRef.current?.pause(); } catch {}
    try { audioCtxRef.current?.close(); } catch {}
  }, []);

  const statusLabel = !voiceAvailable
    ? "No voice Fitting — station local-voice"
    : sessionOn && standby ? "Standby — diz “hey jarvis” para acordar (Space/tap: falar já)"
    : mode === "muted" ? "Muted — não ouço a sala (Space/tap: falar uma vez · M: sair do mute)"
    : mode === "listening" ? (micMuted
        ? "A ouvir a tua pergunta… (Space/tap: cancelar)"
        : "Listening… (fala; a pausa envia · Space/tap: parar · M: mute)")
    : mode === "working" ? "Thinking…"
    : mode === "speaking" ? "Speaking… (Space/tap: interromper · M: mute)"
    : mode === "error" ? "Error"
    : micCaptureAllowed()
      ? (wakeArmed ? "Diz “hey jarvis” (ou Space / tap) para começar" : "Press Space (or tap the core) to start talking")
      : "Mic needs https or localhost";

  return (
    <div className={`jarvis-root state-${mode}${sessionOn ? " session-on" : ""}${panelsOpen ? " panels-open" : ""}`}>
      <div
        className="jarvis-core"
        onClick={onToggle}
        role="button"
        aria-pressed={sessionOn}
        aria-label={sessionOn ? "Stop voice session" : "Start voice session"}
      >
        <GraphCore mode={mode} getLevel={getLevel} bgMode="flat" />
      </div>

      <div className="jarvis-status" data-state={mode}>
        <span className={`jarvis-dot ${mode}`} />
        <span className="jarvis-status-text">{statusLabel}</span>
      </div>


      {debugOn && (
        <pre className="jarvis-debug" data-tick={dbgTick}>
{`mode:${mode}  sr:${audioCtxRef.current?.sampleRate ?? "?"}  ctx:${audioCtxRef.current?.state ?? "?"}  vad:${vadRunningRef.current ? "RUN" : "off"}  mut:${micMutedRef.current ? "Y" : "n"}  ptt:${pttOpenRef.current ? "Y" : "n"}
start:${vadDbgRef.current.starts}  end:${vadDbgRef.current.ends}  mis:${vadDbgRef.current.misfires}  snd:${vadDbgRef.current.sends}  eot:${vadDbgRef.current.eot}
tts:ok${vadDbgRef.current.ttsOk}/err${vadDbgRef.current.ttsErr}   stt:"${vadDbgRef.current.lastStt}"`}
        </pre>
      )}

      {/* Phone-only: reveal / hide the flank panels so the orb owns the screen
          by default. Hidden on desktop (the media query un-hides it). */}
      <button
        className={`jarvis-panels-toggle${panelsOpen ? " is-open" : ""}`}
        onClick={() => setPanelsOpen((v) => !v)}
        aria-pressed={panelsOpen}
        aria-label={panelsOpen ? "Esconder painéis" : "Mostrar painéis"}
      >
        {panelsOpen ? "✕" : "☰"}
      </button>

      {sessionOn && (
        <button
          className={`jarvis-mute${micMuted ? " is-muted" : ""}`}
          onClick={toggleMute}
          aria-pressed={micMuted}
          aria-label={micMuted ? "Unmute microphone (M)" : "Mute microphone (M)"}
          title={micMuted
            ? "Muted — Jarvis não ouve a sala. Space/tap para falar uma vez. (M)"
            : "Mute o mic para falar com outras pessoas sem ativar o Jarvis (M)"}
        >
          <span className="jarvis-mute-icon">{micMuted ? "🔇" : "🎙"}</span>
          <span className="jarvis-mute-label">{micMuted ? "muted" : "mic on"}</span>
        </button>
      )}

      {/* Reply-verbosity dial — 5 stops, persists, rides along as a hidden
          directive on each sent turn. Bottom-left mirror of the mute pill. */}
      <div className="jarvis-verbosity" title="Nível de detalhe das respostas">
        <span className="jarvis-verbosity-head">resposta</span>
        <div className="jarvis-verbosity-track" role="radiogroup" aria-label="Nível de detalhe da resposta">
          {VERBOSITY.map((v, i) => (
            <button
              key={v.key}
              className={`jarvis-verbosity-stop${i <= verbosity ? " is-filled" : ""}${i === verbosity ? " is-active" : ""}`}
              onClick={() => setVerbosity(i)}
              role="radio"
              aria-checked={i === verbosity}
              aria-label={`resposta ${v.label}`}
              title={v.label}
            />
          ))}
        </div>
        <span className="jarvis-verbosity-value">{VERBOSITY[verbosity].label}</span>
      </div>

      {/* Left rail — a single flex column so NOW / Operative / transcript
          stack deterministically and can never overlap, however tall each grows. */}
      <div className="jarvis-rail jarvis-rail-left">
        {activity.length > 0 && (
          <div className="jarvis-activity" data-state={mode}>
            <span className="jarvis-activity-head">NOW</span>
            {activity.map((a) => (
              <div key={a.id} className="jarvis-activity-row">
                <span className="jarvis-activity-dot" />
                <span className="jarvis-activity-tool">{toolVerb(a.tool)}</span>
                {a.detail ? <span className="jarvis-activity-detail">{a.detail}</span> : null}
              </div>
            ))}
          </div>
        )}

        {operative && (
          <aside className={`jarvis-workspace jarvis-operative${opOpen ? "" : " is-collapsed"}`}>
            <button
              className="jarvis-ws-head"
              onClick={() => setOpOpen((v) => !v)}
              aria-expanded={opOpen}
              title={opOpen ? "Collapse operative panel" : "Expand operative panel"}
            >
              <span className="jarvis-ws-title">operative</span>
              <span className={`jarvis-op-health${operative.gateway.ok ? " is-ok" : ""}`}>
                {operative.gateway.ok ? "online" : "offline"}
              </span>
              <span className="jarvis-ws-toggle">{opOpen ? "−" : "+"}</span>
            </button>
            {opOpen && (
              <div className="jarvis-ws-body">
                <div className="jarvis-ws-section">
                  <span className="jarvis-ws-label">runtime</span>
                  <span className="jarvis-ws-row">
                    <span className={`jarvis-op-dot${operative.gateway.ok ? " is-ok" : ""}`} />
                    <span className="jarvis-ws-key">gateway</span>
                    <span className="jarvis-ws-text">
                      {operative.gateway.ok
                        ? `${operative.gateway.mode ?? "?"} · ${operative.gateway.sessions ?? 0} sess · ${operative.gateway.channels ?? 0} ch`
                        : "down"}
                    </span>
                    {operative.gateway.ok && operative.gateway.uptimeMs
                      ? <span className="jarvis-ws-when">{fmtUptime(operative.gateway.uptimeMs)}</span>
                      : null}
                  </span>
                  <span className="jarvis-ws-row">
                    <span className={`jarvis-op-dot${operative.voice.ok ? " is-ok" : ""}`} />
                    <span className="jarvis-ws-key">voice</span>
                    <span className="jarvis-ws-text">
                      {operative.voice.ok
                        ? `${operative.voice.ready ? "ready" : "warming"}${wakeArmed ? " · wake armado" : ""}`
                        : "down"}
                    </span>
                  </span>
                </div>
                {devAvailable && (
                  <div className="jarvis-ws-section">
                    <span className="jarvis-ws-label jarvis-sess-head">
                      <span>sessões</span>
                      <button
                        className="jarvis-sess-new"
                        onClick={() => void createDevSession()}
                        title="Criar uma nova sessão Claude no projeto ativo"
                      >
                        + nova
                      </button>
                    </span>
                    {activeSessionId ? (
                      <button
                        className="jarvis-ws-row jarvis-sess-row is-orchestrator"
                        onClick={() => setActiveSessionId(null)}
                        title="Voltar ao orquestrador"
                      >
                        <span className="jarvis-op-dot" />
                        <span className="jarvis-ws-key">↩</span>
                        <span className="jarvis-ws-text">orquestrador</span>
                      </button>
                    ) : (
                      <span className="jarvis-ws-row is-standby">
                        <span className="jarvis-op-dot is-ok" />
                        <span className="jarvis-ws-key">▶</span>
                        <span className="jarvis-ws-text">orquestrador</span>
                        <span className="jarvis-ws-when">ativo</span>
                      </span>
                    )}
                    {devSessions.length === 0 ? (
                      <span className="jarvis-ws-row is-standby">
                        <span className="jarvis-ws-text jarvis-ws-muted">sem sessões — diz “cria uma sessão”</span>
                      </span>
                    ) : (() => {
                      // Same honest split as the phone drawer: only sessions the
                      // dev-env drives (a running Claude PTY) accept /instruct;
                      // hook-autocreated "external" ones are observed read-only.
                      const commandable = devSessions.filter(devSessionCommandable);
                      const observed = devSessions.filter((s) => !devSessionCommandable(s));
                      return (
                        <>
                          {commandable.slice(0, 6).map((s, i) => {
                            const active = s.id === activeSessionId;
                            const working = devSessionWorking(s);
                            return (
                              <button
                                key={s.id}
                                className={`jarvis-ws-row jarvis-sess-row${active ? " is-active" : ""}`}
                                onClick={() => toggleSession(s.id)}
                                title={active ? "Sessão ativa — clica para voltar ao orquestrador" : "Falar com esta sessão"}
                              >
                                <span className={`jarvis-op-dot${working ? " is-ok" : ""}`} />
                                <span className="jarvis-ws-key">{i + 1}</span>
                                <span className="jarvis-ws-text">{devSessionName(s)}</span>
                                <span className="jarvis-sess-tag">#{devSessionTag(s)}</span>
                                <span className="jarvis-ws-when">{active ? "ativa" : (working ? "working" : (s.lastStatus || ""))}</span>
                              </button>
                            );
                          })}
                          {commandable.length === 0 && (
                            <span className="jarvis-ws-row is-standby">
                              <span className="jarvis-ws-text jarvis-ws-muted">nenhuma gerida pelo Jarvis — “+ nova” cria uma</span>
                            </span>
                          )}
                          {observed.length > 0 && (
                            <>
                              <span className="jarvis-ws-subrow">observadas · só leitura</span>
                              {observed.slice(0, 6).map((s) => {
                                const working = devSessionWorking(s);
                                return (
                                  <span
                                    key={s.id}
                                    className="jarvis-ws-row jarvis-sess-row is-observed"
                                    title="Claude a correr no repo fora do Jarvis (terminal / orquestrador / HUD). Só leitura — não dá para lhe falar daqui."
                                  >
                                    <span className={`jarvis-op-dot${working ? " is-ok" : ""}`} />
                                    <span className="jarvis-ws-key jarvis-sess-eye">◦</span>
                                    <span className="jarvis-ws-text">{devSessionName(s)}</span>
                                    <span className="jarvis-sess-tag">#{devSessionTag(s)}</span>
                                    <span className="jarvis-ws-when">{working ? "working" : (s.lastStatus || "")}</span>
                                  </span>
                                );
                              })}
                            </>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
                {(operative.souls.length > 0 || sessions.length > 0) && (
                  <div className="jarvis-ws-section">
                    <span className="jarvis-ws-label">agents</span>
                    {sessions
                      .filter((s) => !operative.souls.some((n) => s.soul === n || s.soul === `soul-${n}`))
                      .slice(0, 4)
                      .map((s) => (
                        <span key={s.session_id} className="jarvis-ws-row">
                          <span className="jarvis-op-dot is-ok" />
                          <span className="jarvis-ws-key">{s.status}</span>
                          <span className="jarvis-ws-text">{s.soul}</span>
                        </span>
                      ))}
                    {operative.souls.map((name) => {
                      const live = soulIsLive(name, sessions);
                      return (
                        <span key={name} className={`jarvis-ws-row${live ? "" : " is-standby"}`}>
                          <span className={`jarvis-op-dot${live ? " is-ok" : ""}`} />
                          <span className="jarvis-ws-key">{live ? "live" : "standby"}</span>
                          <span className="jarvis-ws-text">{name}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
                {(operative.skills.length > 0 || operative.commands.length > 0) && (
                  <div className="jarvis-ws-section">
                    <span className="jarvis-ws-label">skills</span>
                    {operative.skills.map((name) => (
                      <span key={`sk-${name}`} className="jarvis-ws-row">
                        <span className="jarvis-ws-key">skill</span>
                        <span className="jarvis-ws-text">{name}</span>
                      </span>
                    ))}
                    {operative.commands.map((name) => (
                      <span key={`cmd-${name}`} className="jarvis-ws-row">
                        <span className="jarvis-ws-key">cmd</span>
                        <span className="jarvis-ws-text">/{name}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </aside>
        )}

        <div className="jarvis-transcript" ref={transcriptRef}>
          {turns.map((t) => (
            <div key={t.id} className={`jarvis-turn ${t.role}`}>
              <span className="jarvis-turn-role">{t.role === "user" ? "you" : t.role === "error" ? "!" : "jarvis"}</span>
              {t.role === "assistant" && t.content
                ? <div className="jarvis-turn-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.content) }} />
                : <span className="jarvis-turn-text">{t.content || (t.role === "assistant" ? "…" : "")}</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Right rail — callouts + Workspace, same non-overlapping flex column. */}
      <div className="jarvis-rail jarvis-rail-right">
        {/* Info widget (Calendar / Gmail / Trello) — opened by reply markers,
            shows the data while the spoken answer stays short. */}
        {infoWidget ? <InfoDock widget={infoWidget} onClose={() => setInfoWidget(null)} /> : null}
        {/* Docked web searches of the current turn — cards tethered to the orb
            by the fixed SVG layer SearchDock renders alongside. */}
        <SearchDock
          searches={searches.filter((s) => s.docked)}
          onDismiss={(id) => setSearches((prev) => prev.filter((s) => s.id !== id))}
        />
        <div className="jarvis-callouts">
          {callouts.map((c) => (
            <button key={c.id} className="jarvis-callout" onClick={() => setReport({ path: c.label, content: c.content })}>
              <span className="jarvis-callout-dot" />
              <span className="jarvis-callout-label">{c.label}</span>
              <span className="jarvis-callout-text">{c.content.slice(0, 120)}</span>
            </button>
          ))}
        </div>

        {kanban?.available && (kanban.cards?.length ?? 0) > 0 && (
          <aside className={`jarvis-workspace jarvis-tasks${tasksOpen ? "" : " is-collapsed"}`}>
            <button
              className="jarvis-ws-head"
              onClick={() => setTasksOpen((v) => !v)}
              aria-expanded={tasksOpen}
              title={tasksOpen ? "Collapse tasks panel" : "Expand tasks panel"}
            >
              <span className="jarvis-ws-title">tarefas</span>
              <span className="jarvis-ws-branch">
                {kanban.counts!.total}{kanban.counts!.running > 0 ? ` · ${kanban.counts!.running} a correr` : ""}
              </span>
              <span className="jarvis-ws-toggle">{tasksOpen ? "−" : "+"}</span>
            </button>
            {tasksOpen && (
              <div className="jarvis-ws-body">
                <div className="jarvis-ws-section">
                  {kanban.cards!.map((c) => {
                    const url = cardHref(kanban, c.id);
                    const statusClass = c.status === "needs-attention" ? "attention" : c.status === "running" ? "running" : "ok";
                    const inner = (
                      <>
                        <span className={`jarvis-task-pill jarvis-task-pill--${statusClass}`} />
                        <span className="jarvis-task-main">
                          <span className="jarvis-task-title">{c.title}</span>
                          <span className="jarvis-task-status">{c.statusLine}</span>
                        </span>
                      </>
                    );
                    return url ? (
                      <a key={c.id} className="jarvis-ws-row jarvis-task-row" href={url} target="_blank" rel="noreferrer" title={`${c.title} — ${c.statusLine}`}
                        onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); setBoardUrl(url); } }}>
                        {inner}
                      </a>
                    ) : (
                      <span key={c.id} className="jarvis-ws-row jarvis-task-row" title={`${c.title} — ${c.statusLine}`}>
                        {inner}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </aside>
        )}

        {project?.available ? (
          <aside className={`jarvis-workspace${wsOpen ? "" : " is-collapsed"}`}>
          <button
            className="jarvis-ws-head"
            onClick={() => setWsOpen((v) => !v)}
            aria-expanded={wsOpen}
            title={wsOpen ? "Collapse workspace panel" : "Expand workspace panel"}
          >
            <span className="jarvis-ws-title">{project.name || "workspace"}</span>
            <span className="jarvis-ws-branch">{project.branch || "—"}</span>
            {project.activeSource === "session" ? (
              <span className="jarvis-ws-when">a seguir sessão</span>
            ) : project.activeSource === "last" ? (
              <span className="jarvis-ws-when">último projeto</span>
            ) : null}
            {(project.ahead ?? 0) > 0 || (project.behind ?? 0) > 0 ? (
              <span className="jarvis-ws-sync">
                {(project.ahead ?? 0) > 0 ? `↑${project.ahead}` : ""}
                {(project.behind ?? 0) > 0 ? `↓${project.behind}` : ""}
              </span>
            ) : null}
            <span className="jarvis-ws-toggle">{wsOpen ? "−" : "+"}</span>
          </button>
          {wsOpen && (
            <div className="jarvis-ws-body">
              {(project.changed ?? 0) > 0 && (
                <div className="jarvis-ws-section">
                  <span className="jarvis-ws-label">uncommitted</span>
                  <button
                    className="jarvis-ws-row jarvis-ws-diff"
                    onClick={async () => {
                      try {
                        const d = await fetch("/api/diff").then((r) => r.json());
                        setDiff({
                          title: `git diff HEAD · ${project.changed} changed`,
                          patch: (d?.patch || "").trim(),
                          truncated: Boolean(d?.truncated)
                        });
                      } catch { /* leave the panel as-is on a failed fetch */ }
                    }}
                    title="Ver o diff da working tree (git diff HEAD)"
                  >
                    <span className="jarvis-ws-key">diff</span>
                    <span className="jarvis-ws-text">{project.changed} ficheiro{project.changed === 1 ? "" : "s"} — ver</span>
                  </button>
                </div>
              )}
              {(project.prs?.length ?? 0) > 0 && (
                <div className="jarvis-ws-section">
                  <span className="jarvis-ws-label">pull requests</span>
                  {project.prs!.map((pr) => (
                    <a key={pr.number} className="jarvis-ws-row" href={pr.url} target="_blank" rel="noreferrer">
                      <span className="jarvis-ws-key">#{pr.number}</span>
                      <span className="jarvis-ws-text">{pr.title}</span>
                    </a>
                  ))}
                </div>
              )}
              {(project.commits?.length ?? 0) > 0 && (
                <div className="jarvis-ws-section">
                  <span className="jarvis-ws-label">commits</span>
                  {project.commits!.map((c) =>
                    project.remoteUrl ? (
                      <a key={c.hash} className="jarvis-ws-row" href={`${project.remoteUrl}/commit/${c.hash}`} target="_blank" rel="noreferrer" title={`${c.subject} — ${c.author}, ${c.when}`}>
                        <span className="jarvis-ws-key">{c.hash}</span>
                        <span className="jarvis-ws-text">{c.subject}</span>
                        <span className="jarvis-ws-when">{c.when}</span>
                      </a>
                    ) : (
                      <span key={c.hash} className="jarvis-ws-row" title={`${c.subject} — ${c.author}, ${c.when}`}>
                        <span className="jarvis-ws-key">{c.hash}</span>
                        <span className="jarvis-ws-text">{c.subject}</span>
                        <span className="jarvis-ws-when">{c.when}</span>
                      </span>
                    )
                  )}
                </div>
              )}
              {worktrees.length > 0 && (
                <div className="jarvis-ws-section">
                  <span className="jarvis-ws-label">worktrees</span>
                  {worktrees.slice(0, 5).map((w, i) => (
                    <span key={w.id ?? i} className="jarvis-ws-row">
                      <span className="jarvis-ws-key">{w.branch || w.id || "?"}</span>
                      <span className="jarvis-ws-text">{w.title || w.path || ""}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      ) : project && project.activeSource === "none" ? (
        // No dev session running and no prior project — a calm placeholder
        // instead of falling back to Jarvis's own repo.
        <aside className="jarvis-workspace">
          <div className="jarvis-ws-head jarvis-ws-empty">
            <span className="jarvis-ws-title">workspace</span>
            <span className="jarvis-ws-when">sem projeto ativo</span>
          </div>
        </aside>
      ) : null}
      </div>

      <div className="jarvis-dock">
        {DOCK_ACTIONS.map((a) => (
          <button
            key={a.label}
            className="jarvis-dock-btn"
            onClick={() => void dispatch(a.prompt, a.label)}
            disabled={mode === "working"}
            title={a.prompt}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* ── Phone drawer (mobile-only via CSS) ────────────────────────────────
          A left-sliding panel (transform-based → GPU-composited, no reflow) that
          owns everything the desktop rails hold: session create/switch, the dev
          action buttons, operative health, reports and tasks. The scrim + drawer
          are always mounted so the open/close transition runs both ways; the
          `.panels-open` class on the root drives the slide. Any action closes it
          so the orb + conversation return to view. */}
      <div
        className="jarvis-drawer-scrim"
        onClick={closeDrawer}
        aria-hidden={!panelsOpen}
      />
      <aside className="jarvis-drawer" aria-hidden={!panelsOpen}>
        <div className="jarvis-drawer-scroll">
          {/* sessions — split into two honest groups:
              · comandáveis: the dev-env drives a live Claude PTY → tappable, /instruct works.
              · observadas:  external Claude processes it only watches via hooks → read-only.
              Each row carries a 4-char id tag so same-repo sessions are distinguishable. */}
          {(() => {
            const commandable = devSessions.filter(devSessionCommandable);
            const observed = devSessions.filter((s) => !devSessionCommandable(s));
            return (
              <section className="jarvis-drawer-sec">
                <h3 className="jarvis-drawer-head">sessões</h3>
                <button
                  className="jarvis-drawer-primary"
                  onClick={() => { void createDevSession(); closeDrawer(); }}
                  disabled={!devAvailable}
                  title="Criar uma nova sessão Claude que o Jarvis comanda"
                >
                  <span className="jarvis-drawer-primary-plus">+</span>
                  <span>nova sessão</span>
                </button>

                <button
                  className={`jarvis-drawer-sess${activeSessionId ? "" : " is-active"}`}
                  onClick={() => { setActiveSessionId(null); closeDrawer(); }}
                  title="Falar com o orquestrador"
                >
                  <span className="jarvis-drawer-sess-badge">▶</span>
                  <span className="jarvis-drawer-sess-name">orquestrador</span>
                  <span className="jarvis-drawer-sess-meta">{activeSessionId ? "" : "ativo"}</span>
                </button>

                {commandable.slice(0, 8).map((s, i) => {
                  const active = s.id === activeSessionId;
                  const working = devSessionWorking(s);
                  return (
                    <button
                      key={s.id}
                      className={`jarvis-drawer-sess${active ? " is-active" : ""}`}
                      onClick={() => { toggleSession(s.id); closeDrawer(); }}
                      title={active ? "Sessão ativa — toca para voltar ao orquestrador" : "Falar com esta sessão"}
                    >
                      <span className={`jarvis-drawer-sess-dot${working ? " is-working" : ""}`} />
                      <span className="jarvis-drawer-sess-badge">{i + 1}</span>
                      <span className="jarvis-drawer-sess-name">{devSessionName(s)}</span>
                      <span className="jarvis-drawer-sess-tag">#{devSessionTag(s)}</span>
                      <span className="jarvis-drawer-sess-meta">{active ? "ativa" : (working ? "working" : (s.lastStatus || ""))}</span>
                    </button>
                  );
                })}
                {devAvailable && commandable.length === 0 && (
                  <p className="jarvis-drawer-empty">Nenhuma sessão gerida pelo Jarvis. Toca “+ nova” (ou diz “cria uma sessão”) para uma que ele comanda.</p>
                )}

                {observed.length > 0 && (
                  <>
                    <p className="jarvis-drawer-subhead">observadas · o Jarvis só vê</p>
                    {observed.slice(0, 8).map((s) => {
                      const working = devSessionWorking(s);
                      return (
                        <div
                          key={s.id}
                          className="jarvis-drawer-sess is-observed"
                          title="Claude a correr no repo fora do Jarvis (terminal / orquestrador / a HUD). Só leitura — não dá para lhe falar daqui."
                        >
                          <span className={`jarvis-drawer-sess-dot${working ? " is-working" : ""}`} />
                          <span className="jarvis-drawer-sess-badge jarvis-drawer-sess-eye">◦</span>
                          <span className="jarvis-drawer-sess-name">{devSessionName(s)}</span>
                          <span className="jarvis-drawer-sess-tag">#{devSessionTag(s)}</span>
                          <span className="jarvis-drawer-sess-meta">{working ? "working" : (s.lastStatus || "")}</span>
                        </div>
                      );
                    })}
                    <p className="jarvis-drawer-empty">Processos Claude vivos no repo, iniciados fora do Jarvis. Ficam aqui para veres o que corre — usa “+ nova” para uma que ele comande.</p>
                  </>
                )}
              </section>
            );
          })()}

          {/* dev actions — the former desktop dock, now full-size tappable buttons */}
          <section className="jarvis-drawer-sec">
            <h3 className="jarvis-drawer-head">ações</h3>
            <div className="jarvis-drawer-actions">
              {DOCK_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  className="jarvis-drawer-action"
                  onClick={() => { void dispatch(a.prompt, a.label); closeDrawer(); }}
                  disabled={mode === "working"}
                  title={a.prompt}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </section>

          {/* operative health */}
          {operative && (
            <section className="jarvis-drawer-sec">
              <h3 className="jarvis-drawer-head">
                <span>operative</span>
                <span className={`jarvis-drawer-health${operative.gateway.ok ? " is-ok" : ""}`}>
                  {operative.gateway.ok ? "online" : "offline"}
                </span>
              </h3>
              <div className="jarvis-drawer-stat">
                <span className={`jarvis-op-dot${operative.gateway.ok ? " is-ok" : ""}`} />
                <span className="jarvis-drawer-stat-k">gateway</span>
                <span className="jarvis-drawer-stat-v">
                  {operative.gateway.ok
                    ? `${operative.gateway.mode ?? "?"} · ${operative.gateway.sessions ?? 0} sess`
                    : "down"}
                </span>
              </div>
              <div className="jarvis-drawer-stat">
                <span className={`jarvis-op-dot${operative.voice.ok ? " is-ok" : ""}`} />
                <span className="jarvis-drawer-stat-k">voice</span>
                <span className="jarvis-drawer-stat-v">
                  {operative.voice.ok ? (operative.voice.ready ? "ready" : "warming") : "down"}
                </span>
              </div>
            </section>
          )}

          {/* workspace — the active project's branch + diff + PRs (compact) */}
          {project?.available && (
            <section className="jarvis-drawer-sec">
              <h3 className="jarvis-drawer-head">
                <span>{project.name || "workspace"}</span>
                <span className="jarvis-drawer-head-meta">{project.branch || "—"}</span>
              </h3>
              {(project.changed ?? 0) > 0 && (
                <button
                  className="jarvis-drawer-stat is-btn"
                  onClick={async () => {
                    try {
                      const d = await fetch("/api/diff").then((r) => r.json());
                      setDiff({
                        title: `git diff HEAD · ${project.changed} changed`,
                        patch: (d?.patch || "").trim(),
                        truncated: Boolean(d?.truncated)
                      });
                      closeDrawer();
                    } catch { /* leave the drawer open on a failed fetch */ }
                  }}
                  title="Ver o diff da working tree (git diff HEAD)"
                >
                  <span className="jarvis-drawer-stat-k">diff</span>
                  <span className="jarvis-drawer-stat-v">{project.changed} ficheiro{project.changed === 1 ? "" : "s"} — ver</span>
                </button>
              )}
              {(project.prs?.length ?? 0) > 0 && project.prs!.slice(0, 3).map((pr) => (
                <a key={pr.number} className="jarvis-drawer-stat" href={pr.url} target="_blank" rel="noreferrer">
                  <span className="jarvis-drawer-stat-k">#{pr.number}</span>
                  <span className="jarvis-drawer-stat-v">{pr.title}</span>
                </a>
              ))}
            </section>
          )}

          {/* reports (callouts) */}
          {callouts.length > 0 && (
            <section className="jarvis-drawer-sec">
              <h3 className="jarvis-drawer-head">relatórios</h3>
              {callouts.map((c) => (
                <button
                  key={c.id}
                  className="jarvis-drawer-callout"
                  onClick={() => { setReport({ path: c.label, content: c.content }); closeDrawer(); }}
                >
                  <span className="jarvis-drawer-callout-label">{c.label}</span>
                  <span className="jarvis-drawer-callout-text">{c.content.slice(0, 100)}</span>
                </button>
              ))}
            </section>
          )}

          {/* tasks (kanban) */}
          {kanban?.available && (kanban.cards?.length ?? 0) > 0 && (
            <section className="jarvis-drawer-sec">
              <h3 className="jarvis-drawer-head">
                <span>tarefas</span>
                <span className="jarvis-drawer-head-meta">
                  {kanban.counts!.total}{kanban.counts!.running > 0 ? ` · ${kanban.counts!.running} a correr` : ""}
                </span>
              </h3>
              {kanban.cards!.map((c) => {
                const url = cardHref(kanban, c.id);
                const statusClass = c.status === "needs-attention" ? "attention" : c.status === "running" ? "running" : "ok";
                return (
                  <button
                    key={c.id}
                    className="jarvis-drawer-task"
                    onClick={() => { if (url) setBoardUrl(url); closeDrawer(); }}
                    title={`${c.title} — ${c.statusLine}`}
                  >
                    <span className={`jarvis-task-pill jarvis-task-pill--${statusClass}`} />
                    <span className="jarvis-drawer-task-main">
                      <span className="jarvis-drawer-task-title">{c.title}</span>
                      <span className="jarvis-drawer-task-status">{c.statusLine}</span>
                    </span>
                  </button>
                );
              })}
            </section>
          )}
        </div>
      </aside>

      {(() => {
        // Centre reveal: the one search still typing/searching (docked runs
        // render as tethered cards inside the right rail, see SearchDock above).
        const center = searches.find((s) => !s.docked);
        return center ? (
          <SearchOverlay
            key={center.id}
            query={center.query}
            fetches={center.fetches}
            leaving={center.leaving}
            onClose={retireSearch}
          />
        ) : null;
      })()}
      {/* Ambient mode — idle smart-display over the orb (z below the reveals,
          above the rails). Any pointer/key/voice interaction dismisses it. */}
      {ambientOn ? (
        <AmbientMode
          data={ambientData}
          music={music}
          operative={operative}
          idleSince={lastActivityRef.current}
          nextTickAt={ambientTickAt}
          onMusicCmd={musicCmd}
          onDismiss={() => setAmbientOn(false)}
        />
      ) : null}
      {/* Centre-stage info reveal (Calendar/Gmail/Trello) — plays over the orb
          while the answer is spoken, then flies right into the rail dock. */}
      {infoCenter ? <InfoOverlay widget={infoCenter} leaving={infoLeaving} onDock={dockInfo} /> : null}
      {/* In-HUD YouTube player — persists across turns (background music);
          only its × closes it, deliberately NOT Esc. */}
      {ytPlay ? <YouTubeWidget play={ytPlay} onClose={() => setYtPlay(null)} /> : null}
      {/* Spotify now-playing — shows whenever a track is loaded; × silences it
          until the track changes. */}
      {!ambientOn && music?.available && music.track && musicDismissed !== music.track ? (
        <MusicWidget music={music} onCmd={musicCmd} onClose={() => setMusicDismissed(music.track ?? null)} />
      ) : null}
      {report ? <ReportOverlay report={report} onClose={() => setReport(null)} /> : null}
      {diff ? <DiffOverlay title={diff.title} patch={diff.patch} truncated={diff.truncated} onClose={() => setDiff(null)} /> : null}
      {boardUrl ? <KanbanOverlay url={boardUrl} onClose={() => setBoardUrl(null)} /> : null}
    </div>
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<App />);
}
