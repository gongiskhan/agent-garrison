// The Shells picker: spawn (or reattach to) interactive agent sessions in any
// project folder on a remote transport, from one modal.
//
// The deliberate shape: NO standing UI surface. One button in the sidebar head
// opens this; it lists the transport's ~/dev folders (asked live over ssh, so
// what you see is what is actually there), shows EVERY session already running
// in each, takes a manual path for anything outside ~/dev, and offers Stop for
// sessions whose work is done. Opening is idempotent - picking a session that
// already exists simply attaches to it - and "+" on a project starts ANOTHER
// agent beside the ones it already has.
//
// Once open, a session is an ordinary row in the sessions rail (with its own
// live Working badge), so this modal is the spawner, not the switcher.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface ShellTransportOption {
  name: string;
  label?: string;
}

export interface ShellOpenSpec {
  transport: string;
  tmuxSession: string;
  cwd: string;
  label: string;
}

export interface ShellSpawnSpec {
  transport: string;
  /** The base tmux name; the fitting numbers the instance beside any it finds. */
  base: string;
  cwd: string;
  label: string;
}

interface SessionRow {
  id: string;
  transport: string;
  label: string;
  tmuxSession: string;
  cwd: string | null;
  state: string;
  standing?: boolean;
}

interface ProjectRow {
  name: string;
  path: string;
  sessions: SessionRow[];
}

export function slugForProject(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "proj";
}

