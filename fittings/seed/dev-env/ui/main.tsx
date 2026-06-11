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
import { NewWorktreeDialog, ConfirmDeleteDialog, Toast } from "./dialogs";

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
  claudePty: PtySummary;
  shellPty: PtySummary;
}

const LS_SELECTED = "garrison.devenv.selected";
const LS_SPLIT_RATIO = "garrison.devenv.splitRatio";
const POLL_MS = 3000;
const MOBILE_QUERY = "(max-width: 720px)";

function basename(p: string): string {
  const parts = (p || "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function tabLabel(s: DevEnvSession): string {
  const raw = s.title || s.branch || basename(s.worktreePath) || s.id;
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
  onDividerPointerDown,
  onDividerPointerMove,
  onDividerPointerUp,
  onWired,
  onEnsureClaude,
  onInstruct
}: {
  session: DevEnvSession;
  active: boolean;
  isMobile: boolean;
  mobilePane: "claude" | "shell";
  splitRatio: number;
  onDividerPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDividerPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onDividerPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onWired: (info: WiredInfo) => void;
  onEnsureClaude: (sessionId: string, resume: boolean) => void;
  onInstruct: (sessionId: string, text: string) => Promise<boolean>;
}) {
  const claudeRunning = session.claudePty.state === "running";
  const shellRunning = session.shellPty.state === "running";
  const claudeKey = `${session.claudePty.id ?? "none"}:${session.claudePty.createdAt ?? ""}`;
  const shellKey = `${session.shellPty.id ?? "none"}:${session.shellPty.createdAt ?? ""}`;
  const showClaude = !isMobile || mobilePane === "claude";
  const showShell = !isMobile || mobilePane === "shell";

  return (
    <div className="workspace" style={{ display: active ? "flex" : "none" }}>
      <div
        className="terminals-col"
        style={!isMobile ? { flex: `0 0 calc(${splitRatio * 100}% - 3px)` } : undefined}
      >
        <div className="claude-pane" style={{ display: showClaude ? "flex" : "none" }}>
          <QuickPromptBar
            sessionId={session.id}
            disabled={!claudeRunning || session.claudePty.claudeAlive === false}
            onSend={onInstruct}
          />
          <div className="pane-body">
            {claudeRunning && (
              <TerminalPane key={claudeKey} ptyId={session.claudePty.id!} isActive={active && showClaude} />
            )}
            <ClaudePaneOverlay session={session} onEnsureClaude={onEnsureClaude} />
          </div>
        </div>
        <div className="shell-pane" style={{ display: showShell ? "flex" : "none" }}>
          <div className="pane-body">
            {shellRunning ? (
              <TerminalPane key={shellKey} ptyId={session.shellPty.id!} isActive={active && showShell} />
            ) : (
              <div className="pane-overlay">
                <p>Starting shell…</p>
              </div>
            )}
          </div>
        </div>
      </div>
      {!isMobile && (
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
          <BrowserPane cwd={session.worktreePath} active={active} onWired={onWired} />
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "new-worktree" | "confirm-delete">(null);
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
  // first session.
  const selected = sessions.find((s) => s.id === selectedId) ?? null;
  useEffect(() => {
    if (sessions.length === 0) return;
    if (!selected) {
      const first = sessions[0];
      setSelectedId(first.id);
      setVisited((v) => new Set(v).add(first.id));
    }
  }, [sessions, selected]);

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

  // Selecting a tab lazily ensures its shell PTY.
  useEffect(() => {
    if (!selected) return;
    if (selected.shellPty.state !== "running") {
      void ensurePty(selected.id, "shell");
    }
  }, [selected?.id, selected?.shellPty.state, ensurePty]);

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
              <button type="button" onClick={() => { setMenuOpen(false); setDialog("new-worktree"); }}>
                New worktree…
              </button>
              <button type="button" onClick={() => void clearStale()}>
                Clear stale sessions
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
          {sessions.map((s) => (
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
            </span>
          ))}
          {sessions.length === 0 && <span className="tabs-empty">No sessions — create a worktree or start claude anywhere.</span>}
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
            onDividerPointerDown={onDividerPointerDown}
            onDividerPointerMove={onDividerPointerMove}
            onDividerPointerUp={onDividerPointerUp}
            onWired={onWired}
            onEnsureClaude={onEnsureClaude}
            onInstruct={instruct}
          />
        ))}
        {sessions.length === 0 && (
          <div className="empty-state">
            <p>No active sessions.</p>
            <button type="button" className="btn primary" onClick={() => setDialog("new-worktree")}>
              New worktree…
            </button>
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
