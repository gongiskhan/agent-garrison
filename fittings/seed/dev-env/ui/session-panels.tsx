import React, { useEffect, useState } from "react";

// Header dropdown surfacing Claude Code's own session data: live "Agents" (the
// ~/.claude/sessions registry, across all projects) and past "History" (titled
// transcripts). Clicking either opens it as a tab (POST /sessions/open) — the
// Claude PTY resumes lazily on first focus. Tabs themselves are the open-set
// (openedInDevEnv); these two lists are what's NOT already a tab.

interface Agent {
  sessionId: string;
  cwd: string;
  pid: number;
  status: string | null;
  isOpen: boolean;
  tabId: string | null;
}

interface HistoryItem {
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  startedAt: string | null;
  lastActivityAt: number;
}

function basename(p: string): string {
  const parts = (p || "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// project label = last two path segments (so a worktree under ~/.worktrees/<repo>/<slug>
// or a repo subdir reads clearly), else the basename.
function projectLabel(cwd: string | null): string {
  if (!cwd) return "(unknown)";
  const parts = cwd.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : basename(cwd);
}

function relTime(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function groupByProject<T extends { cwd: string | null }>(items: T[]): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = projectLabel(it.cwd);
    const arr = map.get(k);
    if (arr) arr.push(it);
    else map.set(k, [it]);
  }
  return [...map.entries()];
}

export function SessionsPanel({
  onOpen,
  onClose
}: {
  onOpen: (sessionId: string, cwd: string, title: string | null) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [a, h] = await Promise.all([
          fetch("/sessions/agents").then((r) => r.json()),
          fetch("/sessions/history").then((r) => r.json())
        ]);
        if (!alive) return;
        setAgents(Array.isArray(a?.agents) ? a.agents : []);
        setHistory(Array.isArray(h?.history) ? h.history : []);
      } catch {
        /* keep empties */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="sessions-panel" onClick={(e) => e.stopPropagation()}>
      <div className="sp-section">
        <div className="sp-head">
          Agents <span className="sp-count">{agents.length}</span>
        </div>
        {!loading && agents.length === 0 && <div className="sp-empty">No live sessions.</div>}
        {groupByProject(agents).map(([proj, rows]) => (
          <div key={proj} className="sp-group">
            <div className="sp-proj">{proj}</div>
            {rows.map((a) => (
              <button
                key={a.sessionId}
                type="button"
                className="sp-row"
                title={a.cwd}
                onClick={() => {
                  onOpen(a.sessionId, a.cwd, null);
                  onClose();
                }}
              >
                <span className={`sp-dot ${a.status ?? "idle"}`} aria-hidden="true" />
                <span className="sp-row-main">{a.status ?? "live"}</span>
                {a.isOpen && <span className="sp-tag">open</span>}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="sp-sep" />

      <div className="sp-section">
        <div className="sp-head">History</div>
        {loading && <div className="sp-empty">Loading…</div>}
        {!loading && history.length === 0 && <div className="sp-empty">No past sessions.</div>}
        {groupByProject(history).map(([proj, rows]) => (
          <div key={proj} className="sp-group">
            <div className="sp-proj">{proj}</div>
            {rows.map((h) => (
              <button
                key={h.sessionId}
                type="button"
                className="sp-row"
                title={h.cwd ?? ""}
                disabled={!h.cwd}
                onClick={() => {
                  if (h.cwd) {
                    onOpen(h.sessionId, h.cwd, h.title);
                    onClose();
                  }
                }}
              >
                <span className="sp-row-main">{h.title ?? "(untitled session)"}</span>
                <span className="sp-time">{relTime(h.lastActivityAt)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
