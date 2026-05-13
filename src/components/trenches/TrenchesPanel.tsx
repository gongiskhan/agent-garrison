"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Terminal as TerminalIcon, Maximize2, Minimize2, Monitor, Plus, X, Settings } from "lucide-react";
import { TerminalView } from "./Terminal";
import { ScreenShare } from "./ScreenShare";
import { useAppShell } from "@/components/chrome/AppShell";
import { consumePendingLaunch, onLaunchClaude } from "@/lib/workbench-bus";

interface TrenchesSession {
  id: string;
  name: string;
  type: "terminal" | "screen-share";
  source?: "local" | "ssh" | "outpost";
  outpost?: string | null;
  cwd?: string;
  host?: { user: string; address: string } | null;
  busy: boolean;
  connected?: boolean;
}

interface CreateTerminalResponse extends TrenchesSession {
  wsUrl: string;
}

interface ManagedHost {
  name: string;
  address: string;
  user: string;
}

interface OutpostStatus {
  name: string;
  connected: boolean;
  lastHeartbeat: string | null;
}

const ORCHESTRATOR_BANNER = [
  "[garrison] This terminal is a separate session from the chat tab.",
  "[garrison] It shares compiled memory but not turn history.",
];

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildOrchestratorCommand(compositionDir: string): string {
  const promptPath = `${compositionDir}/.garrison/assembled-system-prompt.md`;
  const bannerLines = ORCHESTRATOR_BANNER.map(
    (line) => `printf '%s\\n' ${shellEscape(line)}`
  ).join("; ");
  return `${bannerLines}; claude --dangerously-skip-permissions --append-system-prompt-file ${shellEscape(promptPath)}`;
}

function buildClaudeCodeCommand(remotePath: string | null, continueSession?: boolean): string {
  const flags = continueSession ? "--dangerously-skip-permissions --continue" : "--dangerously-skip-permissions";
  const claude = `claude ${flags}`;
  if (remotePath) {
    // ~/foo must not be fully single-quoted — tilde doesn't expand inside single quotes
    const escapedPath = remotePath.startsWith("~/")
      ? `~/${shellEscape(remotePath.slice(2))}`
      : shellEscape(remotePath);
    return `cd ${escapedPath} && ${claude}`;
  }
  return claude;
}

