// Card schedule primitives. Kept dependency-free so the board, engine, HTTP
// server and MCP surface share one validator and one timezone-aware cron clock.

export const SCHEDULE_KINDS = ["once", "cron"];
export const SCHEDULE_ACTIONS = ["notify", "run"];
export const DEFAULT_SCHEDULE_TIMEZONE = "Europe/Lisbon";

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
    if (typeof raw.cron !== "string" || !raw.cron.trim()) return "schedule.cron is required for a recurring schedule";
    try { parseCron(raw.cron); } catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  if (raw.nextAt != null && (typeof raw.nextAt !== "string" || !Number.isFinite(Date.parse(raw.nextAt)))) {
    return "schedule.nextAt must be a parseable ISO date-time";
  }
  return null;
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
  const discoveredSkips = [];
  if (kind === "once") {
    const candidate = value.at ?? scheduledFor;
    if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))) return null;
    at = new Date(candidate).toISOString();
    nextAt = nextAt ?? at;
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
  const skippedWallTimes = [...priorSkips, ...discoveredSkips]
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.wallTime === entry.wallTime && candidate.timezone === entry.timezone) === index)
    .slice(-24);
  return {
    kind,
    action,
    ...(at ? { at } : {}),
    ...(cron ? { cron } : {}),
    timezone,
    enabled,
    targetList: target,
    nextAt,
    lastAt,
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

export function occurrenceKey(templateId, scheduledAt, timezone) {
  const wall = zonedMinute(new Date(scheduledAt), timezone).key;
  return `${templateId}:${wall}`;
}
