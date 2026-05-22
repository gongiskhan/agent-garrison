"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useAppShell } from "@/components/chrome/AppShell";

interface LogEvent {
  ts: string;
  stream: "runner" | "stdout" | "stderr" | "input";
  message: string;
}

export function RunPanel() {
  const { composition, runnerState, runAction, busy } = useAppShell();
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!composition?.id) return;
    const source = new EventSource(`/api/runner/${composition.id}/logs`);
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as LogEvent;
        setLogs((prev) => [...prev.slice(-900), parsed]);
      } catch {
        /* ignore */
      }
    };
    return () => source.close();
  }, [composition?.id]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs.length]);

  if (!composition) {
    return (
      <main>
        <div className="page wide">
          <div className="head">
            <h1>Loading…</h1>
          </div>
        </div>
      </main>
    );
  }

  const verifyResults = runnerState?.verifyResults ?? [];
  const verifyOk = verifyResults.filter((r) => r.ok).length;
  const status = runnerState?.status ?? "idle";
  const isRunning = status === "running";

  return (
    <main>
      <div className="crumbs">
        <b>Run</b>
      </div>
      <div className="page wide">
        <div className="head">
          <h1>Run</h1>
          <p className="ld">
            Start, stop, verify, watch. Operative interaction happens through Channel Fittings,
            not through Garrison.
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
            gap: 18,
            marginBottom: 18
          }}
        >
          <section style={{ border: "1px solid var(--rule)", background: "white", padding: "18px 20px" }}>
            <h3 className="font-display" style={{ fontWeight: 600, fontSize: 18, margin: "0 0 4px", letterSpacing: "-0.005em" }}>
              Dispatch
            </h3>
            <p style={{ color: "var(--mute)", fontSize: 12.5, margin: "0 0 14px" }}>
              {isRunning
                ? "The runner is up. Restart re-runs apm install + verify before relaunching the Operative."
                : "Press Run to install Fittings, verify, and start the Operative."}
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                marginBottom: 14
              }}
            >
              <button
                className="btn primary"
                style={{ justifyContent: "center" }}
                disabled={Boolean(busy)}
                onClick={() => void runAction("up")}
              >
                <span className="ic">▶</span>
                {isRunning ? "Restart" : "Run"}
              </button>
              <button
                className="btn danger"
                style={{ justifyContent: "center" }}
                disabled={Boolean(busy) || !isRunning}
                onClick={() => void runAction("down")}
              >
                <span className="ic">□</span>Stop
              </button>
              <button
                className="btn ghost"
                style={{ justifyContent: "center" }}
                disabled={Boolean(busy)}
                onClick={() => void runAction("verify")}
              >
                <span className="ic">✓</span>Verify
              </button>
              <button
                className="btn ghost"
                style={{ justifyContent: "center" }}
                disabled={Boolean(busy)}
                onClick={() => void runAction("dev")}
              >
                <span className="ic">⚙</span>
                {runnerState?.devMode ? "Dev: on" : "Dev mode"}
              </button>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 1,
                background: "var(--rule)",
                border: "1px solid var(--rule)"
              }}
            >
              <Cell label="Status" tone={isRunning ? "ok" : status === "failed" ? "alarm" : "default"}>
                {status}
              </Cell>
              <Cell label="PID" mono>
                {runnerState?.pid ?? "—"}
              </Cell>
              <Cell label="Dev">{runnerState?.devMode ? "on" : "off"}</Cell>
              <Cell
                label="Verify"
                tone={verifyResults.length && verifyOk === verifyResults.length ? "ok" : "default"}
              >
                {verifyResults.length ? `${verifyOk} / ${verifyResults.length}` : "—"}
              </Cell>
            </div>
          </section>

          <section
            style={{
              border: "1px solid var(--rule)",
              background: "white"
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "14px 18px",
                borderBottom: "1px solid var(--rule)"
              }}
            >
              <h3 className="font-display" style={{ fontWeight: 600, fontSize: 16, margin: 0, letterSpacing: "-0.005em" }}>
                Verify hooks
              </h3>
              <span
                className="font-mono"
                style={{
                  fontSize: 11.5,
                  color: verifyOk === verifyResults.length && verifyResults.length > 0 ? "var(--sage)" : "var(--mute)",
                  fontWeight: 600
                }}
              >
                {verifyResults.length ? `${verifyOk} / ${verifyResults.length} passed` : "not run"}
              </span>
            </div>
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {verifyResults.length === 0 ? (
                <div style={{ padding: 28, color: "var(--mute)", fontSize: 13, textAlign: "center" }}>
                  Press Verify to run all installed Fitting hooks.
                </div>
              ) : (
                verifyResults.map((result) => {
                  const failureDetail = !result.ok
                    ? [
                        result.error
                          ? `error: ${result.error}`
                          : `exit ${result.exitCode ?? "null"}, expected stdout to contain "${result.expect}"`,
                        result.stderr.trim() && `stderr: ${result.stderr.trim()}`,
                        result.stdout.trim() && !result.stdout.includes(result.expect) && `stdout: ${result.stdout.trim()}`
                      ]
                        .filter(Boolean)
                        .join("\n")
                    : "";
                  return (
                    <div
                      key={result.fittingId}
                      style={{
                        borderBottom: "1px solid var(--rule)",
                        padding: "9px 18px",
                        fontSize: 12.5
                      }}
                    >
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "14px 1fr auto auto",
                          gap: 12,
                          alignItems: "center"
                        }}
                      >
                        <span
                          className="font-mono"
                          style={{ color: result.ok ? "var(--sage)" : "var(--alarm)", fontWeight: 700 }}
                        >
                          {result.ok ? "•" : "!"}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 500 }}>{result.fittingId}</div>
                          <div
                            className="font-mono"
                            style={{
                              fontSize: 11,
                              color: "var(--mute)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap"
                            }}
                          >
                            {result.command}
                          </div>
                        </div>
                        <span
                          className="font-mono"
                          style={{
                            fontSize: 10.5,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            color: result.ok ? "var(--sage)" : "var(--alarm)"
                          }}
                        >
                          {result.ok ? "passed" : "failed"}
                        </span>
                        <span
                          className="font-mono"
                          style={{
                            fontSize: 10.5,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                            color: "var(--mute)"
                          }}
                        >
                          {result.durationMs}ms
                        </span>
                      </div>
                      {failureDetail && (
                        <pre
                          className="font-mono"
                          style={{
                            margin: "8px 0 0 26px",
                            padding: "8px 10px",
                            background: "rgba(180, 60, 60, 0.06)",
                            border: "1px solid rgba(180, 60, 60, 0.18)",
                            color: "var(--alarm)",
                            fontSize: 11,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            borderRadius: 2
                          }}
                        >
                          {failureDetail}
                        </pre>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>

        <section className="term" style={{ marginBottom: 18 }}>
          <div className="hd">
            <span>
              <span style={{ color: "#74a385" }}>•</span> Runtime log · live stream · ring buffer 5 000 lines
            </span>
            <span>{logs.length} lines</span>
          </div>
          <div className="body">
            {logs.length === 0 ? (
              <div style={{ color: "#7f9188" }}>No log lines yet.</div>
            ) : (
              logs.map((event, i) => (
                <div key={`${event.ts}-${i}`} className="row">
                  <span className="ts">{event.ts.split("T")[1]?.replace("Z", "")}</span>
                  <span className={clsx("stream", event.stream)}>{event.stream}</span>
                  <span style={{ wordBreak: "break-word" }}>{event.message}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </section>
      </div>
    </main>
  );
}

function Cell({
  label,
  children,
  tone,
  mono
}: {
  label: string;
  children: React.ReactNode;
  tone?: "ok" | "alarm" | "default";
  mono?: boolean;
}) {
  return (
    <div style={{ background: "white", padding: "10px 14px" }}>
      <div
        className="font-mono"
        style={{
          fontSize: 9.5,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--mute)"
        }}
      >
        {label}
      </div>
      <div
        className={mono ? "font-mono" : "font-display"}
        style={{
          fontSize: mono ? 14 : 18,
          fontWeight: 600,
          marginTop: 2,
          letterSpacing: mono ? 0 : "-0.005em",
          color: tone === "ok" ? "var(--sage)" : tone === "alarm" ? "var(--alarm)" : "var(--ink)"
        }}
      >
        {children}
      </div>
    </div>
  );
}
