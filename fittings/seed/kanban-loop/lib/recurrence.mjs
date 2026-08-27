// Calendar-style recurrence — the repeat rule a person actually means.
//
// WHY THIS EXISTS RATHER THAN MORE CRON. The board's recurring schedules are
// five-field cron strings, and cron cannot express what the card asked for:
//
//   - "every 2 weeks on Tuesday" — cron has no notion of a week INTERVAL. The
//     day-of-week field can say Tuesday, and nothing can say every other one.
//   - "the second Tuesday of the month" — cron's day-of-month and day-of-week
//     fields are OR'd together when both are restricted (a deliberate, ancient
//     quirk), never AND'd, so the pair cannot name an ordinal weekday.
//
// Compiling this model down to a cron string would therefore have to silently
// drop exactly the two features that were requested. So occurrences are
// computed DIRECTLY from the rule instead, and `schedule.cron` stays untouched
// for every schedule that already uses it.
//
// Dependency-free and pure, like schedules.mjs, so the board, engine, HTTP
// server and MCP surface can all share one validator and one clock.

import { zonedMinute, validTimeZone } from "./schedules.mjs";

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly"];
export const MAX_RECURRENCE_INTERVAL = 366;
// How far ahead a search will look before giving up. An interval of 12 months
// puts the next occurrence a year out, and a monthly ordinal rule can miss a
// month (there is no fifth Tuesday in most of them), so the horizon has to
// clear both with room to spare.
const MAX_SEARCH_DAYS = 800;

// ── wall time ⇄ instant ────────────────────────────────────────────────────
// schedules.mjs converts an instant to zoned wall time. A recurrence needs the
// other direction: "the 14th at 09:00 in Europe/Lisbon" is a wall time, and it
// has to become a real instant, correctly, across both DST transitions.

function wallMinuteNumber(local) {
  return Math.floor(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) / 60000);
}

// The zone's offset (in ms) at a given real instant.
function offsetAt(instant, timeZone) {
  const local = zonedMinute(new Date(instant), timeZone);
  return wallMinuteNumber(local) * 60000 - Math.floor(instant / 60000) * 60000;
}

/**
 * The real instant at which the given wall clock reads in `timeZone`.
 *
 * The two-pass guess is the standard treatment: assume the offset that applies
 * at the naive UTC reading, correct once using the offset that actually applies
 * at the resulting instant. A wall time that does not exist (the hour a spring
 * transition skips) resolves to the instant the clock jumps to, and an
 * ambiguous one (the repeated autumn hour) resolves to its first occurrence —
 * both the conventional choices, and both stable rather than throwing.
 */
export function instantFromWall({ year, month, day, hour, minute }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let instant = naive - offsetAt(naive, timeZone);
  const corrected = naive - offsetAt(instant, timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant).toISOString();
}

// ── the rule ───────────────────────────────────────────────────────────────

function isWholeNumber(value, lo, hi) {
  return Number.isInteger(value) && value >= lo && value <= hi;
}

/**
 * Why a recurrence rule is unusable, or null when it is fine. Mirrors the shape
 * of scheduleValidationError so the server can report either the same way.
 */
