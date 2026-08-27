// Calendar-style recurrence. The two cases that matter most here are exactly
// the two a cron string CANNOT express — a week interval, and an ordinal
// weekday of the month — because those are the reason this module exists at all.
import { describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { nextRecurrenceOccurrence, latestRecurrenceOccurrence, recurrenceValidationError, normaliseRecurrence, describeRecurrence, instantFromWall, dayMatchesRecurrence } from "../fittings/seed/kanban-loop/lib/recurrence.mjs";

const TZ = "Europe/Lisbon";

/** The occurrences after `from`, walked forward `n` times. */
function walk(rule: any, from: string, n: number, timeZone = TZ): string[] {
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i < n; i += 1) {
    const next = nextRecurrenceOccurrence(rule, timeZone, cursor);
    if (!next) break;
    out.push(next.at);
    cursor = next.at;
  }
  return out;
}

describe("instantFromWall", () => {
  it("resolves a wall time to the instant that reads it in the zone", () => {
    // Winter: Lisbon is UTC+0.
    expect(instantFromWall({ year: 2026, month: 1, day: 15, hour: 9, minute: 30 }, TZ))
      .toBe("2026-01-15T09:30:00.000Z");
    // Summer: Lisbon is UTC+1, so 09:30 local is 08:30Z.
    expect(instantFromWall({ year: 2026, month: 7, day: 15, hour: 9, minute: 30 }, TZ))
      .toBe("2026-07-15T08:30:00.000Z");
  });

  it("keeps a wall time stable across a zone with a large offset", () => {
    expect(instantFromWall({ year: 2026, month: 3, day: 10, hour: 14, minute: 0 }, "America/New_York"))
      .toBe("2026-03-10T18:00:00.000Z");
  });
});

describe("nextRecurrenceOccurrence — what cron could not say", () => {
  it("honours a WEEK interval, which cron has no field for", () => {
    // Every 2 weeks on Tuesday, anchored to Tue 2026-01-06.
    const rule = { freq: "weekly", interval: 2, byWeekday: [2], hour: 9, minute: 0, start: "2026-01-06T09:00:00.000Z" };
    expect(walk(rule, "2026-01-01T00:00:00.000Z", 4)).toEqual([
      "2026-01-06T09:00:00.000Z",
      "2026-01-20T09:00:00.000Z",
      "2026-02-03T09:00:00.000Z",
      "2026-02-17T09:00:00.000Z"
    ]);
  });

  it("keeps two weekdays inside the SAME week of an interval", () => {
    // Every 2 weeks on Mon and Wed: both days ride the same qualifying week
    // rather than alternating, which a day-counted interval would get wrong.
    const rule = { freq: "weekly", interval: 2, byWeekday: [1, 3], hour: 8, minute: 0, start: "2026-01-05T08:00:00.000Z" };
    expect(walk(rule, "2026-01-01T00:00:00.000Z", 4)).toEqual([
      "2026-01-05T08:00:00.000Z", // Mon
      "2026-01-07T08:00:00.000Z", // Wed, same week
      "2026-01-19T08:00:00.000Z", // Mon, two weeks on
      "2026-01-21T08:00:00.000Z"  // Wed
    ]);
  });

  it("honours an ORDINAL weekday of the month, which cron OR's away", () => {
    // The 2nd Tuesday of every month.
    const rule = { freq: "monthly", interval: 1, byWeekdayOrdinal: { weekday: 2, ordinal: 2 }, hour: 10, minute: 0, start: "2026-01-01T10:00:00.000Z" };
    expect(walk(rule, "2026-01-01T00:00:00.000Z", 3)).toEqual([
      "2026-01-13T10:00:00.000Z",
      "2026-02-10T10:00:00.000Z",
      "2026-03-10T10:00:00.000Z"
    ]);
  });

  it("reads -1 as the LAST weekday of the month", () => {
    const rule = { freq: "monthly", interval: 1, byWeekdayOrdinal: { weekday: 5, ordinal: -1 }, hour: 17, minute: 0, start: "2026-01-01T17:00:00.000Z" };
    // Last Friday: 30 Jan, 27 Feb, 27 Mar (Lisbon is on summer time from 29 Mar).
    expect(walk(rule, "2026-01-01T00:00:00.000Z", 3)).toEqual([
      "2026-01-30T17:00:00.000Z",
      "2026-02-27T17:00:00.000Z",
      "2026-03-27T17:00:00.000Z"
    ]);
  });
});

