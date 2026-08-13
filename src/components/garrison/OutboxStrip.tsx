"use client";

/**
 * Pending sends (§8.4) - the cancel surface for the outbound delay buffer.
 *
 * A Fitting that owns an irreversible send now parks it for 60 seconds instead
 * of sending it. That window is the entire justification for ever letting the
 * router act on an outbound message without asking first: the action stays
 * revertible in practice. "In practice" was the missing half - the only cancel
 * path was a curl one-liner printed into an agent's answer, in a transcript the
 * user is by definition not reading (the whole point of unattended routing).
 * So the window comes to the page he already has open, and cancelling is one
 * tap.
 *
 * Three things it deliberately does NOT do:
 *
 *   1. It does not claim outbound is cancellable in general. Only a Fitting with
 *      a long-lived process can hold a timer; `google` has no daemon and its
 *      sends really are unbuffered. The strip says so instead of implying
 *      coverage it does not have.
 *   2. It does not remove a row on a 409. After the window elapses the fitting
 *      answers "sent", and hiding the row would present a message that went out
 *      as one the user stopped.
 *   3. It does not render at all when nothing is parked - which is almost
 *      always. A permanently visible empty panel would train the eye to skip
 *      the one place a 60-second window is visible.
 *
 * Polling is 15s, not the 60s the neighbouring panels use: at 60s a send could
 * be queued and gone between two reads and this strip would never have shown
 * it. The countdown ticks locally between polls so the seconds are real.
 *
 * The presentational half is fully controlled by props, so the countdown row
 * and the empty-is-hidden rule are assertable without a DOM -
 * tests/outbox-panel.test.ts.
 */

// Load-bearing for the TEST, not for Next: vitest's esbuild compiles classic
// JSX, so react-dom/server rendering needs React in scope (the
// tests/claude-chat-rail.test.ts convention). Next's automatic runtime ignores it.
import * as React from "react";
import { useEffect, useState } from "react";
import clsx from "clsx";
import styles from "./GarrisonHome.module.css";

export interface PendingSend {
  fitting: string;
  id: string;
  to: string | null;
  preview: string;
  context: string;
  queuedAt: string | null;
  executeAt: string;
}

export const OUTBOX_ENDPOINT = "/api/outbox";
export const OUTBOX_CANCEL_ENDPOINT = "/api/outbox/cancel";
/** A fraction of the 60s window, so no parked send can live and die unseen. */
export const OUTBOX_POLL_MS = 15_000;
/** How long a settled row (already sent, could not cancel) stays legible. */
export const OUTBOX_NOTE_TTL_MS = 20_000;

/** A row is identified by its holder AND its id: ids are only fitting-unique. */
export function rowKey(row: { fitting: string; id: string }): string {
  return `${row.fitting}:${row.id}`;
}

