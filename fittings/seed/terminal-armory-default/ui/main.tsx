import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

interface Session {
  id: string;
  name: string;
  cwd: string;
  shell: string;
  command?: string | null;
  busy: boolean;
  createdAt: string;
}

function TerminalPane({ sessionId, isActive, onPtyData }: { sessionId: string; isActive: boolean; onPtyData?: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const onPtyDataRef = useRef(onPtyData);
  onPtyDataRef.current = onPtyData;
  const [bridgeMsg, setBridgeMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let resizeObs: ResizeObserver | null = null;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 10_000,
      convertEol: false,
      theme: {
        background: "#0e0e0e",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        cursorAccent: "#0e0e0e",
        selectionBackground: "#3b3b3b"
      },
      allowProposedApi: true
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch {}

    // Alt-screen TUIs (Claude Code, vim, less, ...) replace xterm's scrollback
    // with their own buffer, so xterm has nothing to scroll. Translate vertical
    // wheel motion into arrow-key escape sequences so the embedded TUI can
    // scroll its own contents.
    type WheelHandlerHost = {
      attachCustomWheelEventHandler?: (handler: (ev: WheelEvent) => boolean) => void;
    };
    const wheelHost = term as unknown as WheelHandlerHost;
    if (typeof wheelHost.attachCustomWheelEventHandler === "function") {
      wheelHost.attachCustomWheelEventHandler((ev: WheelEvent) => {
        if (term.buffer.active.type !== "alternate") return true;
        const sock = socketRef.current;
        if (!sock || sock.readyState !== WebSocket.OPEN) return false;
        const lines = Math.max(1, Math.round(Math.abs(ev.deltaY) / 16));
        const seq = (ev.deltaY < 0 ? "\x1b[A" : "\x1b[B").repeat(lines);
        sock.send(new TextEncoder().encode(seq));
        return false;
      });
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${window.location.host}/io`);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "init", sessionId, cols: term.cols, rows: term.rows }));
    });

    socket.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        if (ev.data.startsWith("{")) {
          try {
            const msg = JSON.parse(ev.data);
            if (msg && typeof msg.type === "string") {
              if (msg.type === "init_ack") return;
              if (msg.type === "pong") return;
              if (msg.type === "error") { term.writeln(`\r\n[error: ${msg.message}]`); return; }
              if (msg.type === "exit") { term.writeln(`\r\n[exit code=${msg.exitCode}]`); return; }
            }
          } catch {}
        }
        term.write(ev.data);
        onPtyDataRef.current?.(sessionId);
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : (ev.data as Uint8Array);
      term.write(buf);
      onPtyDataRef.current?.(sessionId);
    });

    socket.addEventListener("close", () => {
      if (!cancelled) setBridgeMsg("connection closed");
    });
    socket.addEventListener("error", () => {
      if (!cancelled) setBridgeMsg("connection error");
    });

    term.onData((d) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(new TextEncoder().encode(d));
      }
    });

    const refit = () => {
      if (!containerRef.current) return;
      // Skip when not laid out — fit() would compute 0x0 and break the PTY size.
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      try {
        fit.fit();
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        }
      } catch {}
    };
    resizeObs = new ResizeObserver(refit);
    resizeObs.observe(containerRef.current);
    window.addEventListener("resize", refit);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", refit);
      resizeObs?.disconnect();
      try { socket.close(); } catch {}
      try { term.dispose(); } catch {}
      termRef.current = null;
      fitRef.current = null;
      socketRef.current = null;
    };
  }, [sessionId]);

  // When this pane becomes active again, the container went from display:none
  // (zero size) back to a real layout — re-fit, push the new cols/rows to the
  // PTY, and focus so the cursor is ready to type.
  useEffect(() => {
    if (!isActive) return;
    const t = termRef.current;
    const f = fitRef.current;
    const c = containerRef.current;
    if (!t || !f || !c) return;
    const rafId = requestAnimationFrame(() => {
      try {
        const rect = c.getBoundingClientRect();
        if (rect.width >= 10 && rect.height >= 10) {
          f.fit();
          const sock = socketRef.current;
          if (sock && sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
          }
        }
        t.focus();
      } catch {}
    });
    return () => cancelAnimationFrame(rafId);
  }, [isActive]);

  return (
    <div className={`term-host ${isActive ? "" : "hidden"}`}>
      {bridgeMsg && <div className="bridge-banner">{bridgeMsg}</div>}
      <div ref={containerRef} className="xterm-mount" data-testid="terminal-pane" />
    </div>
  );
}

interface Project { name: string; path: string; }

const LS_LAST_PROJECT = "garrison.terminal.lastProject";

function normalizePath(p: string | null | undefined) {
  if (!p) return "";
  return p.replace(/\/+$/, "");
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bootRef = useRef(false);
  const [dialog, setDialog] = useState<null | { mode: "claude" | "continue"; path: string }>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string>(
    localStorage.getItem(LS_LAST_PROJECT) || ""
  );
  const [splitOpen, setSplitOpen] = useState(true);
  const [appUrl, setAppUrl] = useState<string | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [iframeNonce, setIframeNonce] = useState(0);
  const [splitRatio, setSplitRatio] = useState<number>(() => {
    const v = Number(localStorage.getItem("garrison.terminal.splitRatio"));
    // Default: terminal 1/3, app iframe 2/3.
    return Number.isFinite(v) && v > 0.1 && v < 0.9 ? v : 1 / 3;
  });
  const splitWrapRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const autoOpenedRef = useRef(false);
  const lastDataRef = useRef<Map<string, number>>(new Map());
  const [busyTick, setBusyTick] = useState(0);

  const noteSessionActivity = useCallback((id: string) => {
    lastDataRef.current.set(id, Date.now());
  }, []);

  // Re-render twice a second so the busy pill follows the activity window.
  useEffect(() => {
    const t = setInterval(() => setBusyTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  // Stale: idle for >1.5s since the last byte from the PTY.
  const BUSY_WINDOW_MS = 1500;
  function isBusy(id: string): boolean {
    const t = lastDataRef.current.get(id);
    return !!t && Date.now() - t < BUSY_WINDOW_MS;
  }
  // Touch busyTick so the renderer re-evaluates isBusy on each interval.
  void busyTick;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/sessions");
      const data = await res.json();
      const list: Session[] = data.sessions ?? [];
      setSessions(list);
      if (list.length > 0 && (!activeId || !list.find((s) => s.id === activeId))) {
        setActiveId(list[0].id);
      } else if (list.length === 0) {
        setActiveId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [activeId]);

  const createSession = useCallback(async (body: { cwd?: string; command?: string; name?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `HTTP ${res.status}`);
        return null;
      }
      setActiveId(data.id);
      await refresh();
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  useEffect(() => { void refresh(); }, []); // initial load only

  // Load project list
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/projects");
        const data = await res.json();
        if (Array.isArray(data.projects)) setProjects(data.projects);
      } catch {}
    })();
  }, []);

  // Bootstrap: honour ?focus=<id> (switch to existing session) or ?cwd=&command= (spawn),
  // else create an empty session if none exist.
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const focusId = params.get("focus");
    const cwd = params.get("cwd") || undefined;
    const command = params.get("command") || undefined;
    const name = params.get("name") || undefined;

    if (focusId) {
      void (async () => {
        await refresh();
        // setActiveId is safe even if the id is not in the refreshed list;
        // TerminalPane will surface a connection-failed banner.
        setActiveId(focusId);
        window.history.replaceState({}, "", window.location.pathname);
      })();
      return;
    }

    if (cwd || command) {
      void createSession({ cwd, command, name });
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }
    void (async () => {
      await refresh();
      if (sessions.length === 0) {
        await createSession({});
      }
    })();
  }, []);

  async function close(id: string) {
    try {
      await fetch(`/terminals/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
    } catch {}
  }

  function defaultDialogPath() {
    return activeProject || localStorage.getItem("garrison.terminal.lastPath") || "";
  }
  function openClaudeDialog() {
    setDialog({ mode: "claude", path: defaultDialogPath() });
  }
  function openContinueDialog() {
    setDialog({ mode: "continue", path: defaultDialogPath() });
  }

  // Refresh the session list before matching so we don't spawn a duplicate
  // claude tab when one is already running at this cwd.
  async function findExistingClaudeAt(cwd: string): Promise<Session | null> {
    const target = normalizePath(cwd);
    try {
      const res = await fetch("/sessions");
      const data = await res.json();
      const list: Session[] = data.sessions ?? [];
      setSessions(list);
      const hit = list.find((s) =>
        typeof s.command === "string"
        && s.command.includes("claude")
        && normalizePath(s.cwd) === target
      );
      return hit ?? null;
    } catch {
      return null;
    }
  }

  async function submitDialog() {
    if (!dialog) return;
    const cwd = dialog.path.trim();
    if (cwd) localStorage.setItem("garrison.terminal.lastPath", cwd);
    setDialog(null);

    const existing = await findExistingClaudeAt(cwd);
    if (existing) {
      setActiveId(existing.id);
      return;
    }

    const command =
      dialog.mode === "continue"
        ? "claude --continue --dangerously-skip-permissions"
        : "claude --dangerously-skip-permissions";
    await createSession({ cwd: cwd || undefined, command });
  }

  function pickProject(value: string) {
    setActiveProject(value);
    if (value) localStorage.setItem(LS_LAST_PROJECT, value);
    else localStorage.removeItem(LS_LAST_PROJECT);
  }

  async function newSessionAtProject() {
    const name = activeProject ? activeProject.split("/").filter(Boolean).pop() : undefined;
    await createSession({ cwd: activeProject || undefined, name });
  }

  const activeSession = sessions.find((s) => s.id === activeId) || null;

  // First time we have an active session, try to auto-populate the iframe.
  // Stay quiet on failure — the app.port file may not exist yet.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!activeSession) return;
    autoOpenedRef.current = true;
    void (async () => {
      try {
        const [ipRes, portRes] = await Promise.all([
          fetch("/tailscale-ip"),
          fetch(`/app-port?cwd=${encodeURIComponent(activeSession.cwd)}`)
        ]);
        if (!ipRes.ok || !portRes.ok) return;
        const { ip } = await ipRes.json();
        const { port } = await portRes.json();
        setAppUrl(`http://${ip}:${port}`);
      } catch {}
    })();
  }, [activeSession]);

  async function resolveAppUrl(): Promise<string | null> {
    setSplitError(null);
    if (!activeSession) {
      setSplitError("No active terminal session.");
      return null;
    }
    try {
      const [ipRes, portRes] = await Promise.all([
        fetch("/tailscale-ip"),
        fetch(`/app-port?cwd=${encodeURIComponent(activeSession.cwd)}`)
      ]);
      if (!ipRes.ok) {
        setSplitError("No Tailscale interface found on this machine.");
        return null;
      }
      if (!portRes.ok) {
        const body = await portRes.json().catch(() => ({}));
        setSplitError(`app.port: ${body?.error || `HTTP ${portRes.status}`}`);
        return null;
      }
      const { ip } = await ipRes.json();
      const { port } = await portRes.json();
      return `http://${ip}:${port}`;
    } catch (err) {
      setSplitError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function toggleSplit() {
    if (splitOpen) {
      setSplitOpen(false);
      return;
    }
    const url = await resolveAppUrl();
    if (!url) return;
    setAppUrl(url);
    setSplitOpen(true);
  }

  async function refreshIframe() {
    // Re-resolve in case app.port changed since the panel was opened.
    const url = await resolveAppUrl();
    if (url) setAppUrl(url);
    setIframeNonce((n) => n + 1);
  }

  function openAppInNewTab() {
    if (!appUrl) return;
    window.open(appUrl, "_blank", "noopener");
  }

  function onDividerPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    draggingRef.current = true;
    const target = e.currentTarget;
    try { target.setPointerCapture(e.pointerId); } catch {}
  }

  function onDividerPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const wrap = splitWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const isVertical = window.matchMedia("(max-width: 720px)").matches;
    const raw = isVertical
      ? (e.clientY - rect.top) / rect.height
      : (e.clientX - rect.left) / rect.width;
    const clamped = Math.min(0.9, Math.max(0.1, raw));
    setSplitRatio(clamped);
  }

  function onDividerPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    localStorage.setItem("garrison.terminal.splitRatio", String(splitRatio));
  }

  return (
    <>
      <div className="header">
        <h1>Garrison Terminal</h1>
        <select
          className="project-picker"
          value={activeProject}
          onChange={(e) => pickProject(e.target.value)}
          title="Project picked here becomes the default cwd for new sessions / Claude Code"
        >
          <option value="">~ ($HOME)</option>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>{p.name}</option>
          ))}
          {activeProject && !projects.find((p) => p.path === activeProject) && (
            <option value={activeProject}>{activeProject}</option>
          )}
        </select>
        <div className="tabs">
          {sessions.map((s) => (
            <span
              key={s.id}
              className={`tab ${s.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(s.id)}
              title={s.cwd}
            >
              {isBusy(s.id) && <span className="spinner" aria-hidden="true" />}
              <span>{s.name}</span>
              <span className="close" onClick={(e) => { e.stopPropagation(); void close(s.id); }}>×</span>
            </span>
          ))}
        </div>
        <button type="button" className="btn" onClick={openClaudeDialog} disabled={busy} title="Open a new terminal and run claude">
          Claude Code
        </button>
        <button type="button" className="btn" onClick={openContinueDialog} disabled={busy} title="Open a new terminal and run claude --continue">
          Continue
        </button>
        <button type="button" className="btn primary" onClick={() => void newSessionAtProject()} disabled={busy} title={activeProject ? `New terminal at ${activeProject}` : "New terminal at $HOME"}>
          {busy ? "…" : "+ New"}
        </button>
        <button
          type="button"
          className={`btn ${splitOpen ? "primary" : ""}`}
          onClick={() => void toggleSplit()}
          disabled={!activeSession}
          title="Split this terminal with the app at <tailscale-ip>:<app.port>"
        >
          {splitOpen ? "Close app" : "Split app"}
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
      {splitError && <div className="alert">{splitError}</div>}
      <div ref={splitWrapRef} className={`split-wrap ${splitOpen ? "split-open" : ""}`}>
        <div
          className={`term-wrap ${sessions.length === 0 ? "empty" : ""}`}
          style={(splitOpen && appUrl) ? { flex: `0 0 calc(${splitRatio * 100}% - 3px)` } : undefined}
        >
          {sessions.map((s) => (
            <TerminalPane
              key={s.id}
              sessionId={s.id}
              isActive={s.id === activeId}
              onPtyData={noteSessionActivity}
            />
          ))}
          {sessions.length === 0 && <span>No active session. Click + New to start.</span>}
        </div>
        {splitOpen && appUrl && (
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
            <div className="app-pane" style={{ flex: `0 0 calc(${(1 - splitRatio) * 100}% - 3px)` }}>
              <div className="app-pane-header">
                <code className="app-pane-url">{appUrl}</code>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void refreshIframe()}
                  title="Reload the iframe (also re-reads app.port)"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={openAppInNewTab}
                  title="Open the app in a new tab — then press Cmd+Opt+I (Mac) or F12 for devtools"
                >
                  New tab
                </button>
              </div>
              <iframe
                key={iframeNonce}
                className="app-iframe"
                src={appUrl}
                title="app"
              />
            </div>
          </>
        )}
      </div>

      {dialog && (
        <div className="modal-overlay" onClick={() => setDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{dialog.mode === "continue" ? "Continue Claude Code" : "Open Claude Code"}</h2>
            <p className="modal-help">
              Directory to run <code>claude{dialog.mode === "continue" ? " --continue" : ""} --dangerously-skip-permissions</code> in.
              Leave blank for $HOME. If a claude tab is already open at this directory, it will be focused instead of spawning a new one.
            </p>
            <input
              autoFocus
              type="text"
              value={dialog.path}
              placeholder="/Users/you/dev/project"
              onChange={(e) => setDialog({ ...dialog, path: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitDialog();
                if (e.key === "Escape") setDialog(null);
              }}
            />
            <div className="modal-row">
              <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => void submitDialog()}>
                {dialog.mode === "continue" ? "Continue" : "Open"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
