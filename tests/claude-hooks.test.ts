import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hooksAreInstalled,
  installHooks,
  restoreHooks
} from "@/lib/claude-hooks";

let tmpDir: string;
let settingsPath: string;
let snapshotPath: string;
let metaPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-garrison-hooks-"));
  settingsPath = path.join(tmpDir, "settings.json");
  snapshotPath = path.join(tmpDir, "hooks-snapshot.bytes");
  metaPath = path.join(tmpDir, "hooks-snapshot.meta.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("installHooks", () => {
  it("creates settings.json with 4 hook events when none existed", async () => {
    await installHooks({
      hookUrl: "http://127.0.0.1:3000/hook",
      settingsPath,
      snapshotPath,
      snapshotMetaPath: metaPath
    });
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Notification).toHaveLength(1);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.UserPromptSubmit[0]._garrison).toBe(true);
    expect(parsed.hooks.UserPromptSubmit[0].hooks[0].command).toContain(
      "http://127.0.0.1:3000/hook"
    );
  });

  it("preserves the user's existing settings when merging", async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          theme: "dark",
          hooks: {
            PreToolUse: [
              { matcher: "*", hooks: [{ type: "command", command: "echo pre" }] }
            ]
          }
        },
        null,
        2
      )
    );
    await installHooks({
      hookUrl: "http://127.0.0.1:3000/hook",
      settingsPath,
      snapshotPath,
      snapshotMetaPath: metaPath
    });
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe("echo pre");
    expect(parsed.hooks.UserPromptSubmit[0]._garrison).toBe(true);
  });

  it("is idempotent — does not add duplicate _garrison groups on repeat runs", async () => {
    await installHooks({
      hookUrl: "http://127.0.0.1:3000/hook",
      settingsPath,
      snapshotPath,
      snapshotMetaPath: metaPath
    });
    await installHooks({
      hookUrl: "http://127.0.0.1:3000/hook",
      settingsPath,
      snapshotPath,
      snapshotMetaPath: metaPath
    });
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    for (const event of ["UserPromptSubmit", "Stop", "Notification", "PostToolUse"]) {
      const groups = parsed.hooks[event] as Array<{ _garrison?: boolean }>;
      const garrisonGroups = groups.filter((g) => g._garrison);
      expect(garrisonGroups).toHaveLength(1);
    }
  });
});

describe("hooksAreInstalled", () => {
  it("returns false when settings.json is missing", () => {
    expect(hooksAreInstalled(settingsPath)).toBe(false);
  });

  it("returns false when settings.json has no Garrison groups", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
    expect(hooksAreInstalled(settingsPath)).toBe(false);
  });

  it("returns true after installHooks runs", async () => {
    await installHooks({
      hookUrl: "http://127.0.0.1:3000/hook",
      settingsPath,
      snapshotPath,
      snapshotMetaPath: metaPath
    });
    expect(hooksAreInstalled(settingsPath)).toBe(true);
  });
});

describe("restoreHooks", () => {
  it("restores the original settings file after install", async () => {
    const original = { theme: "dark", hooks: {} };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));
    await installHooks({
      hookUrl: "http://127.0.0.1:3000/hook",
      settingsPath,
      snapshotPath,
      snapshotMetaPath: metaPath
    });
    await restoreHooks({ snapshotPath, snapshotMetaPath: metaPath });
    const restored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(restored).toEqual(original);
  });

  it("removes settings.json entirely if it didn't exist before install", async () => {
    await installHooks({
      hookUrl: "http://127.0.0.1:3000/hook",
      settingsPath,
      snapshotPath,
      snapshotMetaPath: metaPath
    });
    await restoreHooks({ snapshotPath, snapshotMetaPath: metaPath });
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it("is a no-op when there is no snapshot", async () => {
    await expect(
      restoreHooks({ snapshotPath, snapshotMetaPath: metaPath })
    ).resolves.toBeUndefined();
  });
});
