"use client";

import { useState } from "react";
import { ScreenShare } from "./ScreenShare";
import type { FittingViewProps } from "@/components/fitting-views/registry";

export default function ScreenShareView(_props: FittingViewProps) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function startCapture() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/trenches/screen-share", { method: "POST" });
      if (!res.ok) {
        const message = await extractErrorMessage(res);
        setError(message);
      } else {
        setRunning(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function extractErrorMessage(res: Response): Promise<string> {
    const fallback = `HTTP ${res.status}`;
    const text = await res.text().catch(() => "");
    if (!text) return fallback;
    try {
      const body = JSON.parse(text) as { error?: string };
      return body.error ?? fallback;
    } catch {
      const snippet = text.slice(0, 200);
      return `${fallback}: ${snippet}`;
    }
  }

  async function stopCapture() {
    setRunning(false);
    await fetch("/api/trenches/screen-share", { method: "DELETE" }).catch(() => null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 16 }}>
      <div className="strip" style={{ marginBottom: 12 }}>
        {!running ? (
          <button
            type="button"
            className="btn primary small"
            onClick={startCapture}
            disabled={starting}
          >
            {starting ? "Starting…" : "Start Screen Share"}
          </button>
        ) : (
          <button
            type="button"
            className="btn danger small"
            onClick={stopCapture}
          >
            Stop
          </button>
        )}
      </div>
      {error ? (
        <div
          style={{
            padding: "10px 14px",
            background: "var(--alarm-soft)",
            color: "var(--alarm)",
            fontSize: 12,
            borderRadius: 4,
            marginBottom: 12,
            whiteSpace: "pre-wrap"
          }}
        >
          {error}
        </div>
      ) : null}
      {running ? (
        <ScreenShare />
      ) : (
        <div style={{ color: "var(--mute)", fontSize: 13 }}>
          Click &ldquo;Start Screen Share&rdquo; to begin capturing. Requires Screen Recording
          permission in System Settings for the process that started Garrison.
        </div>
      )}
    </div>
  );
}
