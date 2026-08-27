// RELEASE vs DUE — the card asked for a scheduled card to land on To Do at one
// time and be *due* at another, with the due time colouring the card front.
// These tests pin the split itself, the backward compatibility that makes it
// safe to ship (a card with no deadline offset reads exactly as before), and
// the recurring-schedule plumbing that has to survive a rule-driven schedule
// where `schedule.cron` simply does not exist.
import { describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { scheduleDueAt, scheduleNextAt, normaliseCardSchedule, scheduleValidationError, nextScheduleOccurrence, latestScheduleOccurrence } from "../fittings/seed/kanban-loop/lib/schedules.mjs";
import {
  dueInstant,
  releaseInstant,
  hasSplitDeadline,
  scheduleUrgency
} from "../fittings/seed/kanban-loop/ui/schedule-urgency";

const TZ = "Europe/Lisbon";
const RELEASE = "2026-05-04T09:00:00.000Z";

const card = (schedule: any, scheduledFor: string | null = null) => ({ schedule, scheduledFor });

describe("scheduleDueAt — the deadline instant", () => {
  it("is the release instant when no deadline offset is set", () => {
    const c = card({ kind: "once", nextAt: RELEASE });
    expect(scheduleDueAt(c)).toBe(RELEASE);
    expect(scheduleDueAt(c)).toBe(scheduleNextAt(c));
  });

  it("is release PLUS the offset when one is set", () => {
    // Lands on To Do at 09:00, due at 17:00 — the split the card asked for.
    expect(scheduleDueAt(card({ kind: "once", nextAt: RELEASE, dueOffsetMinutes: 480 })))
      .toBe("2026-05-04T17:00:00.000Z");
  });

  it("falls back to the legacy scheduledFor field", () => {
    expect(scheduleDueAt(card(null, RELEASE))).toBe(RELEASE);
  });

  it("returns null when the card carries no schedule at all", () => {
    expect(scheduleDueAt(card(null))).toBeNull();
    expect(scheduleDueAt(undefined as any)).toBeNull();
  });

  it("keeps an unparseable instant visible instead of inventing one", () => {
    expect(scheduleDueAt(card({ kind: "once", nextAt: "not a date", dueOffsetMinutes: 60 }))).toBe("not a date");
  });
});

describe("the deadline offset survives a round trip", () => {
  it("is validated, kept, and reported back", () => {
    const schedule = normaliseCardSchedule(
      { kind: "once", at: RELEASE, targetList: "todo", timezone: TZ, dueOffsetMinutes: 120 },
      { targetList: "todo" }
    );
    expect(schedule.dueOffsetMinutes).toBe(120);
    expect(scheduleDueAt({ schedule })).toBe("2026-05-04T11:00:00.000Z");
  });

  it("drops a nonsense offset rather than clamping it into a wrong deadline", () => {
    for (const bad of [-5, 0, 1.5, "60", null, 999999999]) {
      const schedule = normaliseCardSchedule(
        { kind: "once", at: RELEASE, targetList: "todo", timezone: TZ, dueOffsetMinutes: bad },
        { targetList: "todo" }
      );
      expect(schedule.dueOffsetMinutes).toBeUndefined();
      expect(scheduleDueAt({ schedule })).toBe(RELEASE);
    }
  });

  it("refuses an out-of-range offset at the door with a readable reason", () => {
    expect(scheduleValidationError({ kind: "once", at: RELEASE, targetList: "todo", dueOffsetMinutes: -1 })).toMatch(/dueOffsetMinutes/);
    expect(scheduleValidationError({ kind: "once", at: RELEASE, targetList: "todo", dueOffsetMinutes: 2.5 })).toMatch(/dueOffsetMinutes/);
    expect(scheduleValidationError({ kind: "once", at: RELEASE, targetList: "todo", dueOffsetMinutes: 600 })).toBeNull();
  });

  it("rides a RECURRING schedule too, so every occurrence keeps its deadline", () => {
    // An absolute second instant would have gone stale the first time the
    // template fired; an offset stays correct as nextAt advances.
    const schedule = normaliseCardSchedule(
      { kind: "cron", cron: "0 9 * * 1", targetList: "todo", timezone: TZ, dueOffsetMinutes: 240 },
      { targetList: "todo", now: "2026-05-01T00:00:00.000Z" }
    );
    expect(schedule.dueOffsetMinutes).toBe(240);
    const release = Date.parse(scheduleDueAt({ schedule })!) - Date.parse(schedule.nextAt);
    expect(release).toBe(240 * 60_000);
    // And after the template advances, the deadline advances with it.
    const advanced = { ...schedule, nextAt: nextScheduleOccurrence(schedule, schedule.nextAt)!.at };
    expect(Date.parse(scheduleDueAt({ schedule: advanced })!) - Date.parse(advanced.nextAt)).toBe(240 * 60_000);
  });
});

describe("the card front paints the DEADLINE, not the release", () => {
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  it("stays quiet after release while the deadline is still far off", () => {
    // Released an hour ago, due in six hours: it is on To Do and NOT shouting.
    const c = card({ kind: "once", nextAt: at(-60 * 60_000), dueOffsetMinutes: 7 * 60 });
    expect(scheduleUrgency(releaseInstant(c), Date.now())).toBe("due");   // released
    expect(scheduleUrgency(dueInstant(c), Date.now())).toBe("none");      // not yet due
  });

  it("goes loud once the DEADLINE arrives, not when it was released", () => {
    const c = card({ kind: "once", nextAt: at(-10 * 60 * 60_000), dueOffsetMinutes: 60 });
    expect(scheduleUrgency(dueInstant(c), Date.now())).toBe("due");
  });

  it("reads exactly as before for a card with no deadline offset", () => {
    const c = card({ kind: "once", nextAt: at(-60_000) });
    expect(dueInstant(c)).toBe(releaseInstant(c));
    expect(scheduleUrgency(dueInstant(c), Date.now())).toBe("due");
  });

  it("knows when there are two instants worth showing", () => {
    expect(hasSplitDeadline(card({ kind: "once", nextAt: RELEASE }))).toBe(false);
    expect(hasSplitDeadline(card({ kind: "once", nextAt: RELEASE, dueOffsetMinutes: 0 }))).toBe(false);
    expect(hasSplitDeadline(card({ kind: "once", nextAt: RELEASE, dueOffsetMinutes: 60 }))).toBe(true);
    // No release instant means nothing to offset from.
    expect(hasSplitDeadline(card({ kind: "once", nextAt: null, dueOffsetMinutes: 60 }))).toBe(false);
  });

  it("mirrors the server resolver exactly", () => {
    for (const offset of [undefined, 0, 30, 480]) {
      const c = card({ kind: "once", nextAt: RELEASE, dueOffsetMinutes: offset });
      expect(dueInstant(c as any)).toBe(scheduleDueAt(c));
    }
  });
});

describe("a recurring schedule driven by a calendar RULE instead of cron", () => {
  const recurrence = { freq: "weekly", interval: 2, byWeekday: [2], hour: 9, minute: 0, start: "2026-01-06T09:00:00.000Z" };

  it("normalises, and resolves its own next instant", () => {
    const schedule = normaliseCardSchedule(
      { kind: "cron", recurrence, targetList: "todo", timezone: TZ },
      { targetList: "todo", now: "2026-01-07T00:00:00.000Z" }
    );
    expect(schedule.recurrence.freq).toBe("weekly");
    expect(schedule.cron).toBeUndefined();
    expect(schedule.nextAt).toBe("2026-01-20T09:00:00.000Z");
  });

  it("advances through the SAME dispatchers the cron sweep uses", () => {
    // This is the integration that would otherwise crash: the engine's sweep
    // reaches for schedule.cron, which a rule-driven schedule does not have.
    const schedule = normaliseCardSchedule(
      { kind: "cron", recurrence, targetList: "todo", timezone: TZ },
      { targetList: "todo", now: "2026-01-07T00:00:00.000Z" }
    );
    expect(nextScheduleOccurrence(schedule, schedule.nextAt)?.at).toBe("2026-02-03T09:00:00.000Z");
    // After downtime, catch up to the LATEST missed one, not a replay burst.
    expect(latestScheduleOccurrence(schedule, "2026-02-10T00:00:00.000Z")?.at).toBe("2026-02-03T09:00:00.000Z");
  });

  it("still advances a cron-driven schedule through the same dispatchers", () => {
    const schedule = normaliseCardSchedule(
      { kind: "cron", cron: "0 9 * * 1", targetList: "todo", timezone: TZ },
      { targetList: "todo", now: "2026-01-07T00:00:00.000Z" }
    );
    expect(schedule.nextAt).toBe("2026-01-12T09:00:00.000Z");
    expect(nextScheduleOccurrence(schedule, schedule.nextAt)?.at).toBe("2026-01-19T09:00:00.000Z");
    expect(latestScheduleOccurrence(schedule, "2026-01-20T00:00:00.000Z")?.at).toBe("2026-01-19T09:00:00.000Z");
  });

  it("refuses a schedule that tries to be both a rule and a cron string", () => {
    expect(scheduleValidationError({ kind: "cron", cron: "0 9 * * 1", recurrence, targetList: "todo" })).toMatch(/not both/);
  });

  it("reports a broken rule with the schedule. prefix so the field is findable", () => {
    const error = scheduleValidationError({ kind: "cron", recurrence: { freq: "weekly", byWeekday: [], hour: 9, minute: 0, start: "2026-01-01T00:00:00Z" }, targetList: "todo" });
    expect(error).toMatch(/^schedule\.recurrence\.byWeekday/);
  });

  it("still demands one of the two for a recurring schedule", () => {
    expect(scheduleValidationError({ kind: "cron", targetList: "todo" })).toMatch(/cron or schedule\.recurrence/);
  });
});
