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

function TerminalPane({ sessionId, isActive }: { sessionId: string; isActive: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
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
        return;
      }
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : (ev.data as Uint8Array);
      term.write(buf);
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
      </div>
      {error && <div className="alert">{error}</div>}
      <div className={`term-wrap ${sessions.length === 0 ? "empty" : ""}`}>
        {sessions.map((s) => (
          <TerminalPane key={s.id} sessionId={s.id} isActive={s.id === activeId} />
        ))}
        {sessions.length === 0 && <span>No active session. Click + New to start.</span>}
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