describe("nextRecurrenceOccurrence — the ordinary cases", () => {
  it("walks a daily interval", () => {
    const rule = { freq: "daily", interval: 3, hour: 7, minute: 15, start: "2026-01-01T07:15:00.000Z" };
    expect(walk(rule, "2026-01-01T08:00:00.000Z", 3)).toEqual([
      "2026-01-04T07:15:00.000Z",
      "2026-01-07T07:15:00.000Z",
      "2026-01-10T07:15:00.000Z"
    ]);
  });

  it("holds the WALL time across a DST transition", () => {
    // Lisbon springs forward on 2026-03-29. A daily 09:00 rule must stay at
    // 09:00 local — 09:00Z before, 08:00Z after — not drift by an hour.
    const rule = { freq: "daily", interval: 1, hour: 9, minute: 0, start: "2026-03-27T09:00:00.000Z" };
    expect(walk(rule, "2026-03-27T00:00:00.000Z", 4)).toEqual([
      "2026-03-27T09:00:00.000Z",
      "2026-03-28T09:00:00.000Z",
      "2026-03-29T08:00:00.000Z",
      "2026-03-30T08:00:00.000Z"
    ]);
  });

  it("SKIPS a month that has no such day rather than sliding the date", () => {
    // The 31st: January, March, May — never a made-up 28 February.
    const rule = { freq: "monthly", interval: 1, byMonthDay: 31, hour: 12, minute: 0, start: "2026-01-31T12:00:00.000Z" };
    expect(walk(rule, "2026-01-01T00:00:00.000Z", 3)).toEqual([
      "2026-01-31T12:00:00.000Z",
      "2026-03-31T11:00:00.000Z",
      "2026-05-31T11:00:00.000Z"
    ]);
  });

  it("never fires before its start", () => {
    const rule = { freq: "daily", interval: 1, hour: 9, minute: 0, start: "2026-06-01T08:00:00.000Z" };
    expect(nextRecurrenceOccurrence(rule, TZ, "2026-01-01T00:00:00.000Z")?.at).toBe("2026-06-01T08:00:00.000Z");
  });
});

describe("nextRecurrenceOccurrence — end conditions", () => {
  it("stops at `until`", () => {
    const rule = { freq: "daily", interval: 1, hour: 9, minute: 0, start: "2026-01-01T09:00:00.000Z", until: "2026-01-03T23:59:00.000Z" };
    expect(walk(rule, "2025-12-31T00:00:00.000Z", 10)).toEqual([
      "2026-01-01T09:00:00.000Z",
      "2026-01-02T09:00:00.000Z",
      "2026-01-03T09:00:00.000Z"
    ]);
  });

  it("stops after `count` occurrences, counting the ones already past", () => {
    const rule = { freq: "daily", interval: 1, hour: 9, minute: 0, start: "2026-01-01T09:00:00.000Z", count: 3 };
    expect(walk(rule, "2025-12-31T00:00:00.000Z", 10)).toEqual([
      "2026-01-01T09:00:00.000Z",
      "2026-01-02T09:00:00.000Z",
      "2026-01-03T09:00:00.000Z"
    ]);
    // Asked from the middle, the count is still measured from the start — two
    // are already behind us, so exactly one remains.
    expect(walk(rule, "2026-01-02T12:00:00.000Z", 10)).toEqual(["2026-01-03T09:00:00.000Z"]);
    expect(nextRecurrenceOccurrence(rule, TZ, "2026-01-03T12:00:00.000Z")).toBeNull();
  });
});

describe("recurrenceValidationError", () => {
  it("accepts null and a well-formed rule", () => {
    expect(recurrenceValidationError(null)).toBeNull();
    expect(recurrenceValidationError({ freq: "weekly", interval: 2, byWeekday: [1], hour: 9, minute: 0, start: "2026-01-01T00:00:00Z" })).toBeNull();
  });

  it("rejects the shapes that would silently mean something else", () => {
    expect(recurrenceValidationError({ freq: "yearly", hour: 9, minute: 0, start: "2026-01-01T00:00:00Z" })).toMatch(/freq/);
    expect(recurrenceValidationError({ freq: "weekly", byWeekday: [], hour: 9, minute: 0, start: "2026-01-01T00:00:00Z" })).toMatch(/byWeekday/);
    expect(recurrenceValidationError({ freq: "weekly", byWeekday: [7], hour: 9, minute: 0, start: "2026-01-01T00:00:00Z" })).toMatch(/byWeekday/);
    expect(recurrenceValidationError({ freq: "daily", byWeekday: [1], hour: 9, minute: 0, start: "2026-01-01T00:00:00Z" })).toMatch(/weekly/);
    // A monthly rule with both day selectors, or neither, is ambiguous.
    expect(recurrenceValidationError({ freq: "monthly", byMonthDay: 1, byWeekdayOrdinal: { weekday: 1, ordinal: 1 }, hour: 9, minute: 0, start: "2026-01-01T00:00:00Z" })).toMatch(/exactly one/);
    expect(recurrenceValidationError({ freq: "monthly", hour: 9, minute: 0, start: "2026-01-01T00:00:00Z" })).toMatch(/exactly one/);
    expect(recurrenceValidationError({ freq: "daily", hour: 24, minute: 0, start: "2026-01-01T00:00:00Z" })).toMatch(/hour/);
    expect(recurrenceValidationError({ freq: "daily", hour: 9, minute: 0, start: "nope" })).toMatch(/start/);
    // Two end conditions contradict each other.
    expect(recurrenceValidationError({ freq: "daily", hour: 9, minute: 0, start: "2026-01-01T00:00:00Z", until: "2026-02-01T00:00:00Z", count: 4 })).toMatch(/not both/);
  });
});

