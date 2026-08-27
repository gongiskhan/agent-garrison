import { describe, expect, it } from "vitest";
import {
  SOON_WINDOW_MS,
  scheduleUrgency,
  urgencyClass,
} from "../fittings/seed/kanban-loop/ui/schedule-urgency";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

describe("scheduleUrgency", () => {
  it("is quiet when there is no schedule at all", () => {
    expect(scheduleUrgency(null, NOW)).toBe("none");
    expect(scheduleUrgency(undefined, NOW)).toBe("none");
    expect(scheduleUrgency("", NOW)).toBe("none");
  });

  it("is quiet while the instant is far off", () => {
    expect(scheduleUrgency(at(6 * 60 * 60_000), NOW)).toBe("none");
    expect(scheduleUrgency(at(SOON_WINDOW_MS + 1), NOW)).toBe("none");
  });

  it("turns amber for the last few minutes before the instant", () => {
    expect(scheduleUrgency(at(SOON_WINDOW_MS), NOW)).toBe("soon");
    expect(scheduleUrgency(at(60_000), NOW)).toBe("soon");
    expect(scheduleUrgency(at(1), NOW)).toBe("soon");
  });

  it("turns alarm the moment the instant arrives, and stays there", () => {
    expect(scheduleUrgency(at(0), NOW)).toBe("due");
    expect(scheduleUrgency(at(-1), NOW)).toBe("due");
    expect(scheduleUrgency(at(-90 * 60_000), NOW)).toBe("due");
  });

  it("treats an unparseable instant as due — a broken schedule surfaces loudly, never quietly", () => {
    expect(scheduleUrgency("not a date", NOW)).toBe("due");
  });

  it("is quiet for a PAUSED recurring schedule, however close its next instant", () => {
    expect(scheduleUrgency(at(60_000), NOW, { enabled: false })).toBe("none");
    expect(scheduleUrgency(at(-60_000), NOW, { enabled: false })).toBe("none");
    // enabled undefined (a one-time hold has no enabled flag) must NOT read as paused.
    expect(scheduleUrgency(at(-60_000), NOW, { enabled: undefined })).toBe("due");
    expect(scheduleUrgency(at(-60_000), NOW, { enabled: null })).toBe("due");
  });

  it("honours a caller-supplied window", () => {
    expect(scheduleUrgency(at(20 * 60_000), NOW, { soonWindowMs: 30 * 60_000 })).toBe("soon");
    expect(scheduleUrgency(at(20 * 60_000), NOW, { soonWindowMs: 60_000 })).toBe("none");
  });
});

describe("urgencyClass", () => {
  it("adds nothing while the schedule is quiet, so the base chip is untouched", () => {
    expect(urgencyClass("none")).toBe("");
  });

  it("names the loud states as chip modifiers", () => {
    expect(urgencyClass("soon")).toBe(" soon");
    expect(urgencyClass("due")).toBe(" due");
  });
});
