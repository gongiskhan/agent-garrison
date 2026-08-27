// Card schedule primitives. Kept dependency-free so the board, engine, HTTP
// server and MCP surface share one validator and one timezone-aware cron clock.

import {
  normaliseRecurrence,
  recurrenceValidationError,
  nextRecurrenceOccurrence,
  latestRecurrenceOccurrence
} from "./recurrence.mjs";

export const SCHEDULE_KINDS = ["once", "cron"];
export const SCHEDULE_ACTIONS = ["notify", "run"];
export const DEFAULT_SCHEDULE_TIMEZONE = "Europe/Lisbon";

// RELEASE vs DUE. `nextAt` is the RELEASE instant: the moment the card stops
// being held and lands on its target list. The DEADLINE is a separate thing —
// the card asked for a card to arrive on To Do at one time and to be *due* at
// another, with the due time colouring the card front as it approaches.
//
// The deadline is stored as an OFFSET from the release instant, not as a second
// absolute instant, and that is deliberate: a recurring schedule recomputes
// `nextAt` on every occurrence, so an absolute second instant would go stale the
// first time the template fired. An offset stays correct for every occurrence
// without the engine touching it, and reads the same for a one-time card ("due
// four hours after it lands"). Absent or 0 means due == release, which is
// exactly today's behaviour — so every existing card is unchanged.
export const MAX_DUE_OFFSET_MINUTES = 525600; // one year, a sane upper bound

export function normaliseScheduleAction(raw) {
  return SCHEDULE_ACTIONS.includes(raw) ? raw : "notify";
}

export function normaliseScheduledFor(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value || null;
}

export function validTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.trim() }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function parseField(spec, lo, hi, label) {
  if (spec === "*") return { kind: "any" };
  if (spec.startsWith("*/")) {
    const step = Number(spec.slice(2));
    if (!Number.isInteger(step) || step <= 0 || step > hi - lo + 1) {
      throw new Error(`${label}: invalid step "${spec}"`);
    }
    return { kind: "step", step, lo };
  }
  const values = new Set();
  for (const part of spec.split(",")) {
    if (part.includes("-")) {
      const [a, b, ...extra] = part.split("-").map(Number);
      if (extra.length || !Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) {
        throw new Error(`${label}: invalid range "${part}"`);
      }
      for (let value = a; value <= b; value += 1) values.add(value);
    } else {
      const value = Number(part);
      if (!Number.isInteger(value) || value < lo || value > hi) {
        throw new Error(`${label}: invalid value "${part}"`);
      }
      values.add(value);
    }
  }
  if (!values.size) throw new Error(`${label}: empty field`);
  return { kind: "set", values };
}

