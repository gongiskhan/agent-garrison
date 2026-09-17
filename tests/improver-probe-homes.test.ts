import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it("redeploy's GARRISON_HOME-only invocation installs core probes in the managed home and preserves native settings", () => {
  const root = mkdtempSync(path.join(tmpdir(), "improver-homes-")); roots.push(root);
  const home = path.join(root, ".garrison");
  const userSettings = path.join(root, ".claude", "settings.json");
  mkdirSync(path.dirname(userSettings), { recursive: true });
  const native = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user-hook" }] }] } });
  writeFileSync(userSettings, native);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, GARRISON_HOME: home };
  delete env.GARRISON_CLAUDE_HOME;
  delete env.GARRISON_CLAUDE_SETTINGS_PATH;
  const installer = path.resolve("packages/improver/probes/install-probe-hooks.mjs");
  execFileSync(process.execPath, [installer], { env });
  execFileSync(process.execPath, [installer], { env });
  expect(readFileSync(userSettings, "utf8")).toBe(native);
  const managed = JSON.parse(readFileSync(path.join(home, "runtime-homes", "claude", "settings.json"), "utf8"));
  for (const event of ["Stop", "PostToolUse"]) {
    expect(managed.hooks[event].filter((row: { _garrison?: string }) => row._garrison === "core:improver-probe")).toHaveLength(1);
  }
});
