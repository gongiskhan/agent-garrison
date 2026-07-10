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

  return (
    <div style={{ display: "grid", gap: 18, maxWidth: 760 }}>
      <header>
        <div style={{ fontSize: 20, fontWeight: 600 }}>Snapshots</div>
        <div style={{ fontSize: 13, color: "var(--mute)", marginTop: 4 }}>
          Off-site, encrypted restic backups of the Garrison state. Scheduled
          daily by a systemd timer, independent of Garrison.
        </div>
      </header>

      {error ? <Notice title="Cannot load status" body={error} tone="bad" /> : null}

      <Panel title="Last backup">
        {state ? (
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
                <span style={{ color: "var(--bad, #b00020)" }}>{state.error}</span>
              </Row>
            ) : null}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "var(--mute)" }}>
            No backup has run yet.
          </div>
        )}
      </Panel>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button type="button" onClick={runBackup} disabled={busy !== null} style={primaryButton}>
          {busy === "run" ? "Starting…" : "Back up now"}
        </button>
        <button type="button" onClick={runVerify} disabled={busy !== null} style={secondaryButton}>
          {busy === "verify" ? "Checking…" : "Verify repository"}
        </button>
        <button type="button" onClick={() => void refresh()} disabled={busy !== null} style={secondaryButton}>
          Refresh
        </button>
      </div>

      {notice ? <Notice title={notice} tone="info" /> : null}

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
        <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
          <Row label="Location">
            <span className="font-mono">{repository ?? "not configured"}</span>
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
        {snapshots && snapshots.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 6 }}>
            {snapshots.slice(-5).reverse().map((snap) => (
              <li
                key={snap.id}
                style={{
                  display: "flex",
                  gap: 12,
                  fontSize: 12,
                  padding: "6px 0",
                  borderTop: "1px solid var(--rule)"
                }}
              >
                <span className="font-mono" style={{ minWidth: 90 }}>{snap.id}</span>
                <span className="font-mono" style={{ color: "var(--mute)" }}>
                  {formatTime(snap.time)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel title="Restore">
        <div style={{ fontSize: 13, color: "var(--mute)", marginBottom: 8 }}>
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
        background: "var(--paper, white)",
        padding: "14px 18px"
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--mute)", marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <span style={{ minWidth: 90, color: "var(--mute)" }}>{label}</span>
      <span>{children}</span>
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
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        border: "1px solid var(--ink)",
        background: ok ? "var(--ink)" : "transparent",
        color: ok ? "white" : "var(--bad, #b00020)"
      }}
    >
      {ok ? okLabel : badLabel}
    </span>
  );
}

function Notice({ title, body, tone }: { title: string; body?: string; tone?: "bad" | "info" }) {
  return (
    <div
      style={{
        border: "1px solid var(--rule)",
        borderLeft: `3px solid ${tone === "bad" ? "var(--bad, #b00020)" : "var(--ink)"}`,
        background: "var(--paper-2, #f6f6f4)",
        padding: "10px 14px"
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      {body ? (
        <div style={{ color: "var(--mute)", fontSize: 12, marginTop: 4 }}>{body}</div>
      ) : null}
    </div>
  );
}

const primaryButton: React.CSSProperties = {
  padding: "6px 14px",
  border: "1px solid var(--ink)",
  background: "var(--ink)",
  color: "white",
  fontSize: 12,
  cursor: "pointer"
};

const secondaryButton: React.CSSProperties = {
  padding: "6px 14px",
  border: "1px solid var(--rule)",
  background: "transparent",
  color: "var(--ink)",
  fontSize: 12,
  cursor: "pointer"
};

const preStyle: React.CSSProperties = {
  background: "var(--paper-2, #f6f6f4)",
  padding: 12,
  fontSize: 12.5,
  overflowX: "auto",
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all"
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