export function recurrenceValidationError(raw) {
  if (raw === null || raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "recurrence must be an object or null";
  if (!RECURRENCE_FREQUENCIES.includes(raw.freq)) return `recurrence.freq must be one of ${RECURRENCE_FREQUENCIES.join(", ")}`;
  if (raw.interval !== undefined && !isWholeNumber(raw.interval, 1, MAX_RECURRENCE_INTERVAL)) {
    return `recurrence.interval must be a whole number between 1 and ${MAX_RECURRENCE_INTERVAL}`;
  }
  if (!isWholeNumber(raw.hour, 0, 23)) return "recurrence.hour must be a whole number between 0 and 23";
  if (!isWholeNumber(raw.minute, 0, 59)) return "recurrence.minute must be a whole number between 0 and 59";
  if (typeof raw.start !== "string" || !Number.isFinite(Date.parse(raw.start))) {
    return "recurrence.start must be a parseable ISO date-time";
  }
  if (raw.freq === "weekly") {
    if (!Array.isArray(raw.byWeekday) || !raw.byWeekday.length) return "recurrence.byWeekday must list at least one weekday for a weekly rule";
    if (!raw.byWeekday.every((day) => isWholeNumber(day, 0, 6))) return "recurrence.byWeekday entries must be 0 (Sunday) through 6 (Saturday)";
  } else if (raw.byWeekday !== undefined && raw.byWeekday !== null) {
    return "recurrence.byWeekday only applies to a weekly rule";
  }
  if (raw.freq === "monthly") {
    const hasMonthDay = raw.byMonthDay !== undefined && raw.byMonthDay !== null;
    const hasOrdinal = raw.byWeekdayOrdinal !== undefined && raw.byWeekdayOrdinal !== null;
    if (hasMonthDay === hasOrdinal) return "a monthly rule needs exactly one of recurrence.byMonthDay or recurrence.byWeekdayOrdinal";
    if (hasMonthDay && !isWholeNumber(raw.byMonthDay, 1, 31)) return "recurrence.byMonthDay must be a whole number between 1 and 31";
    if (hasOrdinal) {
      const ord = raw.byWeekdayOrdinal;
      if (!ord || typeof ord !== "object" || Array.isArray(ord)) return "recurrence.byWeekdayOrdinal must be an object";
      if (!isWholeNumber(ord.weekday, 0, 6)) return "recurrence.byWeekdayOrdinal.weekday must be 0 (Sunday) through 6 (Saturday)";
      // -1 is "the last one in the month", the same convention iCalendar uses.
      if (!isWholeNumber(ord.ordinal, 1, 5) && ord.ordinal !== -1) {
        return "recurrence.byWeekdayOrdinal.ordinal must be 1-5, or -1 for the last";
      }
    }
  } else if ((raw.byMonthDay !== undefined && raw.byMonthDay !== null)
    || (raw.byWeekdayOrdinal !== undefined && raw.byWeekdayOrdinal !== null)) {
    return "recurrence.byMonthDay and recurrence.byWeekdayOrdinal only apply to a monthly rule";
  }
  const hasUntil = raw.until !== undefined && raw.until !== null;
  const hasCount = raw.count !== undefined && raw.count !== null;
  if (hasUntil && hasCount) return "a recurrence ends on recurrence.until or after recurrence.count, not both";
  if (hasUntil && (typeof raw.until !== "string" || !Number.isFinite(Date.parse(raw.until)))) {
    return "recurrence.until must be a parseable ISO date-time";
  }
  if (hasCount && !isWholeNumber(raw.count, 1, 10000)) return "recurrence.count must be a whole number between 1 and 10000";
  return null;
}

/** The rule in canonical form, or null when it is unusable. */
export function normaliseRecurrence(raw) {
  if (recurrenceValidationError(raw)) return null;
  if (raw === null || raw === undefined) return null;
  const freq = raw.freq;
  const interval = Number.isInteger(raw.interval) && raw.interval >= 1 ? raw.interval : 1;
  return {
    freq,
    interval,
    hour: raw.hour,
    minute: raw.minute,
    start: new Date(raw.start).toISOString(),
    // Sorted and de-duplicated so two rules that mean the same thing compare
    // equal — the board diffs schedules to decide whether anything changed.
    ...(freq === "weekly" ? { byWeekday: [...new Set(raw.byWeekday)].sort((a, b) => a - b) } : {}),
    ...(freq === "monthly" && raw.byMonthDay != null ? { byMonthDay: raw.byMonthDay } : {}),
    ...(freq === "monthly" && raw.byWeekdayOrdinal != null
      ? { byWeekdayOrdinal: { weekday: raw.byWeekdayOrdinal.weekday, ordinal: raw.byWeekdayOrdinal.ordinal } }
      : {}),
    ...(raw.until != null ? { until: new Date(raw.until).toISOString() } : {}),
    ...(raw.count != null ? { count: raw.count } : {})
  };
}

// ── occurrence search ──────────────────────────────────────────────────────
// Candidate days are generated in plain calendar arithmetic and only then
// converted to instants. Walking real minutes (as the cron clock does) cannot
// answer "every second week", because the anchor is a wall-calendar fact.

function daysBetweenUTC(a, b) {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86400000);
}