export function TrenchesPanel() {
  const { composition, runnerState, setError: setShellError, sidebarCollapsed } = useAppShell();
  const sidebarW = sidebarCollapsed ? 48 : 244;
  const [sessions, setSessions] = useState<TrenchesSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [target, setTarget] = useState<string>("local");
  const [hosts, setHosts] = useState<ManagedHost[]>([]);
  const [outposts, setOutposts] = useState<OutpostStatus[]>([]);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claudeModal, setClaudeModal] = useState(false);
  const [claudePath, setClaudePath] = useState("");
  const [claudeContinueMode, setClaudeContinueMode] = useState(false);
  const [hostsModal, setHostsModal] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const parsedTarget = useMemo(() => {
    if (target === "local") return { kind: "local" as const };
    if (target.startsWith("ssh:")) {
      const n = target.slice(4);
      return { kind: "ssh" as const, host: hosts.find((h) => h.name === n) ?? null };
    }
    if (target.startsWith("outpost:")) {
      const n = target.slice(8);
      return { kind: "outpost" as const, name: n, status: outposts.find((o) => o.name === n) ?? null };
    }
    return { kind: "local" as const };
  }, [target, hosts, outposts]);

  const isOutpost = parsedTarget.kind === "outpost";
  const isSshHost = parsedTarget.kind === "ssh";
  const isRemote = isOutpost || isSshHost;
  const selectedHost = parsedTarget.kind === "ssh" ? parsedTarget.host : null;
  const isRunning = runnerState?.status === "running";
  const projectsRoot = composition?.globalConfig.projects_root ?? "~";
  const compositionDir = composition?.directory ?? null;

  useEffect(() => {
    setClaudePath((current) => (current ? current : `${projectsRoot}/`));
  }, [projectsRoot]);

  useEffect(() => {
    let cancelled = false;
    async function loadHosts() {
      try {
        const res = await fetch("/api/trenches/hosts", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { hosts: ManagedHost[] };
        if (!cancelled) setHosts(json.hosts ?? []);
      } catch {
        // ignore
      }
    }
    void loadHosts();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/workbench/outposts", { cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as { outposts?: OutpostStatus[] };
          if (!cancelled) setOutposts(json.outposts ?? []);
        }
      } catch {
        // ignore — outpost-host may not be running
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/trenches/sessions", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { sessions: TrenchesSession[]; wsUrl?: string };
      setSessions(json.sessions ?? []);
      if (json.wsUrl && json.wsUrl !== wsUrl) {
        setWsUrl(json.wsUrl);
      }
    } catch {
      // tolerate transient errors
    }
  }, [wsUrl]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (activeId && !sessions.some((s) => s.id === activeId)) {
      setActiveId(null);
    }
  }, [sessions, activeId]);

  const launchTerminal = useCallback(
    async (body: Record<string, unknown>) => {
      if (creating) return;
      setCreating(true);
      setError(null);
      try {
        const transportFields =
          parsedTarget.kind === "ssh" && parsedTarget.host
            ? { host: parsedTarget.host.name, sshUser: parsedTarget.host.user, sshAddress: parsedTarget.host.address }
            : parsedTarget.kind === "outpost"
              ? { outpost: parsedTarget.name }
              : {};
        const res = await fetch("/api/trenches/terminals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, ...transportFields }),
        });
        const json = (await res.json()) as CreateTerminalResponse | { error: string };
        if (!res.ok || "error" in json) {
          const msg = "error" in json ? json.error : `HTTP ${res.status}`;
          setError(msg);
          setShellError?.(msg);
          return;
        }
        setWsUrl(json.wsUrl);
        setSessions((prev) => {
          if (prev.some((s) => s.id === json.id)) return prev;
          return [...prev, { ...json }];
        });
        setActiveId(json.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
      } finally {
        setCreating(false);
      }
    },
    [creating, parsedTarget, setShellError]
  );

  // Direct launch that bypasses parsedTarget state timing — used for
  // worktree "Claude Code" button which supplies target explicitly.
  const handleLaunchClaude = useCallback(
    async (path: string, rawTarget: string, continueSession?: boolean) => {
      if (!path || !rawTarget) return;
      const projectName = path.split("/").filter(Boolean).pop() ?? "claude";
      const isOutpost = rawTarget.startsWith("outpost:");
      const outpostName = isOutpost ? rawTarget.slice(8) : null;
      const isSsh = rawTarget.startsWith("ssh:");
      const sshName = isSsh ? rawTarget.slice(4) : null;
      const sshHost = sshName ? hosts.find((h) => h.name === sshName) ?? null : null;

      setTarget(rawTarget);

      const body: Record<string, unknown> = outpostName
        ? {
            name: `claude-${outpostName}-${projectName}`,
            initialCommand: buildClaudeCodeCommand(path, continueSession),
            outpost: outpostName,
          }
        : sshHost
          ? {
              name: `claude-${sshName}-${projectName}`,
              initialCommand: buildClaudeCodeCommand(path, continueSession),
              host: sshHost.name,
              sshUser: sshHost.user,
              sshAddress: sshHost.address,
            }
          : {
              name: `claude-${projectName}`,
              cwd: path,
              initialCommand: buildClaudeCodeCommand(null, continueSession),
            };

      if (creating) return;
      setCreating(true);
      setError(null);
      try {
        const res = await fetch("/api/trenches/terminals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as CreateTerminalResponse | { error: string };
        if (!res.ok || "error" in json) {
          const msg = "error" in json ? json.error : `HTTP ${res.status}`;
          setError(msg);
          setShellError?.(msg);
          return;
        }
        const session = json as CreateTerminalResponse;
        setWsUrl(session.wsUrl);
        setSessions((prev) =>
          prev.some((s) => s.id === session.id) ? prev : [...prev, session]
        );
        setActiveId(session.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCreating(false);
      }
    },
    [creating, hosts, setShellError]
  );

  // Keep a stable ref so the mount-only effect always calls the latest version.
  const handleLaunchClaudeRef = useRef(handleLaunchClaude);
  useEffect(() => { handleLaunchClaudeRef.current = handleLaunchClaude; });

  // On mount: consume a pending launch queued before this tab was active.
  useEffect(() => {
    const p = consumePendingLaunch();
    if (p?.path) void handleLaunchClaudeRef.current(p.path, p.target, p.continueSession);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Already mounted: react to live launch events. Uses ref so re-subscription
  // is unnecessary — a stable listener with [] deps avoids the cleanup gap
  // that occurs when [handleLaunchClaude] deps cause churn.
  useEffect(() => {
    return onLaunchClaude((p) => {
      consumePendingLaunch(); // clear slot so remount doesn't double-fire
      if (p?.path) void handleLaunchClaudeRef.current(p.path, p.target, p.continueSession);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const newTerminal = useCallback(() => {
    void launchTerminal(parsedTarget.kind === "local" ? { cwd: projectsRoot } : {});
  }, [launchTerminal, projectsRoot, parsedTarget]);

  const openOrchestrator = useCallback(() => {
    if (!compositionDir || !isRunning || isRemote) return;
    void launchTerminal({
      name: "orchestrator",
      cwd: projectsRoot,
      initialCommand: buildOrchestratorCommand(compositionDir),
    });
  }, [compositionDir, isRunning, isRemote, launchTerminal, projectsRoot]);

  const openClaudeCode = useCallback((continueMode?: boolean) => {
    setClaudePath((current) => (current ? current : `${projectsRoot}/`));
    setClaudeContinueMode(continueMode ?? false);
    setClaudeModal(true);
  }, [projectsRoot]);

  const submitClaudeCode = useCallback((continueSession?: boolean) => {
    const trimmed = claudePath.trim();
    if (!trimmed) return;
    setClaudeModal(false);
    const projectName = trimmed.split("/").filter(Boolean).pop() ?? "claude";
    if (parsedTarget.kind === "ssh" && parsedTarget.host) {
      void launchTerminal({
        name: `claude-${parsedTarget.host.name}-${projectName}`,
        initialCommand: buildClaudeCodeCommand(trimmed, continueSession),
      });
    } else if (parsedTarget.kind === "outpost") {
      void launchTerminal({
        name: `claude-${parsedTarget.name}-${projectName}`,
        initialCommand: buildClaudeCodeCommand(trimmed, continueSession),
      });
    } else {
      void launchTerminal({
        name: `claude-${projectName}`,
        cwd: trimmed,
        initialCommand: buildClaudeCodeCommand(null, continueSession),
      });
    }
  }, [claudePath, launchTerminal, parsedTarget]);

  const closeSession = useCallback(
    async (id: string, type: TrenchesSession["type"] = "terminal", outpost?: string | null) => {
      try {
        if (type === "screen-share") {
          const url = outpost
            ? `/api/trenches/screen-share?outpost=${encodeURIComponent(outpost)}`
            : "/api/trenches/screen-share";
          await fetch(url, { method: "DELETE" });
        } else {
          await fetch(`/api/trenches/terminals/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
        }
      } catch {
        // server-side error tolerated; refresh will surface state
      } finally {
        await refresh();
      }
    },
    [refresh]
  );

  const startScreenShare = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const url = isOutpost
        ? `/api/trenches/screen-share?outpost=${encodeURIComponent(parsedTarget.kind === "outpost" ? parsedTarget.name : "")}`
        : "/api/trenches/screen-share";
      const res = await fetch(url, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      setActiveId(json.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [creating, isOutpost, parsedTarget, refresh]);

  const active = useMemo(() => sessions.find((s) => s.id === activeId) ?? null, [sessions, activeId]);

  const orchestratorTooltip = isRemote
    ? "Open Orchestrator is local-only; the Operative's prompt lives on this machine."
    : !isRunning
      ? "No composition is running — start one from the Run tab first."
      : "Open the Operative in this terminal";

  const handleTargetChange = (value: string) => {
    if (value === "__manage__") {
      setHostsModal(true);
      return;
    }
    setTarget(value);
  };

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMaximized(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  const newTerminalTitle = parsedTarget.kind === "outpost"
    ? `New terminal on outpost ${parsedTarget.name}`
    : parsedTarget.kind === "ssh" && parsedTarget.host
      ? `New SSH terminal on ${parsedTarget.host.name}`
      : "New terminal";

  return (
    <main>
      <div className="crumbs">
        <b>Trenches</b>
      </div>
      <div className="page wide">
        <div className="head">
          <h1
            className="font-display"
            style={{ fontSize: 28, fontWeight: 600, margin: "0 0 4px", letterSpacing: "-0.01em" }}
          >
            Trenches
          </h1>
          <p className="ld">
            Embedded terminals and screen sharing. Sessions are in-memory only — they don&apos;t survive a Garrison restart.
          </p>
        </div>

        {error ? (
          <div
            style={{
              border: "1px solid var(--rule)",
              background: "#fff5f0",
              padding: "10px 14px",
              fontSize: 12.5,
              color: "var(--ink)",
              marginBottom: 12,
            }}
          >
            <b>error</b> · {error}
          </div>
        ) : null}

        <section
          style={maximized ? {
            position: "fixed",
            left: sidebarW,
            top: 0,
            right: 0,
            bottom: 0,
            zIndex: 100,
            background: "white",
            display: "grid",
            gridTemplateRows: "auto 1fr",
          } : {
            border: "1px solid var(--rule)",
            background: "white",
            display: "grid",
            gridTemplateRows: "auto 1fr",
            minHeight: 560,
            marginBottom: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: "10px 14px",
              borderBottom: "1px solid var(--rule)",
              alignItems: "center",
            }}
          >
            <button
              className="btn primary"
              disabled={creating}
              onClick={() => newTerminal()}
              title={newTerminalTitle}
            >
              <span className="ic">
                <Plus size={14} aria-hidden />
              </span>
              {creating ? "Starting…" : "New Terminal"}
            </button>
            <button
              className="btn ghost"
              disabled={creating}
              onClick={() => void startScreenShare()}
              title="Start screen share"
            >
              <span className="ic">
                <Monitor size={14} aria-hidden />
              </span>
              New Screen Share
            </button>
            <span style={{ flex: 1 }} />
            <button
              className="btn ghost"
              disabled={creating || isRemote || !isRunning || !compositionDir}
              onClick={() => openOrchestrator()}
              title={orchestratorTooltip}
            >
              <span className="ic">
                <TerminalIcon size={14} aria-hidden />
              </span>
              Open Orchestrator
            </button>
            <button
              className="btn ghost"
              disabled={creating}
              onClick={() => openClaudeCode()}
              title={isRemote ? `Open Claude Code on ${parsedTarget.kind === "outpost" ? parsedTarget.name : (selectedHost?.name ?? target)}` : "Open Claude Code at a project path"}
            >
              <span className="ic">
                <TerminalIcon size={14} aria-hidden />
              </span>
              Open Claude Code
            </button>
            <button
              className="btn ghost"
              disabled={creating}
              onClick={() => openClaudeCode(true)}
              title={isRemote ? `Continue last Claude Code session on ${parsedTarget.kind === "outpost" ? parsedTarget.name : (selectedHost?.name ?? target)}` : "Continue last Claude Code session at a project path"}
            >
              <span className="ic">
                <TerminalIcon size={14} aria-hidden />
              </span>
              Continue Claude Code
            </button>
            <select
              className="font-mono"
              value={target}
              onChange={(e) => handleTargetChange(e.target.value)}
              style={{
                padding: "6px 8px",
                fontSize: 12,
                border: "1px solid var(--rule)",
                background: "white",
              }}
              title="Where to run this terminal"
            >
              <option value="local">local</option>
              {hosts.length > 0 && (
                <optgroup label="SSH hosts">
                  {hosts.map((h) => (
                    <option key={`ssh:${h.name}`} value={`ssh:${h.name}`}>
                      {h.name} · {h.address}
                    </option>
                  ))}
                </optgroup>
              )}
              {outposts.length > 0 && (
                <optgroup label="Outposts">
                  {outposts.map((o) => (
                    <option
                      key={`outpost:${o.name}`}
                      value={`outpost:${o.name}`}
                      disabled={!o.connected}
                      title={o.connected ? o.name : `${o.name} — disconnected`}
                    >
                      {o.name}{o.connected ? "" : " (disconnected)"}
                    </option>
                  ))}
                </optgroup>
              )}
              <option value="__manage__">Manage hosts…</option>
            </select>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setMaximized((m) => !m)}
              title={maximized ? "Exit fullscreen (Esc)" : "Maximize"}
            >
              <span className="ic">
                {maximized ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
              </span>
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", minHeight: 0 }}>
            <aside
              style={{
                borderRight: "1px solid var(--rule)",
                padding: "10px 0",
                background: "var(--bg-soft, #fafaf7)",
                overflowY: "auto",
              }}
            >
              {sessions.length === 0 ? (
                <div style={{ padding: "16px 14px", color: "var(--mute)", fontSize: 12 }}>
                  No sessions yet.
                </div>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.id}
                    className={clsx("trenches-tab", s.id === activeId && "active")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "8px 14px",
                      borderBottom: "1px solid var(--rule)",
                      background: s.id === activeId ? "white" : "transparent",
                      fontSize: 12.5,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveId(s.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flex: 1,
                        background: "transparent",
                        border: "none",
                        textAlign: "left",
                        padding: 0,
                        cursor: "pointer",
                        fontSize: 12.5,
                      }}
                    >
                      <span className="ic">
                        {s.type === "terminal" ? (
                          <TerminalIcon size={14} aria-hidden />
                        ) : (
                          <Monitor size={14} aria-hidden />
                        )}
                      </span>
                      <span style={{ flex: 1 }}>
                        {s.name}
                        {s.outpost ? (
                          <span style={{ marginLeft: 4, color: "var(--mute)", fontSize: 11 }}>
                            @{s.outpost}
                          </span>
                        ) : null}
                      </span>
                      <span
                        title={s.busy ? "busy" : "idle"}
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          background: s.busy ? "var(--sage, #6a8e5a)" : "var(--rule)",
                        }}
                      />
                    </button>
                    <button
                      type="button"
                      title="Close session"
                      onClick={() => void closeSession(s.id, s.type, s.outpost)}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--mute)",
                        padding: 2,
                      }}
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </div>
                ))
              )}
            </aside>

            <main style={{ padding: 0, overflow: "hidden", display: "flex", minHeight: 0 }}>
              {active && active.type === "terminal" && wsUrl ? (
                <TerminalView sessionId={active.id} wsUrl={wsUrl} />
              ) : active && active.type === "screen-share" ? (
                <ScreenShare outpost={active.outpost} />
              ) : active ? (
                <div style={{ padding: 24, color: "var(--mute)", fontSize: 13 }}>
                  Session <code className="font-mono">{active.id}</code> — unknown type.
                </div>
              ) : (
                <div
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    color: "var(--mute)",
                    padding: 32,
                    textAlign: "center",
                  }}
                >
                  <TerminalIcon size={32} aria-hidden style={{ opacity: 0.4 }} />
                  <p style={{ margin: 0, fontSize: 14 }}>No sessions yet. Click New Terminal to start.</p>
                </div>
              )}
            </main>
          </div>
        </section>
      </div>

      {claudeModal ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 15, 15, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
          onClick={() => setClaudeModal(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "white",
              border: "1px solid var(--rule)",
              padding: 24,
              width: 480,
              maxWidth: "92vw",
            }}
          >
            <h3 className="font-display" style={{ margin: "0 0 6px", fontSize: 18 }}>
              {claudeContinueMode ? "Continue" : "Open"} Claude Code{parsedTarget.kind === "outpost" ? ` on ${parsedTarget.name}` : parsedTarget.kind === "ssh" && parsedTarget.host ? ` on ${parsedTarget.host.name}` : ""}
            </h3>
            <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--mute)" }}>
              {parsedTarget.kind === "outpost"
                ? <>Path on outpost <b>{parsedTarget.name}</b>. Runs <code>claude --dangerously-skip-permissions{claudeContinueMode ? " --continue" : ""}</code> on the remote machine.</>
                : parsedTarget.kind === "ssh" && parsedTarget.host
                  ? <>Path on <b>{parsedTarget.host.name}</b>. SSH connects, then runs <code>claude --dangerously-skip-permissions{claudeContinueMode ? " --continue" : ""}</code>.</>
                  : <>Path on this machine. A new terminal opens at this directory and runs <code>claude --dangerously-skip-permissions{claudeContinueMode ? " --continue" : ""}</code>.</>}
            </p>
            <input
              autoFocus
              type="text"
              value={claudePath}
              onChange={(e) => setClaudePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitClaudeCode(claudeContinueMode);
                if (e.key === "Escape") setClaudeModal(false);
              }}
              className="font-mono"
              style={{
                width: "100%",
                padding: "8px 10px",
                fontSize: 13,
                border: "1px solid var(--rule)",
                marginBottom: 14,
              }}
              placeholder={`${projectsRoot}/<project>`}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setClaudeModal(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => submitClaudeCode(claudeContinueMode)} disabled={!claudePath.trim()}>
                {claudeContinueMode ? "Continue" : "Open"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {hostsModal ? (
        <HostsModal
          hosts={hosts}
          onClose={() => setHostsModal(false)}
          onChange={(next) => setHosts(next)}
        />
      ) : null}
    </main>
  );
}

interface HostsModalProps {
  hosts: ManagedHost[];
  onClose: () => void;
  onChange: (next: ManagedHost[]) => void;
}

function HostsModal({ hosts, onClose, onChange }: HostsModalProps) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || !address.trim() || !user.trim()) {
      setError("Name, address, and user are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/trenches/hosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), address: address.trim(), user: user.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? `HTTP ${res.status}`);
        return;
      }
      onChange(json.hosts);
      setName("");
      setAddress("");
      setUser("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (target: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/trenches/hosts/${encodeURIComponent(target)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (res.ok) {
        onChange(json.hosts);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 15, 15, 0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          border: "1px solid var(--rule)",
          padding: 24,
          width: 540,
          maxWidth: "92vw",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Settings size={16} aria-hidden />
          <h3 className="font-display" style={{ margin: 0, fontSize: 18 }}>
            Manage hosts
          </h3>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--mute)" }}>
          Tailscale or SSH-reachable machines. Auth uses your local SSH config — keys must already be set up.
          Stored in <code className="font-mono">~/.garrison/hosts.json</code>.
        </p>

        {hosts.length === 0 ? (
          <div style={{ padding: "12px 0", color: "var(--mute)", fontSize: 12.5 }}>
            No hosts yet. Local is always available.
          </div>
        ) : (
          <table className="font-mono" style={{ width: "100%", fontSize: 12, marginBottom: 14, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--mute)" }}>
                <th style={{ padding: "6px 8px" }}>name</th>
                <th style={{ padding: "6px 8px" }}>address</th>
                <th style={{ padding: "6px 8px" }}>user</th>
                <th style={{ padding: "6px 8px", width: 24 }}></th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((h) => (
                <tr key={h.name} style={{ borderTop: "1px solid var(--rule)" }}>
                  <td style={{ padding: "6px 8px" }}>{h.name}</td>
                  <td style={{ padding: "6px 8px" }}>{h.address}</td>
                  <td style={{ padding: "6px 8px" }}>{h.user}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>
                    <button
                      type="button"
                      title="Delete"
                      onClick={() => void remove(h.name)}
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--mute)",
                      }}
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
          <input
            placeholder="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="font-mono"
            style={{ padding: "8px 10px", fontSize: 12.5, border: "1px solid var(--rule)" }}
          />
          <input
            placeholder="100.x.y.z or hostname"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="font-mono"
            style={{ padding: "8px 10px", fontSize: 12.5, border: "1px solid var(--rule)" }}
          />
          <input
            placeholder="user"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            className="font-mono"
            style={{ padding: "8px 10px", fontSize: 12.5, border: "1px solid var(--rule)" }}
          />
        </div>

        {error ? (
          <div style={{ marginBottom: 10, fontSize: 12, color: "var(--alarm, #b03030)" }}>{error}</div>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            Add host
          </button>
        </div>
      </div>
    </div>
  );
}
