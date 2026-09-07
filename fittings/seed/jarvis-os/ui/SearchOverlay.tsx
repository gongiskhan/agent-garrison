"use client";

// ---------------------------------------------------------------------------
// Web-search reveal overlay — a cinematic Google-style search box that TYPES
// the Operative's live query (typewriter), then drops into a "searching" state
// and fills faux result rows with the domains Jarvis actually opens (WebFetch).
//
// Triggered from the `activity` SSE feed: a WebSearch tool_use (re)opens it with
// the query; WebFetch tool_uses append their hostnames. It does not vanish — it
// DOCKS: shortly after the typewriter finishes (or when the reply starts / a new
// search fires / Esc / scrim click), main.tsx flips it into a SearchDock card on
// the right flank, tethered to the orb. `leaving` plays the fly-right exit that
// sells the hand-off.
//
// The Google wordmark is a CSS letter homage (coloured <span>s), not an embedded
// logo asset — a personal, local HUD flourish, never distributed.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";

// Classic wordmark colours, letter by letter.
const WORDMARK = [
  { ch: "G", c: "#4285f4" },
  { ch: "o", c: "#ea4335" },
  { ch: "o", c: "#fbbc05" },
  { ch: "g", c: "#4285f4" },
  { ch: "l", c: "#34a853" },
  { ch: "e", c: "#ea4335" },
];

const TYPE_MS = 45; // per-character reveal cadence
const DOCK_DWELL_MS = 3600; // time fully-typed + searching before auto-docking

export default function SearchOverlay({
  query,
  fetches,
  leaving,
  onClose,
}: {
  query: string;
  /** hostnames Jarvis has opened this search, newest last */
  fetches: string[];
  /** exit animation running — the card is flying right into the dock */
  leaving?: boolean;
  onClose: () => void;
}) {
  // Typewriter: reveal `query` one char at a time, then flip to "searching".
  const [typed, setTyped] = useState("");
  const [done, setDone] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Reset for a fresh query (component is keyed by search id, so this runs on
    // each new search) and schedule one timer per character.
    setTyped("");
    setDone(false);
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const chars = Array.from(query);
    chars.forEach((_, i) => {
      timers.current.push(
        setTimeout(() => setTyped(chars.slice(0, i + 1).join("")), TYPE_MS * (i + 1)),
      );
    });
    timers.current.push(setTimeout(() => setDone(true), TYPE_MS * chars.length + 260));
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, [query]);

  // Auto-dock: once the box has sat in "searching" for the dwell, hand off to
  // the dock (main.tsx owns the flip). A new query remounts (key) and re-arms.
  useEffect(() => {
    if (!done || leaving) return;
    const t = setTimeout(onClose, DOCK_DWELL_MS);
    return () => clearTimeout(t);
  }, [done, leaving, onClose]);

  return (
    <div className={`gsearch-overlay${leaving ? " is-leaving" : ""}`} onClick={onClose}>
      <div className="gsearch-card" onClick={(e) => e.stopPropagation()}>
        <div className="gsearch-wordmark" aria-hidden>
          {WORDMARK.map((l, i) => (
            <span key={i} style={{ color: l.c }}>
              {l.ch}
            </span>
          ))}
        </div>

        <div className={`gsearch-box${done ? " is-searching" : ""}`}>
          <svg className="gsearch-glass" viewBox="0 0 24 24" width="20" height="20" aria-hidden>
            <path
              fill="#9aa0a6"
              d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14Z"
            />
          </svg>
          <span className="gsearch-text">
            {typed}
            <span className="gsearch-caret" data-done={done} />
          </span>
          <svg className="gsearch-mic" viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path fill="#4285f4" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
            <path
              fill="#34a853"
              d="M17 12a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V22h2v-3.08A7 7 0 0 0 19 12h-2Z"
            />
          </svg>
        </div>

        <div className="gsearch-status" data-done={done}>
          {done ? "a pesquisar na web…" : ""}
        </div>

        {/* Faux result rows — skeleton shimmer, filled by the domains Jarvis
            actually opens. Purely a visual echo of real WebFetch activity. */}
        {done && (
          <div className="gsearch-results">
            {(fetches.length ? fetches : [null, null, null]).slice(-3).map((host, i) => (
              <div className="gsearch-result" key={`${host ?? "sk"}-${i}`}>
                <div className="gsearch-result-host">
                  {host ? (
                    <>
                      <span className="gsearch-favicon" />
                      {host}
                    </>
                  ) : (
                    <span className="gsearch-skel gsearch-skel-host" />
                  )}
                </div>
                <span className="gsearch-skel gsearch-skel-line" />
                <span className="gsearch-skel gsearch-skel-line short" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
