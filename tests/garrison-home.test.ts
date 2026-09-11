import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ensureGarrisonHome, GARRISON_HOME_README } from "../src/lib/garrison-home";
import { assertGarrisonHome, garrisonRuntimeHome } from "../src/lib/claude-home";

let root: string;
let user: string;
let runtime: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-two-homes-"));
  user = path.join(root, "user/.claude");
  runtime = path.join(root, "garrison/runtime-homes/claude");
  for (const [key, value] of Object.entries({
    HOME: path.join(root, "user"), GARRISON_HOME: path.join(root, "garrison"),
    GARRISON_CLAUDE_HOME: runtime, GARRISON_CLAUDE_JSON: path.join(runtime, ".claude.json"),
    GARRISON_USER_CLAUDE_HOME: user, GARRISON_USER_CLAUDE_JSON: path.join(root, "user/.claude.json"),
    GARRISON_USER_CODEX_HOME: path.join(root, "user/.codex"),
    GARRISON_USER_GEMINI_HOME: path.join(root, "user/.gemini")
  })) vi.stubEnv(key, value);
  await fs.mkdir(user, { recursive: true });
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

it("links credentials, seeds only onboarding/trust keys with private permissions and writes the exact README", async () => {
  await fs.writeFile(path.join(user, ".credentials.json"), "fixture credential");
  await fs.writeFile(process.env.GARRISON_USER_CLAUDE_JSON!, JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", userID: "fixture-user", projects: { secret: true }, oauthToken: "excluded" }));
  const result = await ensureGarrisonHome({ runtime: "claude" });
  expect(result).toEqual({ home: runtime, credentialsLinked: true, seeded: true });
  expect(await fs.readlink(path.join(runtime, ".credentials.json"))).toBe(path.join(user, ".credentials.json"));
  const config = path.join(runtime, ".claude.json");
  expect(JSON.parse(await fs.readFile(config, "utf8"))).toEqual({ hasCompletedOnboarding: true, theme: "dark", userID: "fixture-user" });
  expect((await fs.stat(config)).mode & 0o777).toBe(0o600);
  expect(await fs.readFile(path.join(runtime, "README.md"), "utf8")).toBe(GARRISON_HOME_README);
  await fs.writeFile(config, '{"theme":"light"}\n');
  expect((await ensureGarrisonHome({ runtime: "claude" })).seeded).toBe(false);
  expect(await fs.readFile(config, "utf8")).toBe('{"theme":"light"}\n');
});
it("does not invent credentials when the user has none", async () => {
  expect(await ensureGarrisonHome({ runtime: "claude" })).toMatchObject({ credentialsLinked: false, seeded: true });
  await expect(fs.lstat(path.join(runtime, ".credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("repoints a stale credentials link without touching either credential source", async () => {
  await fs.mkdir(runtime, { recursive: true });
  const old = path.join(root, "old-credential");
  await fs.writeFile(old, "old");
  await fs.writeFile(path.join(user, ".credentials.json"), "new");
  await fs.symlink(old, path.join(runtime, ".credentials.json"));
  expect((await ensureGarrisonHome({ runtime: "claude" })).credentialsLinked).toBe(true);
  expect(await fs.readFile(old, "utf8")).toBe("old");
  expect(await fs.readFile(path.join(runtime, ".credentials.json"), "utf8")).toBe("new");
});
it("leaves a regular runtime credential file alone and logs its presence", async () => {
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(runtime, ".credentials.json"), "runtime-owned");
  await fs.writeFile(path.join(user, ".credentials.json"), "user-owned");
  const log = vi.fn();
  expect((await ensureGarrisonHome({ runtime: "claude", log })).credentialsLinked).toBe(false);
  expect(await fs.readFile(path.join(runtime, ".credentials.json"), "utf8")).toBe("runtime-owned");
  expect(log).toHaveBeenCalledWith(expect.stringContaining("leaving existing credentials file"));
});
it("does not link the machine credential when an account is pinned", async () => {
  await fs.writeFile(path.join(user, ".credentials.json"), "fixture");
  expect((await ensureGarrisonHome({ runtime: "claude", accountPinned: true })).credentialsLinked).toBe(false);
  await expect(fs.lstat(path.join(runtime, ".credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it.each([['codex', '.codex', 'auth.json'], ['gemini', '.gemini', 'oauth_creds.json']] as const)("links only the %s auth file", async (engine, userDir, name) => {
  const source = path.join(root, "user", userDir, name);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, "fixture");
  const result = await ensureGarrisonHome({ runtime: engine });
  expect(result).toEqual({ home: garrisonRuntimeHome(engine), credentialsLinked: true, seeded: false });
  expect(await fs.readdir(result.home)).toEqual([name]);
  expect(await fs.readlink(path.join(result.home, name))).toBe(source);
});
it("refuses direct and symlinked aliases of the user's config before writing", async () => {
  vi.stubEnv("GARRISON_CLAUDE_HOME", user);
  expect(assertGarrisonHome).toThrow("refusing to run Garrison against your own Claude Code config");
  await expect(ensureGarrisonHome({ runtime: "claude" })).rejects.toThrow("refusing to run Garrison");
  const alias = path.join(root, "alias");
  await fs.symlink(user, alias);
  vi.stubEnv("GARRISON_CLAUDE_HOME", alias);
  expect(assertGarrisonHome).toThrow("refusing to run Garrison");
  expect(await fs.readdir(user)).toEqual([]);
});
it("replaces an owned README symlink without changing its target", async () => {
  await fs.mkdir(runtime, { recursive: true });
  const source = path.join(root, "user-notes.md");
  await fs.writeFile(source, "mine");
  await fs.symlink(source, path.join(runtime, "README.md"));
  await ensureGarrisonHome({ runtime: "claude" });
  expect(await fs.readFile(source, "utf8")).toBe("mine");
  expect((await fs.lstat(path.join(runtime, "README.md"))).isSymbolicLink()).toBe(false);
});
