import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSettingsView, writeSettingsPatch, KNOWN_SETTINGS } from "@/lib/settings";
import { settingsPath } from "@/lib/claude-settings-file";

let home: string;
let garrison: string;
let prevGarrisonHome: string | undefined;

const BESPOKE = {
  advisorModel: "opus",
  autoMode: { environment: ["solo dev", "ggomes"] },
  autoDreamEnabled: true,
  remoteControlAtStartup: true
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gar-settings-home-"));
  garrison = fs.mkdtempSync(path.join(os.tmpdir(), "gar-settings-garr-"));
  prevGarrisonHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = garrison; // redirect last-seen baseline
});
afterEach(() => {
  if (prevGarrisonHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevGarrisonHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(garrison, { recursive: true, force: true });
});

function seed(obj: unknown): void {
  fs.writeFileSync(settingsPath(home), JSON.stringify(obj));
}
function onDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath(home), "utf8"));
}

describe("settings view + patch", () => {
  it("splits documented keys (typed) from bespoke keys (passthrough)", async () => {
    seed({ cleanupPeriodDays: 365, model: "claude-sonnet-4-6", ...BESPOKE });
    const view = await readSettingsView(home);

    const cleanup = view.known.find((k) => k.key === "cleanupPeriodDays");
    expect(cleanup?.present).toBe(true);
    expect(cleanup?.value).toBe(365);
    expect(cleanup?.control).toBe("number");

    const unknownKeys = view.unknown.map((u) => u.key).sort();
    expect(unknownKeys).toEqual(["advisorModel", "autoDreamEnabled", "autoMode", "remoteControlAtStartup"]);
    // every KNOWN_SETTINGS descriptor is rendered, even when absent from the file
    expect(view.known).toHaveLength(KNOWN_SETTINGS.length);
  });

  it("patches only the changed key and preserves bespoke keys by VALUE", async () => {
    seed({ cleanupPeriodDays: 365, ...BESPOKE });
    await readSettingsView(home); // establish baseline
    await writeSettingsPatch({ cleanupPeriodDays: 30 }, home);

    const disk = onDisk();
    expect(disk.cleanupPeriodDays).toBe(30);
    // bespoke keys round-trip by value (formatting is normalised — not byte-equal)
    expect(disk.advisorModel).toBe("opus");
    expect(disk.autoMode).toEqual(BESPOKE.autoMode);
    expect(disk.autoDreamEnabled).toBe(true);
    expect(disk.remoteControlAtStartup).toBe(true);
  });

  it("does NOT flag the writer's own save as external drift", async () => {
    seed({ cleanupPeriodDays: 365, ...BESPOKE });
    await readSettingsView(home);
    const after = await writeSettingsPatch({ cleanupPeriodDays: 30 }, home);
    expect(after.drift.changedExternally).toBe(false);
    const reopened = await readSettingsView(home);
    expect(reopened.drift.changedExternally).toBe(false);
  });

  it("flags an EXTERNAL edit as drift (parsed-value compare, not bytes)", async () => {
    seed({ cleanupPeriodDays: 365, ...BESPOKE });
    await readSettingsView(home); // baseline
    // Claude Code rewrites the file with a real value change
    fs.writeFileSync(settingsPath(home), JSON.stringify({ cleanupPeriodDays: 365, model: "x", ...BESPOKE }));
    const view = await readSettingsView(home);
    expect(view.drift.changedExternally).toBe(true);
  });

  it("does not flag drift on a pure reformat with identical values", async () => {
    const value = { cleanupPeriodDays: 365, ...BESPOKE };
    seed(value);
    await readSettingsView(home); // baseline from compact JSON
    // rewrite same values, pretty-printed (Claude Code reformat)
    fs.writeFileSync(settingsPath(home), JSON.stringify(value, null, 2));
    const view = await readSettingsView(home);
    expect(view.drift.changedExternally).toBe(false);
  });

  it("removes a key when patched with undefined", async () => {
    seed({ cleanupPeriodDays: 365, advisorModel: "opus" });
    await readSettingsView(home);
    await writeSettingsPatch({ advisorModel: undefined }, home);
    expect(Object.prototype.hasOwnProperty.call(onDisk(), "advisorModel")).toBe(false);
    expect(onDisk().cleanupPeriodDays).toBe(365);
  });

  it("creates settings.json when none exists", async () => {
    const view = await readSettingsView(home);
    expect(view.exists).toBe(false);
    await writeSettingsPatch({ cleanupPeriodDays: 14 }, home);
    expect(onDisk()).toEqual({ cleanupPeriodDays: 14 });
  });
});
