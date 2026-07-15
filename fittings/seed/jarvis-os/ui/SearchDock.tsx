"use client";

// ---------------------------------------------------------------------------
// Search dock — docked web searches on the right flank, each a MINIATURE of
// the centre Google reveal (white card, wordmark, pill query box), tethered to
// the orb by a curved SVG line with a slow energy-flow dash animation. A
// multi-search session reads as a connected constellation around the core.
//
// Everything on the card is a real link (new tab): the pill opens the query on
// Google, each visited domain opens that site. Cards persist ACROSS turns —
// main.tsx caps them at 3, FIFO — and a card's × dismisses just that card.
// Desktop-only — the phone layout hides the right rail.
//
// Tether endpoints: the orb is the full-screen GraphCore centred in the
// viewport, so the line runs viewport-centre → card's left edge. Card rects
// are measured after layout and on resize (cheap: ≤3 cards).
// ---------------------------------------------------------------------------

import { useLayoutEffect, useRef, useState } from "react";

export type DockedSearch = { id: string; query: string; fetches: string[]; summary?: string };

type Tether = { id: string; d: string; x: number; y: number };

// Classic wordmark colours, letter by letter (CSS homage, not a logo asset).
const WORDMARK = [
  { ch: "G", c: "#4285f4" },
  { ch: "o", c: "#ea4335" },
  { ch: "o", c: "#fbbc05" },
  { ch: "g", c: "#4285f4" },
  { ch: "l", c: "#34a853" },
  { ch: "e", c: "#ea4335" },
];

// Last N unique hostnames, newest last.
function uniqueHosts(fetches: string[], n: number): string[] {
  return [...new Set(fetches)].slice(-n);
}

export default function SearchDock({
  searches,
  onDismiss,
}: {
  searches: DockedSearch[];
  onDismiss: (id: string) => void;
}) {
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [tethers, setTethers] = useState<Tether[]>([]);

  // Measure card positions → build orb-centre → card-edge bezier paths. Re-run
  // when the card set changes and on resize. rAF lets the entrance transform
  // settle before measuring (the fly-in animates translate, not layout).
  useLayoutEffect(() => {
    let raf = 0;
    const measure = () => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const next: Tether[] = [];
      for (const s of searches) {
        const el = cardRefs.current.get(s.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const x = r.left - 6; // just off the card's left edge
        const y = r.top + Math.min(30, r.height / 2); // near the card head
        const mx = (cx + x) / 2;
        next.push({ id: s.id, d: `M ${cx} ${cy} C ${mx} ${cy}, ${mx} ${y}, ${x} ${y}`, x, y });
      }
      setTethers(next);
    };
    raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [searches]);

  if (searches.length === 0) return null;

  return (
    <>
      <svg className="sdock-links" aria-hidden>
        {tethers.map((t) => (
          <g key={t.id} className="sdock-link">
            <path className="sdock-link-glow" d={t.d} />
            <path className="sdock-link-line" d={t.d} />
            <circle className="sdock-link-node" cx={t.x} cy={t.y} r="3" />
          </g>
        ))}
      </svg>

      <div className="sdock">
        {searches.map((s) => (
          <div
            key={s.id}
            className="sdock-card"
            ref={(el) => {
              if (el) cardRefs.current.set(s.id, el);
              else cardRefs.current.delete(s.id);
            }}
          >
            <div className="sdock-head">
              <span className="sdock-brand" aria-hidden>
                {WORDMARK.map((l, i) => (
                  <span key={i} style={{ color: l.c }}>
                    {l.ch}
                  </span>
                ))}
              </span>
              <button className="sdock-close" onClick={() => onDismiss(s.id)} aria-label="dismiss">
                ✕
              </button>
            </div>

            {/* The pill IS the search — opens the real results in a new tab. */}
            <a
              className="sdock-pill"
              href={`https://www.google.com/search?q=${encodeURIComponent(s.query)}`}
              target="_blank"
              rel="noopener noreferrer"
              title={s.query}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <path
                  fill="#9aa0a6"
                  d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14Z"
                />
              </svg>
              <span className="sdock-pill-text">{s.query}</span>
            </a>

            {/* 1–2 line digest of the turn's answer, stamped when the reply
                lands ("" = the turn ended without one — row stays hidden). */}
            {s.summary ? <div className="sdock-summary">{s.summary}</div> : null}

            {s.fetches.length > 0 && (
              <div className="sdock-hosts">
                {uniqueHosts(s.fetches, 3).map((h) => (
                  <a
                    className="sdock-host"
                    key={h}
                    href={`https://${h}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="sdock-favicon" />
                    {h}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
