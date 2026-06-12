// Garrison Dev Env shell. One compact header (hamburger menu + tab strip),
// one workspace per visited session: Claude terminal + shell terminal on the
// left, the live browser pane on the right (desktop only). Mobile collapses
// to a single full-screen terminal with a Claude | Shell segmented toggle.
// Sessions are polled from GET /sessions every 3s — the single channel for
// status / dirty / PTY state.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TerminalPane } from "./terminal-pane";
import { BrowserPane, type WiredInfo } from "./browser-pane";
import { NewWorktreeDialog, StartSessionDialog, ConfirmDeleteDialog, Toast } from "./dialogs";

interface PtySummary {
  id?: string;
  state: "running" | "exited" | "persisted" | "none";
  exitCode?: number | null;
  createdAt?: string;
  claudeAlive?: boolean;
}

interface DevEnvSession {
  id: string;
  branch: string;
  worktreePath: string;
  projectName: string;
  projectPath: string;
  lastStatus: string;
  lastStatusAt: string;
  claudeSessionId: string | null;
  title: string | null;
  source: string;
  dirty: boolean | null;
  isWorktree: boolean;
  external: boolean;
  claudeClosed: boolean;
  shellClosed: boolean;
  claudePty: PtySummary;
  shellPty: PtySummary;
}

const LS_SELECTED = "garrison.devenv.selected";
const LS_SPLIT_RATIO = "garrison.devenv.splitRatio";
const LS_SHOW_ALL = "garrison.devenv.showAll";
const POLL_MS = 3000;
const MOBILE_QUERY = "(max-width: 720px)";
const ACTIVE_WINDOW_MS = 90 * 60 * 1000;

// The state file is a ledger of every session the hooks ever saw, not a list
// of live ones. A tab is shown by default only when the session is plausibly
// active: a PTY exists here (running, exited, or parked for resume), hooks
// say it's working right now, or it fired any hook in the last 90 minutes.
// `waiting` is NOT inherently active — the server never decays it, so a
// days-old unanswered Notification would pin a tab forever; recency covers
// the live case. Same for worktree rows: adopted-but-untouched worktrees are
// exactly the ledger noise, and Dev-Env-created ones stay visible through
// their PTYs. Everything else hides behind the menu's Show-all toggle.
function isActiveSession(s: DevEnvSession): boolean {
  if (s.claudePty.state !== "none" || s.shellPty.state !== "none") return true;
  if (s.lastStatus === "working" || s.lastStatus === "starting") return true;
  const t = Date.parse(s.lastStatusAt || "");
  return Number.isFinite(t) && Date.now() - t < ACTIVE_WINDOW_MS;
}

function basename(p: string): string {
  const parts = (p || "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// Label priority: explicit title; on a default/detached branch the folder
// name (projectName carries repo/subdir for hook-created rows); otherwise
// the worktree dir name for worktrees, else the branch name.
function tabLabel(s: DevEnvSession): string {
  const folder = s.projectName || basename(s.worktreePath) || s.id;
  let raw: string;
  if (s.title) raw = s.title;
  else if (!s.branch || s.branch === "main" || s.branch === "master" || s.branch === "detached") raw = folder;
  else if (s.isWorktree) raw = basename(s.worktreePath) || s.branch;
  else raw = s.branch;
  return raw.length > 30 ? raw.slice(0, 29) + "…" : raw;
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

function QuickPromptBar({
  sessionId,
  disabled,
  onSend
}: {
  sessionId: string;
  disabled: boolean;
  onSend: (sessionId: string, text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await onSend(sessionId, t);
    setBusy(false);
    if (ok) setText("");
  }

  return (
    <div className="quick-prompt">
      <input
        type="text"
        value={text}
        disabled={disabled || busy}
        placeholder="Send a prompt to Claude…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
      />
      <button type="button" className="btn" disabled={disabled || busy || !text.trim()} onClick={() => void send()}>
        Send
      </button>
    </div>
  );
}

function ClaudePaneOverlay({
  session,
  onEnsureClaude
}: {
  session: DevEnvSession;
  onEnsureClaude: (sessionId: string, resume: boolean) => void;
}) {
  const { claudePty, external, claudeSessionId } = session;

  if (claudePty.state === "running" && claudePty.claudeAlive === false) {
    return (
      <div className="pane-overlay">
        <p>claude exited — the shell underneath is still alive.</p>
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, true)}>
          Restart claude
        </button>
      </div>
    );
  }
  if (claudePty.state === "running") return null;

  if (claudePty.state === "persisted") {
    return (
      <div className="pane-overlay">
        <p>Claude session persisted from a previous Dev Env run.</p>
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, true)}>
          Resume (claude --continue)
        </button>
      </div>
    );
  }
  if (claudePty.state === "exited") {
    return (
      <div className="pane-overlay">
        <p>Terminal exited with code {claudePty.exitCode ?? "?"}.</p>
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, true)}>
          Restart
        </button>
      </div>
    );
  }
  if (external) {
    return (
      <div className="pane-overlay">
        <p>Claude is running elsewhere for this directory (detected via hooks).</p>
        <p className="pane-overlay-warn">
          Take over starts a second claude here with <code>--continue</code>; if the
          external one is still running, both will be attached to the project.
        </p>
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, true)}>
          Take over (claude --continue)
        </button>
      </div>
    );
  }
  return (
    <div className="pane-overlay">
      <p>No Claude terminal for this session yet.</p>
      <div className="pane-overlay-row">
        <button type="button" className="btn primary" onClick={() => onEnsureClaude(session.id, false)}>
          Start Claude
        </button>
        {claudeSessionId && (
          <button type="button" className="btn" onClick={() => onEnsureClaude(session.id, true)}>
            Resume (claude --continue)
          </button>
        )}
      </div>
    </div>
  );
}

