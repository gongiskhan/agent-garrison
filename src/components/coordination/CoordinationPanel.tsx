"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./CoordinationPanel.module.css";

// Read-only Coordination view. Renders the SINGLE coordination-state source
// (GET /api/coordination/status, which runs the same `coord state --json` the CLI
// renders — so the UI can never show green while the CLI shows red). Three guarded
// actions only: Verify now (canary), release-lock, restart agent_mail.

interface Liveness {
  up: boolean;
  latencyMs?: number;
  url?: string;
  reason?: string;
}
interface SessionRow {
  sessionId: string;
  repo: string;
  gitBranch: string;
  ageMinutes: number;
  recent: boolean;
  fires: number;
  conflicts: number;
  flag: "active" | "red" | "idle";
}
interface Waiter {
  session: string;
  waitMinutes: number;
  summary?: string;
}
interface LockRow {
  repo: string;
  session: string;
  summary: string;
  startedAt: string;
  expiresAt: string;
  heldMinutes: number;
  expired: boolean;
  isFocus: boolean;
  waiters: Waiter[];
}
interface IntentRow {
  repo: string;
  session: string;
  area?: string;
  files?: string[];
  reason: string;
  ts: string;
}
interface LeaseRow {
  agent: string;
  pathPattern: string;
  exclusive: boolean;
  reason: string;
  stale: boolean;
}
interface HeroVerdict {
  overall: "live-and-used" | "idle" | "degraded" | "down" | "unknown";
  reasons: string[];
}
interface CoordState {
  repo: string | null;
  timestamp: string;
  unreachable?: boolean;
  liveness: { agentMail: Liveness } | null;
  sessions: SessionRow[];
  locks: LockRow[];
  recentIntents: IntentRow[];
  recentPlans: { repo: string; session: string; summary: string; releasedAt: string }[];
  leases: LeaseRow[];
  heartbeat?: { lastTs: string | null; lastBytes: number | null; firesInWindow: number; fresh: boolean };
  heroVerdict: HeroVerdict;
}

const T = {
  paper: "var(--paper)",
  paper2: "var(--paper-2)",
  ink: "var(--ink)",
  mute: "var(--mute)",
  rule: "var(--rule)",
  sage: "var(--sage)",
  sageSoft: "var(--sage-soft)",
  brass: "var(--brass)",
  alarm: "var(--alarm)"
};

const VERDICT = {
  "live-and-used": { label: "LIVE & IN USE", glyph: "●", bg: "var(--sage-soft)", border: "var(--sage)", fg: "var(--sage-2)" },
  idle: { label: "LIVE (IDLE)", glyph: "○", bg: "var(--paper-2)", border: "var(--rule-2)", fg: "var(--mute)" },
  degraded: { label: "DEGRADED", glyph: "▲", bg: "var(--warn-soft)", border: "var(--brass)", fg: "var(--brass)" },
  down: { label: "DOWN", glyph: "■", bg: "var(--alarm-soft)", border: "var(--alarm)", fg: "var(--alarm)" },
  unknown: { label: "UNKNOWN", glyph: "?", bg: "var(--alarm-soft)", border: "var(--alarm)", fg: "var(--alarm)" }
} as const;

const monoLabel: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: T.mute
};
const card: React.CSSProperties = { background: "var(--surface)", border: `1px solid ${T.rule}`, padding: "18px 20px" };
const dot = (color: string): React.CSSProperties => ({ display: "inline-block", width: 8, height: 8, borderRadius: 0, background: color, marginRight: 8 });

