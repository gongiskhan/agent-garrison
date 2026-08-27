// The month grid behind the schedule date picker.
import { describe, expect, it } from "vitest";
import {
  monthGrid,
  shiftMonth,
  daysInMonth,
  splitLocalValue,
  joinLocalValue,
  isoDate,
  todayIso
} from "../fittings/seed/kanban-loop/ui/calendar-grid";

describe("monthGrid", () => {
  it("is always six full weeks, so the grid never reflows while paging", () => {
    for (const [year, month] of [[2026, 2], [2026, 5], [2024, 2], [2026, 8]]) {
      const grid = monthGrid(year, month);
      expect(grid).toHaveLength(6);
      for (const week of grid) expect(week).toHaveLength(7);
    }
  });

  it("starts every row on a Sunday", () => {
    for (const week of monthGrid(2026, 5)) {
      expect(week[0].weekday).toBe(0);
      expect(week[6].weekday).toBe(6);
    }
  });

  it("pads with the neighbouring months and marks them out of month", () => {
    // 1 May 2026 is a Friday, so the first row leads with 26-30 April.
    const grid = monthGrid(2026, 5);
    expect(grid[0][0].iso).toBe("2026-04-26");
    expect(grid[0][0].inMonth).toBe(false);
    expect(grid[0][5].iso).toBe("2026-05-01");
    expect(grid[0][5].inMonth).toBe(true);
    // And the tail spills into June.
    const last = grid[5][6];
    expect(last.month).toBe(6);
    expect(last.inMonth).toBe(false);
  });

  it("contains every day of the month exactly once", () => {
    const inMonth = monthGrid(2026, 2).flat().filter((day) => day.inMonth);
    expect(inMonth.map((day) => day.day)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
  });

  it("handles a leap February", () => {
    const inMonth = monthGrid(2024, 2).flat().filter((day) => day.inMonth);
    expect(inMonth).toHaveLength(29);
    expect(inMonth[28].iso).toBe("2024-02-29");
  });

  it("is stable across a DST weekend — the grid is calendar, not clock", () => {
    // Lisbon springs forward on 2026-03-29; the month still has 31 days.
    const inMonth = monthGrid(2026, 3).flat().filter((day) => day.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth.map((d) => d.day)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });
});

describe("shiftMonth", () => {
  it("steps months without a 31st sliding past a short month", () => {
    // The bug this guards: date arithmetic would turn 31 Jan + 1 month into
    // 2 March, making the picker skip February.
    expect(shiftMonth(2026, 1, 1)).toEqual({ year: 2026, month: 2 });
    expect(shiftMonth(2026, 3, -1)).toEqual({ year: 2026, month: 2 });
  });

  it("rolls across year boundaries in both directions", () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 1, -13)).toEqual({ year: 2024, month: 12 });
    expect(shiftMonth(2026, 6, 18)).toEqual({ year: 2027, month: 12 });
  });
});

describe("daysInMonth", () => {
  it("knows the short months and leap years", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe("splitLocalValue / joinLocalValue", () => {
  it("round-trips the local-wall value the editors already speak", () => {
    expect(splitLocalValue("2026-05-04T09:30")).toEqual({ date: "2026-05-04", time: "09:30" });
    expect(joinLocalValue("2026-05-04", "09:30")).toBe("2026-05-04T09:30");
  });

  it("tolerates an empty or partial value", () => {
    expect(splitLocalValue("")).toEqual({ date: "", time: "" });
    expect(splitLocalValue(null)).toEqual({ date: "", time: "" });
    expect(splitLocalValue("2026-05-04")).toEqual({ date: "2026-05-04", time: "" });
    expect(joinLocalValue("", "09:30")).toBe("");
  });

  it("drops seconds a browser may append", () => {
    expect(splitLocalValue("2026-05-04T09:30:00")).toEqual({ date: "2026-05-04", time: "09:30" });
  });

  it("defaults a bare date to the morning, not to midnight", () => {
    // "Tuesday" means Tuesday morning; midnight would put the card a day early
    // in every practical reading.
    expect(joinLocalValue("2026-05-04", "")).toBe("2026-05-04T09:00");
    expect(joinLocalValue("2026-05-04", "garbage")).toBe("2026-05-04T09:00");
  });
});

describe("isoDate / todayIso", () => {
  it("zero-pads", () => {
    expect(isoDate(2026, 5, 4)).toBe("2026-05-04");
    expect(isoDate(2026, 12, 31)).toBe("2026-12-31");
  });

  it("reads today in the browser's own zone", () => {
    expect(todayIso(new Date(2026, 4, 4, 23, 30))).toBe("2026-05-04");
  });
});
