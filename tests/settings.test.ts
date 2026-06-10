import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSettingsView, reloadSettingsView, writeSettingsPatch, computeSettingsDrift, KNOWN_SETTINGS } from "@/lib/settings";
import { settingsPath } from "@/lib/claude-settings-file";

let home: string;
let garrison: string;
let prevGarrisonHome: string | undefined;

// Genuinely bespoke keys: NOT in the official schema, so they must surface in
// the Advanced passthrough and round-trip by value. (autoMode used to sit here
// until the schema adopted it — it is a known object-form key now.)
const BESPOKE = {
  advisorModel: "opus",
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
    expect(unknownKeys).toEqual(["advisorModel", "autoDreamEnabled", "remoteControlAtStartup"]);
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
    expect(disk.autoDreamEnabled).toBe(true);
    expect(disk.remoteControlAtStartup).toBe(true);
  });

  it("schema-dropped keys (editorMode, autoScrollEnabled) fall to the passthrough with zero data loss", async () => {
    // These two were in Garrison's old hand-picked catalog but are NOT in the
    // official schema — dropping them from the typed catalog must demote them
    // to the Advanced passthrough, never lose them.
    seed({ editorMode: "vim", autoScrollEnabled: false, cleanupPeriodDays: 365 });
    const view = await readSettingsView(home);
    expect(view.known.find((k) => k.key === "editorMode")).toBeUndefined();
    const unknownKeys = view.unknown.map((u) => u.key).sort();
    expect(unknownKeys).toEqual(["autoScrollEnabled", "editorMode"]);

    await writeSettingsPatch({ cleanupPeriodDays: 30 }, home);
    expect(onDisk().editorMode).toBe("vim");
    expect(onDisk().autoScrollEnabled).toBe(false);
  });

  it("a whole-object patch (sandbox) replaces only that key and preserves sibling bespoke keys", async () => {
    // Object-form editors assemble the WHOLE top-level object and queue
    // { sandbox: ... } — exactly the JSON-control semantics. Siblings,
    // documented or bespoke, must survive untouched.
    seed({ sandbox: { enabled: false }, cleanupPeriodDays: 365, ...BESPOKE });
    await readSettingsView(home);
    await writeSettingsPatch(
      { sandbox: { enabled: true, excludedCommands: ["docker"], someFutureSubkey: 1 } },
      home
    );
    const disk = onDisk();
    expect(disk.sandbox).toEqual({ enabled: true, excludedCommands: ["docker"], someFutureSubkey: 1 });
    expect(disk.cleanupPeriodDays).toBe(365);
    expect(disk.advisorModel).toBe("opus");
    expect(disk.autoDreamEnabled).toBe(true);
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

  it("'reload from disk' clears drift by advancing the baseline (bug fix)", async () => {
    seed({ cleanupPeriodDays: 365, ...BESPOKE });
    await readSettingsView(home); // baseline
    // external edit -> drift surfaces
    fs.writeFileSync(settingsPath(home), JSON.stringify({ cleanupPeriodDays: 365, model: "x", ...BESPOKE }));
    expect((await readSettingsView(home)).drift.changedExternally).toBe(true);
    // a plain re-read must NOT clear it (baseline intentionally not advanced)
    expect((await readSettingsView(home)).drift.changedExternally).toBe(true);
    // reloadSettingsView advances the baseline -> drift clears AND shows disk values
    const reloaded = await reloadSettingsView(home);
    expect(reloaded.drift.changedExternally).toBe(false);
    expect(reloaded.known.find((k) => k.key === "model")?.value).toBe("x");
    // and it stays cleared on the next read
    expect((await readSettingsView(home)).drift.changedExternally).toBe(false);
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

describe("computeSettingsDrift (read-only drift poll)", () => {
  it("returns false with no baseline yet and never WRITES one (no side effect)", async () => {
    seed({ cleanupPeriodDays: 365, ...BESPOKE });
    const drift = await computeSettingsDrift(home);
    expect(drift.changedExternally).toBe(false);
    expect(drift.lastSeenAt).toBeNull();
    // polling must not establish a baseline (that's readSettingsView's job)
    expect(fs.existsSync(path.join(garrison, "claude-settings.last-seen.json"))).toBe(false);
  });

  it("flags an external edit once a baseline exists, value-compared not byte-compared", async () => {
    const value = { cleanupPeriodDays: 365, ...BESPOKE };
    seed(value);
    await readSettingsView(home); // establishes baseline
    expect((await computeSettingsDrift(home)).changedExternally).toBe(false);
    // pure reformat, identical values -> still no drift
    fs.writeFileSync(settingsPath(home), JSON.stringify(value, null, 2));
    expect((await computeSettingsDrift(home)).changedExternally).toBe(false);
    // a real external value change -> drift
    fs.writeFileSync(settingsPath(home), JSON.stringify({ ...value, model: "x" }));
    expect((await computeSettingsDrift(home)).changedExternally).toBe(true);
  });

  it("does not flag Garrison's own autosave as drift", async () => {
    seed({ cleanupPeriodDays: 365, ...BESPOKE });
    await readSettingsView(home);
    await writeSettingsPatch({ cleanupPeriodDays: 30 }, home); // our own write refreshes baseline
    expect((await computeSettingsDrift(home)).changedExternally).toBe(false);
  });
});