function weekStart(day) {
  // Sunday-based, matching the weekday numbering used throughout.
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day));
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayOf(day) {
  return new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Does this calendar day carry an occurrence of the rule? */
export function dayMatchesRecurrence(rule, day, startDay) {
  if (daysBetweenUTC(startDay, day) < 0) return false;
  if (rule.freq === "daily") {
    return daysBetweenUTC(startDay, day) % rule.interval === 0;
  }
  if (rule.freq === "weekly") {
    if (!rule.byWeekday.includes(weekdayOf(day))) return false;
    // The interval counts WEEKS from the start's week, not days from the start,
    // so "every 2 weeks on Mon and Wed" keeps both days in the same week.
    const weeks = daysBetweenUTC(weekStart(startDay), weekStart(day)) / 7;
    return Number.isInteger(weeks) && weeks % rule.interval === 0;
  }
  // monthly
  const months = (day.year - startDay.year) * 12 + (day.month - startDay.month);
  if (months < 0 || months % rule.interval !== 0) return false;
  if (rule.byMonthDay != null) {
    // A 31st in a 30-day month simply does not occur — the month is skipped
    // rather than the occurrence being dragged onto the 30th, which would put
    // two different rules on the same day and quietly change what was asked.
    return day.day === rule.byMonthDay;
  }
  const { weekday, ordinal } = rule.byWeekdayOrdinal;
  if (weekdayOf(day) !== weekday) return false;
  if (ordinal === -1) {
    return day.day + 7 > daysInMonth(day.year, day.month);
  }
  return Math.floor((day.day - 1) / 7) + 1 === ordinal;
}

function addDays(day, delta) {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + delta));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * The first occurrence strictly after `after`, or null when the rule has run
 * out (an `until` passed, a `count` exhausted, or nothing found inside the
 * search horizon).
 *
 * Returns the same `{ at, wallKey }` shape as nextCronOccurrence, so callers
 * that already thread a cron occurrence around need no new plumbing — the wall
 * key remains the idempotency identity for an occurrence.
 */
export function nextRecurrenceOccurrence(recurrence, timeZone, after, { maxDays = MAX_SEARCH_DAYS } = {}) {
  const rule = normaliseRecurrence(recurrence);
  if (!rule) throw new Error(recurrenceValidationError(recurrence) || "invalid recurrence");
  if (!validTimeZone(timeZone)) throw new Error(`invalid IANA timezone: ${timeZone}`);
  const base = after instanceof Date ? after.getTime() : Date.parse(after);
  if (!Number.isFinite(base)) throw new Error("after must be a parseable date-time");

  const startLocal = zonedMinute(new Date(rule.start), timeZone);
  const startDay = { year: startLocal.year, month: startLocal.month, day: startLocal.day };
  const untilMs = rule.until ? Date.parse(rule.until) : null;

  // `count` is a bound on occurrences since the start, so the ones already
  // behind us have to be counted before the next one can be judged in or out.
  // The walk begins at the start day for a counted rule and at "now" otherwise,
  // so an uncounted rule stays cheap however old it is.
  const afterLocal = zonedMinute(new Date(base), timeZone);
  const fromDay = { year: afterLocal.year, month: afterLocal.month, day: afterLocal.day };
  const counting = rule.count != null;
  let cursor = counting ? startDay : (daysBetweenUTC(startDay, fromDay) > 0 ? fromDay : startDay);
  const horizon = counting ? maxDays + Math.max(0, daysBetweenUTC(startDay, fromDay)) : maxDays;
  let seen = 0;

  for (let index = 0; index <= horizon; index += 1, cursor = addDays(cursor, 1)) {
    if (!dayMatchesRecurrence(rule, cursor, startDay)) continue;
    const at = instantFromWall({ ...cursor, hour: rule.hour, minute: rule.minute }, timeZone);
    const t = Date.parse(at);
    if (counting) {
      if (seen >= rule.count) return null;
      // Only occurrences at or before the cutoff consume the count; the one we
      // are about to return is the (seen + 1)th and is still within it.
      if (t <= base) { seen += 1; continue; }
      seen += 1;
    } else if (t <= base) {
      continue;
    }
    if (untilMs != null && t > untilMs) return null;
    return { at, wallKey: zonedMinute(new Date(t), timeZone).key };
  }
  return null;
}

