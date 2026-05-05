"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useAppShell } from "@/components/chrome/AppShell";
import type { RunnerState } from "@/lib/types";

interface LogEvent {
  ts: string;
  stream: "runner" | "stdout" | "stderr" | "input";
  message: string;
}

export function GarrisonHome() {
  const {
    composition,
    runnerState,
    vaultNeedsPassword,
    runAction,
    busy
  } = useAppShell();

  const [tail, setTail] = useState<LogEvent[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!composition?.id) return;
    const source = new EventSource(`/api/runner/${composition.id}/logs`);
    sourceRef.current = source;
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as LogEvent;
        setTail((current) => [...current.slice(-4), parsed]);
      } catch {
        /* ignore */
      }
    };
    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [composition?.id]);

  if (!composition) {
    return (
      <main>
        <div className="page">
          <div className="head">
            <h1>Loading Agent Garrison…</h1>
            <p className="ld">Reading the composition manifest.</p>
          </div>
        </div>
      </main>
    );
  }

  const status = runnerState?.status ?? "idle";
  const isRunning = status === "running";
  const verifyResults = runnerState?.verifyResults ?? [];
  const verifyTotal = verifyResults.length;
  const verifyOk = verifyResults.filter((r) => r.ok).length;
  const stationed = Object.keys(composition.selections ?? {}).filter((k) => {
    const sel = composition.selections[k as keyof typeof composition.selections];
    return Array.isArray(sel) && sel.length > 0;
  }).length;

  const greeting = greetingForNow();
  const orchestratorMissing =
    !composition.selections.orchestrator || composition.selections.orchestrator.length === 0;

  return (
    <main>
      <div className="crumbs">
        <b>Garrison</b>
      </div>
      <div className="page">
        <div className="hero">
          <div>
            <div className="font-mono" style={{ color: "var(--mute)", letterSpacing: "0.16em", fontSize: 10.5, textTransform: "uppercase" }}>
              {formatNowStamp()}
            </div>
            <h1 className="font-display" style={{ fontWeight: 600, fontSize: 44, letterSpacing: "-0.014em", lineHeight: 1.02, margin: "6px 0 8px" }}>
              {greeting}
            </h1>
            <p className="font-display" style={{ fontSize: 17, lineHeight: 1.5, color: "var(--mute)", margin: 0, maxWidth: 540 }}>
              {operativeSummary(status, verifyTotal, verifyOk)}
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
            <Link className="btn ghost" href="/chat">
              <span className="ic">□</span>Open chat
            </Link>
            <Link className="btn primary" href="/run">
              <span className="ic">▶</span>Run panel
            </Link>
          </div>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid var(--rule)", margin: "18px 0 22px" }} />

        {vaultNeedsPassword ? (
          <div className="banner warn">
            <span className="glyph">!</span>
            <div>
              <h5>Vault is using the unsafe starter state</h5>
              <p>
                The vault opens without a password for bootstrap convenience. Set one before storing
                Trello, Anthropic, or any other API keys.
              </p>
              <div className="actions">
                <Link href="/vault">Set vault password →</Link>
              </div>
            </div>
          </div>
        ) : null}

        {orchestratorMissing ? (
          <div className="banner alarm">
            <span className="glyph">!</span>
            <div>
              <h5>Orchestrator station is empty</h5>
              <p>
                The Operative needs a single governing Fitting to assemble its system prompt. Until one is
                stationed, the runner falls back to a stub orchestrator.
              </p>
              <div className="actions">
                <Link href="/compose/orchestrator">Open Orchestrator station →</Link>
              </div>
            </div>
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 380px",
            gap: 24,
            alignItems: "start"
          }}
        >
          <div>
            <article
              style={{
                border: "1px solid var(--rule)",
                background: "white"
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  alignItems: "center",
                  padding: "18px 22px",
                  borderBottom: "1px solid var(--rule)"
                }}
              >
                <div>
                  <h2
                    className="font-display"
                    style={{
                      fontWeight: 600,
                      fontSize: 22,
                      letterSpacing: "-0.008em",
                      margin: 0
                    }}
                  >
                    {composition.name}
                  </h2>
                  <div
                    className="font-mono"
                    style={{
                      fontSize: 11,
                      color: "var(--mute)",
                      marginTop: 4,
                      letterSpacing: "0.04em",
                      wordBreak: "break-all"
                    }}
                  >
                    composition · {composition.manifestPath}
                  </div>
                </div>
                <span className={clsx("pill", isRunning && "live", statusToneClass(status))}>
                  {isRunning ? <span className="dot" /> : null}
                  {status}
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  borderBottom: "1px solid var(--rule)"
                }}
              >
                <Stat
                  label="Status"
                  value={status}
                  tone={isRunning ? "ok" : "default"}
                  sub={runnerState?.startedAt ? `since ${shortTime(runnerState.startedAt)}` : undefined}
                />
                <Stat
                  label="Verify"
                  value={verifyTotal ? `${verifyOk} / ${verifyTotal}` : "—"}
                  tone={verifyTotal && verifyOk === verifyTotal ? "ok" : "default"}
                  sub={verifyTotal ? "all hooks pass" : "not run"}
                />
                <Stat
                  label="Faculties"
                  value={`${stationed} / 13`}
                  sub="stationed"
                />
                <Stat
                  label="PID"
                  value={runnerState?.pid ? String(runnerState.pid) : "—"}
                  mono
                  sub="claude code"
                />
              </div>

              <div
                style={{
                  padding: "16px 22px 18px",
                  background: "var(--paper)",
                  borderTop: "1px solid var(--rule)"
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8
                  }}
                >
                  <h4
                    className="font-mono"
                    style={{
                      fontSize: 10.5,
                      letterSpacing: "0.16em",
                      textTransform: "uppercase",
                      color: "var(--mute)",
                      fontWeight: 500,
                      margin: 0
                    }}
                  >
                    Last log lines
                  </h4>
                  <Link
                    href="/run"
                    style={{ fontSize: 11.5, color: "var(--ink)", textDecoration: "underline" }}
                  >
                    open Run →
                  </Link>
                </div>
                <div
                  className="font-mono"
                  style={{
                    fontSize: 11.5,
                    lineHeight: 1.7,
                    background: "#0f1612",
                    color: "#d7e3dc",
                    padding: "12px 14px",
                    overflow: "hidden"
                  }}
                >
                  {tail.length === 0 ? (
                    <div style={{ color: "#7f9188" }}>
                      No log lines yet. Press Run to start the operative.
                    </div>
                  ) : (
                    tail.map((event, i) => (
                      <div
                        key={`${event.ts}-${i}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "76px 56px 1fr",
                          gap: 10
                        }}
                      >
                        <span style={{ color: "#6f8076" }}>{event.ts.split("T")[1]?.replace(/Z?$/, "")}</span>
                        <span style={{ color: streamColor(event.stream), fontWeight: 600 }}>
                          {event.stream}
                        </span>
                        <span style={{ wordBreak: "break-word" }}>{event.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: 12,
                  alignItems: "center",
                  padding: "14px 22px",
                  borderTop: "1px solid var(--rule)"
                }}
              >
                <div className="font-mono" style={{ color: "var(--mute)", fontSize: 11 }}>
                  {isRunning
                    ? "process survives tab close · Stop ends it cleanly"
                    : "press Run to install Fittings, verify, and start the Operative"}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    className="btn small ghost"
                    onClick={() => void runAction("verify")}
                    disabled={Boolean(busy)}
                  >
                    Verify
                  </button>
                  {isRunning ? (
                    <button
                      className="btn small danger"
                      onClick={() => void runAction("down")}
                      disabled={Boolean(busy)}
                    >
                      Stop
                    </button>
                  ) : null}
                  <button
                    className="btn small primary"
                    onClick={() => void runAction("up")}
                    disabled={Boolean(busy)}
                  >
                    {isRunning ? "Restart" : "Run"}
                  </button>
                </div>
              </div>
            </article>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <Panel title="Quick actions" tight>
              <Quick href="/compose" nm="Tune the composition" sm="Add or change Fittings · 13 stations" />
              <Quick href="/chat" nm="Talk to the operative" sm="Through the gateway · running session" />
              <Quick href="/armory" nm="Browse the Armory" sm="Curated Fittings registry" />
              <Quick
                href="/vault"
                nm="Vault"
                sm={vaultNeedsPassword ? "Password not set" : "Secrets are encrypted"}
                alarm={vaultNeedsPassword}
              />
            </Panel>

            <Panel title="Composition · readiness">
              <ReadyRow label="Faculties stationed" value={`${stationed} / 13`} />
              <ReadyRow
                label="Capability wiring"
                value={composition.capabilityIssues.length === 0 ? "resolved" : `${composition.capabilityIssues.length} issue${composition.capabilityIssues.length === 1 ? "" : "s"}`}
                tone={composition.capabilityIssues.length === 0 ? "ok" : "alarm"}
              />
              <ReadyRow
                label="Vault password"
                value={vaultNeedsPassword ? "not set" : "set"}
                tone={vaultNeedsPassword ? "alarm" : "ok"}
              />
              <ReadyRow
                label="Verify hooks"
                value={verifyTotal ? `${verifyOk} / ${verifyTotal}` : "not run"}
                tone={verifyTotal && verifyOk === verifyTotal ? "ok" : "default"}
              />
            </Panel>

            {composition.derivedTasks ? (
              <Panel title={`Tasks · derived from ${prettySource(composition.derivedTasks.source)}`}>
                <div className="font-mono" style={{ color: "var(--mute)", fontSize: 11.5, marginBottom: 8 }}>
                  truth file · {composition.derivedTasks.truthFile}
                </div>
                <div style={{ fontSize: 13, color: "var(--mute)" }}>
                  Selecting {prettySource(composition.derivedTasks.source)} as a data source makes derived
                  Tasks Trello-backed automatically.
                </div>
              </Panel>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
  sub,
  mono
}: {
  label: string;
  value: string;
  tone?: "ok" | "default";
  sub?: string;
  mono?: boolean;
}) {
  return (
    <div style={{ padding: "14px 22px", borderRight: "1px solid var(--rule)" }}>
      <div
        className="font-mono"
        style={{
          fontSize: 9.5,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--mute)",
          marginBottom: 4
        }}
      >
        {label}
      </div>
      <div
        className={mono ? "font-mono" : "font-display"}
        style={{
          fontWeight: 600,
          fontSize: mono ? 18 : 22,
          color: tone === "ok" ? "var(--sage)" : "var(--ink)",
          lineHeight: 1.1,
          letterSpacing: mono ? 0 : "-0.005em"
        }}
      >
        {value}
      </div>
      {sub ? (
        <div className="font-mono" style={{ fontSize: 10.5, color: "var(--mute)", marginTop: 4 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function Panel({
  title,
  children,
  tight
}: {
  title: string;
  children: React.ReactNode;
  tight?: boolean;
}) {
  return (
    <div style={{ border: "1px solid var(--rule)", background: "white", padding: tight ? 0 : "16px 18px" }}>
      <h4
        className="font-mono"
        style={{
          fontSize: 10,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: "var(--brass)",
          fontWeight: 500,
          margin: tight ? 0 : "0 0 10px",
          padding: tight ? "14px 18px 10px" : 0,
          borderBottom: tight ? "1px solid var(--rule)" : undefined
        }}
      >
        {title}
      </h4>
      {children}
    </div>
  );
}

function Quick({
  href,
  nm,
  sm,
  alarm
}: {
  href: string;
  nm: string;
  sm: string;
  alarm?: boolean;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        alignItems: "center",
        padding: "10px 18px",
        borderBottom: "1px solid var(--rule)",
        fontSize: 13,
        textDecoration: "none",
        color: "var(--ink)"
      }}
    >
      <div>
        <div style={{ fontWeight: 500 }}>{nm}</div>
        <div style={{ color: alarm ? "var(--alarm)" : "var(--mute)", fontSize: 12, marginTop: 2 }}>
          {sm}
        </div>
      </div>
      <span className="font-mono" style={{ color: "var(--mute)" }}>
        →
      </span>
    </Link>
  );
}

function ReadyRow({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone?: "ok" | "alarm" | "default";
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 6,
        fontSize: 13
      }}
    >
      <span>{label}</span>
      <span
        className="font-mono"
        style={{
          fontWeight: 600,
          fontSize: 12,
          color:
            tone === "ok"
              ? "var(--sage)"
              : tone === "alarm"
              ? "var(--alarm)"
              : "var(--ink)"
        }}
      >
        {value}
      </span>
    </div>
  );
}

function greetingForNow(): string {
  const h = new Date().getHours();
  if (h < 6) return "Late again, Gonçalo.";
  if (h < 12) return "Good morning, Gonçalo.";
  if (h < 18) return "Good afternoon, Gonçalo.";
  return "Good evening, Gonçalo.";
}

function formatNowStamp(): string {
  const d = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${days[d.getDay()]} · ${d.getDate()} ${months[d.getMonth()]} · ${hh}:${mm}`;
}

function shortTime(iso: string): string {
  try {
    return iso.split("T")[1]?.slice(0, 8).replace(/Z?$/, "Z") ?? iso;
  } catch {
    return iso;
  }
}

function streamColor(stream: LogEvent["stream"]): string {
  if (stream === "stderr") return "#c8513f";
  if (stream === "runner") return "#d8a82e";
  if (stream === "input") return "#9aa39c";
  return "#74a385";
}

function statusToneClass(status: RunnerState["status"] | string | undefined): string {
  if (status === "running") return "";
  if (status === "failed") return "alarm";
  if (status === "starting" || status === "verifying" || status === "stopping") return "warn";
  return "idle";
}

function prettySource(source: string): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function operativeSummary(status: string, verifyTotal: number, verifyOk: number): string {
  if (status === "running") {
    return verifyTotal && verifyOk === verifyTotal
      ? "One operative running. Verify clean. Heartbeat keeps the loop ticking."
      : "One operative running. Verify partial — open Run for hook-by-hook detail.";
  }
  if (status === "starting" || status === "verifying") {
    return "Bringing the operative up. APM install in progress, verify pending.";
  }
  if (status === "stopping") {
    return "Tearing down. Materialised .env will be wiped when this completes.";
  }
  if (status === "failed") {
    return "Last run ended in failure. Check the Run panel for the runtime log.";
  }
  return "Operative is idle. Press Run to install Fittings, verify, and start it.";
}