function shortId(id: string) {
  return id.length > 10 ? id.slice(0, 8) : id;
}
function ago(ts: string | null | undefined) {
  if (!ts) return "—";
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function CoordinationPanel() {
  const [state, setState] = useState<CoordState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/coordination/status", { cache: "no-store" });
      const json = (await res.json()) as CoordState;
      setState(json);
      setLoadError(null);
    } catch (e) {
      // The state source itself is unreachable — say so, never show stale green.
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const verdict = loadError
    ? VERDICT.unknown
    : VERDICT[state?.heroVerdict?.overall ?? "unknown"] ?? VERDICT.unknown;
  const reasons = loadError ? [`Coordination view cannot reach the state source: ${loadError}`] : state?.heroVerdict?.reasons ?? [];

  const sessionsByRepo = useMemo(() => {
    const m: Record<string, SessionRow[]> = {};
    for (const s of state?.sessions ?? []) (m[s.repo] ||= []).push(s);
    return m;
  }, [state]);

  async function runCanary() {
    setBusy("canary");
    setActionMsg(null);
    try {
      const res = await fetch("/api/coordination/canary", { method: "POST" });
      const j = await res.json();
      setActionMsg({ ok: Boolean(j.ok), text: j.ok ? "Canary passed — write → detect → inject chain verified." : `Canary FAILED: ${(j.output || j.error || "").slice(-300)}` });
    } catch (e) {
      setActionMsg({ ok: false, text: `Canary error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
      refresh();
    }
  }
  async function releaseLock(repo: string) {
    if (!window.confirm(`Force-release the planning lock for:\n\n${repo}\n\nReleasing a session that is mid-plan is consequential. Only do this for a stale or abandoned lock. Continue?`)) return;
    setBusy(`release:${repo}`);
    setActionMsg(null);
    try {
      const res = await fetch("/api/coordination/release-lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo }) });
      const j = await res.json();
      setActionMsg(res.ok ? { ok: true, text: `Released planning lock for ${repo}.` } : { ok: false, text: `Release failed: ${j.error || res.status}` });
    } catch (e) {
      setActionMsg({ ok: false, text: `Release error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
      refresh();
    }
  }
  async function restartAgentMail() {
    setBusy("restart");
    setActionMsg(null);
    try {
      const res = await fetch("/api/fittings/coord-agentmail/restart", { method: "POST" });
      const j = await res.json();
      setActionMsg(res.ok ? { ok: true, text: `agent_mail restarted (pid ${j.pid ?? "?"}).` } : { ok: false, text: `Restart failed: ${j.error || res.status}` });
    } catch (e) {
      setActionMsg({ ok: false, text: `Restart error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(null);
      refresh();
    }
  }

  const live = state?.liveness;
  const hb = state?.heartbeat;

  return (
    <main>
      <div className="crumbs">
        <b>Coordination</b>
      </div>
      <div className="page">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Shared ground</span>
            <h1>Coordination</h1>
          </div>
          <p>
            One operational picture of current sessions, planning locks, file
            leases, and the hook chain that keeps concurrent work apart.
          </p>
        </header>

        {/* HERO VERDICT — the one-second answer */}
        <div
          className={styles.verdict}
          data-testid="hero-verdict"
          data-verdict={loadError ? "unknown" : state?.heroVerdict?.overall ?? "unknown"}
          style={{ background: verdict.bg, borderColor: verdict.border }}
        >
          <span style={{ fontSize: 26, lineHeight: 1, color: verdict.fg }} aria-hidden>
            {verdict.glyph}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 600, color: verdict.fg }}>{verdict.label}</div>
            <ul style={{ margin: "6px 0 0", paddingLeft: 16, color: T.ink }}>
              {reasons.map((r, i) => (
                <li key={i} style={{ fontSize: 13.5 }}>{r}</li>
              ))}
            </ul>
          </div>
          <button className="btn ghost" onClick={refresh} disabled={busy !== null}>
            Refresh
          </button>
        </div>

        {actionMsg ? (
          <div className={`banner ${actionMsg.ok ? "info" : "alarm"}`} style={{ marginTop: 10 }}>
            <span className="glyph">{actionMsg.ok ? "✓" : "!"}</span>
            <div><p>{actionMsg.text}</p></div>
          </div>
        ) : null}

        <div className={styles.coordGrid}>
        {/* LIVENESS */}
        <section className={styles.card} style={card}>
          <div style={monoLabel}>Liveness</div>
          <div style={{ display: "flex", gap: 28, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <LiveDot label="agent_mail" l={live?.agentMail} />
            {live && !live.agentMail.up ? (
              <button className="btn small ghost" onClick={restartAgentMail} disabled={busy !== null}>
                {busy === "restart" ? "Restarting…" : "Restart agent_mail"}
              </button>
            ) : null}
          </div>
        </section>

        {/* PLANNING GATE — the other hero element */}
        <section className={`${styles.card} ${styles.planning}`} style={card}>
          <div style={monoLabel}>Planning gate</div>
          {(state?.locks ?? []).length === 0 ? (
            <p style={{ color: T.mute, fontSize: 13, marginTop: 8 }}>No repo is being planned right now.</p>
          ) : (
            (state?.locks ?? []).map((l) => (
              <div key={l.repo} style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.rule}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <span style={dot(l.expired ? T.alarm : T.sage)} />
                    <b style={{ fontSize: 14 }}>{l.repo}</b>{" "}
                    {l.expired ? (
                      <span style={{ color: T.alarm, fontWeight: 600 }}>STALE — held past TTL ({ago(l.expiresAt)} expired)</span>
                    ) : (
                      <span style={{ color: T.sage }}>held {l.heldMinutes}m</span>
                    )}
                  </div>
                  <button className={`btn small ${l.expired ? "danger" : "ghost"}`} onClick={() => releaseLock(l.repo)} disabled={busy !== null}>
                    {busy === `release:${l.repo}` ? "Releasing…" : "Release lock"}
                  </button>
                </div>
                <div style={{ fontSize: 13, color: T.ink, marginTop: 4 }}>
                  Holder <b>{l.session}</b> — “{l.summary || "(no summary)"}”
                </div>
                {l.waiters.length > 0 ? (
                  <div style={{ fontSize: 12.5, color: T.mute, marginTop: 4 }}>
                    Waiting: {l.waiters.map((w) => `${w.session} (${w.waitMinutes}m${w.waitMinutes > 15 ? ", long" : ""})`).join(", ")}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </section>

        {/* SESSIONS */}
        <section className={`${styles.card} ${styles.sessions}`} style={card}>
          <div style={monoLabel}>Active sessions (by repo)</div>
          {Object.keys(sessionsByRepo).length === 0 ? (
            <p style={{ color: T.mute, fontSize: 13, marginTop: 8 }}>No sessions active in the last few hours.</p>
          ) : (
            Object.entries(sessionsByRepo).map(([repo, list]) => (
              <div key={repo} style={{ marginTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{repo}</div>
                {list.slice(0, 8).map((s) => (
                  <div key={s.sessionId} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 13, marginTop: 4 }}>
                    <span style={dot(s.flag === "active" ? T.sage : s.flag === "red" ? T.alarm : T.rule)} />
                    <code style={{ fontSize: 12 }}>{shortId(s.sessionId)}</code>
                    <span style={{ color: T.mute }}>{s.gitBranch || "—"}</span>
                    <span style={{ color: T.mute }}>active {s.ageMinutes}m ago</span>
                    {s.flag === "active" ? (
                      <span style={{ color: T.sage }}>{s.fires} hook fires{s.conflicts ? `, ${s.conflicts} conflicts surfaced` : ""}</span>
                    ) : s.flag === "red" ? (
                      <span style={{ color: T.alarm, fontWeight: 600 }}>RED — running {s.ageMinutes}m, hasn’t recorded any coordination — may be working blind</span>
                    ) : (
                      <span style={{ color: T.mute }}>idle</span>
                    )}
                  </div>
                ))}
                {list.length > 8 ? <div style={{ fontSize: 12, color: T.mute, marginTop: 2 }}>+{list.length - 8} more</div> : null}
              </div>
            ))
          )}
        </section>

        {/* RECENT DECISIONS & INTENTS */}
        <section className={styles.card} style={card}>
          <div style={monoLabel}>Recent intents &amp; decisions</div>
          {(state?.recentIntents ?? []).length === 0 ? (
            <p style={{ color: T.mute, fontSize: 13, marginTop: 8 }}>Nothing recorded recently.</p>
          ) : (
            (state?.recentIntents ?? []).slice(0, 8).map((i, idx) => (
              <div key={idx} style={{ fontSize: 13, marginTop: 6 }}>
                <b>{i.session}</b> on <code style={{ fontSize: 12 }}>{i.area || (i.files || []).join(", ")}</code> — “{i.reason}” <span style={{ color: T.mute }}>· {ago(i.ts)} · {i.repo}</span>
              </div>
            ))
          )}
        </section>

        {/* FILE LEASES (channel 2) */}
        <section className={styles.card} style={card}>
          <div style={monoLabel}>File leases (agent_mail)</div>
          {(state?.leases ?? []).length === 0 ? (
            <p style={{ color: T.mute, fontSize: 13, marginTop: 8 }}>No active file leases for this repo.</p>
          ) : (
            (state?.leases ?? []).map((l, idx) => (
              <div key={idx} style={{ fontSize: 13, marginTop: 6 }}>
                <span style={{ ...monoLabel, fontSize: 9.5, marginRight: 6 }}>{l.exclusive ? "EXCL" : "SHARED"}</span>
                <code style={{ fontSize: 12 }}>{l.pathPattern}</code> <span style={{ color: T.mute }}>· {l.agent} · “{l.reason}”{l.stale ? " · stale" : ""}</span>
              </div>
            ))
          )}
        </section>

        {/* HOOK HEARTBEAT + VERIFY */}
        <section className={`${styles.card} ${styles.heartbeat}`} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={monoLabel}>Hook heartbeat</div>
              {hb && hb.lastTs ? (
                <p style={{ fontSize: 13, marginTop: 8, color: hb.fresh ? T.ink : T.alarm }}>
                  Last injection {ago(hb.lastTs)} · {hb.lastBytes ?? "?"} bytes · {hb.firesInWindow} in the last 30m
                  {!hb.fresh ? " — no recent injections; the hook may be quiet while sessions are active." : ""}
                </p>
              ) : (
                <p style={{ fontSize: 13, marginTop: 8, color: T.mute }}>No hook injections recorded yet.</p>
              )}
            </div>
            <button className="btn primary" onClick={runCanary} disabled={busy !== null}>
              {busy === "canary" ? "Verifying…" : "Verify now"}
            </button>
          </div>
        </section>
        </div>

        <p className={styles.stateStamp} style={monoLabel}>
          {state?.timestamp ? `state @ ${new Date(state.timestamp).toLocaleTimeString()}` : ""}
          {state?.unreachable ? " · STATE SOURCE UNREACHABLE" : ""}
        </p>
      </div>
    </main>
  );
}

function LiveDot({ label, l }: { label: string; l?: Liveness }) {
  const up = l?.up;
  const color = up ? T.sage : T.alarm;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", fontSize: 13 }}>
      <span style={dot(color)} />
      <b>{label}</b>
      <span style={{ marginLeft: 8, color: up ? T.sage : T.alarm, fontWeight: 600 }}>{up ? "UP" : "DOWN"}</span>
      {up && l?.latencyMs != null ? <span style={{ marginLeft: 6, color: T.mute }}>{l.latencyMs}ms</span> : null}
      {!up && l?.reason ? <span style={{ marginLeft: 6, color: T.mute }}>({l.reason})</span> : null}
    </span>
  );
}
