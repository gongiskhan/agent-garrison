"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface ViewEntry {
  fittingId: string;
  port: number;
  url: string;
  pid: number | null;
  startedAt: string | null;
  healthy: boolean;
}

export default function EmbedPage() {
  const params = useParams<{ fittingId: string }>();
  const fittingId = params.fittingId;
  const [entry, setEntry] = useState<ViewEntry | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const res = await fetch("/api/fittings/views", { cache: "no-store" });
        const data = await res.json();
        const found = (data.views as ViewEntry[] | undefined)?.find(
          (v) => v.fittingId === fittingId
        );
        if (alive) setEntry(found ?? null);
      } catch {
        if (alive) setEntry(null);
      }
    }
    void load();
    return () => {
      alive = false;
    };
  }, [fittingId]);

  if (entry === undefined) {
    return (
      <div style={{ padding: 24, color: "var(--mute)" }}>Loading view…</div>
    );
  }
  if (!entry || !entry.url) {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ marginTop: 0 }}>{fittingId} is not running</h2>
        <p style={{ color: "var(--mute)" }}>
          Start the operative to launch this view, or open the fitting overview
          to inspect it.
        </p>
      </div>
    );
  }
  return (
    <iframe
      src={entry.url}
      title={fittingId}
      style={{
        width: "100%",
        height: "100vh",
        border: 0,
        display: "block",
        background: "var(--paper)"
      }}
    />
  );
}
