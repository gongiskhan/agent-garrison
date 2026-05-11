"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FittingViewProps } from "@/components/fitting-views/registry";

interface OutpostStatus {
  name: string;
  registeredAt: string;
  connected: boolean;
  lastHeartbeat: string | null;
  events: { type: string; payload: unknown; receivedAt: string }[];
}

function formatAge(iso: string | null): string {
  if (!iso) return "never";
  const delta = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

export default function OutpostView(_props: FittingViewProps) {
  const [outposts, setOutposts] = useState<OutpostStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showWizard, setShowWizard] = useState(false);
  const [wizardName, setWizardName] = useState("");
  const [wizardHost, setWizardHost] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [generatedCommand, setGeneratedCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const failRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/workbench/outposts", { cache: "no-store" });
      const data = (await res.json()) as { outposts?: OutpostStatus[]; error?: string };
      if (!res.ok) {
        failRef.current += 1;
        setError(data.error ?? `HTTP ${res.status}`);
      } else {
        failRef.current = 0;
        setOutposts(data.outposts ?? []);
      }
    } catch (err) {
      failRef.current += 1;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(tick, 3000);
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  const handleGenerate = async () => {
    if (!wizardName.trim() || !wizardHost.trim()) {
      setGenError("Machine name and Garrison host are required.");
      return;
    }
    setGenerating(true);
    setGenError(null);
    setGeneratedCommand(null);
    try {
      const res = await fetch("/api/workbench/outposts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: wizardName.trim(), garrison_host: wizardHost.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; command?: string; error?: string };
      if (!res.ok || !data.ok) {
        setGenError(data.error ?? `HTTP ${res.status}`);
      } else {
        setGeneratedCommand(data.command ?? "");
        await refresh();
      }
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = () => {
    if (!generatedCommand) return;
    void navigator.clipboard.writeText(generatedCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRemove = async (name: string) => {
    try {
      await fetch(`/api/workbench/outposts/${encodeURIComponent(name)}`, { method: "DELETE" });
      await refresh();
    } catch {
      // swallow — next poll will reflect reality
    }
  };

  const closeWizard = () => {
    setShowWizard(false);
    setWizardName("");
    setWizardHost("");
    setGenError(null);
    setGeneratedCommand(null);
    setCopied(false);
  };

  return (
    <div style={{ padding: "16px", fontFamily: "var(--font-mono, monospace)", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Outposts</span>
        {loading && <span style={{ color: "var(--mute, #888)" }}>refreshing…</span>}
        <button
          onClick={() => (showWizard ? closeWizard() : setShowWizard(true))}
          style={{
            marginLeft: "auto",
            padding: "4px 10px",
            background: "var(--panel, #1e1e1e)",
            border: "1px solid var(--border, #333)",
            color: "var(--fg, #ccc)",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          {showWizard ? "Cancel" : "Add outpost"}
        </button>
      </div>

      {error && (
        <div style={{ color: "var(--alarm, #f44)", marginBottom: 12 }}>
          Error: {error}
        </div>
      )}

      {showWizard && (
        <div
          style={{
            background: "var(--panel, #1e1e1e)",
            border: "1px solid var(--border, #333)",
            borderRadius: 6,
            padding: 14,
            marginBottom: 16,
          }}
        >
          {generatedCommand ? (
            <>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>Bootstrap command</div>
              <div style={{ fontSize: 11, color: "var(--mute, #888)", marginBottom: 8 }}>
                Run this on the remote Mac. The outpost will appear connected within 60s.
              </div>
              <div
                style={{
                  background: "var(--bg, #111)",
                  border: "1px solid var(--border, #333)",
                  borderRadius: 4,
                  padding: "8px 10px",
                  fontSize: 11,
                  wordBreak: "break-all",
                  marginBottom: 10,
                  lineHeight: 1.5,
                }}
              >
                {generatedCommand}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={handleCopy}
                  style={{
                    padding: "5px 12px",
                    background: copied ? "var(--sage, #4a8)" : "var(--panel, #1e1e1e)",
                    border: "1px solid var(--border, #333)",
                    color: copied ? "#000" : "var(--fg, #ccc)",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={closeWizard}
                  style={{
                    padding: "5px 12px",
                    background: "transparent",
                    border: "1px solid var(--border, #333)",
                    color: "var(--mute, #888)",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  Done
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>Generate bootstrap command</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <input
                  placeholder="Machine name (e.g. mac-studio)"
                  value={wizardName}
                  onChange={(e) => setWizardName(e.target.value)}
                  style={{
                    background: "var(--bg, #111)",
                    border: "1px solid var(--border, #333)",
                    color: "var(--fg, #ccc)",
                    padding: "6px 8px",
                    borderRadius: 4,
                    fontSize: 13,
                  }}
                />
                <input
                  placeholder="Garrison host (Tailscale IP or hostname)"
                  value={wizardHost}
                  onChange={(e) => setWizardHost(e.target.value)}
                  style={{
                    background: "var(--bg, #111)",
                    border: "1px solid var(--border, #333)",
                    color: "var(--fg, #ccc)",
                    padding: "6px 8px",
                    borderRadius: 4,
                    fontSize: 13,
                  }}
                />
                {genError && <div style={{ color: "var(--alarm, #f44)", fontSize: 12 }}>{genError}</div>}
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  style={{
                    padding: "6px 12px",
                    background: "var(--sage, #4a8)",
                    border: "none",
                    color: "#000",
                    borderRadius: 4,
                    cursor: generating ? "not-allowed" : "pointer",
                    fontWeight: 600,
                    fontSize: 13,
                    alignSelf: "flex-start",
                  }}
                >
                  {generating ? "Generating…" : "Generate"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {outposts.length === 0 && !loading && (
        <div style={{ color: "var(--mute, #888)" }}>
          No outposts registered. Click &ldquo;Add outpost&rdquo; to connect a remote Mac.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {outposts.map((o) => (
          <div
            key={o.name}
            style={{
              background: "var(--panel, #1e1e1e)",
              border: "1px solid var(--border, #333)",
              borderRadius: 6,
              padding: "10px 14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: o.connected ? "var(--sage, #4a8)" : "var(--mute, #888)",
                  flexShrink: 0,
                  display: "inline-block",
                }}
              />
              <span style={{ fontWeight: 600, flexGrow: 1 }}>{o.name}</span>
              <span style={{ color: "var(--mute, #888)", fontSize: 11 }}>
                {o.connected ? "connected" : "disconnected"}
              </span>
              <button
                onClick={() => void handleRemove(o.name)}
                style={{
                  padding: "2px 8px",
                  background: "transparent",
                  border: "1px solid var(--border, #333)",
                  color: "var(--mute, #888)",
                  borderRadius: 3,
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                Remove
              </button>
            </div>
            <div style={{ marginTop: 6, color: "var(--mute, #888)", fontSize: 11 }}>
              Heartbeat: {formatAge(o.lastHeartbeat)}
              {o.registeredAt && (
                <span style={{ marginLeft: 16 }}>
                  Registered: {new Date(o.registeredAt).toLocaleDateString()}
                </span>
              )}
            </div>
            {o.events.length > 0 && (
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--mute, #888)" }}>
                Last event: {o.events[o.events.length - 1].type}{" "}
                <span style={{ opacity: 0.6 }}>
                  {formatAge(o.events[o.events.length - 1].receivedAt)}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
