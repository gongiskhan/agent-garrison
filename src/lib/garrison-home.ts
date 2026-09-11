import fs from "node:fs/promises";
import path from "node:path";
import {
  garrisonRuntimeHome, userClaudeHome, userClaudeJsonPath,
  userCodexHome, userGeminiHome, resolvedHome, garrisonHomeRefusal
} from "./claude-home";
import { writeFileAtomic } from "./atomic-write";

export const GARRISON_HOME_README = `This directory is Garrison's own Claude Code home (CLAUDE_CONFIG_DIR for every
session Garrison starts). Skills, hooks and MCP servers here are installed by the
active composition and reconciled on every \`up\`. Do not edit by hand; edit the
composition. Your own Claude Code config is untouched at ~/.claude, except for
fittings you marked Shared.
`;

const ONBOARDING_KEYS = [
  "hasCompletedOnboarding", "installMethod", "autoUpdates", "userID",
  "firstStartTime", "hasTrustDialogAccepted", "bypassPermissionsModeAccepted",
  "theme", "numStartups"
] as const;

async function lstat(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Materialise only runtime credentials and initial onboarding, never user settings. */
export async function ensureGarrisonHome({ runtime, accountPinned = false, log = console.info }: {
  runtime: "claude" | "codex" | "gemini";
  accountPinned?: boolean;
  log?: (message: string) => void;
}): Promise<{ home: string; credentialsLinked: boolean; seeded: boolean }> {
  const home = garrisonRuntimeHome(runtime);
  const user = runtime === "claude" ? userClaudeHome() : runtime === "codex" ? userCodexHome() : userGeminiHome();
  if (resolvedHome(home) === resolvedHome(user)) throw new Error(garrisonHomeRefusal());
  const name = runtime === "claude" ? ".credentials.json" : runtime === "codex" ? "auth.json" : "oauth_creds.json";
  const source = path.join(user, name);
  const destination = path.join(home, name);
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  let credentialsLinked = false;
  if (!accountPinned && await lstat(source)) {
    const current = await lstat(destination);
    if (current && !current.isSymbolicLink()) {
      log(`Garrison home: leaving existing credentials file at ${destination}`);
    } else {
      const target = current ? path.resolve(path.dirname(destination), await fs.readlink(destination)) : null;
      if (target !== path.resolve(source)) {
        if (current) await fs.unlink(destination);
        await fs.symlink(source, destination);
      }
      credentialsLinked = true;
    }
  }
  let seeded = false;
  if (runtime === "claude") {
    const config = path.join(home, ".claude.json");
    if (!await lstat(config)) {
      let original: Record<string, unknown> = {};
      try { original = JSON.parse(await fs.readFile(userClaudeJsonPath(), "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const seed = Object.fromEntries(ONBOARDING_KEYS.filter(key => Object.hasOwn(original, key)).map(key => [key, original[key]]));
      try {
        await fs.writeFile(config, JSON.stringify(seed, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        seeded = true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    await writeFileAtomic(path.join(home, "README.md"), GARRISON_HOME_README);
  }
  return { home, credentialsLinked, seeded };
}
