// Web Channel UI — the ONE generic, context-driven chat surface, now with a
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
//   • Rich operative console (explicit ?console=1) - the same component against
//     the gateway's live /claude/* PTY surface. The operative test interface.
//
// The channel stays generic: a `thread` is an OPAQUE key + optional title a host
// (Kanban / Automations) puts on the query string. The channel never interprets
// it — it just persists turns under it and lists them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Marked } from "marked";
import {
  ClaudeChat,
  createHttpTransport,
  type ChatEvent,
  type ChatTransport,
  type ChatSendMeta,
} from "@garrison/claude-chat";

// A private marked instance for the brief PREVIEW (kept separate from the chat's).
const briefMd = new Marked({ breaks: true, gfm: true });

// Pull the absolute brief path out of the Discuss context a host handed us. The
// context arrives as a JSON string (decodeContext) or an already-parsed object; the
// host (Kanban / Automations) sets `briefAbsPath` to the brief file's absolute path.
// Returns undefined when absent — the Brief button then simply doesn't show.
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

// ── Generic context/mode/thread from the URL ───────────────────────────────
function decodeContext(raw: string | null): unknown {
  if (!raw) return undefined;
  if (typeof atob === "function" && typeof btoa === "function") {
    try {
      const bytes = atob(raw);
      if (btoa(bytes) === raw) {
        try { return decodeURIComponent(escape(bytes)); } catch { return bytes; }
      }
    } catch {
      /* not base64 — forward verbatim */
    }
  }
  return raw;
}

interface UrlState {
  context: unknown;
  mode: string | undefined;
  kickoff: string | undefined;
  thread: string | undefined;
  title: string | undefined;
  returnUrl: string | undefined;
  returnLabel: string | undefined;
  /** Explicit ?console=1 - mount the raw PTY operative console instead of the
   *  threaded surface. */
  console: boolean;
}

// Return to whatever page the user came from (the board / Automations), robust across
// every access mode — the web channel is reached at its OWN port (127.0.0.1:7083), via
// Garrison's /embed proxy (127.0.0.1:7777), or over the tailnet, and the host's URL
// differs in each. history.back() returns to the previous page regardless of its URL,
// so we never guess a route (an earlier version hard-coded "/embed/kanban-loop", which
// 404'd → SPA-fell-back to the default console when opened directly on :7083). Prefer the
// TOP window when it's same-origin (Garrison embed); fall back to this window (direct
// access — the common case) if the top is cross-origin or is this window.
function goBackToHost(): void {
  let w: Window = window;
  try {
    if (window.top && window.top !== window.self && typeof window.top.location.href === "string") {
      w = window.top;
    }
  } catch {
    w = window; // cross-origin top — can't drive it; use our own history
  }
  w.history.back();
}

function readUrl(): UrlState {
  if (typeof window === "undefined") {
    return { context: undefined, mode: undefined, kickoff: undefined, thread: undefined, title: undefined, returnUrl: undefined, returnLabel: undefined, console: false };
  }
  const q = new URLSearchParams(window.location.search);
  const modeRaw = q.get("mode");
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
  return {
    context: decodeContext(q.get("context")),
    mode: modeRaw && modeRaw.trim() ? modeRaw.trim() : undefined,
    kickoff,
    thread,
    title,
    returnUrl,
    returnLabel,
    console: q.get("console") === "1",
  };
}

