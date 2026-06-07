import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSettingsRaw,
  writeSettingsMerged,
  settingsPath,
  upsertGarrisonHookGroup,
  stripGarrisonGroupsForOwner,
  listGarrisonHookOwners,
  type SettingsObject
} from "@/lib/claude-settings-file";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gar-settings-file-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function seed(obj: unknown): void {
  fs.writeFileSync(settingsPath(home), JSON.stringify(obj));
}
function onDisk(): SettingsObject {
  return JSON.parse(fs.readFileSync(settingsPath(home), "utf8"));
}

describe("claude-settings-file writer", () => {
  it("creates the file on first write and preserves unknown keys", async () => {
    seed({ advisorModel: "opus", autoMode: { environment: ["x"] } });
    await writeSettingsMerged((d) => {
      d.cleanupPeriodDays = 30;
    }, home);
    const disk = onDisk();
    expect(disk.cleanupPeriodDays).toBe(30);
    expect(disk.advisorModel).toBe("opus");
    expect(disk.autoMode).toEqual({ environment: ["x"] });
  });

  it("reads FRESH on every write — never serialises a stale copy", async () => {
    seed({ a: 1 });
    await writeSettingsMerged((d) => {
      d.b = 2;
    }, home);
    expect(onDisk()).toEqual({ a: 1, b: 2 });

    // Simulate Claude Code rewriting the file between Garrison's writes:
    // it removes `b`, adds `c`. Garrison's NEXT merged write must build on the
    // current on-disk state, not a remembered snapshot.
    fs.writeFileSync(settingsPath(home), JSON.stringify({ a: 1, c: 3 }));
    await writeSettingsMerged((d) => {
      d.d = 4;
    }, home);
    expect(onDisk()).toEqual({ a: 1, c: 3, d: 4 });
  });

  it("returns {} json when the file is missing", async () => {
    const r = await readSettingsRaw(home);
    expect(r.exists).toBe(false);
    expect(r.json).toEqual({});
  });

  it("upserts an owner-tagged hook group and is idempotent per owner+event", async () => {
    const draft: SettingsObject = {};
    upsertGarrisonHookGroup(draft, "SessionStart", { hooks: [{ type: "command", command: "a" }] }, "fitting:memory");
    upsertGarrisonHookGroup(draft, "SessionStart", { hooks: [{ type: "command", command: "a2" }] }, "fitting:memory");
    const groups = (draft.hooks as Record<string, unknown[]>).SessionStart;
    expect(groups).toHaveLength(1); // replaced, not duplicated
    expect((groups[0] as Record<string, unknown>)._garrison).toBe("fitting:memory");
  });

  it("strips ONLY the named owner's groups, leaving others + hand-authored intact", async () => {
    const draft: SettingsObject = {};
    upsertGarrisonHookGroup(draft, "Stop", { hooks: [{ type: "command", command: "m" }] }, "fitting:memory");
    upsertGarrisonHookGroup(draft, "Stop", { hooks: [{ type: "command", command: "s" }] }, "fitting:session-view");
    // a hand-authored, untagged group
    (draft.hooks as Record<string, unknown[]>).Stop.push({ hooks: [{ type: "command", command: "user" }] });

    const removed = stripGarrisonGroupsForOwner(draft, "fitting:memory");
    expect(removed).toBe(true);
    const remaining = (draft.hooks as Record<string, unknown[]>).Stop as Record<string, unknown>[];
    expect(remaining).toHaveLength(2);
    expect(remaining.some((g) => g._garrison === "fitting:session-view")).toBe(true);
    expect(remaining.some((g) => g._garrison === undefined)).toBe(true); // hand-authored survives
    expect(remaining.some((g) => g._garrison === "fitting:memory")).toBe(false);
  });

  it("lists distinct hook owners (including legacy bare marker)", async () => {
    const draft: SettingsObject = {
      hooks: {
        Stop: [
          { _garrison: "fitting:a", hooks: [] },
          { _garrison: true, hooks: [] },
          { hooks: [] }
        ]
      }
    };
    expect(listGarrisonHookOwners(draft)).toEqual(["fitting:a", "legacy:_garrison"]);
  });
});
