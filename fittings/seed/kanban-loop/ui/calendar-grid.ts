// Month-grid arithmetic for the date picker.
//
// The board's two schedule editors were bare <input type="datetime-local">
// boxes. The card asked for "a proper calendar for setting the date and time",
// and nothing in packages/claude-chat had one to reuse, so this is the grid the
// picker paints. Kept pure and separate from the component so the tricky parts —
// leading/trailing days, week alignment, month arithmetic that must not slide a
// 31st onto the 1st — are testable without a browser.

export interface GridDay {
  year: number;
  /** 1-12, unlike a JS Date's month. */
  month: number;
  day: number;
  /** ISO calendar date, `YYYY-MM-DD` — the picker's value vocabulary. */
  iso: string;
  /** False for the leading/trailing days that only pad the first and last row. */
  inMonth: boolean;
  weekday: number;
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The month as six weeks of seven days, padded from the neighbouring months so
 * every row is full and the grid never reflows as the user pages through.
 * Sunday-first, matching the weekday numbering used by the recurrence rules.
 */
export function monthGrid(year: number, month: number): GridDay[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  // Start on the Sunday on or before the 1st.
  const start = new Date(first);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const weeks: GridDay[][] = [];
  const cursor = new Date(start);
  for (let week = 0; week < 6; week += 1) {
    const row: GridDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      const y = cursor.getUTCFullYear();
      const m = cursor.getUTCMonth() + 1;
      const d = cursor.getUTCDate();
      row.push({
        year: y,
        month: m,
        day: d,
        iso: isoDate(y, m, d),
        inMonth: m === month && y === year,
        weekday: cursor.getUTCDay()
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(row);
  }
  return weeks;
}

/**
 * Step the displayed month. Plain month arithmetic on a Date slides a 31st into
 * the next month (31 Jan + 1 month = 2 Mar), which would make paging skip
 * February entirely — so the month is stepped as a number, never as a date.
 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/** Split a local-wall value (`YYYY-MM-DDTHH:MM`) into its date and time halves. */
export function splitLocalValue(value: string | null | undefined): { date: string; time: string } {
  if (!value) return { date: "", time: "" };
  const [date = "", rest = ""] = value.split("T");
  return { date, time: rest.slice(0, 5) };
}

/** Rejoin a date and a time into the local-wall value the editors already speak.
 *  A date with no time defaults to 09:00 rather than midnight: a card scheduled
 *  for "Tuesday" means Tuesday morning, not the instant Monday ends. */
export function joinLocalValue(date: string, time: string): string {
  if (!date) return "";
  return `${date}T${/^\d{2}:\d{2}$/.test(time) ? time : "09:00"}`;
}

/** Today in the browser's own zone, as an ISO calendar date. */
export function todayIso(now: Date = new Date()): string {
  return isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
