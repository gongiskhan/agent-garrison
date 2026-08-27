"use client";

// Session-log viewer (Harness brief §1): read-only projection of the
// append-only per-run JSONL. Runs list → event tail with domain badges and
// expandable payloads. Deliberately small — the log's first consumers are
// machines (improver, kanban, search); this panel is the human spot-check.

import { useCallback, useEffect, useState } from "react";
import styles from "./SessionLogPanel.module.css";

interface RunRow { runId: string; bytes: number; mtime: string; }
interface LogEvent {
  seq: number; ts: string; domain: string; turn: string | null; kind: string;
  runtimeSessionId?: string; shadowOf?: number; payload: unknown;
}

const DOMAINS = ["all", "session", "channel", "agent", "api", "lifecycle"];

export function SessionLogPanel() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [run, setRun] = useState<string | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [domain, setDomain] = useState("all");
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/session-log")
      .then((r) => r.json())
      .then((d) => {
        setRuns(d.runs ?? []);
        if (!run && d.runs?.length) setRun(d.runs[0].runId);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async (runId: string, dom: string) => {
    try {
      const q = dom !== "all" ? `&domain=${encodeURIComponent(dom)}` : "";
      const r = await fetch(`/api/session-log?run=${encodeURIComponent(runId)}&limit=1000${q}`);
      const d = await r.json();
      setEvents((d.events ?? []).slice(-200));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (run) void load(run, domain);
  }, [run, domain, load]);

  if (!runs.length) return null; // no log yet — the panel earns its place only with data

  return (
    <section className={styles.panel} aria-label="Session log">
      <header className={styles.head}>
        <span className={styles.kicker}>Session log</span>
        <select className={styles.select} value={run ?? ""} onChange={(e) => setRun(e.target.value)}>
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.runId} · {(r.bytes / 1024).toFixed(0)}kB
            </option>
          ))}
        </select>
        <div className={styles.domains} role="radiogroup" aria-label="Domain filter">
          {DOMAINS.map((d) => (
            <button
              key={d}
              type="button"
              className={`${styles.domainBtn} ${domain === d ? styles.domainOn : ""}`}
              onClick={() => setDomain(d)}
            >
              {d}
            </button>
          ))}
        </div>
      </header>
      {error && <div className={styles.error}>{error}</div>}
      <div className={styles.rows}>
        {events.map((e) => (
          <div key={e.seq} className={styles.row}>
            <button type="button" className={styles.rowHead} onClick={() => setOpen(open === e.seq ? null : e.seq)}>
              <span className={styles.seq}>{e.seq}</span>
              <span className={`${styles.domain} ${styles[`d_${e.domain}`] ?? ""}`}>{e.domain}</span>
              <span className={styles.kind}>{e.kind}</span>
              {e.turn ? <span className={styles.turn} title={e.turn}>{e.turn.slice(0, 18)}</span> : null}
              {typeof e.shadowOf === "number" ? <span className={styles.shadow}>shadows #{e.shadowOf}</span> : null}
              <span className={styles.ts}>{e.ts.slice(11, 19)}</span>
            </button>
            {open === e.seq && (
              <pre className={styles.payload}>{JSON.stringify(e.payload, null, 2)?.slice(0, 20000)}</pre>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
