// Managed non-project workspace for personal cards on an Outpost.
//
// It intentionally mirrors kanban-loop/lib/personal-workspace.mjs. The worker
// bundle cannot import a host-side fitting on a remote Mac, so a parity test
// locks the policy text and filenames together. Runtime login/config remains
// machine-local; this directory contains no copied credentials or sessions.

import { access, chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const OUTPOST_PERSONAL_POLICY = `# Personal workspace

This is Garrison's stable workspace for personal tasks that do not belong to a software project.

- Treat it as private, non-repository working space. Do not initialize Git here.
- Keep task artifacts inside this directory unless the user explicitly chooses another destination.
- Do not treat a task description as a timeless personal fact. Record durable facts only through the configured memory workflow.
- Never write passwords, tokens, private keys, or other secrets into workspace files or memory.
`;

export const OUTPOST_PERSONAL_POLICY_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"];

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

  if (writePolicy) {
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