describe("normaliseRecurrence", () => {
  it("canonicalises so equal rules compare equal", () => {
    const a = normaliseRecurrence({ freq: "weekly", byWeekday: [3, 1, 1], hour: 9, minute: 5, start: "2026-01-01T00:00:00.000Z" });
    const b = normaliseRecurrence({ freq: "weekly", interval: 1, byWeekday: [1, 3], hour: 9, minute: 5, start: "2026-01-01T00:00:00Z" });
    expect(a).toEqual(b);
    expect(a?.interval).toBe(1);
  });

  it("returns null for an unusable rule instead of a half-built one", () => {
    expect(normaliseRecurrence({ freq: "monthly", hour: 9, minute: 0, start: "2026-01-01T00:00:00Z" })).toBeNull();
  });
});

describe("dayMatchesRecurrence", () => {
  it("never matches a day before the start", () => {
    const rule = normaliseRecurrence({ freq: "daily", hour: 9, minute: 0, start: "2026-05-10T09:00:00.000Z" })!;
    const startDay = { year: 2026, month: 5, day: 10 };
    expect(dayMatchesRecurrence(rule, { year: 2026, month: 5, day: 9 }, startDay)).toBe(false);
    expect(dayMatchesRecurrence(rule, { year: 2026, month: 5, day: 10 }, startDay)).toBe(true);
  });
});

describe("describeRecurrence", () => {
  it("reads back the rules cron could not express", () => {
    expect(describeRecurrence({ freq: "weekly", interval: 2, byWeekday: [2], hour: 9, minute: 0, start: "2026-01-06T09:00:00Z" }))
      .toBe("every 2 weeks on Tue at 09:00");
    expect(describeRecurrence({ freq: "monthly", interval: 1, byWeekdayOrdinal: { weekday: 2, ordinal: 2 }, hour: 10, minute: 0, start: "2026-01-01T10:00:00Z" }))
      .toBe("every month on the 2nd Tue at 10:00");
    expect(describeRecurrence({ freq: "monthly", interval: 1, byWeekdayOrdinal: { weekday: 5, ordinal: -1 }, hour: 17, minute: 0, start: "2026-01-01T17:00:00Z" }))
      .toBe("every month on the last Fri at 17:00");
    expect(describeRecurrence({ freq: "daily", interval: 1, hour: 7, minute: 30, start: "2026-01-01T07:30:00Z", count: 5 }))
      .toBe("every day at 07:30, 5 times");
  });
});

describe("latestRecurrenceOccurrence honours count", () => {
  it("a count-limited rule's latest occurrence is its FINAL one, not the walk-back from now", () => {
    // The downtime catch-up reads "latest" during the sweep; ignoring count
    // materialised a phantom occurrence on a day the rule never included
    // (daily count=3 from Aug 1 = Aug 1..3; asked at Aug 10 it answered Aug 10).
    const rule = { freq: "daily", interval: 1, start: "2026-08-01T00:00:00.000Z", hour: 9, minute: 0, count: 3 };
    const latest = latestRecurrenceOccurrence(rule, "UTC", "2026-08-10T12:00:00Z");
    expect(latest?.at).toBe("2026-08-03T09:00:00.000Z");
    // …and mid-series it reports the most recent occurrence inside the count.
    const mid = latestRecurrenceOccurrence(rule, "UTC", "2026-08-02T12:00:00Z");
    expect(mid?.at).toBe("2026-08-02T09:00:00.000Z");
    // Before the first occurrence there is nothing yet.
    expect(latestRecurrenceOccurrence(rule, "UTC", "2026-07-31T12:00:00Z")).toBeNull();
  });
});