export function parseCron(cron) {
  if (typeof cron !== "string") throw new Error("cron must be a string");
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron must have 5 fields, got ${parts.length}`);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return parts.map((spec, index) => parseField(spec, ranges[index][0], ranges[index][1], `cron field ${index + 1}`));
}

function fieldMatches(field, value) {
  if (field.kind === "any") return true;
  if (field.kind === "step") return (value - field.lo) % field.step === 0;
  return field.values.has(value);
}

const formatters = new Map();
function formatter(timeZone) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23"
    });
    formatters.set(timeZone, value);
  }
  return value;
}

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zonedMinute(date, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const dow = WEEKDAY[parts.weekday];
  return {
    year, month, day, hour, minute, dow,
    key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

export function cronMatches(parsed, date, timeZone) {
  const local = zonedMinute(date, timeZone);
  return cronMatchesLocal(parsed, local);
}

function cronMatchesLocal(parsed, local) {
  const dayOfMonth = fieldMatches(parsed[2], local.day);
  const dayOfWeek = fieldMatches(parsed[4], local.dow);
  // Standard five-field cron: when BOTH day fields are restricted, either may
  // match. If one is *, the restricted field remains authoritative.
  const dayMatches = parsed[2].kind !== "any" && parsed[4].kind !== "any"
    ? dayOfMonth || dayOfWeek
    : dayOfMonth && dayOfWeek;
  return fieldMatches(parsed[0], local.minute)
    && fieldMatches(parsed[1], local.hour)
    && dayMatches
    && fieldMatches(parsed[3], local.month);
}

function wallMinuteNumber(local) {
  return Math.floor(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) / 60000);
}

function localFromWallMinute(value) {
  const date = new Date(value * 60000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  return {
    year,
    month,
    day,
    hour,
    minute,
    dow: date.getUTCDay(),
    key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

// Search real UTC minutes while matching local wall time. This naturally skips a
// nonexistent DST wall minute. `excludeWallKey` suppresses the second copy of a
// repeated fallback minute, so a wall-time recurrence fires exactly once.
export function nextCronOccurrence(cron, timeZone, after, {
  excludeWallKey = null,
  maxMinutes = 60 * 24 * 370,
  onSkip = null
} = {}) {
  const parsed = parseCron(cron);
  if (!validTimeZone(timeZone)) throw new Error(`invalid IANA timezone: ${timeZone}`);
  const base = after instanceof Date ? after.getTime() : Date.parse(after);
  if (!Number.isFinite(base)) throw new Error("after must be a parseable date-time");
  let cursor = Math.floor(base / 60000) * 60000 + 60000;
  let previousLocal = zonedMinute(new Date(cursor - 60000), timeZone);
  // Local wall time normally increases with real time. During a fallback it
  // moves backwards; every minute until it catches the previous high-water
  // mark is the second copy of a wall minute that already existed. Suppress
  // the whole repeated interval, not only the last fired key — a cron such as
  // `*/15 1 * * *` would otherwise run 01:00/01:15/01:30 twice.
  let highestWallMinute = wallMinuteNumber(previousLocal);
  const reportedSkips = new Set();
  for (let index = 0; index < maxMinutes; index += 1, cursor += 60000) {
    const date = new Date(cursor);
    const local = zonedMinute(date, timeZone);
    const gap = wallMinuteNumber(local) - wallMinuteNumber(previousLocal);
    // A forward offset transition jumps over local wall minutes that never
    // existed. They cannot be discovered by matching real UTC instants, so
    // explicitly test the missing wall interval and expose matching cron
    // minutes to the caller for a durable skip receipt.
    if (gap > 1 && typeof onSkip === "function") {
      const prior = wallMinuteNumber(previousLocal);
      for (let missing = 1; missing < gap; missing += 1) {
        const skipped = localFromWallMinute(prior + missing);
        if (!cronMatchesLocal(parsed, skipped) || reportedSkips.has(skipped.key)) continue;
        reportedSkips.add(skipped.key);
        onSkip({
          wallTime: skipped.key,
          timezone: timeZone,
          reason: "nonexistent-dst-wall-time"
        });
      }
    }
    previousLocal = local;
    const localWallMinute = wallMinuteNumber(local);
    if (localWallMinute <= highestWallMinute) continue;
    highestWallMinute = localWallMinute;
    if (!cronMatchesLocal(parsed, local)) continue;
    const key = local.key;
    if (excludeWallKey && key === excludeWallKey) continue;
    return { at: date.toISOString(), wallKey: key };
  }
  return null;
}

// Most recent matching real minute at or before `at`. Used after downtime so a
// recurring card creates only the latest missed occurrence instead of replaying
// an unbounded burst. The returned wall key remains the idempotency identity.
export function latestCronOccurrence(cron, timeZone, at, { maxMinutes = 60 * 24 * 370 } = {}) {
  const parsed = parseCron(cron);
  if (!validTimeZone(timeZone)) throw new Error(`invalid IANA timezone: ${timeZone}`);
  const base = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(base)) throw new Error("at must be a parseable date-time");
  let cursor = Math.floor(base / 60000) * 60000;
  for (let index = 0; index < maxMinutes; index += 1, cursor -= 60000) {
    const date = new Date(cursor);
    if (!cronMatches(parsed, date, timeZone)) continue;
    return { at: date.toISOString(), wallKey: zonedMinute(date, timeZone).key };
  }
  return null;
}

export function scheduleValidationError(raw) {
  if (raw === null || raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "schedule must be an object or null";
  if (!SCHEDULE_KINDS.includes(raw.kind)) return "schedule.kind must be once or cron";
  if (raw.action !== undefined && !SCHEDULE_ACTIONS.includes(raw.action)) return "schedule.action must be notify or run";
  if (typeof raw.targetList !== "string" || !raw.targetList.trim()) return "schedule.targetList must be a non-empty list id";
  const timeZone = typeof raw.timezone === "string" && raw.timezone.trim() ? raw.timezone.trim() : DEFAULT_SCHEDULE_TIMEZONE;
  if (!validTimeZone(timeZone)) return `schedule.timezone is not a valid IANA timezone: ${timeZone}`;
  if (raw.kind === "once") {
    if (typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))) return "schedule.at must be a parseable ISO date-time for a once schedule";
  } else {
    // A recurring schedule is described EITHER by a calendar rule or by a cron
    // string. The rule is the one a person picks in the UI; cron stays for every
    // schedule already written that way, and for the system jobs that use it.
    const hasRecurrence = raw.recurrence !== undefined && raw.recurrence !== null;
    const hasCron = typeof raw.cron === "string" && raw.cron.trim();
    if (hasRecurrence && hasCron) return "a recurring schedule carries schedule.recurrence or schedule.cron, not both";
    if (hasRecurrence) {
      const error = recurrenceValidationError(raw.recurrence);
      if (error) return `schedule.${error}`;
    } else {
      if (!hasCron) return "schedule.cron or schedule.recurrence is required for a recurring schedule";
      try { parseCron(raw.cron); } catch (error) { return error instanceof Error ? error.message : String(error); }
    }
  }
  if (raw.nextAt != null && (typeof raw.nextAt !== "string" || !Number.isFinite(Date.parse(raw.nextAt)))) {
    return "schedule.nextAt must be a parseable ISO date-time";
  }
  if (raw.dueOffsetMinutes != null) {
    if (!Number.isInteger(raw.dueOffsetMinutes) || raw.dueOffsetMinutes < 0 || raw.dueOffsetMinutes > MAX_DUE_OFFSET_MINUTES) {
      return `schedule.dueOffsetMinutes must be a whole number of minutes between 0 and ${MAX_DUE_OFFSET_MINUTES}`;
    }
  }
  if (raw.updatedAt != null && (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt)))) {
    return "schedule.updatedAt must be a parseable ISO date-time";
  }
  return null;
}

// ── Google Calendar sync receipt ───────────────────────────────────────────
// The synced fields of a schedule, as ONE value. Two schedules with the same
// signature describe the same calendar event, so the sync can decide whether a
// push is needed by comparing signatures rather than by diffing field by field
// (and can therefore never forget to compare a field it also pushes).
export function scheduleSyncSignature({ title, releaseAt, dueAt }) {
  return JSON.stringify([title ?? "", releaseAt ?? "", dueAt ?? ""]);
}

export function normaliseCalendarLink(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.eventId !== "string" || !raw.eventId.trim()) return null;
  const iso = (value) =>
    typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const syncedAt = iso(raw.syncedAt);
  const remoteUpdated = iso(raw.remoteUpdated);
  return {
    eventId: raw.eventId.trim().slice(0, 1024),
    calendarId: typeof raw.calendarId === "string" && raw.calendarId.trim() ? raw.calendarId.trim().slice(0, 512) : "primary",
    // The signature of what we last PUSHED. A mismatch against the card's
    // current signature is the whole push trigger.
    signature: typeof raw.signature === "string" ? raw.signature.slice(0, 2000) : "",
    ...(syncedAt ? { syncedAt } : {}),
    // Calendar's own `updated` stamp at the moment we last agreed with it. The
    // pull side treats a NEWER remote stamp as "a human edited it in Calendar".
    ...(remoteUpdated ? { remoteUpdated } : {}),
    ...(typeof raw.lastError === "string" && raw.lastError ? { lastError: raw.lastError.slice(0, 500) } : {})
  };
}

export function normaliseCardSchedule(raw, {
  scheduledFor = null,
  scheduleAction = null,
  targetList = "backlog",
  now = new Date().toISOString()
} = {}) {
  let value = raw;
  if ((value === null || value === undefined) && scheduledFor) {
    value = {
      kind: "once",
      action: normaliseScheduleAction(scheduleAction),
      at: scheduledFor,
      timezone: DEFAULT_SCHEDULE_TIMEZONE,
      enabled: true,
      targetList
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = value.kind === "cron" ? "cron" : value.kind === "once" ? "once" : null;
  if (!kind) return null;
  const action = normaliseScheduleAction(value.action ?? scheduleAction);
  const timezone = typeof value.timezone === "string" && validTimeZone(value.timezone.trim())
    ? value.timezone.trim()
    : DEFAULT_SCHEDULE_TIMEZONE;
  const target = typeof value.targetList === "string" && value.targetList.trim() ? value.targetList.trim() : targetList;
  const enabled = value.enabled !== false;
  const lastAt = typeof value.lastAt === "string" && Number.isFinite(Date.parse(value.lastAt)) ? new Date(value.lastAt).toISOString() : null;
  let nextAt = typeof value.nextAt === "string" && Number.isFinite(Date.parse(value.nextAt)) ? new Date(value.nextAt).toISOString() : null;
  let at = null;
  let cron = null;
  let recurrence = null;
  const discoveredSkips = [];
  if (kind === "once") {
    const candidate = value.at ?? scheduledFor;
    if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))) return null;
    at = new Date(candidate).toISOString();
    nextAt = nextAt ?? at;
  } else if (value.recurrence !== undefined && value.recurrence !== null) {
    recurrence = normaliseRecurrence(value.recurrence);
    if (!recurrence) return null;
    if (!nextAt && enabled) {
      // A rule whose end condition has already passed simply has no next
      // instant; that is a finished schedule, not a broken one.
      nextAt = nextRecurrenceOccurrence(recurrence, timezone, now)?.at ?? null;
    }
  } else {
    if (typeof value.cron !== "string") return null;
    cron = value.cron.trim();
    try { parseCron(cron); } catch { return null; }
    if (!nextAt && enabled) {
      nextAt = nextCronOccurrence(cron, timezone, now, {
        onSkip: (skip) => discoveredSkips.push({ ...skip, recordedAt: now })
      })?.at ?? null;
    }
  }
  const priorSkips = Array.isArray(value.skippedWallTimes)
    ? value.skippedWallTimes
        .filter((entry) => entry && typeof entry.wallTime === "string" && typeof entry.timezone === "string")
        .map((entry) => ({
          wallTime: entry.wallTime.slice(0, 32),
          timezone: entry.timezone.slice(0, 100),
          reason: "nonexistent-dst-wall-time",
          ...(typeof entry.recordedAt === "string" && Number.isFinite(Date.parse(entry.recordedAt))
            ? { recordedAt: new Date(entry.recordedAt).toISOString() }
            : {})
        }))
    : [];
  // A deadline offset only survives if it is a whole, sane number of minutes.
  // Anything else is dropped rather than clamped: a card whose deadline was
  // silently invented is worse than one that simply has none.
  const dueOffsetMinutes = Number.isInteger(value.dueOffsetMinutes)
    && value.dueOffsetMinutes > 0
    && value.dueOffsetMinutes <= MAX_DUE_OFFSET_MINUTES
    ? value.dueOffsetMinutes
    : 0;
  const skippedWallTimes = [...priorSkips, ...discoveredSkips]
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.wallTime === entry.wallTime && candidate.timezone === entry.timezone) === index)
    .slice(-24);
  return {
    kind,
    action,
    ...(at ? { at } : {}),
    ...(cron ? { cron } : {}),
    ...(recurrence ? { recurrence } : {}),
    timezone,
    enabled,
    targetList: target,
    nextAt,
    lastAt,
    ...(dueOffsetMinutes ? { dueOffsetMinutes } : {}),
    // Last-write-wins needs a local stamp to compare against Calendar's
    // `updated`. It is only ever carried through here — bumping it is the
    // caller's job (touchScheduleUpdatedAt), because only the caller knows
    // whether a write actually changed anything a human would see.
    ...(typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
      ? { updatedAt: new Date(value.updatedAt).toISOString() }
      : {}),
    ...(normaliseCalendarLink(value.calendar) ? { calendar: normaliseCalendarLink(value.calendar) } : {}),
    ...(value.pending && typeof value.pending === "object" ? { pending: value.pending } : {}),
    ...(typeof value.lastError === "string" && value.lastError ? { lastError: value.lastError.slice(0, 500) } : {}),
    ...(typeof value.snoozedUntil === "string" && Number.isFinite(Date.parse(value.snoozedUntil))
      ? { snoozedUntil: new Date(value.snoozedUntil).toISOString() }
      : {}),
    ...(skippedWallTimes.length ? { skippedWallTimes } : {}),
    ...(value.runNowVerification && typeof value.runNowVerification === "object" &&
      typeof value.runNowVerification.occurrenceId === "string" &&
      typeof value.runNowVerification.verifiedAt === "string" &&
      Number.isFinite(Date.parse(value.runNowVerification.verifiedAt))
      ? {
          runNowVerification: {
            occurrenceId: value.runNowVerification.occurrenceId.slice(0, 80),
            occurrenceKey: typeof value.runNowVerification.occurrenceKey === "string"
              ? value.runNowVerification.occurrenceKey.slice(0, 220)
              : null,
            verifiedAt: new Date(value.runNowVerification.verifiedAt).toISOString()
          }
        }
      : {}),
    ...(value.cutoverPending === true ? {
      cutoverPending: true,
      desiredEnabled: value.desiredEnabled !== false
    } : {})
  };
}

export function scheduleNextAt(card) {
  const value = card?.schedule?.enabled !== false ? card?.schedule?.nextAt : null;
  return value || card?.scheduledFor || null;
}

// ── recurring-schedule clock, whichever kind of rule it carries ────────────
// A recurring schedule is described by a calendar rule OR a cron string. Every
// caller that advances one goes through this pair rather than reaching for
// `schedule.cron`, which is undefined on a rule-driven schedule and would take
// parseCron straight into a throw mid-sweep.

/** The first occurrence strictly after `after`, or null when the rule is spent. */
export function nextScheduleOccurrence(schedule, after, { excludeWallKey = null, onSkip = null } = {}) {
  if (!schedule) return null;
  if (schedule.recurrence) {
    // No exclusion is needed for a calendar rule: it yields exactly one instant
    // per calendar day, so a repeated wall hour cannot produce a duplicate.
    return nextRecurrenceOccurrence(schedule.recurrence, schedule.timezone, after);
  }
  if (typeof schedule.cron !== "string" || !schedule.cron) return null;
  return nextCronOccurrence(schedule.cron, schedule.timezone, after, { excludeWallKey, onSkip });
}

/** The most recent occurrence at or before `at` — how a schedule that fell
 *  behind catches up with one occurrence instead of a replay burst. */
export function latestScheduleOccurrence(schedule, at) {
  if (!schedule) return null;
  if (schedule.recurrence) return latestRecurrenceOccurrence(schedule.recurrence, schedule.timezone, at);
  if (typeof schedule.cron !== "string" || !schedule.cron) return null;
  return latestCronOccurrence(schedule.cron, schedule.timezone, at);
}

// The DEADLINE instant — release plus the card's deadline offset. With no
// offset this is the release instant itself, so every caller that used to read
// the release instant as "the time on the card" keeps reading the same value.
export function scheduleDueAt(card) {
  const release = scheduleNextAt(card);
  if (!release) return null;
  const offset = card?.schedule?.dueOffsetMinutes;
  if (!Number.isInteger(offset) || offset <= 0) return release;
  const t = Date.parse(release);
  if (!Number.isFinite(t)) return release; // keep the unparseable value visible
  return new Date(t + offset * 60000).toISOString();
}

export function occurrenceKey(templateId, scheduledAt, timezone) {
  const wall = zonedMinute(new Date(scheduledAt), timezone).key;
  return `${templateId}:${wall}`;
}
