// New shell: start a fresh (or resumed) CLI session on ANY mesh node, in any
// project folder, for any runtime the target node's Shells fitting can see.
// Talks to the target node's fitting DIRECTLY (shell-origin.ts) - never a
// same-origin relay, since the node picked here is usually not "this node".

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { errorCopy, resolveShellOrigin, shellFetch, ShellOriginError } from "./shell-origin";

export interface NewShellNodeOption {
  node: string;
  accentColor: string | null;
  shellOrigin?: string | null;
}

export interface NewShellStartedSession {
  id: string;
  tmuxSession: string;
  cwd?: string | null;
  label?: string | null;
}

export interface NewShellSpec {
  node: string;
  origin: string;
  transport: string;
  runtime: string;
  cwd: string;
  label: string;
  session: NewShellStartedSession;
}

interface RuntimeOption { id: string; label: string; available: boolean; path: string | null }
interface ProjectRow { name: string; path: string }

export function NewShellModal({
  nodes,
  self,
  onStarted,
  onClose,
}: {
  nodes: NewShellNodeOption[];
  self: NewShellNodeOption;
  onStarted: (spec: NewShellSpec) => void;
  onClose: () => void;
}) {
  const allNodes = useMemo(() => {
    const seen = new Set<string>();
    const out: NewShellNodeOption[] = [];
    for (const n of [self, ...nodes]) {
      if (!n.node || seen.has(n.node)) continue;
      seen.add(n.node);
      out.push(n);
    }
    return out;
  }, [nodes, self]);

  const [node, setNode] = useState(self.node ?? "");
  const [origin, setOrigin] = useState<string>("");
  const [originError, setOriginError] = useState<ShellOriginError | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([]);
  const [runtime, setRuntime] = useState("shell");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [cwd, setCwd] = useState("");
  const [manualPath, setManualPath] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setOrigin("");
    setOriginError(null);
    setRuntimes([]);
    setProjects([]);
    if (!node) return;
    const shellOrigin = allNodes.find((n) => n.node === node)?.shellOrigin ?? null;
    void resolveShellOrigin({ node, shellOrigin }, self.node)
      .then(async (o) => {
        if (!alive) return;
        if (!o) {
          setOriginError(new ShellOriginError("no-origin", "no reachable origin"));
          return;
        }
        setOrigin(o);
        try {
          const rt = await shellFetch<{ runtimes: RuntimeOption[] }>(o, "/runtimes?transport=local");
          if (alive) setRuntimes(rt.runtimes ?? []);
        } catch { /* runtime list optional */ }
        try {
          const pr = await shellFetch<{ projects: ProjectRow[] }>(o, "/projects?transport=local");
          if (alive) setProjects(pr.projects ?? []);
        } catch { /* project list optional */ }
      })
      .catch((err) => { if (alive) setOriginError(err instanceof ShellOriginError ? err : new ShellOriginError("unreachable", String(err))); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, self.node]);

  const nodeAccent = allNodes.find((n) => n.node === node)?.accentColor ?? null;

  const start = useCallback(async () => {
    if (!origin) return;
    const path = manualPath ? cwd.trim() : cwd;
    if (!path) { setError("choose or type a project folder"); return; }
    setBusy(true);
    setError(null);
    try {
      const body = await shellFetch<{ session: NewShellStartedSession }>(origin, "/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transport: "local", runtime, cwd: path, label: path.split("/").pop() || path, allocate: true })
      });
      if (!body.session?.tmuxSession) throw new Error("the shell started no session");
      onStarted({ node, origin, transport: "local", runtime, cwd: path, label: body.session.label ?? path, session: body.session });
    } catch (err) {
      setError(err instanceof ShellOriginError ? errorCopy(err, node).sub : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [origin, manualPath, cwd, runtime, node, onStarted]);

  return (
    <div className="wc-prompt-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="wc-prompt wc-shells" role="dialog" aria-label="New shell" data-testid="newshell-modal">
        <div className="wc-prompt-title">New shell</div>

        <div className="wc-newshell-seg" role="radiogroup" aria-label="Node">
          {allNodes.map((n) => (
            <button
              key={n.node}
              type="button"
              data-testid={`newshell-node-${n.node}`}
              aria-pressed={node === n.node}
              className={node === n.node ? "wc-newshell-seg-active" : ""}
              onClick={() => setNode(n.node)}
            >
              <span className="wc-row-dot" style={{ background: n.accentColor || "#6a746b" }} aria-hidden />
              {n.node}
            </button>
          ))}
        </div>

        {originError && (
          <div className="wc-shells-error" data-testid="newshell-error">{errorCopy(originError, node).title}: {errorCopy(originError, node).sub}</div>
        )}

        {origin && (
          <>
            <div className="wc-newshell-seg" role="radiogroup" aria-label="Runtime">
              {["shell", "claude", "codex", "cursor", "gemini"].map((id) => {
                const known = runtimes.find((r) => r.id === id);
                const unavailable = id !== "shell" && known && !known.available;
                return (
                  <button
                    key={id}
                    type="button"
                    data-testid={`newshell-runtime-${id}`}
                    aria-pressed={runtime === id}
                    disabled={Boolean(unavailable)}
                    title={unavailable ? `not available on ${node}` : undefined}
                    className={runtime === id ? "wc-newshell-seg-active" : ""}
                    onClick={() => setRuntime(id)}
                  >
                    {id === "shell" ? "Shell" : id.charAt(0).toUpperCase() + id.slice(1)}
                  </button>
                );
              })}
            </div>

            {!manualPath && projects.length > 0 ? (
              <select
                className="wc-newshell-select"
                data-testid="newshell-project"
                value={cwd}
                onChange={(e) => (e.target.value === "__manual__" ? setManualPath(true) : setCwd(e.target.value))}
              >
                <option value="" disabled>Pick a project…</option>
                {projects.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
                <option value="__manual__">Type a path…</option>
              </select>
            ) : (
              <input
                className="wc-newshell-input"
                data-testid="newshell-path"
                placeholder="~/dev/my-project"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                autoFocus={manualPath}
              />
            )}

            {error && <div className="wc-shells-error" data-testid="newshell-error">{error}</div>}
          </>
        )}

        <div className="wc-prompt-actions">
          <button type="button" className="wc-prompt-cancel" data-testid="newshell-cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="wc-prompt-save" data-testid="newshell-start" disabled={!origin || busy || !cwd} onClick={() => void start()}>
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
