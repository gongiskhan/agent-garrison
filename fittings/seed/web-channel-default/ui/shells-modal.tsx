// The Shells picker: spawn (or reattach to) an interactive agent session in
// any project folder on a remote transport, from one modal.
//
// The deliberate shape: NO standing UI surface. One button in the sidebar head
// opens this; it lists the transport's ~/dev folders (asked live over ssh, so
// what you see is what is actually there), marks the ones that already have a
// session, takes a manual path for anything outside ~/dev, and offers Stop for
// sessions whose work is done. Opening is idempotent - picking a project that
// already has a session simply attaches to it.

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

interface ProjectRow {
  name: string;
  path: string;
  sessionId: string | null;
  state: string | null;
}

interface SessionRow {
  id: string;
  transport: string;
  label: string;
  tmuxSession: string;
  cwd: string | null;
  state: string;
}

export function slugForProject(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "proj";
}

export function ShellsModal({ transports, onOpen, onClose }: {
  transports: ShellTransportOption[];
  onOpen: (spec: ShellOpenSpec) => void;
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

  const openProject = useCallback((p: { name: string; path: string }) => {
    if (!transport) return;
    onOpen({
      transport,
      tmuxSession: slugForProject(p.name),
      cwd: p.path,
      label: p.name
    });
  }, [transport, onOpen]);

  const openManual = useCallback(() => {
    const path = manualPath.trim().replace(/\/+$/, "");
    if (!path) return;
    const name = path.split("/").filter(Boolean).pop() ?? "shell";
    openProject({ name, path });
  }, [manualPath, openProject]);

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
  const projectPaths = useMemo(() => new Set((projects ?? []).map((p) => p.path)), [projects]);
  const extraSessions = sessions.filter((s) => !s.cwd || !projectPaths.has(s.cwd));

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
            <div className="wc-shells-head">Open sessions</div>
            <div className="wc-shells-list">
              {extraSessions.map((s) => (
                <div key={s.id} className="wc-shells-row">
                  <span className={`wc-shells-dot wc-shells-dot--${s.state === "running" ? "running" : "idle"}`} aria-hidden />
                  <button
                    type="button"
                    className="wc-shells-open"
                    onClick={() => onOpen({
                      transport: s.transport,
                      tmuxSession: s.tmuxSession,
                      cwd: s.cwd ?? "~",
                      label: s.label
                    })}
                  >
                    <span className="wc-shells-name">{s.label}</span>
                    <span className="wc-shells-path">{s.cwd ?? s.tmuxSession}</span>
                  </button>
                  <button type="button" className="wc-shells-stop" disabled={busy} onClick={() => { void stopSession(s.id); }}>
                    Stop
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="wc-shells-head">Projects on {transports.find((t) => t.name === transport)?.label || transport}</div>
        {projects === null && <div className="wc-shells-empty">Listing ~/dev over the tunnel…</div>}
        {projects !== null && projects.length === 0 && !error && <div className="wc-shells-empty">Nothing under ~/dev on this machine</div>}
        {error && <div className="wc-shells-error">{error}</div>}
        {projects !== null && projects.length > 0 && (
          <div className="wc-shells-list wc-shells-list--projects">
            {projects.map((p) => {
              const live = sessions.find((s) => s.id === p.sessionId) ?? null;
              return (
                <div key={p.path} className="wc-shells-row">
                  <span
                    className={`wc-shells-dot${live ? ` wc-shells-dot--${live.state === "running" ? "running" : "idle"}` : ""}`}
                    aria-hidden
                  />
                  <button type="button" className="wc-shells-open" onClick={() => openProject(p)}>
                    <span className="wc-shells-name">{p.name}</span>
                    <span className="wc-shells-path">{live ? "session open - click to attach" : p.path}</span>
                  </button>
                  {live && (
                    <button type="button" className="wc-shells-stop" disabled={busy} onClick={() => { void stopSession(live.id); }}>
                      Stop
                    </button>
                  )}
                </div>
              );
            })}
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
