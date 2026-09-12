// A stretch is not the user's Claude Code session. These pin the two things
// that make the redirect safe: credentials must be a LIVE symlink (the CLI
// refreshes the OAuth token in place, so a copy goes stale and fails turns
// hours later), and nothing personal may be carried over.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore - pure .mjs module (single line: TS7016 lands on the closing line)
import { ensureStretchClaudeHome, realClaudeConfigDir } from "../fittings/seed/http-gateway/scripts/lib/stretch-claude-home.mjs";

let root: string;
let real: string;
let garrison: string;
let env: Record<string, string>;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "stretch-home-"));
  real = path.join(root, ".claude");
  garrison = path.join(root, ".garrison");
  mkdirSync(path.join(real, "skills", "deep-research"), { recursive: true });
  mkdirSync(path.join(real, "agents"), { recursive: true });
  mkdirSync(path.join(real, "projects", "-some-repo", "memory"), { recursive: true });
  writeFileSync(path.join(real, ".credentials.json"), '{"token":"live"}');
  writeFileSync(path.join(real, "CLAUDE.md"), "personal instructions");
  writeFileSync(path.join(real, "settings.json"), '{"hooks":{}}');
  writeFileSync(path.join(real, "projects", "-some-repo", "memory", "MEMORY.md"), "# personal memory index");
  writeFileSync(`${real}.json`, JSON.stringify({
    hasCompletedOnboarding: true, theme: "dark", numStartups: 41,
    projects: { "/private/thing": { history: ["a secret prompt"] } },
    oauthAccount: { emailAddress: "someone@example.com" },
  }));
  env = { CLAUDE_CONFIG_DIR: real, GARRISON_HOME: garrison };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stretch claude home", () => {
  it("returns a directory that is not the user's", () => {
    const dir = ensureStretchClaudeHome({ garrisonHome: garrison, env });
    expect(dir).toBe(path.join(garrison, "stretch-claude"));
    expect(dir).not.toBe(real);
  });

  it("symlinks credentials rather than copying them", () => {
    const dir = ensureStretchClaudeHome({ garrisonHome: garrison, env })!;
    const link = path.join(dir, ".credentials.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(path.join(real, ".credentials.json"));
    // A refreshed token must be visible immediately, not at the next up().
    writeFileSync(path.join(real, ".credentials.json"), '{"token":"refreshed"}');
    expect(JSON.parse(readFileSync(link, "utf8")).token).toBe("refreshed");
  });

  it("carries NOTHING personal - that is the entire point", () => {
    const dir = ensureStretchClaudeHome({ garrisonHome: garrison, env })!;
    for (const personal of ["CLAUDE.md", "settings.json", "skills", "agents", "projects", "hooks", "commands"]) {
      expect(existsSync(path.join(dir, personal)), personal).toBe(false);
    }
  });

  it("seeds the sibling state file with onboarding flags only", () => {
    const dir = ensureStretchClaudeHome({ garrisonHome: garrison, env })!;
    const seeded = JSON.parse(readFileSync(`${dir}.json`, "utf8"));
    expect(seeded.hasCompletedOnboarding).toBe(true);
    expect(seeded.theme).toBe("dark");
    // Prompt history and the account identity stay behind.
    expect(seeded.projects).toBeUndefined();
    expect(seeded.oauthAccount).toBeUndefined();
  });

  it("does not re-seed an existing state file, which is Garrison's after the first run", () => {
    const dir = ensureStretchClaudeHome({ garrisonHome: garrison, env })!;
    writeFileSync(`${dir}.json`, '{"mine":true}');
    ensureStretchClaudeHome({ garrisonHome: garrison, env });
    expect(JSON.parse(readFileSync(`${dir}.json`, "utf8")).mine).toBe(true);
  });

  it("is idempotent", () => {
    const a = ensureStretchClaudeHome({ garrisonHome: garrison, env });
    const b = ensureStretchClaudeHome({ garrisonHome: garrison, env });
    expect(a).toBe(b);
    expect(lstatSync(path.join(a!, ".credentials.json")).isSymbolicLink()).toBe(true);
  });

  it("REFUSES when there are no credentials to link, rather than breaking every stretch", () => {
    rmSync(path.join(real, ".credentials.json"));
    const events: unknown[] = [];
    expect(ensureStretchClaudeHome({ garrisonHome: garrison, env, log: (e: unknown) => events.push(e) })).toBeNull();
    expect(JSON.stringify(events)).toContain("no credentials");
  });

  it("repairs a link that points at the wrong place", () => {
    const dir = ensureStretchClaudeHome({ garrisonHome: garrison, env })!;
    writeFileSync(path.join(dir, ".credentials.json"), "a stale COPY");
    ensureStretchClaudeHome({ garrisonHome: garrison, env });
    expect(lstatSync(path.join(dir, ".credentials.json")).isSymbolicLink()).toBe(true);
  });

  it("resolves the user's dir from the environment the gateway actually has", () => {
    expect(realClaudeConfigDir({ CLAUDE_CONFIG_DIR: "/x" })).toBe("/x");
    expect(realClaudeConfigDir({ GARRISON_CLAUDE_HOME: "/y" })).toBe("/y");
    expect(realClaudeConfigDir({})).toBe(path.join(os.homedir(), ".claude"));
  });
});
