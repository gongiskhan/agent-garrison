"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useAppShell } from "@/components/chrome/AppShell";

interface LogEvent {
  ts: string;
  stream: "runner" | "stdout" | "stderr" | "input";
  message: string;
}

interface SubAgentExecution {
  id: string;
  kind: "plan" | "execute";
  project: string;
  goal?: string;
  plan_id?: string;
  started_at: string;
  ended_at: string | null;
  status: "running" | "done" | "failed" | "killed";
  log_path: string;
  error?: string;
}

interface SubAgentLogLine {
  ts?: string;
  kind?: string;
  text?: string;
  name?: string;
  input?: unknown;
  raw?: string;
  [key: string]: unknown;
}

export function RunPanel() {
  const { composition, runnerState, runAction, busy, setError } = useAppShell();
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [testInput, setTestInput] = useState("");
  const [sending, setSending] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const [subAgentExecution, setSubAgentExecution] = useState<SubAgentExecution | null>(null);
  const [subAgentLog, setSubAgentLog] = useState<SubAgentLogLine[]>([]);
  const [subAgentExpanded, setSubAgentExpanded] = useState(true);
  const [killingId, setKillingId] = useState<string | null>(null);
  const subAgentEndRef = useRef<HTMLDivElement | null>(null);

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
    if (!composition?.id) return;
    const source = new EventSource(`/api/runner/${composition.id}/subagent-logs`);

    source.addEventListener("init", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          execution: SubAgentExecution | null;
        };
        setSubAgentExecution(data.execution);
        setSubAgentLog([]);
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("log", (event) => {
      try {
        const line = JSON.parse((event as MessageEvent).data) as SubAgentLogLine;
        setSubAgentLog((prev) => [...prev.slice(-900), line]);
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("execution-changed", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          execution: SubAgentExecution;
        };
        setSubAgentExecution(data.execution);
        setSubAgentLog([]);
      } catch {
        /* ignore */
      }
    });

    source.addEventListener("execution-status", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          id: string;
          status: SubAgentExecution["status"];
          ended_at: string | null;
          error?: string;
        };
        setSubAgentExecution((prev) =>
          prev && prev.id === data.id
            ? { ...prev, status: data.status, ended_at: data.ended_at, error: data.error }
            : prev
        );
        setKillingId((prev) => (prev === data.id ? null : prev));
      } catch {
        /* ignore */
      }
    });

    return () => source.close();
  }, [composition?.id]);

  useEffect(() => {
    subAgentEndRef.current?.scrollIntoView({ block: "end" });
  }, [subAgentLog.length]);

  async function killSubAgent() {
    if (!composition || !subAgentExecution) return;
    if (subAgentExecution.status !== "running") return;
    setKillingId(subAgentExecution.id);
    try {
      const res = await fetch(
        `/api/runner/${composition.id}/subagent-kill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ execution_id: subAgentExecution.id })
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `kill failed: ${res.status}`);
      }
    } catch (err) {
      setKillingId(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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

        <SubAgentPane
          execution={subAgentExecution}
          log={subAgentLog}
          expanded={subAgentExpanded}
          onToggleExpanded={() => setSubAgentExpanded((v) => !v)}
          killing={killingId === subAgentExecution?.id}
          onKill={killSubAgent}
          endRef={subAgentEndRef}
        />

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

function SubAgentPane({
  execution,
  log,
  expanded,
  onToggleExpanded,
  killing,
  onKill,
  endRef
}: {
  execution: SubAgentExecution | null;
  log: SubAgentLogLine[];
  expanded: boolean;
  onToggleExpanded: () => void;
  killing: boolean;
  onKill: () => void;
  endRef: React.RefObject<HTMLDivElement>;
}) {
  const status = execution?.status;
  const isRunning = status === "running";
  const statusTone =
    status === "running"
      ? "var(--sage)"
      : status === "failed"
      ? "var(--alarm)"
      : status === "killed"
      ? "var(--alarm)"
      : "var(--mute)";

  return (
    <section
      className="term"
      style={{ marginBottom: 18, borderColor: isRunning ? "var(--sage)" : undefined }}
    >
      <div className="hd" style={{ cursor: "pointer" }} onClick={onToggleExpanded}>
        <span>
          <span style={{ color: statusTone }}>•</span> Sub-agent
          {execution ? (
            <>
              {" · "}
              <span style={{ color: "#9fb1a8" }}>
                {execution.kind} · {execution.project}
              </span>
              {execution.goal ? (
                <>
                  {" · "}
                  <span style={{ color: "#7f9188" }}>
                    {execution.goal.length > 80
                      ? `${execution.goal.slice(0, 80)}…`
                      : execution.goal}
                  </span>
                </>
              ) : null}
              {" · "}
              <span style={{ color: statusTone, fontWeight: 600 }}>
                {execution.status}
              </span>
            </>
          ) : (
            <span style={{ color: "#7f9188" }}> · idle</span>
          )}
        </span>
        <span>
          {execution ? (
            <span style={{ marginRight: 12 }}>{log.length} lines</span>
          ) : null}
          {isRunning ? (
            <button
              className="btn danger"
              style={{
                padding: "2px 10px",
                fontSize: 11,
                marginRight: 8
              }}
              disabled={killing}
              onClick={(event) => {
                event.stopPropagation();
                onKill();
              }}
            >
              {killing ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          <span style={{ color: "#7f9188" }}>{expanded ? "▾" : "▸"}</span>
        </span>
      </div>
      {expanded ? (
        <div className="body">
          {!execution ? (
            <div style={{ color: "#7f9188" }}>
              No sub-agent run yet. The Operative will spawn one when it
              calls coding-subagent plan or execute.
            </div>
          ) : log.length === 0 ? (
            <div style={{ color: "#7f9188" }}>
              {isRunning ? "Sub-agent starting…" : "Log is empty."}
            </div>
          ) : (
            log.map((line, i) => <SubAgentLogRow key={`${line.ts ?? i}`} line={line} />)
          )}
          <div ref={endRef} />
        </div>
      ) : null}
    </section>
  );
}

function SubAgentLogRow({ line }: { line: SubAgentLogLine }) {
  const ts =
    typeof line.ts === "string" ? line.ts.split("T")[1]?.replace("Z", "") ?? "" : "";
  const kind = line.kind ?? "raw";
  const tag = kind === "tool-use" ? `tool:${line.name ?? "?"}` : kind;
  const body =
    typeof line.text === "string"
      ? line.text
      : kind === "tool-use" && line.input
      ? truncateInput(line.input)
      : line.raw ?? "";
  return (
    <div className="row">
      <span className="ts">{ts}</span>
      <span
        className="stream"
        style={{
          color:
            kind === "tool-use"
              ? "var(--sage)"
              : kind === "subagent-end" || kind === "subagent-start"
              ? "var(--ink)"
              : kind === "killed-by-signal"
              ? "var(--alarm)"
              : "#7f9188"
        }}
      >
        {tag}
      </span>
      <span style={{ wordBreak: "break-word" }}>{body}</span>
    </div>
  );
}

function truncateInput(input: unknown): string {
  try {
    const text = typeof input === "string" ? input : JSON.stringify(input);
    return text.length > 240 ? `${text.slice(0, 240)}…` : text;
  } catch {
    return "[unserializable input]";
  }
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