/**
 * The most recent occurrence at or before `at`, or null when the rule had not
 * started yet. The cron clock's counterpart exists so that a schedule which
 * fell behind during downtime creates only the LATEST missed occurrence instead
 * of replaying every one it slept through; a calendar rule needs exactly the
 * same protection.
 */
export function latestRecurrenceOccurrence(recurrence, timeZone, at, { maxDays = MAX_SEARCH_DAYS } = {}) {
  const rule = normaliseRecurrence(recurrence);
  if (!rule) throw new Error(recurrenceValidationError(recurrence) || "invalid recurrence");
  if (!validTimeZone(timeZone)) throw new Error(`invalid IANA timezone: ${timeZone}`);
  const base = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(base)) throw new Error("at must be a parseable date-time");

  const startLocal = zonedMinute(new Date(rule.start), timeZone);
  const startDay = { year: startLocal.year, month: startLocal.month, day: startLocal.day };
  const atLocal = zonedMinute(new Date(base), timeZone);

  // A COUNTED rule's series has a fixed end that only a forward count can
  // find, so it walks forward from the start exactly like
  // nextRecurrenceOccurrence's counting branch — the backward walk below
  // cannot know an occurrence's ordinal. Without this, the sweep's downtime
  // catch-up read "latest" occurrences past a count-limited rule's final one
  // and materialised a phantom on a day the rule never included.
  if (rule.count != null) {
    const fromDay = { year: atLocal.year, month: atLocal.month, day: atLocal.day };
    const horizon = maxDays + Math.max(0, daysBetweenUTC(startDay, fromDay));
    let seen = 0;
    let last = null;
    let forward = { ...startDay };
    for (let index = 0; index <= horizon && seen < rule.count; index += 1, forward = addDays(forward, 1)) {
      if (!dayMatchesRecurrence(rule, forward, startDay)) continue;
      const occurrence = instantFromWall({ ...forward, hour: rule.hour, minute: rule.minute }, timeZone);
      const t = Date.parse(occurrence);
      if (rule.until && t > Date.parse(rule.until)) break;
      seen += 1;
      if (t > base) break;
      last = { at: occurrence, wallKey: zonedMinute(new Date(t), timeZone).key };
    }
    return last;
  }

  let cursor = { year: atLocal.year, month: atLocal.month, day: atLocal.day };

  for (let index = 0; index <= maxDays; index += 1, cursor = addDays(cursor, -1)) {
    if (daysBetweenUTC(startDay, cursor) < 0) return null;
    if (!dayMatchesRecurrence(rule, cursor, startDay)) continue;
    const occurrence = instantFromWall({ ...cursor, hour: rule.hour, minute: rule.minute }, timeZone);
    const t = Date.parse(occurrence);
    if (t > base) continue;
    if (rule.until && t > Date.parse(rule.until)) continue;
    return { at: occurrence, wallKey: zonedMinute(new Date(t), timeZone).key };
  }
  return null;
}

/** A short human reading of the rule, for a chip on the card front. */
export function describeRecurrence(recurrence) {
  const rule = normaliseRecurrence(recurrence);
  if (!rule) return "";
  const time = `${String(rule.hour).padStart(2, "0")}:${String(rule.minute).padStart(2, "0")}`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const every = rule.interval === 1 ? "every" : `every ${rule.interval}`;
  let body;
  if (rule.freq === "daily") {
    body = rule.interval === 1 ? "every day" : `${every} days`;
  } else if (rule.freq === "weekly") {
    body = `${every} ${rule.interval === 1 ? "week" : "weeks"} on ${rule.byWeekday.map((day) => names[day]).join(", ")}`;
  } else if (rule.byMonthDay != null) {
    body = `${every} ${rule.interval === 1 ? "month" : "months"} on day ${rule.byMonthDay}`;
  } else {
    const { weekday, ordinal } = rule.byWeekdayOrdinal;
    const which = ordinal === -1 ? "last" : ["1st", "2nd", "3rd", "4th", "5th"][ordinal - 1];
    body = `${every} ${rule.interval === 1 ? "month" : "months"} on the ${which} ${names[weekday]}`;
  }
  const end = rule.until
    ? `, until ${rule.until.slice(0, 10)}`
    : rule.count != null ? `, ${rule.count} times` : "";
  return `${body} at ${time}${end}`;
}
