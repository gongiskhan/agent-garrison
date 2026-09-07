"use client";

// ---------------------------------------------------------------------------
// Info widgets — product-styled data cards on the right flank, opened by the
// reply markers `[agenda] {json}` (Google Calendar), `[emails] {json}` (Gmail)
// and `[board] {json}` (Trello). Same load-bearing marker pattern as [card] /
// [youtube]: the Orchestrator fetches real data via its connectors, distills
// it into one single-line JSON payload, and the HUD renders it while the
// spoken reply stays short. Markers are stripped from chat and speech.
//
// Choreography (same as the Google-search reveal): the card first opens BIG,
// centre-stage (InfoOverlay) with rows cascading in while the spoken answer
// plays, dwells a few seconds, then flies right and docks into the rail
// (InfoDock). One widget at a time (newest replaces); the docked card persists
// across turns until its × or until replaced. Malformed JSON = no widget
// (fail silent; the spoken answer already carried the content).
//
// Styling: each card is an unmistakable nod to its product (Calendar's colored
// time blocks, Gmail's row list, Trello's columns) without embedding logos.
// ---------------------------------------------------------------------------

import { useEffect } from "react";

export type AgendaData = {
  title?: string;
  events: Array<{ time?: string; title: string; location?: string }>;
};
export type EmailsData = {
  title?: string;
  items: Array<{ from?: string; to?: string; subject: string; time?: string; unread?: boolean }>;
};
export type BoardData = {
  title?: string;
  columns: Array<{ name: string; cards: string[] }>;
};

export type InfoWidgetState =
  | { kind: "agenda"; data: AgendaData }
  | { kind: "emails"; data: EmailsData }
  | { kind: "board"; data: BoardData };

// Parse a marker payload into widget state. Tolerant: JSON must parse and the
// load-bearing array must exist, else null (no widget beats a broken widget).
export function parseInfoMarker(kind: string, payload: string): InfoWidgetState | null {
  let obj: any;
  try {
    obj = JSON.parse(payload.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (kind === "agenda" && Array.isArray(obj.events)) {
    const events = obj.events
      .filter((e: any) => e && typeof e.title === "string")
      .slice(0, 8);
    // Empty agenda is a real, showable answer ("dia livre") — unlike emails/
    // board, where an empty list means there is nothing to show.
    return { kind: "agenda", data: { title: obj.title, events } };
  }
  if (kind === "emails" && Array.isArray(obj.items)) {
    const items = obj.items
      .filter((e: any) => e && typeof e.subject === "string")
      .slice(0, 8);
    return items.length ? { kind: "emails", data: { title: obj.title, items } } : null;
  }
  if (kind === "board" && Array.isArray(obj.columns)) {
    const columns = obj.columns
      .filter((c: any) => c && typeof c.name === "string" && Array.isArray(c.cards))
      .map((c: any) => ({ name: c.name, cards: c.cards.filter((x: any) => typeof x === "string").slice(0, 6) }))
      .slice(0, 4);
    return columns.length ? { kind: "board", data: { title: obj.title, columns } } : null;
  }
  return null;
}

// Deterministic per-event accent (Google Calendar's block colours).
const GCAL_COLORS = ["#1a73e8", "#0b8043", "#f6bf26", "#d93025", "#8e24aa", "#e67c73"];

function AgendaCard({ data }: { data: AgendaData }) {
  return (
    <div className="iw-card iw-agenda">
      <div className="iw-head">
        <span className="iw-glyph iw-glyph-cal" aria-hidden>31</span>
        <span className="iw-title">{data.title || "Agenda"}</span>
      </div>
      <div className="iw-agenda-list">
        {data.events.length === 0 && (
          <div className="iw-empty">
            <span className="iw-empty-glyph" aria-hidden>☀</span>
            Sem eventos — dia livre
          </div>
        )}
        {data.events.map((e, i) => (
          <div
            className="iw-event"
            key={i}
            style={{ borderLeftColor: GCAL_COLORS[i % GCAL_COLORS.length], animationDelay: `${180 + i * 120}ms` }}
          >
            {e.time ? <span className="iw-event-time">{e.time}</span> : null}
            <span className="iw-event-title">{e.title}</span>
            {e.location ? <span className="iw-event-loc">{e.location}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmailsCard({ data }: { data: EmailsData }) {
  return (
    <div className="iw-card iw-emails">
      <div className="iw-head">
        <span className="iw-glyph iw-glyph-mail" aria-hidden>✉</span>
        <span className="iw-title">{data.title || "Gmail"}</span>
      </div>
      <div className="iw-mail-list">
        {data.items.map((m, i) => (
          <div className={`iw-mail${m.unread ? " is-unread" : ""}`} key={i} style={{ animationDelay: `${180 + i * 100}ms` }}>
            <span className="iw-mail-from">{m.from ?? m.to ?? ""}</span>
            <span className="iw-mail-subject">{m.subject}</span>
            {m.time ? <span className="iw-mail-time">{m.time}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function BoardCard({ data }: { data: BoardData }) {
  return (
    <div className="iw-card iw-board">
      <div className="iw-head">
        <span className="iw-glyph iw-glyph-board" aria-hidden>▦</span>
        <span className="iw-title">{data.title || "Board"}</span>
      </div>
      <div className="iw-board-cols">
        {data.columns.map((c, i) => (
          <div className="iw-col" key={i} style={{ animationDelay: `${180 + i * 140}ms` }}>
            <span className="iw-col-name">{c.name}</span>
            {c.cards.map((card, j) => (
              <span className="iw-col-card" key={j}>{card}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function renderCard(widget: InfoWidgetState) {
  if (widget.kind === "agenda") return <AgendaCard data={widget.data} />;
  if (widget.kind === "emails") return <EmailsCard data={widget.data} />;
  return <BoardCard data={widget.data} />;
}

const CENTER_DWELL_MS = 4200; // centre-stage time before auto-docking

// Centre-stage reveal: the card opens BIG over the orb (rows cascade in) while
// the spoken answer plays, then flies right into the rail (main.tsx flips it
// into InfoDock after the `leaving` exit). Scrim click / Esc dock it early.
export function InfoOverlay({
  widget,
  leaving,
  onDock,
}: {
  widget: InfoWidgetState;
  leaving: boolean;
  onDock: () => void;
}) {
  useEffect(() => {
    if (leaving) return;
    const t = setTimeout(onDock, CENTER_DWELL_MS);
    return () => clearTimeout(t);
  }, [leaving, onDock]);
  return (
    <div className={`iw-overlay${leaving ? " is-leaving" : ""}`} onClick={onDock}>
      <div className="iw-center" onClick={(e) => e.stopPropagation()}>
        {renderCard(widget)}
      </div>
    </div>
  );
}

export default function InfoDock({ widget, onClose }: { widget: InfoWidgetState; onClose: () => void }) {
  return (
    <div className="iw-dock">
      <button className="iw-close" onClick={onClose} aria-label="fechar">✕</button>
      {renderCard(widget)}
    </div>
  );
}