/** Seconds left in the cancel window; null when the timestamp is unreadable. */
export function secondsRemaining(executeAt: string, now: number): number | null {
  const at = Date.parse(executeAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function countdownLabel(seconds: number | null): string {
  if (seconds === null) return "due";
  if (seconds <= 0) return "sending now";
  return `${seconds}s`;
}

export interface RowNote {
  row: PendingSend;
  label: string;
  at: number;
  /** The window is spent - there is nothing left to cancel, so the tap is over. */
  spent: boolean;
}

/**
 * What the strip shows: everything the last poll reported, plus any row the
 * poll has already dropped that still carries an unexpired note. Without the
 * second half, an "already sent" answer would vanish on the next 15s tick and
 * the user would be left believing the cancel worked.
 */
export function visibleRows(
  rows: PendingSend[],
  notes: Record<string, RowNote>,
  now: number
): PendingSend[] {
  const live = new Set(rows.map(rowKey));
  const held = Object.values(notes)
    .filter((note) => now - note.at < OUTBOX_NOTE_TTL_MS && !live.has(rowKey(note.row)))
    .map((note) => note.row);
  return rows.concat(held);
}

export function noteFor(
  row: PendingSend,
  notes: Record<string, RowNote>,
  now: number
): RowNote | null {
  const note = notes[rowKey(row)];
  if (!note || now - note.at >= OUTBOX_NOTE_TTL_MS) return null;
  return note;
}

/**
 * How a fitting's cancel answer reads on the row. `status` is the fitting's own
 * word for what happened (outbox.cancel), so this stays honest as the buffer
 * grows states rather than guessing from the HTTP code alone.
 *
 * `spent` is the difference between the two ways a cancel fails to cancel. A
 * 409 means the message went and the button has no work left to do. Anything
 * else - a 502, a dead shell route, a dropped connection - proves nothing about
 * the send, so the button MUST stay live: telling someone to try again and then
 * disabling the control is worse than not offering the retry.
 */
export function cancelOutcome(
  status: number,
  body: { status?: unknown } | null
): { removed: boolean; note: string | null; spent: boolean } {
  const said = typeof body?.status === "string" ? body.status : null;
  // Cancelled, and idempotently so: the send never happens.
  if (status >= 200 && status < 300) return { removed: true, note: null, spent: false };
  // The window elapsed while the tap was in flight. It went out.
  if (status === 409) {
    return { removed: false, note: said === "sent" ? "already sent" : `already ${said ?? "settled"}`, spent: true };
  }
  // Nothing to cancel: the buffer has already forgotten it.
  if (status === 404) return { removed: true, note: null, spent: false };
  return { removed: false, note: "could not cancel - try again", spent: false };
}

/** The container: polls, ticks, and owns the cancel round trip. */
export function OutboxStrip() {
  const [rows, setRows] = useState<PendingSend[]>([]);
  const [notes, setNotes] = useState<Record<string, RowNote>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(OUTBOX_ENDPOINT, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { pending?: PendingSend[] };
        if (!cancelled) setRows(Array.isArray(data?.pending) ? data.pending : []);
      } catch {
        // Keep the last known list. A dashboard should not shout about a feed
        // that simply is not there - and the countdown keeps ticking, so a row
        // whose window has run out reads as "sending now" either way.
      }
    };
    void load();
    const poll = window.setInterval(() => void load(), OUTBOX_POLL_MS);
    // The seconds have to move between polls or the number on screen is a lie.
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, []);

  const cancel = async (row: PendingSend) => {
    const key = rowKey(row);
    setBusy((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await fetch(OUTBOX_CANCEL_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fitting: row.fitting, id: row.id })
      });
      const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
      const outcome = cancelOutcome(res.status, body);
      const note = outcome.note;
      if (outcome.removed) {
        setRows((prev) => prev.filter((r) => rowKey(r) !== key));
        // A retry that succeeded must take the failed attempt's note with it -
        // otherwise visibleRows keeps holding the row up under a stale "could
        // not cancel" for the rest of the note's life.
        setNotes((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      } else if (note) {
        setNotes((prev) => ({ ...prev, [key]: { row, label: note, at: Date.now(), spent: outcome.spent } }));
      }
    } catch {
      // The request never landed, so the send is untouched: retryable.
      setNotes((prev) => ({
        ...prev,
        [key]: { row, label: "could not cancel - try again", at: Date.now(), spent: false }
      }));
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  return (
    <PendingSends
      rows={visibleRows(rows, notes, now)}
      notes={notes}
      busy={busy}
      now={now}
      onCancel={(row) => void cancel(row)}
    />
  );
}

/** Presentational, and silent when there is nothing parked. */
export function PendingSends({
  rows,
  notes,
  busy,
  now,
  onCancel
}: {
  rows: PendingSend[];
  notes: Record<string, RowNote>;
  busy: Record<string, boolean>;
  now: number;
  onCancel: (row: PendingSend) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <section className={styles.outbox} data-testid="outbox-strip">
      <div className={styles.outboxHead}>
        <span>Pending sends</span>
        {/* The honest scope: this is the set of Fittings that hold a window, not
            the set of things Garrison can send. */}
        <small>held in a cancel window - channels without a buffer send immediately</small>
      </div>
      <ul className={styles.outboxRows}>
        {rows.map((row) => {
          const key = rowKey(row);
          const note = noteFor(row, notes, now);
          const left = secondsRemaining(row.executeAt, now);
          return (
            <li key={key} className={styles.outboxRow} data-testid={`outbox-row-${key}`}>
              <div className={styles.outboxTo}>{row.to ?? "unknown destination"}</div>
              <span
                className={clsx(styles.outboxCount, !note && left !== null && left <= 10 && styles.outboxCountLow)}
                data-testid={`outbox-count-${key}`}
              >
                {note?.label ?? countdownLabel(left)}
              </span>
              <button
                type="button"
                className={styles.outboxCancel}
                data-testid={`outbox-cancel-${key}`}
                disabled={Boolean(busy[key]) || Boolean(note?.spent)}
                onClick={() => onCancel(row)}
              >
                {busy[key] ? "Cancelling" : "Cancel"}
              </button>
              {row.preview ? <p className={styles.outboxPreview}>{row.preview}</p> : null}
              <div className={styles.outboxMeta}>
                {row.fitting} · {row.context}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
