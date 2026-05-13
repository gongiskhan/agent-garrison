"use client";

import { useEffect, useState } from "react";

const FRAME_URL = "/api/trenches/screen-share/frame";
const POLL_INTERVAL_MS = 500;

interface Props {
  outpost?: string | null;
}

export function ScreenShare({ outpost }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let prevUrl: string | null = null;

    async function tick() {
      if (cancelled) return;
      try {
        const base = outpost
          ? `${FRAME_URL}?outpost=${encodeURIComponent(outpost)}&t=${Date.now()}`
          : `${FRAME_URL}?t=${Date.now()}`;
        const res = await fetch(base, { cache: "no-store" });
        if (!res.ok) {
          if (res.status !== 404) {
            setError(`frame ${res.status}`);
          }
        } else {
          const blob = await res.blob();
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          setSrc(url);
          if (prevUrl) URL.revokeObjectURL(prevUrl);
          prevUrl = url;
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (prevUrl) URL.revokeObjectURL(prevUrl);
    };
  }, [outpost]);

  return (
    <div
      style={{
        flex: 1,
        background: "#0e0e0e",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 0,
      }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt="screen share"
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        />
      ) : (
        <div style={{ color: "var(--mute)", fontSize: 13 }}>
          {error ? `Capturing… (${error})` : "Capturing first frame…"}
        </div>
      )}
    </div>
  );
}
