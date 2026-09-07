"use client";

// ---------------------------------------------------------------------------
// Spotify now-playing — a VINYL: the album art is a spinning record (grooves,
// spindle hole, sheen) wrapped in a circular progress ring, floating on a dark
// glass card with the album art blurred into an ambient aura behind it.
// Spin runs while playing and freezes on pause (animation-play-state — the
// element never remounts, so the rotation angle is continuous across polls).
// Progress ticks locally every second between the 10s polls.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

export type MusicState = {
  available: boolean;
  is_playing?: boolean;
  track?: string | null;
  artist?: string | null;
  album?: string | null;
  art?: string | null;
  device?: string | null;
  progress_ms?: number | null;
  duration_ms?: number | null;
};

function fmtMs(ms?: number | null): string {
  if (ms == null) return "";
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const RING_R = 56; // svg units; ring radius around the 96px disc
const RING_C = 2 * Math.PI * RING_R;

export default function MusicWidget({
  music,
  onCmd,
  onClose,
}: {
  music: MusicState;
  onCmd: (action: "pause" | "resume" | "next" | "previous") => void;
  onClose: () => void;
}) {
  // Local 1s progress tick between polls; resnaps whenever a poll lands.
  const [localMs, setLocalMs] = useState<number | null>(music.progress_ms ?? null);
  useEffect(() => setLocalMs(music.progress_ms ?? null), [music.progress_ms, music.track]);
  useEffect(() => {
    if (!music.is_playing) return;
    const t = setInterval(() => {
      setLocalMs((v) => (v == null ? v : Math.min(v + 1000, music.duration_ms ?? v + 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [music.is_playing, music.duration_ms]);

  const pct = localMs != null && music.duration_ms ? Math.min(1, localMs / music.duration_ms) : 0;

  return (
    <div className="mw2">
      {music.art ? <img className="mw2-aura" src={music.art} alt="" aria-hidden /> : null}
      <div className="mw2-glass">
        <div className={`mw2-turntable${music.is_playing ? " is-spinning" : ""}`}>
          <svg className="mw2-ring" viewBox="0 0 128 128" aria-hidden>
            <circle className="mw2-ring-track" cx="64" cy="64" r={RING_R} />
            <circle
              className="mw2-ring-fill"
              cx="64"
              cy="64"
              r={RING_R}
              strokeDasharray={RING_C}
              strokeDashoffset={RING_C * (1 - pct)}
            />
          </svg>
          <div
            className="mw2-disc"
            style={music.art ? { backgroundImage: `url(${music.art})` } : undefined}
          >
            <div className="mw2-grooves" />
            <div className="mw2-spindle" />
          </div>
        </div>

        <div className="mw2-body">
          <div className="mw2-track" title={music.track ?? ""}>{music.track ?? "—"}</div>
          <div className="mw2-artist" title={music.artist ?? ""}>{music.artist ?? ""}</div>
          <div className="mw2-meta">
            <span className="mw2-time">{fmtMs(localMs)} · {fmtMs(music.duration_ms)}</span>
            {music.device ? <span className="mw2-device">▸ {music.device}</span> : null}
          </div>
          <div className="mw2-controls">
            <button className="mw2-btn" onClick={() => onCmd("previous")} aria-label="anterior">⏮</button>
            <button
              className="mw2-btn mw2-play"
              onClick={() => onCmd(music.is_playing ? "pause" : "resume")}
              aria-label={music.is_playing ? "pausa" : "tocar"}
            >
              {music.is_playing ? "❚❚" : "▶"}
            </button>
            <button className="mw2-btn" onClick={() => onCmd("next")} aria-label="seguinte">⏭</button>
          </div>
        </div>

        <button className="mw2-close" onClick={onClose} aria-label="fechar">✕</button>
      </div>
    </div>
  );
}
