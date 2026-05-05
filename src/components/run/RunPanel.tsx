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
  const { composition, runnerState, runAction, busy, setError } = useAppShell();
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [testInput, setTestInput] = useState("");
  const [sending, setSending] = useState(false);
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

  async function sendTest() {
    if (!composition || !testInput.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/runner/${composition.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: testInput })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `test failed: ${res.status}`);
      setTestInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <main>
      <div className="crumbs">
        <b>Run</b>
      </div>
      <div className="page wide">
        <div className="head">
          <h1>Run</h1>
          <p className="ld">
            The runner. Start, stop, verify, watch — and pipe a test message into the running session
            without going through a real channel.
          </p>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
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
                verifyResults.map((result) => (
                  <div
                    key={result.fittingId}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "14px 1fr auto auto",
                      gap: 12,
                      padding: "9px 18px",
                      borderBottom: "1px solid var(--rule)",
                      alignItems: "center",
                      fontSize: 12.5
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
                ))
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

        <section style={{ border: "1px solid var(--rule)", background: "white", padding: "16px 18px 18px" }}>
          <h3 className="font-display" style={{ fontWeight: 600, fontSize: 16, margin: "0 0 4px" }}>
            Operative test box
          </h3>
          <p style={{ color: "var(--mute)", fontSize: 12.5, margin: "0 0 12px" }}>
            Send a one-shot message to the running operative through the gateway.{" "}
            <b>Not a Channel</b> — channel inputs come from real surfaces wired in Compose.
          </p>
          <textarea
            placeholder={isRunning ? "ping the trello data source" : "Operative offline — press Run first"}
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            disabled={!isRunning || sending}
            style={{
              width: "100%",
              minHeight: 70,
              padding: "10px 12px",
              fontSize: 13,
              border: "1px solid var(--rule)",
              background: "var(--paper)",
              resize: "vertical",
              fontFamily: "inherit",
              color: "var(--ink)"
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void sendTest();
              }
            }}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 8
            }}
          >
            <span className="font-mono" style={{ fontSize: 10.5, color: "var(--mute)" }}>
              ⌘ + Enter to send
            </span>
            <button
              className="btn primary"
              disabled={!isRunning || !testInput.trim() || sending}
              onClick={() => void sendTest()}
            >
              <span className="ic">→</span>
              {sending ? "Sending…" : "Send test"}
            </button>
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
