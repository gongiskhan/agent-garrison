"use client";

import { useEffect, useState } from "react";

interface OutpostStatus {
  lastSyncAt?: string;
  uploaded: number;
  deleted: number;
  skipped: number;
  failed: number;
  error?: string;
}

type SyncStatus = Record<string, OutpostStatus>;

function timeAgo(iso: string): string {
  const delta = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

export default function VaultSyncStatus() {
  const [status, setStatus] = useState<SyncStatus>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/vault-sync/status");
        if (!cancelled && res.ok) {
          const data = (await res.json()) as SyncStatus;
          setStatus(data);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const interval = setInterval(() => { void load(); }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const entries = Object.entries(status);

  return (
    <div style={{ padding: 16, fontSize: 13 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>Vault Sync</div>
      {error ? (
        <div style={{ color: "var(--alarm)", fontSize: 12 }}>{error}</div>
      ) : entries.length === 0 ? (
        <p style={{ color: "var(--mute)", fontSize: 12 }}>No sync data yet.</p>
      ) : (
        <table className="simple" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Outpost</th>
              <th>Last sync</th>
              <th>Up</th>
              <th>Del</th>
              <th>Skip</th>
              <th>Fail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([name, s]) => (
              <tr key={name}>
                <td>{name}</td>
                <td style={{ color: "var(--mute)" }}>
                  {s.lastSyncAt ? timeAgo(s.lastSyncAt) : "—"}
                </td>
                <td>{s.uploaded}</td>
                <td>{s.deleted}</td>
                <td>{s.skipped}</td>
                <td style={{ color: s.failed > 0 ? "var(--alarm)" : undefined }}>
                  {s.failed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {entries.some(([, s]) => s.error) ? (
        <div style={{ marginTop: 8, fontSize: 11, color: "var(--alarm)" }}>
          {entries
            .filter(([, s]) => s.error)
            .map(([name, s]) => (
              <div key={name}>{name}: {s.error}</div>
            ))}
        </div>
      ) : null}
    </div>
  );
}