function SessionWorkspace({
  session,
  active,
  isMobile,
  mobilePane,
  splitRatio,
  browserPref,
  onDividerPointerDown,
  onDividerPointerMove,
  onDividerPointerUp,
  onWired,
  onEnsureClaude,
  onInstruct,
  onClosePty,
  onStartShell,
  onCloseBrowser,
  onPinBrowserOpen
}: {
  session: DevEnvSession;
  active: boolean;
  isMobile: boolean;
  mobilePane: "claude" | "shell";
  splitRatio: number;
  browserPref: "open" | "closed" | undefined;
  onDividerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDividerPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDividerPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onWired: (info: WiredInfo) => void;
  onEnsureClaude: (sessionId: string, resume: boolean) => void;
  onInstruct: (sessionId: string, text: string) => Promise<boolean>;
  onClosePty: (sessionId: string, role: "claude" | "shell") => void;
  onStartShell: (sessionId: string) => void;
  onCloseBrowser: (sessionId: string) => void;
  onPinBrowserOpen: (sessionId: string) => void;
}) {
  const claudeRunning = session.claudePty.state === "running";
  const shellRunning = session.shellPty.state === "running";
  const shellClosed = session.shellClosed;
  const claudeKey = `${session.claudePty.id ?? "none"}:${session.claudePty.createdAt ?? ""}`;
  const shellKey = `${session.shellPty.id ?? "none"}:${session.shellPty.createdAt ?? ""}`;
  const showClaude = !isMobile || mobilePane === "claude";
  const showShell = !isMobile || mobilePane === "shell";

  // The browser pane only opens by default while an app.port is detected for
  // this cwd; "open"/"closed" prefs (menu Open browser / pane ×) override.
  // Hiding needs 3 consecutive misses so a dev-server restart (brief app.port
  // gap) or a flaky Tailscale fetch doesn't unmount the pane mid-use.
  const [hasAppPort, setHasAppPort] = useState(false);
  const missesRef = useRef(0);
  useEffect(() => {
    if (isMobile || !active || browserPref !== undefined) return;
    let cancelled = false;
    const check = async () => {
      let ok = false;
      try {
        const res = await fetch(`/app-port?cwd=${encodeURIComponent(session.worktreePath)}`);
        ok = res.ok;
      } catch {}
      if (cancelled) return;
      if (ok) {
        missesRef.current = 0;
        setHasAppPort(true);
      } else {
        missesRef.current += 1;
        if (missesRef.current >= 3) setHasAppPort(false);
      }
    };
    void check();
    const id = window.setInterval(check, 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [active, isMobile, browserPref, session.worktreePath]);
  const browserVisible =
    !isMobile && (browserPref === "open" || (browserPref !== "closed" && hasAppPort));

  return (
    <div className="workspace" style={{ display: active ? "flex" : "none" }}>
      <div
        className="terminals-col"
        style={!isMobile && browserVisible ? { flex: `0 0 calc(${splitRatio * 100}% - 3px)` } : undefined}
      >
        <div className="claude-pane" style={{ display: showClaude ? "flex" : "none" }}>
          <div className="quick-prompt-row">
            <QuickPromptBar
              sessionId={session.id}
              disabled={!claudeRunning || session.claudePty.claudeAlive === false}
              onSend={onInstruct}
            />
            {session.claudePty.state !== "none" && (
              <button
                type="button"
                className="pane-close"
                onClick={() => onClosePty(session.id, "claude")}
                title="Close Claude terminal"
              >
                ×
              </button>
            )}
          </div>
          <div className="pane-body">
            {claudeRunning && (
              <TerminalPane key={claudeKey} ptyId={session.claudePty.id!} isActive={active && showClaude} />
            )}
            <ClaudePaneOverlay session={session} onEnsureClaude={onEnsureClaude} />
          </div>
        </div>
        <div className="shell-pane" style={{ display: showShell ? "flex" : "none" }}>
          {session.shellPty.state !== "none" && (
            <div className="pane-strip">
              <span>shell</span>
              <button
                type="button"
                className="pane-close"
                onClick={() => onClosePty(session.id, "shell")}
                title="Close shell terminal"
              >
                ×
              </button>
            </div>
          )}
          <div className="pane-body">
            {shellRunning ? (
              <TerminalPane key={shellKey} ptyId={session.shellPty.id!} isActive={active && showShell} />
            ) : (
              <div className="pane-overlay">
                {session.shellPty.state === "exited" ? (
                  <p>Terminal exited with code {session.shellPty.exitCode ?? "?"}.</p>
                ) : shellClosed ? (
                  <p>Shell terminal closed.</p>
                ) : (
                  <p>Starting shell…</p>
                )}
                {(session.shellPty.state === "exited" || shellClosed) && (
                  <button type="button" className="btn primary" onClick={() => onStartShell(session.id)}>
                    Start terminal
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {browserVisible && (
        <>
          <div
            className="split-divider"
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={onDividerPointerUp}
            onPointerCancel={onDividerPointerUp}
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
          />
          <BrowserPane
            cwd={session.worktreePath}
            active={active}
            onWired={onWired}
            onManualNav={() => onPinBrowserOpen(session.id)}
            onClose={() => onCloseBrowser(session.id)}
          />
        </>
      )}
    </div>
  );
}

function App() {
  const [sessions, setSessions] = useState<DevEnvSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => localStorage.getItem(LS_SELECTED)
  );
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [mobilePane, setMobilePane] = useState<"claude" | "shell">("claude");
  const [showAll, setShowAll] = useState(() => localStorage.getItem(LS_SHOW_ALL) === "1");
  // Per-session browser override ("open" = forced visible, "closed" = forced
  // hidden; unset = auto, i.e. visible only while an app.port is detected).
  // Shell-closed state is SERVER-side (session.shellClosed) so a second
  // connected client cannot resurrect a pane this one just closed.
  const [browserPref, setBrowserPref] = useState<Record<string, "open" | "closed">>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "new-worktree" | "start-session" | "confirm-delete">(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const toastTimer = useRef<number | null>(null);
  const ensuredRef = useRef<Set<string>>(new Set());
  const wiredByCwd = useRef<Map<string, WiredInfo>>(new Map());
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem(LS_SPLIT_RATIO));
    // Default: terminals 1/2, app pane 1/2.
    return Number.isFinite(v) && v > 0.1 && v < 0.9 ? v : 0.5;
  });
  const draggingRef = useRef(false);
  const shellWrapRef = useRef<HTMLDivElement | null>(null);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/sessions");
      const data = await res.json();
      const list: DevEnvSession[] = data.sessions ?? [];
      setSessions(list);
      ensuredRef.current.clear();
    } catch {
      // transient poll failure; keep the last list
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Auto-select: keep the stored selection while it exists; fall back to the
  // first VISIBLE session. The selected session always stays visible even
  // when it fails the active filter, so toggling Show-all off never yanks
  // the workspace out from under you.
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  const visibleSessions = sessions.filter(
    (s) => showAll || s.id === selectedId || isActiveSession(s)
  );
  const hiddenCount = sessions.length - visibleSessions.length;
  useEffect(() => {
    if (visibleSessions.length === 0) return;
    if (!selected) {
      const first = visibleSessions[0];
      setSelectedId(first.id);
      setVisited((v) => new Set(v).add(first.id));
    }
  }, [visibleSessions, selected]);

  function toggleShowAll() {
    setShowAll((prev) => {
      const next = !prev;
      localStorage.setItem(LS_SHOW_ALL, next ? "1" : "0");
      return next;
    });
  }

  useEffect(() => {
    if (selectedId) {
      localStorage.setItem(LS_SELECTED, selectedId);
      setVisited((v) => (v.has(selectedId) ? v : new Set(v).add(selectedId)));
    }
  }, [selectedId]);

  const ensurePty = useCallback(
    async (sessionId: string, role: "claude" | "shell", resume = false) => {
      const key = `${sessionId}:${role}`;
      if (ensuredRef.current.has(key)) return;
      ensuredRef.current.add(key);
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/ptys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, resume })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error ?? `PTY start failed: HTTP ${res.status}`);
          return;
        }
        await refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh, toast]
  );

  // Selecting a tab lazily spawns its shell PTY — but only the first time
  // (state "none"): an exited shell shows a Start-terminal overlay instead of
  // auto-respawning, and an explicitly closed one (server-side marker) stays
  // closed across every connected client.
  useEffect(() => {
    if (!selected) return;
    if (selected.shellPty.state === "none" && !selected.shellClosed) {
      void ensurePty(selected.id, "shell");
    }
  }, [selected?.id, selected?.shellPty.state, selected?.shellClosed, ensurePty]);

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const closePty = useCallback(
    async (sessionId: string, role: "claude" | "shell") => {
      try {
        await fetch(`/sessions/${encodeURIComponent(sessionId)}/ptys/${role}`, { method: "DELETE" });
      } catch {}
      ensuredRef.current.delete(`${sessionId}:${role}`);
      await refresh();
    },
    [refresh]
  );

  const startShell = useCallback(
    (sessionId: string) => {
      ensuredRef.current.delete(`${sessionId}:shell`);
      void ensurePty(sessionId, "shell");
    },
    [ensurePty]
  );

  const closeTab = useCallback(
    async (sessionId: string) => {
      const idx = visibleSessions.findIndex((s) => s.id === sessionId);
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/close`, { method: "POST" });
        // 404 = already gone (double-click ×, another client) — treat as
        // success and proceed with local cleanup.
        if (!res.ok && res.status !== 404) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error ?? `close failed: HTTP ${res.status}`);
          return;
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
        return;
      }
      setVisited((v) => {
        const next = new Set(v);
        next.delete(sessionId);
        return next;
      });
      setBrowserPref((p) => {
        if (!(sessionId in p)) return p;
        const next = { ...p };
        delete next[sessionId];
        return next;
      });
      // Re-read the selection at resolution time: the user may have clicked
      // another tab while the close round-trip was in flight.
      if (selectedIdRef.current === sessionId) {
        const neighbors = visibleSessions.filter((s) => s.id !== sessionId);
        const neighbor = neighbors[idx] ?? neighbors[idx - 1] ?? null;
        setSelectedId(neighbor ? neighbor.id : null);
      }
      await refresh();
    },
    [visibleSessions, refresh, toast]
  );

  const closeBrowser = useCallback((sessionId: string) => {
    setBrowserPref((p) => ({ ...p, [sessionId]: "closed" }));
  }, []);

  // Manual URL navigation pins the pane open — otherwise the app.port
  // visibility poll could unmount it mid-browse.
  const pinBrowserOpen = useCallback((sessionId: string) => {
    setBrowserPref((p) => (p[sessionId] === "open" ? p : { ...p, [sessionId]: "open" }));
  }, []);

  function openBrowser() {
    setMenuOpen(false);
    if (!selected) return;
    setBrowserPref((p) => ({ ...p, [selected.id]: "open" }));
  }

  const onEnsureClaude = useCallback(
    (sessionId: string, resume: boolean) => {
      ensuredRef.current.delete(`${sessionId}:claude`);
      void ensurePty(sessionId, "claude", resume);
    },
    [ensurePty]
  );

  const instruct = useCallback(
    async (sessionId: string, text: string): Promise<boolean> => {
      try {
        const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/instruct`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error ?? `instruct failed: HTTP ${res.status}`);
          return false;
        }
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [toast]
  );

  function select(id: string) {
    setSelectedId(id);
  }

  async function clearStale() {
    setMenuOpen(false);
    try {
      const res = await fetch("/sessions/cleanup", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data?.error ?? `cleanup failed: HTTP ${res.status}`);
        return;
      }
      toast(`${data.removed?.length ?? 0} session(s) cleared`);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  }

  async function menuInstruct(text: string) {
    setMenuOpen(false);
    if (!selected) return;
    const ok = await instruct(selected.id, text);
    if (ok) toast("Sent to Claude");
  }

  async function deleteSelected() {
    setDialog(null);
    if (!selected) return;
    const idx = sessions.findIndex((s) => s.id === selected.id);
    try {
      const res = await fetch(`/sessions/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data?.error ?? `delete failed: HTTP ${res.status}`);
        return;
      }
      const neighbor = sessions[idx + 1] ?? sessions[idx - 1] ?? null;
      setSelectedId(neighbor ? neighbor.id : null);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  }

  async function openAppInNewTab() {
    setMenuOpen(false);
    if (!selected) return;
    const wired = wiredByCwd.current.get(selected.worktreePath);
    if (wired?.canvasUrl) {
      window.open(wired.canvasUrl, "_blank", "noopener");
      return;
    }
    try {
      const res = await fetch(`/app-port?cwd=${encodeURIComponent(selected.worktreePath)}`);
      if (res.ok) {
        const { port } = await res.json();
        window.open(`http://${window.location.hostname}:${port}`, "_blank", "noopener");
        return;
      }
    } catch {}
    toast("No app detected for this session (missing app.port).");
  }

  const onWired = useCallback((info: WiredInfo) => {
    wiredByCwd.current.set(info.cwd, info);
  }, []);

  function onDividerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    draggingRef.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }

  function onDividerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const wrap = shellWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const raw = (e.clientX - rect.left) / rect.width;
    const clamped = Math.min(0.9, Math.max(0.1, raw));
    setSplitRatio(clamped);
  }

  function onDividerPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    localStorage.setItem(LS_SPLIT_RATIO, String(splitRatio));
  }

  // Close the menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

  const visible = sessions.filter((s) => visited.has(s.id));

  return (
    <>
      <div className="header">
        <div className="menu-wrap" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn menu-btn"
            title="Menu"
            aria-label="Menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="1" y="2" width="12" height="1.6" fill="currentColor" />
              <rect x="1" y="6.2" width="12" height="1.6" fill="currentColor" />
              <rect x="1" y="10.4" width="12" height="1.6" fill="currentColor" />
            </svg>
          </button>
          {menuOpen && (
            <div className="menu">
              <button type="button" onClick={() => { setMenuOpen(false); setDialog("start-session"); }}>
                Start session…
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); setDialog("new-worktree"); }}>
                New worktree…
              </button>
              <button type="button" onClick={() => void clearStale()}>
                Clear stale sessions
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); toggleShowAll(); }}>
                {showAll
                  ? "Show active only"
                  : `Show all sessions${hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}`}
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                disabled={!selected}
                onClick={() => void menuInstruct(
                  "Commit any pending changes, push the branch, and open a PR with gh; report the PR URL."
                )}
              >
                Create PR
              </button>
              <button
                type="button"
                disabled={!selected}
                onClick={() => void menuInstruct(
                  "Commit any pending changes with a sensible message and push the branch."
                )}
              >
                Commit &amp; push
              </button>
              <button type="button" disabled={!selected} onClick={() => void menuInstruct("/run")}>
                Run
              </button>
              <div className="menu-sep" />
              <button
                type="button"
                disabled={!selected || selected.shellPty.state === "running"}
                onClick={() => { setMenuOpen(false); if (selected) startShell(selected.id); }}
              >
                Start terminal
              </button>
              <button
                type="button"
                disabled={!selected || isMobile || browserPref[selected.id] === "open"}
                onClick={openBrowser}
                title={isMobile ? "Browser pane is desktop-only" : "Show the browser pane for this tab"}
              >
                Open browser
              </button>
              <button type="button" disabled={!selected} onClick={() => void openAppInNewTab()}>
                Open app in browser tab
              </button>
              {selected?.isWorktree && (
                <>
                  <div className="menu-sep" />
                  <button type="button" className="danger" onClick={() => { setMenuOpen(false); setDialog("confirm-delete"); }}>
                    Delete worktree
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="tabs">
          {visibleSessions.map((s) => (
            <span
              key={s.id}
              className={`tab ${s.id === selectedId ? "active" : ""} ${s.lastStatus === "stale" ? "stale" : ""}`}
              onClick={() => select(s.id)}
              title={`${s.worktreePath}\n${s.lastStatus}${s.external ? " · external" : ""}`}
            >
              {s.lastStatus === "working" && <span className="spinner" aria-hidden="true" />}
              {s.lastStatus === "waiting" && <span className="badge-waiting" aria-hidden="true" />}
              <span className="tab-label">{tabLabel(s)}</span>
              {s.dirty === true && <span className="dirty-dot" title="Uncommitted changes" />}
              <span
                className="close"
                title="Close tab (terminals die; the directory and worktree stay)"
                onClick={(e) => { e.stopPropagation(); void closeTab(s.id); }}
              >
                ×
              </span>
            </span>
          ))}
          {sessions.length === 0 && <span className="tabs-empty">No sessions — create a worktree or start claude anywhere.</span>}
          {sessions.length > 0 && visibleSessions.length === 0 && (
            <span className="tabs-empty">No active sessions — {hiddenCount} hidden.</span>
          )}
        </div>
        {isMobile && selected && (
          <div className="segmented" role="tablist" aria-label="Pane">
            <button
              type="button"
              className={mobilePane === "claude" ? "on" : ""}
              onClick={() => setMobilePane("claude")}
            >
              Claude
            </button>
            <button
              type="button"
              className={mobilePane === "shell" ? "on" : ""}
              onClick={() => setMobilePane("shell")}
            >
              Shell
            </button>
          </div>
        )}
      </div>

      <div className="shell-wrap" ref={shellWrapRef}>
        {visible.map((s) => (
          <SessionWorkspace
            key={s.id}
            session={s}
            active={s.id === selectedId}
            isMobile={isMobile}
            mobilePane={mobilePane}
            splitRatio={splitRatio}
            browserPref={browserPref[s.id]}
            onDividerPointerDown={onDividerPointerDown}
            onDividerPointerMove={onDividerPointerMove}
            onDividerPointerUp={onDividerPointerUp}
            onWired={onWired}
            onEnsureClaude={onEnsureClaude}
            onInstruct={instruct}
            onClosePty={(sid, role) => void closePty(sid, role)}
            onStartShell={startShell}
            onCloseBrowser={closeBrowser}
            onPinBrowserOpen={pinBrowserOpen}
          />
        ))}
        {visibleSessions.length === 0 && (
          <div className="empty-state">
            <p>No active sessions.</p>
            <div className="pane-overlay-row">
              <button type="button" className="btn primary" onClick={() => setDialog("new-worktree")}>
                New worktree…
              </button>
              {hiddenCount > 0 && (
                <button type="button" className="btn" onClick={() => toggleShowAll()}>
                  Show all sessions ({hiddenCount} hidden)
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {dialog === "new-worktree" && (
        <NewWorktreeDialog
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setSelectedId(id);
            setVisited((v) => new Set(v).add(id));
            void refresh();
          }}
          onError={(m) => toast(m)}
        />
      )}
      {dialog === "start-session" && (
        <StartSessionDialog
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setSelectedId(id);
            setVisited((v) => new Set(v).add(id));
            void refresh();
          }}
          onError={(m) => toast(m)}
        />
      )}
      {dialog === "confirm-delete" && selected && (
        <ConfirmDeleteDialog
          label={tabLabel(selected)}
          detail={selected.worktreePath}
          onClose={() => setDialog(null)}
          onConfirm={() => void deleteSelected()}
        />
      )}
      <Toast message={toastMsg} />
    </>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
