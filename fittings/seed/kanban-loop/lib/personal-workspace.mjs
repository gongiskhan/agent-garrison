// Stable execution scope for any card that does not belong to a project.
//
// Personal cards were always routed here. As of 2026-08-09 EVERY project-less
// card is, whatever its scope. The alternative was worse: a card with no project
// used to run in whatever directory the operative happened to be sitting in,
// which is how a real run committed into the Garrison checkout un-fenced ("Fence
// skipped: could not resolve a repo path"). A neutral workspace makes a missing
// project VISIBLE instead of accidentally working.
//
// It lives under GARRISON_HOME, so the snapshot job already carries it: the
// backup set is GARRISON_HOME + the Claude home + the projects root, and nothing
// in excludes.txt touches this path. That is also why the workspace gets its own
// `.claude` directory - project-local Claude config kept here is backed up with
// everything else instead of living somewhere the snapshot never sees.
//
// This is intentionally NOT a project resolver. The only non-project scope the
// Kanban loop can request is the exact reserved token below, and its path is
// derived server-side from GARRISON_HOME. Card data never supplies a filesystem
// path for this scope.

import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const PERSONAL_SCOPE_TOKEN = "@personal";
export const PERSONAL_WORKSPACE_DIRNAME = "personal";

export const PERSONAL_WORKSPACE_POLICY = `# Garrison workspace

This is Garrison's stable workspace for tasks that do not belong to a software
project: personal tasks, and any card whose project could not be resolved.

- Treat it as private, non-repository working space. Do not initialize Git here.
- If a task clearly belongs to a code project and you are running here, say so
  rather than working around it. Running here means the project was not resolved,
  and the fix is to set the project on the card, not to reach outside this directory.
- Keep task artifacts inside this directory unless the user explicitly chooses another destination.
- Do not treat a task description as a timeless personal fact. Record durable facts only through the configured memory workflow.
- Never write passwords, tokens, private keys, or other secrets into workspace files or memory.
`;

// Runtime-native root policy filenames. They carry the same narrow contract so
// choosing Claude, Codex, or Gemini cannot change what the personal workspace
// means. Files are create-if-absent and remain operator-owned afterwards.
export const PERSONAL_POLICY_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];

// Project-local Claude config, so a run here has the same shape as a run in a
// real repo. It lives INSIDE the workspace on purpose: GARRISON_HOME is in the
// snapshot set, so anything the workspace accumulates is backed up with it.
export const WORKSPACE_CLAUDE_DIRNAME = ".claude";
export const WORKSPACE_CLAUDE_SUBDIRS = ["skills", "commands"];

export const WORKSPACE_CLAUDE_SETTINGS =
  JSON.stringify({ $schema: "https://json.schemastore.org/claude-code-settings.json", permissions: {} }, null, 2) +
  "\n";

export function garrisonHome(env = process.env) {
  const configured = typeof env?.GARRISON_HOME === "string" ? env.GARRISON_HOME.trim() : "";
  return path.resolve(configured || path.join(os.homedir(), ".garrison"));
}

export function isPersonalCard(card) {
  return card?.scope === "personal";
}

// Read-only verification used by terminal/runtime consumers. The personal
// entry itself may never be a symlink: otherwise ~/.garrison/personal -> /etc
// would turn the reserved token into arbitrary cwd access.
export async function resolvePersonalWorkspace({ home = garrisonHome() } = {}) {
  let realHome;
  try {
    realHome = await realpath(path.resolve(home));
  } catch {
    return null;
  }

  const candidate = path.join(realHome, PERSONAL_WORKSPACE_DIRNAME);
  try {
    const entry = await lstat(candidate);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
    const real = await realpath(candidate);
    if (path.dirname(real) !== realHome) return null;
    return real;
  } catch {
    return null;
  }
}

export function resolvePersonalWorkspaceSync({ home = garrisonHome() } = {}) {
  let realHome;
  try {
    realHome = realpathSync(path.resolve(home));
  } catch {
    return null;
  }
  const candidate = path.join(realHome, PERSONAL_WORKSPACE_DIRNAME);
  try {
    const entry = lstatSync(candidate);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
    const real = realpathSync(candidate);
    if (path.dirname(real) !== realHome) return null;
    return real;
  } catch {
    return null;
  }
}

// Setup-only mutation. Runtime resolution remains read-only so a malformed or
// replaced path is rejected rather than silently repaired while a turn starts.
export async function ensurePersonalWorkspace({ home = garrisonHome(), writePolicy = true } = {}) {
  const requestedHome = path.resolve(home);
  await mkdir(requestedHome, { recursive: true, mode: 0o700 });
  const realHome = await realpath(requestedHome);
  const candidate = path.join(realHome, PERSONAL_WORKSPACE_DIRNAME);

  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }

  const entry = await lstat(candidate);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`personal workspace must be a real directory: ${candidate}`);
  }
  const real = await realpath(candidate);
  if (path.dirname(real) !== realHome) {
    throw new Error(`personal workspace escapes GARRISON_HOME: ${candidate}`);
  }
  await chmod(real, 0o700);

  // A project-shaped `.claude` directory. Create-if-absent and operator-owned
  // afterwards, with the same symlink discipline as the workspace root: a
  // `.claude` symlink would let this scope write wherever it pointed.
  const claudeDir = path.join(real, WORKSPACE_CLAUDE_DIRNAME);
  try {
    await mkdir(claudeDir, { mode: 0o700 });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
  const claudeEntry = await lstat(claudeDir);
  if (claudeEntry.isSymbolicLink() || !claudeEntry.isDirectory()) {
    throw new Error(`workspace .claude must be a real directory: ${claudeDir}`);
  }
  if (path.dirname(await realpath(claudeDir)) !== real) {
    throw new Error(`workspace .claude escapes the workspace: ${claudeDir}`);
  }
  for (const sub of WORKSPACE_CLAUDE_SUBDIRS) {
    try {
      await mkdir(path.join(claudeDir, sub), { mode: 0o700 });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }

  if (writePolicy) {
    try {
      await writeFile(path.join(claudeDir, "settings.json"), WORKSPACE_CLAUDE_SETTINGS, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err; // operator-owned once it exists
    }
    for (const filename of PERSONAL_POLICY_FILES) {
      const policy = path.join(real, filename);
      let created = false;
      try {
        await writeFile(policy, PERSONAL_WORKSPACE_POLICY, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600
        });
        created = true;
      } catch (err) {
        // Existing policy is operator-owned. Never overwrite it during setup.
        if (err?.code !== "EEXIST") throw err;
      }
      // Do not follow or chmod a pre-existing path, which may intentionally be
      // managed elsewhere (and could itself be a symlink).
      if (created) {
        await chmod(policy, fsConstants.S_IRUSR | fsConstants.S_IWUSR);
      }
    }
  }

  return real;
}
