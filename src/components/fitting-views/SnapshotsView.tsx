"use client";

import { useCallback, useEffect, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";

interface SnapshotsState {
  lastRun: string;
  ok: boolean;
  bytes?: number;
  error?: string;
}

interface Snapshot {
  id: string;
  time?: string;
  paths?: string[];
  hostname?: string;
}

interface StatusResponse {
  state: SnapshotsState | null;
  repository: string | null;
  snapshots: Snapshot[] | null;
  snapshotsError?: string;
  restoreHint: string;
}

export default function SnapshotsView(_props: FittingViewProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "run" | "verify">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; output: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/snapshots/status");
      const data = (await res.json()) as StatusResponse | { error: string };
      if (!res.ok) throw new Error("error" in data ? data.error : res.statusText);
      setStatus(data as StatusResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runBackup = useCallback(async () => {
    setBusy("run");
    setNotice(null);
    try {
      const res = await fetch("/api/snapshots/run", { method: "POST" });
      const data = (await res.json()) as { started?: boolean; error?: string };
      if (!res.ok || !data.started) throw new Error(data.error ?? "could not start backup");
      setNotice("Backup started in the background. Refresh in a moment to see the result.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const runVerify = useCallback(async () => {
    setBusy("verify");
    setVerifyResult(null);
    try {
      const res = await fetch("/api/snapshots/verify", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; output?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "verify failed to run");
      setVerifyResult({ ok: Boolean(data.ok), output: data.output ?? "" });
    } catch (err) {
      setVerifyResult({ ok: false, output: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }, []);

  const state = status?.state ?? null;
  const snapshots = status?.snapshots ?? null;
  const repository = status?.repository ?? null;
  const initialLoading = status === null && error === null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        width: "100%",
        minWidth: 0,
        gap: 20,
        maxWidth: 820
      }}
    >
      <header style={{ borderLeft: "2px solid var(--brass)", paddingLeft: 18 }}>
        <div className="font-mono" style={{ fontSize: 10, letterSpacing: "0.17em", textTransform: "uppercase", color: "var(--brass)", marginBottom: 5 }}>
          State protection
        </div>
        <div className="font-display" style={{ fontSize: 28, lineHeight: 1.05, letterSpacing: "-0.025em", fontWeight: 600 }}>
          Snapshots
        </div>
        <div style={{ maxWidth: 620, fontSize: 13.5, lineHeight: 1.65, color: "var(--mute)", marginTop: 7 }}>
          Off-site, encrypted restic backups of the Garrison state. Scheduled
          daily by a systemd timer, independent of Garrison.
        </div>
      </header>

      {error ? <Notice title="Cannot load status" body={error} tone="bad" /> : null}

      <Panel title="Last backup">
        {initialLoading ? (
          <PanelLoading label="Reading backup status" />
        ) : state ? (
          <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
            <Row label="Result">
              <StatusBadge ok={state.ok} />
            </Row>
            <Row label="When">
              <span className="font-mono">{formatTime(state.lastRun)}</span>
            </Row>
            {typeof state.bytes === "number" ? (
              <Row label="Processed">
                <span className="font-mono">{formatBytes(state.bytes)}</span>
              </Row>
            ) : null}
            {state.error ? (
              <Row label="Error">
                <span style={{ color: "var(--alarm)" }}>{state.error}</span>
              </Row>
            ) : null}
          </div>
        ) : (
          <EmptyState title="No backup recorded">
            Run the first encrypted backup to establish a restore point.
          </EmptyState>
        )}
      </Panel>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 9, alignItems: "center" }}>
        <button type="button" onClick={runBackup} disabled={busy !== null} className={primaryButtonClass}>
          {busy === "run" ? "Starting…" : "Back up now"}
        </button>
        <button type="button" onClick={runVerify} disabled={busy !== null} className={secondaryButtonClass}>
          {busy === "verify" ? "Checking…" : "Verify repository"}
        </button>
        <button type="button" onClick={() => void refresh()} disabled={busy !== null} className={secondaryButtonClass}>
          Refresh
        </button>
      </div>

      {notice ? <Notice title="Backup queued" body={notice} tone="info" /> : null}

      {verifyResult ? (
        <Panel title="Verify result">
          <div style={{ marginBottom: 6 }}>
            <StatusBadge ok={verifyResult.ok} okLabel="check passed" badLabel="check failed" />
          </div>
          {verifyResult.output ? (
            <pre style={preStyle}>{verifyResult.output}</pre>
          ) : null}
        </Panel>
      ) : null}

      <Panel title="Repository">
        {initialLoading ? (
          <PanelLoading label="Reading repository" />
        ) : (
          <div style={{ display: "grid", gap: 7, fontSize: 13 }}>
            <Row label="Location">
              <span className="font-mono" style={{ overflowWrap: "anywhere" }}>{repository ?? "not configured"}</span>
            </Row>
            <Row label="Snapshots">
              {snapshots ? (
                <span className="font-mono">{snapshots.length}</span>
              ) : (
                <span style={{ color: "var(--mute)" }}>
                  {status?.snapshotsError ?? "unavailable"}
                </span>
              )}
            </Row>
          </div>
        )}
        {!initialLoading && snapshots && snapshots.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 6 }}>
            {snapshots.slice(-5).reverse().map((snap) => (
              <li
                key={snap.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(90px, auto) 1fr",
                  gap: 12,
                  fontSize: 12,
                  padding: "8px 10px",
                  background: "var(--surface-strong)",
                  borderLeft: "2px solid var(--rule-2)"
                }}
              >
                <span className="font-mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{snap.id}</span>
                <span className="font-mono" style={{ color: "var(--mute)" }}>
                  {formatTime(snap.time)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel title="Restore">
        <div style={{ maxWidth: 640, fontSize: 13, lineHeight: 1.6, color: "var(--mute)", marginBottom: 10 }}>
          Restore is never automated. Copy the command below, swap in the snapshot
          id and a target directory, and run it in a terminal.
        </div>
        <pre style={preStyle}>{status?.restoreHint ?? "restic -r <repo> restore <snapshot-id> --target <target-dir>"}</pre>
      </Panel>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        border: "1px solid var(--rule)",
        borderTop: "2px solid var(--brass)",
        background: "var(--surface)",
        padding: "16px 18px"
      }}
    >
      <div className="font-mono" style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.15em", color: "var(--brass)", marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function PanelLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" style={{ display: "grid", gap: 8 }}>
      <span className="skeleton-line" style={{ display: "block", width: "54%", height: 10, borderRadius: 2 }} aria-hidden />
      <span className="skeleton-line" style={{ display: "block", width: "36%", height: 10, borderRadius: 2 }} aria-hidden />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}

function EmptyState({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px dashed var(--rule-2)",
        borderLeft: "3px solid var(--brass)",
        background: "var(--surface-strong)",
        padding: "12px 14px",
        fontSize: 12.5,
        lineHeight: 1.6,
        color: "var(--mute)"
      }}
    >
      <b style={{ display: "block", marginBottom: 2, color: "var(--ink)" }}>{title}</b>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(86px, 0.28fr) minmax(0, 1fr)", gap: 12 }}>
      <span className="font-mono" style={{ fontSize: 11, color: "var(--mute)" }}>{label}</span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

function StatusBadge({
  ok,
  okLabel = "success",
  badLabel = "failed"
}: {
  ok: boolean;
  okLabel?: string;
  badLabel?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        padding: "3px 8px",
        border: `1px solid ${ok ? "var(--sage)" : "var(--alarm)"}`,
        background: ok ? "var(--sage-soft)" : "var(--alarm-soft)",
        color: ok ? "var(--sage)" : "var(--alarm)"
      }}
    >
      {ok ? okLabel : badLabel}
    </span>
  );
}

function Notice({ title, body, tone }: { title: string; body?: string; tone?: "bad" | "info" }) {
  const bad = tone === "bad";
  return (
    <div
      style={{
        border: "1px solid var(--rule)",
        borderLeft: `3px solid ${bad ? "var(--alarm)" : "var(--brass)"}`,
        background: bad ? "var(--alarm-soft)" : "var(--surface)",
        padding: "11px 14px"
      }}
      role={bad ? "alert" : "status"}
      aria-live={bad ? "assertive" : "polite"}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: bad ? "var(--alarm)" : "var(--ink)" }}>{title}</div>
      {body ? (
        <div style={{ color: "var(--mute)", fontSize: 12.5, lineHeight: 1.55, marginTop: 4 }}>{body}</div>
      ) : null}
    </div>
  );
}

const primaryButtonClass =
  "min-h-10 rounded-[4px] border border-[var(--sage)] bg-[var(--sage)] px-4 text-xs font-semibold text-[var(--paper)] transition hover:border-[var(--sage-2)] hover:bg-[var(--sage-2)] active:translate-y-px active:scale-[0.99] disabled:opacity-50";

const secondaryButtonClass =
  "min-h-10 rounded-[4px] border border-[var(--rule-2)] bg-[var(--surface)] px-4 text-xs font-semibold text-[var(--ink)] transition hover:border-[var(--brass)] hover:bg-[var(--paper-2)] active:translate-y-px active:scale-[0.99] disabled:opacity-50";

const preStyle: React.CSSProperties = {
  background: "var(--ink)",
  color: "var(--paper-2)",
  borderLeft: "3px solid var(--brass)",
  padding: "13px 14px",
  fontFamily: "var(--font-mono), monospace",
  fontSize: 12.5,
  lineHeight: 1.6,
  overflowX: "auto",
  margin: 0,
  whiteSpace: "pre",
  wordBreak: "normal"
};

function formatTime(iso?: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
