import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isInstalled,
  assertClaudeWritable,
  getInstallStatus,
  install,
  disable,
  backupNow,
  installStatePath,
  NotInstalledError
} from "@/lib/install-state";
import { globalCompositionDir } from "@/lib/claude-home";
import { writeSettingsMerged } from "@/lib/claude-settings-file";
import { addMcpServer } from "@/lib/mcp-writer";
import { createFilePrimitive } from "@/lib/primitive-files";

// This file exercises the REAL install gate, so it opts OUT of the global test
// bypass (tests/setup.ts sets GARRISON_ASSUME_INSTALLED=1). Homes are sandboxed
// via env; HOME is redirected too so the config backup does not read the real
// user's ~/.codex / ~/.gemini.

let base: string;
let claudeHome: string;
let garrisonHome: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "gar-install-state-"));
  claudeHome = path.join(base, ".claude");
  garrisonHome = path.join(base, ".garrison");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(garrisonHome, { recursive: true });
  for (const k of ["GARRISON_CLAUDE_HOME", "GARRISON_HOME", "GARRISON_ASSUME_INSTALLED", "HOME"]) {
    saved[k] = process.env[k];
  }
  process.env.GARRISON_CLAUDE_HOME = claudeHome;
  process.env.GARRISON_HOME = garrisonHome;
  process.env.HOME = base;
  delete process.env.GARRISON_ASSUME_INSTALLED;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describe("install gate", () => {
  it("a fresh machine with no evidence is NOT installed and refuses every write", async () => {
    expect(await isInstalled()).toBe(false);
    await expect(assertClaudeWritable("test")).rejects.toBeInstanceOf(NotInstalledError);

    // Each real writer chokepoint refuses.
    await expect(writeSettingsMerged((d) => { d.model = "x"; }, claudeHome)).rejects.toBeInstanceOf(
      NotInstalledError
    );
    await expect(addMcpServer("foo", { command: "echo" }, claudeHome)).rejects.toBeInstanceOf(
      NotInstalledError
    );
    await expect(createFilePrimitive("skill", "mine", "# hi", claudeHome)).rejects.toBeInstanceOf(
      NotInstalledError
    );

    // ...and nothing was written to ~/.claude.
    expect(fs.existsSync(path.join(claudeHome, "settings.json"))).toBe(false);
    expect(fs.existsSync(path.join(claudeHome, "mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(claudeHome, "skills", "mine"))).toBe(false);
  });

  it("NotInstalledError carries the not-installed code and the refused op", async () => {
    const err = await assertClaudeWritable("wire settings.json").then(
      () => null,
      (e) => e as NotInstalledError
    );
    expect(err).toBeInstanceOf(NotInstalledError);
    expect(err?.code).toBe("not-installed");
    expect(err?.op).toBe("wire settings.json");
  });

  it("grandfathers a box that already has a global-composition dir (predates the gate)", async () => {
    fs.mkdirSync(globalCompositionDir(), { recursive: true });
    expect(await isInstalled()).toBe(true);
    // A gated writer now passes.
    await writeSettingsMerged((d) => { d.model = "sonnet"; }, claudeHome);
    expect(JSON.parse(fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8")).model).toBe("sonnet");

    // getInstallStatus materialises a grandfathered record with no backup.
    const status = await getInstallStatus();
    expect(status.installed).toBe(true);
    expect(status.grandfathered).toBe(true);
    expect(status.backupDir).toBeNull();
    expect(fs.existsSync(installStatePath())).toBe(true);
  });

  it("the GARRISON_ASSUME_INSTALLED env bypass forces installed", async () => {
    expect(await isInstalled()).toBe(false);
    process.env.GARRISON_ASSUME_INSTALLED = "1";
    expect(await isInstalled()).toBe(true);
  });
});

describe("install() / disable()", () => {
  it("snapshots the pristine config, then enables management", async () => {
    // Seed a realistic pre-install ~/.claude.
    fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({ model: "opus", env: { A: "1" } }, null, 2));
    fs.writeFileSync(path.join(claudeHome, "mcp.json"), JSON.stringify({ mcpServers: { user: { command: "x" } } }, null, 2));
    fs.mkdirSync(path.join(claudeHome, "skills", "user-skill"), { recursive: true });
    fs.writeFileSync(path.join(claudeHome, "skills", "user-skill", "SKILL.md"), "# user skill\n");

    expect(await isInstalled()).toBe(false);
    const status = await install();
    expect(status.installed).toBe(true);
    expect(status.grandfathered).toBe(false);
    expect(status.backupDir).toBeTruthy();
    expect(await isInstalled()).toBe(true);

    // Backup captured the config subset + a manifest with per-file hashes.
    const dir = status.backupDir as string;
    expect(fs.existsSync(path.join(dir, "claude", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "claude", "mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "claude", "skills", "user-skill", "SKILL.md"))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest.reason).toBe("pre-install");
    const settingsEntry = manifest.entries.find((e: { rel: string }) => e.rel === "claude/settings.json");
    expect(settingsEntry.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(settingsEntry.mtimeMs).toBeGreaterThan(0);

    // Backup byte-for-byte matches the source.
    expect(fs.readFileSync(path.join(dir, "claude", "settings.json"), "utf8")).toBe(
      fs.readFileSync(path.join(claudeHome, "settings.json"), "utf8")
    );

    // A gated writer now works (management is on).
    await writeSettingsMerged((d) => { d.statusLine = { type: "command", command: "x" }; }, claudeHome);
  });

  it("is idempotent — a second install does not overwrite the first backup", async () => {
    const first = await install();
    const second = await install();
    expect(second.backupDir).toBe(first.backupDir);
  });

  it("disable() turns the gate back off and writers refuse again", async () => {
    await install();
    expect(await isInstalled()).toBe(true);
    const status = await disable();
    expect(status.installed).toBe(false);
    expect(status.disabledAt).toBeTruthy();
    expect(await isInstalled()).toBe(false);
    await expect(writeSettingsMerged((d) => { d.model = "x"; }, claudeHome)).rejects.toBeInstanceOf(
      NotInstalledError
    );
  });

  it("backupNow() snapshots on demand and records the dir on the state", async () => {
    fs.writeFileSync(path.join(claudeHome, "settings.json"), JSON.stringify({ model: "opus" }));
    fs.mkdirSync(globalCompositionDir(), { recursive: true }); // grandfathered
    await getInstallStatus(); // materialise the record
    const { dir } = await backupNow();
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);
    const status = await getInstallStatus();
    expect(status.backupDir).toBe(dir);
  });
});
