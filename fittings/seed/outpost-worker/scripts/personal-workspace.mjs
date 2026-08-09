// Managed non-project workspace for project-less cards on an Outpost.
//
// It intentionally mirrors kanban-loop/lib/personal-workspace.mjs. The worker
// bundle cannot import a host-side fitting on a remote Mac, so a parity test
// locks the policy text and filenames together. Runtime login/config remains
// machine-local; this directory contains no copied credentials or sessions.

import { access, chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const OUTPOST_PERSONAL_POLICY = `# Garrison workspace

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

export const OUTPOST_PERSONAL_POLICY_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];

// Mirrors the host's project-shaped `.claude` directory. A remote run must have
// the same shape as a host run, or "it worked on the Outpost" stops meaning the
// same thing as "it worked here".
export const OUTPOST_WORKSPACE_CLAUDE_DIRNAME = ".claude";
export const OUTPOST_WORKSPACE_CLAUDE_SUBDIRS = ["skills", "commands"];
export const OUTPOST_WORKSPACE_CLAUDE_SETTINGS =
  JSON.stringify({ $schema: "https://json.schemastore.org/claude-code-settings.json", permissions: {} }, null, 2) +
  "\n";

export async function ensureOutpostPersonalWorkspace({ configPath, writePolicy = true } = {}) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
    throw new Error("the Outpost personal workspace requires an absolute worker config path");
  }
  const configuredRoot = path.dirname(path.resolve(configPath));
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(configuredRoot);
  const candidate = path.join(realRoot, "personal");
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const entry = await lstat(candidate);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Outpost personal workspace must be a real directory: ${candidate}`);
  }
  const workspace = await realpath(candidate);
  if (path.dirname(workspace) !== realRoot) {
    throw new Error(`Outpost personal workspace escapes its config directory: ${candidate}`);
  }
  await chmod(workspace, 0o700);
  try {
    await access(path.join(workspace, ".git"));
    throw new Error(`Outpost personal workspace must not be a Git repository: ${workspace}`);
  } catch (error) {
    if (error?.message?.includes("must not be a Git repository")) throw error;
  }

  const claudeDir = path.join(workspace, OUTPOST_WORKSPACE_CLAUDE_DIRNAME);
  try {
    await mkdir(claudeDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const claudeEntry = await lstat(claudeDir);
  if (claudeEntry.isSymbolicLink() || !claudeEntry.isDirectory()) {
    throw new Error(`Outpost workspace .claude must be a real directory: ${claudeDir}`);
  }
  if (path.dirname(await realpath(claudeDir)) !== workspace) {
    throw new Error(`Outpost workspace .claude escapes the workspace: ${claudeDir}`);
  }
  for (const sub of OUTPOST_WORKSPACE_CLAUDE_SUBDIRS) {
    try {
      await mkdir(path.join(claudeDir, sub), { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }

  if (writePolicy) {
    try {
      await writeFile(path.join(claudeDir, "settings.json"), OUTPOST_WORKSPACE_CLAUDE_SETTINGS, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    for (const filename of OUTPOST_PERSONAL_POLICY_FILES) {
      const target = path.join(workspace, filename);
      let created = false;
      try {
        await writeFile(target, OUTPOST_PERSONAL_POLICY, { encoding: "utf8", flag: "wx", mode: 0o600 });
        created = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      if (created) await chmod(target, 0o600);
    }
  }
  return workspace;
}
