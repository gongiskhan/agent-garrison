"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";

type SessionStatus = "starting" | "working" | "waiting" | "idle" | "errored" | "dead";

interface AggregatedSession {
  branch: string;
  worktreePath: string;
  lastStatus: SessionStatus;
  lastStatusAt: string;
  projectName: string;
  projectPath: string;
  machine: string;
  online: boolean;
}

interface TrenchesSession {
  id: string;
  cwd?: string;
  outpost?: string | null;
}

interface OutpostSummary {
  name: string;
  online: boolean;
  lastSyncedAt: string | null;
}

const STATUS_COLORS: Record<SessionStatus, string> = {
  working: "var(--sage)",
  waiting: "var(--brass-2)",
  starting: "var(--brass-2)",
  idle: "var(--mute)",
  errored: "var(--alarm)",
  dead: "var(--alarm)"
};

function terminalCount(s: AggregatedSession, terminals: TrenchesSession[]): number {
  return terminals.filter(
    (t) =>
      t.cwd === s.worktreePath &&
      (s.machine === "local" ? !t.outpost : t.outpost === s.machine)
  ).length;
}

export default function SessionView(_props: FittingViewProps) {
  const [sessions, setSessions] = useState<AggregatedSession[]>([]);
  const [outposts, setOutposts] = useState<OutpostSummary[]>([]);
  const [terminals, setTerminals] = useState<TrenchesSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failureCountRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sessRes, termRes] = await Promise.all([
        fetch("/api/workbench/sessions"),
        fetch("/api/trenches/sessions").catch(() => null),
      ]);

      const sessData = (await sessRes.json()) as {
        sessions?: AggregatedSession[];
        outposts?: OutpostSummary[];
        error?: string;
      };

      if (!sessRes.ok) {
        failureCountRef.current += 1;
        setError(sessData.error ?? `HTTP ${sessRes.status}`);
      } else {
        failureCountRef.current = 0;
        setSessions(sessData.sessions ?? []);
        setOutposts(sessData.outposts ?? []);
      }

      if (termRes?.ok) {
        const termData = (await termRes.json()) as { sessions?: TrenchesSession[] };
        setTerminals(termData.sessions ?? []);
      }
    } catch (err) {
      failureCountRef.current += 1;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      // Fixed 3 s tick; back off to 30 s on consecutive errors.
      const delay = failureCountRef.current === 0
        ? 3000
        : Math.min(30000, 3000 * 2 ** Math.max(0, failureCountRef.current - 1));
      timer = setTimeout(tick, delay);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [refresh]);

  async function openInTerminal(s: AggregatedSession) {
    const body: Record<string, string> = { cwd: s.worktreePath };
    if (s.machine !== "local") body.outpost = s.machine;
    try {
      await fetch("/api/trenches/terminals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // user can switch to Workbench > Terminal manually
    }
  }

  async function killSession(s: AggregatedSession) {
    const matching = terminals.filter(
      (t) =>
        t.cwd === s.worktreePath &&
        (s.machine === "local" ? !t.outpost : t.outpost === s.machine)
    );
    if (matching.length !== 1) return;
    try {
      await fetch(`/api/trenches/terminals/${matching[0].id}`, { method: "DELETE" });
      void refresh();
    } catch {
      // ignore
    }
  }

  const noState = sessions.length === 0 && outposts.length === 0 && !loading;

  return (
    <div style={{ padding: 20, maxWidth: 800 }}>
      <div className="strip" style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 12, color: "var(--mute)" }}>
          {loading ? "Loading…" : `${sessions.length} session${sessions.length !== 1 ? "s" : ""}`}
          {outposts.length > 0 ? (
            <span style={{ marginLeft: 8 }}>
              {outposts.map((o) => (
                <span
                  key={o.name}
                  title={o.online ? `Last synced: ${o.lastSyncedAt ?? "—"}` : "Disconnected"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    marginRight: 8,
                    fontSize: 11,
                    color: o.online ? "var(--sage)" : "var(--alarm)",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: o.online ? "var(--sage)" : "var(--alarm)",
                      display: "inline-block",
                    }}
                  />
                  {o.name}
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span className="sep" />
        <button
          type="button"
          className="btn small ghost"
          onClick={() => { void refresh(); }}
          disabled={loading}
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--alarm-soft)",
            color: "var(--alarm)",
            fontSize: 12,
            borderRadius: 4,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      ) : null}

      {noState ? (
        <p style={{ fontSize: 13, color: "var(--mute)" }}>
          No active sessions. Sessions appear here when Claude Code hooks write to{" "}
          <code>~/.garrison/sessions/state.json</code>.
        </p>
      ) : null}

      {sessions.length > 0 ? (
        <table className="simple">
          <thead>
            <tr>
              <th>Machine</th>
              <th>Project</th>
              <th>Branch</th>
              <th>Status</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => {
              const count = terminalCount(s, terminals);
              const canKill = s.online && count === 1;
              const multiKill = s.online && count > 1;
              return (
                <tr
                  key={`${s.machine}:${s.projectPath}:${s.branch}`}
                  style={{ opacity: s.online ? 1 : 0.5 }}
                >
                  <td style={{ fontSize: 11, color: "var(--mute)" }}>{s.machine}</td>
                  <td style={{ fontSize: 12 }}>{s.projectName}</td>
                  <td>
                    <code style={{ fontSize: 12 }}>{s.branch}</code>
                  </td>
                  <td>
                    <span
                      className="pill"
                      style={{
                        color: STATUS_COLORS[s.lastStatus] ?? "var(--mute)",
                        fontSize: 11,
                      }}
                    >
                      {s.lastStatus}
                    </span>
                  </td>
                  <td style={{ fontSize: 11, color: "var(--mute)" }}>
                    {s.lastStatusAt ? new Date(s.lastStatusAt).toLocaleTimeString() : "—"}
                  </td>
                  <td style={{ display: "flex", gap: 6 }}>
                    {s.worktreePath ? (
                      <button
                        type="button"
                        className="btn small ghost"
                        title={`Open terminal in ${s.worktreePath}`}
                        disabled={!s.online}
                        onClick={() => { void openInTerminal(s); }}
                      >
                        Open terminal
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={!canKill}
                      title={
                        !s.online
                          ? "Outpost offline"
                          : multiKill
                          ? "Multiple sessions — kill from Terminal tab"
                          : count === 0
                          ? "No active terminal session"
                          : "Kill session"
                      }
                      onClick={() => { void killSession(s); }}
                    >
                      Kill
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
