"use client";

import { useCallback, useEffect, useState } from "react";
import type { LogCategory, LogEntry, LogTail } from "@/lib/claude-logs";

// Read-only master/detail tail viewer for Quarters > Logs and Quarters >
// Sessions. Garrison never writes these records — there is no editor, only a
// bounded tail. Mirrors the PlansPanel layout/visual language.

const COPY: Record<LogCategory, { title: string; blurb: string; empty: string }> = {
  logs: {
    title: "Logs",
    blurb: "Claude Code logs under your real ~/.claude (logs/, debug/, *.log) — tailed read-only.",
    empty: "No log files found under ~/.claude."
  },
  sessions: {
    title: "Sessions",
    blurb: "Session records (sessions/*.json) and transcripts (projects/**/*.jsonl) — tailed read-only.",
    empty: "No session records or transcripts found under ~/.claude."
  }
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
  } catch {
    return "";
  }
}

export function ReadOnlyTailPanel({ category }: { category: LogCategory }) {
  const copy = COPY[category];
  const endpoint = `/api/quarters/${category}`;
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [capped, setCapped] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tail, setTail] = useState<LogTail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(endpoint);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? res.statusText);
      setEntries(data.entries as LogEntry[]);
      setCapped(Boolean(data.capped));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [endpoint]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const open = useCallback(
    async (relPath: string) => {
      setSelected(relPath);
      setTail(null);
      try {
        const res = await fetch(`${endpoint}?path=${encodeURIComponent(relPath)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? res.statusText);
        setTail(data as LogTail);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [endpoint]
  );

  return (
    <main>
      <div className="crumbs">
        <b>Quarters</b> · {copy.title}
      </div>
      <div className="page">
        <div className="head">
          <h1>{copy.title}</h1>
          <p className="ld">{copy.blurb}</p>
          <span className="pill idle" style={{ fontSize: 10.5 }}>
            read-only
          </span>
        </div>

        {error ? (
          <div className="banner alarm" data-testid={`${category}-error`}>
            <span className="glyph">!</span>
            <div>
              <h5>{copy.title} error</h5>
              <p>{error}</p>
            </div>
          </div>
        ) : null}

        <div
          data-testid={`readonly-${category}`}
          style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) 1fr", gap: 16 }}
        >
          <section
            style={{ border: "1px solid var(--rule)", background: "white", maxHeight: 560, overflow: "auto" }}
            data-testid={`${category}-list`}
          >
            {entries.length === 0 ? (
              <div style={{ padding: 16, color: "var(--mute)", fontSize: 12.5 }}>{copy.empty}</div>
            ) : (
              entries.map((e) => (
                <button
                  key={e.relPath}
                  data-testid={`logentry-${e.relPath}`}
                  onClick={() => void open(e.relPath)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 14px",
                    border: "none",
                    borderBottom: "1px solid var(--rule)",
                    background: selected === e.relPath ? "var(--paper)" : "white",
                    cursor: "pointer"
                  }}
                >
                  <div className="font-mono" style={{ fontSize: 12.5 }}>
                    {e.name}
                  </div>
                  <div style={{ fontSize: 10.5, color: "var(--mute)", marginTop: 2 }}>
                    {e.group && e.group !== e.name ? `${e.group} · ` : ""}
                    {fmtBytes(e.bytes)} · {fmtTime(e.mtimeMs)}
                  </div>
                </button>
              ))
            )}
            {capped ? (
              <div style={{ padding: "8px 14px", fontSize: 10.5, color: "var(--mute)" }}>
                List capped — more files exist than are shown (newest first).
              </div>
            ) : null}
          </section>

          <section>
            {tail ? (
              <div style={{ border: "1px solid var(--rule)", background: "white" }}>
                <div
                  style={{
                    padding: "8px 12px",
                    borderBottom: "1px solid var(--rule)",
                    fontSize: 11,
                    color: "var(--mute)",
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap"
                  }}
                >
                  <span className="font-mono">{tail.relPath}</span>
                  <span>{tail.lines.length} lines</span>
                  <span>{fmtBytes(tail.totalBytes)} total</span>
                  {tail.truncated ? <span>(head truncated — showing the tail)</span> : null}
                </div>
                <pre
                  data-testid={`tail-${category}`}
                  style={{
                    margin: 0,
                    padding: 12,
                    maxHeight: 520,
                    overflow: "auto",
                    fontSize: 11.5,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word"
                  }}
                  className="font-mono"
                >
                  {tail.lines.length > 0 ? tail.lines.join("\n") : "(empty file)"}
                </pre>
              </div>
            ) : (
              <div style={{ padding: 20, color: "var(--mute)", fontSize: 13 }}>
                Select a {category === "logs" ? "log file" : "session"} to view its tail.
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
