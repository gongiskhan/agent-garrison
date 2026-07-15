"use client";

// ---------------------------------------------------------------------------
// In-HUD YouTube player — a mini widget docked bottom-right (expandable to a
// centre overlay) that plays the video/music Jarvis was asked for, INSIDE the
// HUD. Playing in-page means the audio comes out of whatever device has the
// HUD open (Mac or phone via Tailscale) — no "wrong device" problem.
//
// Triggered by the `[youtube] <url — title>` marker the Orchestrator appends
// to a "toca/põe o vídeo…" reply (same load-bearing marker pattern as [card]).
// Autoplay is attempted; browsers may require one tap on the play button when
// the page hasn't been interacted with yet (mobile especially).
//
// youtube-nocookie.com: same player, fewer tracking cookies.
// ---------------------------------------------------------------------------

import { useState } from "react";

export type YtPlay = { id: string; title: string };

// Extract a YouTube video id (11 chars) from a marker payload: full URL forms
// (watch?v=, youtu.be/, embed/, shorts/) or a bare id. Whatever follows the
// URL (e.g. "— Bohemian Rhapsody") becomes the display title.
export function parseYtMarker(payload: string): YtPlay | null {
  const s = (payload || "").trim();
  const m =
    s.match(/(?:youtube\.com\/(?:watch\?[^\s]*?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/) ||
    s.match(/(?:^|\s)([A-Za-z0-9_-]{11})(?=\s|$)/);
  if (!m) return null;
  const title = s
    .replace(/https?:\/\/\S+/g, "")
    .replace(m[1], "")
    .replace(/^[\s\-—:·|]+|[\s\-—:·|]+$/g, "")
    .trim();
  return { id: m[1], title };
}

export default function YouTubeWidget({ play, onClose }: { play: YtPlay; onClose: () => void }) {
  const [big, setBig] = useState(false);
  const src = `https://www.youtube-nocookie.com/embed/${play.id}?autoplay=1&playsinline=1`;
  return (
    <div className={`yt-widget${big ? " is-big" : ""}`}>
      <div className="yt-head">
        <span className="yt-brand" aria-hidden>▶</span>
        <span className="yt-title" title={play.title || "YouTube"}>{play.title || "YouTube"}</span>
        {/* escape hatch: some label videos refuse embedding — one tap opens
            the real page (browser tab, same device) */}
        <a
          className="yt-btn"
          href={`https://www.youtube.com/watch?v=${play.id}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="abrir no YouTube"
          title="abrir no YouTube"
        >
          ↗
        </a>
        <button className="yt-btn" onClick={() => setBig((v) => !v)} aria-label={big ? "encolher" : "expandir"}>
          {big ? "⤡" : "⤢"}
        </button>
        <button className="yt-btn" onClick={onClose} aria-label="fechar">✕</button>
      </div>
      <div className="yt-frame">
        <iframe
          src={src}
          title={play.title || "YouTube"}
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>
    </div>
  );
}
