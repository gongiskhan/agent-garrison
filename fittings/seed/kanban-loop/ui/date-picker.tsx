// The schedule date/time picker, and the calendar-style repeat builder.
//
// Both replace text-ish inputs the card called out by name: a bare
// <input type="datetime-local"> ("we should have a proper calendar for setting
// the date and time also") and a raw five-field cron box ("a system to schedule
// recurring cards similar to google calendar instead of a cron expression").
//
// Both are controlled components over values the editors already speak — a
// local-wall `YYYY-MM-DDTHH:MM` string for the picker, and the recurrence rule
// object lib/recurrence.mjs validates for the repeat builder — so neither owns
// any state the surrounding editor cannot see.

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  monthGrid,
  shiftMonth,
  splitLocalValue,
  joinLocalValue,
  todayIso,
  MONTH_LABELS,
  WEEKDAY_LABELS
} from "./calendar-grid";

// A stored instant's LOCAL calendar date (YYYY-MM-DD). The builder writes
// dates as browser-local wall times, so reads must come back through the same
// clock - never through a UTC slice of the ISO string.
function localDateOf(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface RecurrenceRule {
  freq: "daily" | "weekly" | "monthly";
  interval: number;
  hour: number;
  minute: number;
  start: string;
  byWeekday?: number[];
  byMonthDay?: number;
  byWeekdayOrdinal?: { weekday: number; ordinal: number };
  until?: string;
  count?: number;
}

// ── date + time ────────────────────────────────────────────────────────────

export function DateTimePicker({
  value,
  onChange,
  label,
  id
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  id?: string;
}) {
  const { date, time } = splitLocalValue(value);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => {
    const [y, m] = (date || todayIso()).split("-").map(Number);
    return { year: y, month: m };
  });
  const wrap = useRef<HTMLDivElement>(null);

  // Follow the value when it is changed from outside (opening a different card
  // must not leave the grid parked on the previous card's month).
  useEffect(() => {
    if (!date) return;
    const [y, m] = date.split("-").map(Number);
    setView({ year: y, month: m });
  }, [date]);

  // A click anywhere else closes the grid — the ordinary popover contract, and
  // the one thing whose absence makes a calendar feel broken.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const weeks = useMemo(() => monthGrid(view.year, view.month), [view.year, view.month]);
  const today = todayIso();

  const pick = (iso: string) => {
    onChange(joinLocalValue(iso, time));
    setOpen(false);
  };

  return (
    <div className="dtp" ref={wrap}>
      <button
        type="button"
        id={id}
        className="dtp-trigger"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {date ? `${date} ${time || "09:00"}` : "pick a date…"}
      </button>
      {open && (
        <div className="dtp-pop" role="dialog" aria-label={label}>
          <div className="dtp-head">
            <button type="button" className="btn tiny" aria-label="Previous month"
              onClick={() => setView(shiftMonth(view.year, view.month, -1))}>‹</button>
            <span className="dtp-month">{MONTH_LABELS[view.month - 1]} {view.year}</span>
            <button type="button" className="btn tiny" aria-label="Next month"
              onClick={() => setView(shiftMonth(view.year, view.month, 1))}>›</button>
          </div>
          <div className="dtp-grid">
            {WEEKDAY_LABELS.map((name) => <span key={name} className="dtp-dow">{name[0]}</span>)}
            {weeks.flat().map((day) => (
              <button
                key={day.iso}
                type="button"
                className={`dtp-day${day.inMonth ? "" : " out"}${day.iso === date ? " on" : ""}${day.iso === today ? " today" : ""}`}
                onClick={() => pick(day.iso)}
              >
                {day.day}
              </button>
            ))}
          </div>
          <div className="dtp-foot">
            <input
              type="time"
              aria-label={`${label} time`}
              value={time || "09:00"}
              onChange={(e) => onChange(joinLocalValue(date || today, e.target.value))}
            />
            <button type="button" className="btn tiny" onClick={() => pick(today)}>Today</button>
            {value && <button type="button" className="btn tiny" onClick={() => { onChange(""); setOpen(false); }}>Clear</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── repeat rule ────────────────────────────────────────────────────────────

const ORDINALS: { value: number; label: string }[] = [
  { value: 1, label: "first" },
  { value: 2, label: "second" },
  { value: 3, label: "third" },
  { value: 4, label: "fourth" },
  { value: -1, label: "last" }
];

/** A sane starting rule, so opening the builder never shows an invalid one. */
export function defaultRecurrence(from: Date = new Date()): RecurrenceRule {
  return {
    freq: "weekly",
    interval: 1,
    hour: 9,
    minute: 0,
    start: from.toISOString(),
    byWeekday: [from.getDay()]
  };
}

export function RecurrenceBuilder({
  value,
  onChange
}: {
  value: RecurrenceRule;
  onChange: (next: RecurrenceRule) => void;
}) {
  const set = (patch: Partial<RecurrenceRule>) => onChange({ ...value, ...patch });

  // Switching frequency has to drop the selectors that belong to the old one —
  // a weekly byWeekday left on a monthly rule is rejected by the validator, and
  // rejected on save is a worse experience than never being offered.
  const setFreq = (freq: RecurrenceRule["freq"]) => {
    const base: RecurrenceRule = {
      ...value,
      freq,
      byWeekday: undefined,
      byMonthDay: undefined,
      byWeekdayOrdinal: undefined
    };
    if (freq === "weekly") base.byWeekday = [new Date().getDay()];
    if (freq === "monthly") base.byMonthDay = new Date().getDate();
    onChange(base);
  };

  const toggleWeekday = (day: number) => {
    const current = value.byWeekday ?? [];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b);
    // A weekly rule with no day selected can never fire; keep the last one.
    set({ byWeekday: next.length ? next : current });
  };

  const endMode = value.until != null ? "until" : value.count != null ? "count" : "never";
  // The stored instants were WRITTEN as browser-local wall times (local
  // midnight / 23:59 below), so they must be READ back in local time too.
  // Slicing the UTC ISO string read the previous day in any UTC+ timezone -
  // including Europe/Lisbon in summer, the default schedule timezone - so a
  // start picked as the 14th displayed and measured as the 13th.
  const startDate = localDateOf(value.start);

  return (
    <div className="rec-builder">
      <div className="rec-row">
        <span className="rec-label">Repeat every</span>
        <input
          className="rec-interval"
          type="number"
          min={1}
          max={366}
          aria-label="Repeat interval"
          value={value.interval}
          onChange={(e) => set({ interval: Math.max(1, Math.min(366, Number(e.target.value) || 1)) })}
        />
        <select aria-label="Repeat frequency" value={value.freq} onChange={(e) => setFreq(e.target.value as RecurrenceRule["freq"])}>
          <option value="daily">{value.interval === 1 ? "day" : "days"}</option>
          <option value="weekly">{value.interval === 1 ? "week" : "weeks"}</option>
          <option value="monthly">{value.interval === 1 ? "month" : "months"}</option>
        </select>
        <span className="rec-label">at</span>
        <input
          type="time"
          aria-label="Repeat time"
          value={`${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`}
          onChange={(e) => {
            const [h, m] = e.target.value.split(":").map(Number);
            if (Number.isInteger(h) && Number.isInteger(m)) set({ hour: h, minute: m });
          }}
        />
      </div>

      {value.freq === "weekly" && (
        <div className="rec-row" role="group" aria-label="Repeat on">
          <span className="rec-label">on</span>
          {WEEKDAY_LABELS.map((name, day) => (
            <button
              key={name}
              type="button"
              aria-pressed={(value.byWeekday ?? []).includes(day)}
              className={`rec-dow${(value.byWeekday ?? []).includes(day) ? " on" : ""}`}
              onClick={() => toggleWeekday(day)}
            >
              {name[0]}
            </button>
          ))}
        </div>
      )}

      {value.freq === "monthly" && (
        <div className="rec-row">
          <select
            aria-label="Monthly rule"
            value={value.byWeekdayOrdinal ? "ordinal" : "monthday"}
            onChange={(e) => e.target.value === "ordinal"
              ? set({ byMonthDay: undefined, byWeekdayOrdinal: { weekday: new Date().getDay(), ordinal: 1 } })
              : set({ byWeekdayOrdinal: undefined, byMonthDay: new Date().getDate() })}
          >
            <option value="monthday">on day</option>
            <option value="ordinal">on the</option>
          </select>
          {value.byWeekdayOrdinal ? (
            <>
              <select aria-label="Which weekday of the month" value={value.byWeekdayOrdinal.ordinal}
                onChange={(e) => set({ byWeekdayOrdinal: { ...value.byWeekdayOrdinal!, ordinal: Number(e.target.value) } })}>
                {ORDINALS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select aria-label="Weekday of the month" value={value.byWeekdayOrdinal.weekday}
                onChange={(e) => set({ byWeekdayOrdinal: { ...value.byWeekdayOrdinal!, weekday: Number(e.target.value) } })}>
                {WEEKDAY_LABELS.map((name, day) => <option key={name} value={day}>{name}</option>)}
              </select>
            </>
          ) : (
            <input
              className="rec-interval"
              type="number"
              min={1}
              max={31}
              aria-label="Day of the month"
              value={value.byMonthDay ?? 1}
              onChange={(e) => set({ byMonthDay: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })}
            />
          )}
          {(value.byMonthDay ?? 0) > 28 && (
            <span className="muted rec-note">months without a {value.byMonthDay}th are skipped</span>
          )}
        </div>
      )}

      <div className="rec-row">
        <span className="rec-label">starting</span>
        <DateTimePicker
          label="Repeat start date"
          value={`${startDate}T${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`}
          onChange={(next) => {
            const { date } = splitLocalValue(next);
            if (date) set({ start: new Date(`${date}T00:00:00`).toISOString() });
          }}
        />
      </div>

      <div className="rec-row">
        <span className="rec-label">ends</span>
        <select
          aria-label="Repeat end condition"
          value={endMode}
          onChange={(e) => {
            if (e.target.value === "never") set({ until: undefined, count: undefined });
            else if (e.target.value === "count") set({ until: undefined, count: 10 });
            else set({ count: undefined, until: new Date(Date.now() + 90 * 86400_000).toISOString() });
          }}
        >
          <option value="never">never</option>
          <option value="until">on a date</option>
          <option value="count">after N times</option>
        </select>
        {endMode === "until" && (
          <DateTimePicker
            label="Repeat until"
            value={`${localDateOf(value.until!)}T23:59`}
            onChange={(next) => {
              const { date } = splitLocalValue(next);
              if (date) set({ until: new Date(`${date}T23:59:00`).toISOString() });
            }}
          />
        )}
        {endMode === "count" && (
          <input
            className="rec-interval"
            type="number"
            min={1}
            max={10000}
            aria-label="Number of occurrences"
            value={value.count ?? 1}
            onChange={(e) => set({ count: Math.max(1, Math.min(10000, Number(e.target.value) || 1)) })}
          />
        )}
      </div>
    </div>
  );
}