// ── Context-aware transport (orchestrator path) ─────────────────────────────
// `threadId` identifies the conversation this transport serves; it rides every
// POST /api/chat body so the SERVER can persist the exchange into the thread
// when the upstream `done` event arrives (survives navigation/tab-close mid-turn).
function createOrchestratorTransport(base = "/api", threadId?: string): ChatTransport {
  const b = base.replace(/\/$/, "");
  let listener: ((ev: ChatEvent) => void) | null = null;
  let acc = "";

  const send: (text: string, meta?: ChatSendMeta) => Promise<void> = async (text, meta) => {
    acc = "";
    const payload: Record<string, unknown> = { message: text };
    if (threadId) payload.thread = threadId;
    if (meta?.context !== undefined && meta.context !== null) payload.context = meta.context;
    // D21: the chat's Autonomous toggle (toolbar chip) - the explicit D8 marker.
    if (meta?.autonomous === true) payload.autonomous = true;
    if (typeof meta?.mode === "string" && meta.mode.trim()) {
      payload.mode = meta.mode.trim();
      // A mode-carrying turn is an interactive Discuss/design chat (Kanban / Automations
      // open these with mode=james). These must NOT use extended thinking: the router
      // otherwise classifies a "design a process" prompt as standard-tier → Sonnet with
      // `/effort medium`, and extended thinking on that content trips Anthropic's
      // usage-policy classifier (a hard AUP refusal on every Discuss turn). Pin the turn
      // to the no-thinking trivial tier — Discuss is lightweight by design, and the
      // gateway honors this classification hint (routeHintsFromBody). Ad-hoc threaded
      // chats carry no mode and are left to auto-classify as before.
      payload.classification = { taskType: "other", tier: "T0-trivial" };
    }

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
        // `replace` marks a full re-emit after a screen reflow (not a delta) — REPLACE
        // the accumulator rather than appending, so a reflow doesn't duplicate the whole
        // reply into the stream (the kilobytes-of-repeated-text bug).
        if (data.replace) acc = data.text;
        else acc += data.text;
        sawReply = true;
        listener?.({ type: "assistant", text: acc });
      } else if (name === "done") {
        // The done event carries the AUTHORITATIVE final reply (the settled scrape).
        // Prefer it whenever present: the streamed chunks are a live preview that can
        // still carry transient reflow artifacts, while done.reply is the clean result.
        if (typeof data.reply === "string" && data.reply.trim()) {
          acc = data.reply;
          sawReply = true;
          listener?.({ type: "assistant", text: acc });
        }
        // The turn settled but produced nothing — surface it instead of silently
        // doing nothing (the old failure mode), so the user can retry.
        if (!sawReply) {
          listener?.({ type: "assistant", text: "_The operative returned an empty reply. Try sending again._" });
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

// ── Thread types + API ──────────────────────────────────────────────────────
interface ThreadMeta {
  id: string;
  title: string;
  source: string;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
}
interface ThreadMessage { role: "user" | "assistant"; text: string; ts?: string }
interface Thread extends ThreadMeta {
  mode: string | null;
  context?: unknown;
  messages: ThreadMessage[];
}

async function apiListThreads(): Promise<ThreadMeta[]> {
  try {
    const r = await fetch("/api/threads", { cache: "no-store" });
    const d = await r.json();
    return Array.isArray(d.threads) ? d.threads : [];
  } catch { return []; }
}
async function apiGetThread(id: string): Promise<Thread | null> {
  try {
    const r = await fetch(`/api/threads/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const d = await r.json();
    return d.thread ?? null;
  } catch { return null; }
}
async function apiEnsureThread(payload: { id?: string; title?: string; source?: string; mode?: string; context?: unknown }): Promise<Thread | null> {
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
async function apiDelete(id: string): Promise<void> {
  try { await fetch(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { /* ignore */ }
}

// Pair a flat role/text transcript into the {user, assistant} exchanges the chat
// component seeds from. Robust to a trailing unanswered user turn.
function toHistory(messages: ThreadMessage[]): { user: string; assistant: string }[] {
  const out: { user: string; assistant: string }[] = [];
  let pendingUser: string | null = null;
  for (const m of messages ?? []) {
    if (m.role === "user") {
      if (pendingUser !== null) out.push({ user: pendingUser, assistant: "" });
      pendingUser = m.text;
    } else if (m.role === "assistant") {
      out.push({ user: pendingUser ?? "", assistant: m.text });
      pendingUser = null;
    }
  }
  if (pendingUser !== null) out.push({ user: pendingUser, assistant: "" });
  return out;
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
// toggle), and saves back (PUT). Handles the "no brief written yet" case — Save
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
            placeholder={exists ? "" : "No brief written yet — type here to create it, then Save."}
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

// ── Threaded app (sidebar + chat) ───────────────────────────────────────────
function ThreadedApp({ url }: { url: UrlState }) {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  // Bumped to re-mount BriefPanel (re-fetch fresh content) when the brief changes on disk.
  const [briefReloadKey, setBriefReloadKey] = useState(0);
  // Last-observed brief content, to detect a NEW write after a turn. undefined = not yet
  // baselined; null = checked & absent; string = last-seen content.
  const lastBriefRef = useRef<string | null | undefined>(undefined);
  // The kickoff is auto-sent only for a FRESH thread opened from a host (Discuss),
  // never when reopening a thread that already has history or when switching.
  const [kickoffFor, setKickoffFor] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    setThreads(await apiListThreads());
  }, []);

  const openThread = useCallback(async (id: string, opts?: { kickoff?: boolean }) => {
    const t = await apiGetThread(id);
    setActiveId(id);
    setActiveThread(t);
    setKickoffFor(opts?.kickoff && (!t || t.messages.length === 0) ? id : null);
    setSidebarOpen(false);
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
          source: url.mode === "james" ? "discuss" : "chat",
          mode: url.mode,
          context: url.context,
        });
        if (!alive) return;
        const id = ensured?.id ?? url.thread;
        await openThread(id, { kickoff: Boolean(url.kickoff) });
      } else if (url.context !== undefined || url.mode !== undefined || url.kickoff !== undefined) {
        // Context-driven but no stable key → a fresh ad-hoc thread carrying it.
        const ensured = await apiEnsureThread({
          title: url.title,
          source: url.mode === "james" ? "discuss" : "chat",
          mode: url.mode,
          context: url.context,
        });
        if (!alive) return;
        if (ensured) await openThread(ensured.id, { kickoff: Boolean(url.kickoff) });
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
      await openThread(ensured.id);
      await refreshList();
    }
  }, [openThread, refreshList]);

  const selectThread = useCallback(async (id: string) => {
    if (id === activeId) { setSidebarOpen(false); return; }
    await openThread(id);
  }, [activeId, openThread]);

  const removeThread = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await apiDelete(id);
    const list = await apiListThreads();
    setThreads(list);
    if (id === activeId) {
      if (list.length > 0) await openThread(list[0].id);
      else await newChat();
    }
  }, [activeId, openThread, newChat]);

  // Persistence is SERVER-SIDE: server.mjs handleChat tees each exchange into the
  // thread when the upstream `done` event arrives (the transport sends the thread
  // id on every POST /api/chat), so a mid-turn navigation or tab close never loses
  // it. On turn completion the client only refreshes the session list metadata.
  const onTurnSettled = useCallback(async () => {
    await refreshList();
  }, [refreshList]);

  const history = useMemo(() => {
    if (!activeThread) return [] as { user: string; assistant: string; hideUser?: boolean }[];
    const h: { user: string; assistant: string; hideUser?: boolean }[] = toHistory(activeThread.messages);
    // A reopened Discuss thread's first exchange is the auto-sent kickoff instruction —
    // hide its user bubble so the transcript starts with James's question, not the prompt.
    const isDiscuss = activeThread.mode === "james" || activeThread.source === "discuss";
    if (isDiscuss && h.length > 0) h[0] = { ...h[0], hideUser: true };
    return h;
  }, [activeThread]);
  // Show a prominent Back button for a host-opened Discuss (Kanban / Automations set a
  // returnLabel). Clicking it returns to the page the user came from via history.back().
  const backLabel = url.returnLabel && url.returnLabel.trim()
    ? url.returnLabel.trim()
    : (url.returnUrl ? "Back" : undefined);
  const ctx = activeThread?.context ?? url.context;
  // The Discuss brief's absolute path (host-provided) — enables the Brief editor.
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

  // After a turn settles, re-check the brief; if James just wrote or updated it, auto-open
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
      }
    } catch { /* best effort — auto-open is a convenience */ }
  }, [briefPath]);

  const mode = activeThread?.mode ?? url.mode;
  const kickoff = activeId && kickoffFor === activeId ? url.kickoff : undefined;
  // One transport per open thread (ClaudeChat re-mounts on activeId anyway), so
  // every send carries the thread id the server persists under.
  const transport = useMemo(() => createOrchestratorTransport("/api", activeId ?? undefined), [activeId]);

  return (
    <div className={`wc-shell${sidebarOpen ? " wc-shell--open" : ""}`}>
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
          <span className="wc-sidebar-title">Sessions</span>
          <button className="wc-new" onClick={newChat} title="Start a new conversation">+ New</button>
        </div>
        <div className="wc-thread-list">
          {threads.length === 0 && <div className="wc-empty-list">No conversations yet</div>}
          {threads.map((t) => (
            <button
              key={t.id}
              className={`wc-thread${t.id === activeId ? " wc-thread--active" : ""}`}
              onClick={() => selectThread(t.id)}
              title={t.title}
            >
              <span className="wc-thread-main">
                <span className="wc-thread-title">{t.title || "New conversation"}</span>
                <span className="wc-thread-meta">
                  {t.source && t.source !== "chat" && <span className="wc-thread-src">{t.source}</span>}
                  <span className="wc-thread-when">{fmtWhen(t.updatedAt)}</span>
                </span>
              </span>
              <span
                className="wc-thread-del"
                role="button"
                aria-label="Delete conversation"
                title="Delete"
                onClick={(e) => removeThread(t.id, e)}
              >
                ×
              </span>
            </button>
          ))}
        </div>
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
                onClick={() => setBriefOpen((v) => !v)}
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
        {loading || !activeId ? (
          <div className="wc-loading">Loading…</div>
        ) : (
          <ClaudeChat
            key={activeId}
            transport={transport}
            title="Operative"
            features={{ voice: true, autonomous: true }}
            context={ctx}
            mode={mode}
            initialMessage={kickoff}
            initialMessageHidden={Boolean(kickoff)}
            initialHistory={history}
            onTurnComplete={() => { void onTurnSettled(); void checkBriefAfterTurn(); }}
          />
        )}
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

  if (threaded) return <ThreadedApp url={url} />;
  // Explicit ?console=1: the rich operative console (live PTY surface).
  return <ClaudeChat transport={createHttpTransport("/api")} title="Operative" features={{ voice: true, autonomous: true }} />;
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