export function ShellsModal({ transports, onOpen, onSpawn, onClose }: {
  transports: ShellTransportOption[];
  onOpen: (spec: ShellOpenSpec) => void;
  onSpawn: (spec: ShellSpawnSpec) => void;
  onClose: () => void;
}) {
  const [transport, setTransport] = useState<string>(transports[0]?.name ?? "");
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const reloadRef = useRef(0);

  const load = useCallback((t: string) => {
    if (!t) return;
    const epoch = ++reloadRef.current;
    setProjects(null);
    setError(null);
    void Promise.all([
      fetch(`/api/remote-shell/projects?transport=${encodeURIComponent(t)}`).then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || `project listing failed (${r.status})`);
        return Array.isArray(d?.projects) ? d.projects : [];
      }),
      fetch("/api/remote-shell/sessions").then(async (r) => {
        const d = await r.json().catch(() => ({}));
        return Array.isArray(d?.sessions) ? d.sessions : [];
      })
    ]).then(([proj, sess]) => {
      if (epoch !== reloadRef.current) return;
      setProjects(proj);
      setSessions(sess.filter((x: SessionRow) => x.transport === t));
    }).catch((err) => {
      if (epoch !== reloadRef.current) return;
      setProjects([]);
      setError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  useEffect(() => { load(transport); }, [transport, load]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const attach = useCallback((s: SessionRow) => {
    onOpen({
      transport: s.transport,
      tmuxSession: s.tmuxSession,
      cwd: s.cwd ?? "~",
      label: s.label
    });
  }, [onOpen]);

  const spawn = useCallback((p: { name: string; path: string }) => {
    if (!transport) return;
    onSpawn({ transport, base: slugForProject(p.name), cwd: p.path, label: p.name });
  }, [transport, onSpawn]);

  // A project row opens what is there and starts one when nothing is: the
  // common case is one agent per folder, and asking first would put a dialog in
  // front of the only sensible answer.
  const openProject = useCallback((p: ProjectRow) => {
    if (p.sessions.length > 0) attach(p.sessions[0]);
    else spawn(p);
  }, [attach, spawn]);

  const openManual = useCallback(() => {
    const path = manualPath.trim().replace(/\/+$/, "");
    if (!path) return;
    const name = path.split("/").filter(Boolean).pop() ?? "shell";
    const here = sessions.filter((s) => s.cwd === path);
    if (here.length > 0) attach(here[0]);
    else onSpawn({ transport, base: slugForProject(name), cwd: path, label: name });
  }, [manualPath, sessions, transport, attach, onSpawn]);

  const stopSession = useCallback(async (id: string) => {
    setBusy(true);
    try {
      await fetch(`/api/remote-shell/sessions/${encodeURIComponent(id)}?kill=1`, { method: "DELETE" });
    } catch { /* the reload below shows the truth either way */ }
    setBusy(false);
    load(transport);
  }, [transport, load]);

  // Sessions that exist but match no listed project (manual paths, the
  // transport's standing session) still deserve a row - they are exactly the
  // ones you cannot rediscover by clicking a folder.
  const projectSessionIds = useMemo(
    () => new Set((projects ?? []).flatMap((p) => p.sessions.map((s) => s.id))),
    [projects]
  );
  const extraSessions = sessions.filter((s) => !projectSessionIds.has(s.id));

  const sessionRow = (s: SessionRow, sub: boolean) => (
    <div key={s.id} className={`wc-shells-row${sub ? " wc-shells-row--sub" : ""}`}>
      <span className={`wc-shells-dot wc-shells-dot--${s.state === "running" ? "running" : "idle"}`} aria-hidden />
      <button type="button" className="wc-shells-open" onClick={() => attach(s)}>
        <span className="wc-shells-name">{s.label}</span>
        <span className="wc-shells-path">
          {s.state === "running" ? "working" : "idle"}
          {" · "}
          {/* Under its project the folder is already on the row above; what
              tells two agents apart there is the tmux session. */}
          {sub ? s.tmuxSession : (s.cwd ?? s.tmuxSession)}
        </span>
      </button>
      <button type="button" className="wc-shells-stop" disabled={busy} onClick={() => { void stopSession(s.id); }}>
        Stop
      </button>
    </div>
  );

  return (
    <div className="wc-prompt-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wc-prompt wc-shells" role="dialog" aria-label="Interactive shells">
        <div className="wc-prompt-title">Interactive shells</div>

        {transports.length > 1 && (
          <label className="wc-shells-transport">
            Machine
            <select value={transport} onChange={(e) => setTransport(e.target.value)}>
              {transports.map((t) => <option key={t.name} value={t.name}>{t.label || t.name}</option>)}
            </select>
          </label>
        )}

        {extraSessions.length > 0 && (
          <>
            <div className="wc-shells-head">Other sessions</div>
            <div className="wc-shells-list">{extraSessions.map((s) => sessionRow(s, false))}</div>
          </>
        )}

        <div className="wc-shells-head">Projects on {transports.find((t) => t.name === transport)?.label || transport}</div>
        {projects === null && <div className="wc-shells-empty">Listing ~/dev over the tunnel…</div>}
        {projects !== null && projects.length === 0 && !error && <div className="wc-shells-empty">Nothing under ~/dev on this machine</div>}
        {error && <div className="wc-shells-error">{error}</div>}
        {projects !== null && projects.length > 0 && (
          <div className="wc-shells-list wc-shells-list--projects">
            {projects.map((p) => (
              <div key={p.path} className="wc-shells-project">
                <div className="wc-shells-row">
                  <span
                    className={`wc-shells-dot${p.sessions.some((s) => s.state === "running")
                      ? " wc-shells-dot--running"
                      : p.sessions.length > 0 ? " wc-shells-dot--idle" : ""}`}
                    aria-hidden
                  />
                  <button type="button" className="wc-shells-open" onClick={() => openProject(p)}>
                    <span className="wc-shells-name">{p.name}</span>
                    <span className="wc-shells-path">
                      {p.sessions.length === 0
                        ? p.path
                        : `${p.sessions.length} session${p.sessions.length > 1 ? "s" : ""} · ${p.path}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="wc-shells-add"
                    title={`Start another agent in ${p.name}`}
                    aria-label={`Start another agent in ${p.name}`}
                    onClick={() => spawn(p)}
                  >
                    +
                  </button>
                </div>
                {p.sessions.length > 1 && p.sessions.map((s) => sessionRow(s, true))}
              </div>
            ))}
          </div>
        )}

        <div className="wc-shells-manual">
          <input
            value={manualPath}
            placeholder="Or a path on the machine, e.g. ~/work/thing"
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") openManual(); }}
          />
          <button type="button" disabled={!manualPath.trim()} onClick={openManual}>Open path</button>
        </div>

        <div className="wc-prompt-actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
