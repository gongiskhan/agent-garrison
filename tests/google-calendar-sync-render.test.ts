import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(
  REPO_ROOT,
  "fittings/seed/google-calendar/scripts/calendar.py"
);
const FIXTURE_DIR = path.join(REPO_ROOT, "tests/fixtures/google-calendar");

function render(fixture: string): string {
  const fixturePath = path.join(FIXTURE_DIR, fixture);
  const result = spawnSync(
    "python3",
    [SCRIPT, "--render-fixture", fixturePath],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `python3 calendar.py --render-fixture ${fixture} exited ${result.status}\n${result.stderr}`
    );
  }
  return result.stdout;
}

describe("google-calendar sync renderer", () => {
  it("source files exist", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    expect(existsSync(FIXTURE_DIR)).toBe(true);
  });

  it("renders an empty fixture as (no events) for both today and tomorrow", () => {
    const md = render("empty.json");
    expect(md).toContain("# Calendar — synced 2026-05-08 09:00 UTC");
    expect(md).toContain("## Today (Friday, 2026-05-08)");
    expect(md).toContain("## Tomorrow (Saturday, 2026-05-09)");
    const noEventsMatches = md.match(/\(no events\)/g) ?? [];
    expect(noEventsMatches.length).toBe(2);
    expect(md).toContain("## Next 5 days");
    expect(md).toContain("(empty)");
  });

  it("renders all-day events with the (all day) prefix", () => {
    const md = render("all-day.json");
    expect(md).toContain("- (all day) — Public holiday");
    expect(md).not.toContain("00:00–");
  });

  it("renders multi-day events on each day they cover, with edge clipping", () => {
    const md = render("multi-day.json");
    const today = md.split("## Tomorrow")[0];
    const tomorrow = md.split("## Tomorrow")[1].split("## Next 5 days")[0];
    expect(today).toContain("15:00–23:59 — Conference (Lisbon)");
    expect(tomorrow).toContain("00:00–18:00 — Conference (Lisbon)");
  });

  it("omits the location suffix when an event has no location", () => {
    const md = render("no-location.json");
    expect(md).toContain("- 09:00–09:30 — Standup\n");
    expect(md).toContain("- 12:00–13:00 — Lunch with M.\n");
    expect(md).not.toMatch(/Standup \(/);
    expect(md).not.toMatch(/Lunch with M\. \(/);
  });
});
