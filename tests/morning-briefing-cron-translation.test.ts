import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  __dirname,
  "..",
  "fittings/seed/morning-briefing/scripts/briefing.py"
);

function cron(time: string, weekdaysOnly: string): { stdout: string; status: number; stderr: string } {
  const r = spawnSync("python3", [SCRIPT, "--cron", time, weekdaysOnly], {
    encoding: "utf8",
  });
  return { stdout: r.stdout.trim(), status: r.status ?? -1, stderr: r.stderr };
}

describe("morning-briefing time→cron translation", () => {
  it("08:00 + weekdays_only=true → '0 8 * * 1-5'", () => {
    const r = cron("08:00", "true");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("0 8 * * 1-5");
  });

  it("09:30 + weekdays_only=false → '30 9 * * *'", () => {
    const r = cron("09:30", "false");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("30 9 * * *");
  });

  it("00:00 (midnight) → '0 0 * * 1-5' weekdays / '0 0 * * *' all", () => {
    expect(cron("00:00", "true").stdout).toBe("0 0 * * 1-5");
    expect(cron("00:00", "false").stdout).toBe("0 0 * * *");
  });

  it("23:59 (end of day) → '59 23 * * 1-5' weekdays", () => {
    expect(cron("23:59", "true").stdout).toBe("59 23 * * 1-5");
  });

  it("accepts truthy aliases for weekdays_only (1, yes, y)", () => {
    expect(cron("08:00", "1").stdout).toBe("0 8 * * 1-5");
    expect(cron("08:00", "yes").stdout).toBe("0 8 * * 1-5");
    expect(cron("08:00", "y").stdout).toBe("0 8 * * 1-5");
    expect(cron("08:00", "no").stdout).toBe("0 8 * * *");
  });

  it("rejects malformed time inputs", () => {
    const r = cron("not-a-time", "true");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("briefing_time");
  });

  it("rejects out-of-range hour", () => {
    const r = cron("25:00", "true");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("hour out of range");
  });
});
