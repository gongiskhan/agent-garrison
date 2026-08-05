// Stable execution scope for personal cards that do not belong to a project.
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

export const PERSONAL_WORKSPACE_POLICY = `# Personal workspace

This is Garrison's stable workspace for personal tasks that do not belong to a software project.

- Treat it as private, non-repository working space. Do not initialize Git here.
- Keep task artifacts inside this directory unless the user explicitly chooses another destination.
- Do not treat a task description as a timeless personal fact. Record durable facts only through the configured memory workflow.
- Never write passwords, tokens, private keys, or other secrets into workspace files or memory.
`;

// Runtime-native root policy filenames. They carry the same narrow contract so
// choosing Claude, Codex, or Gemini cannot change what the personal workspace
// means. Files are create-if-absent and remain operator-owned afterwards.
export const PERSONAL_POLICY_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];

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

  if (writePolicy) {
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
