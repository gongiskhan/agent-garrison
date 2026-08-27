// The commit-push executor that survives `down` — the Next app's copy of the
// one mesh action a node must be able to perform precisely when its operative
// and fittings are dead: committing and pushing its own work so a peer's
// pull-from-others (and the nightly card) can see it.
//
// The file-browser fitting carries the richer twin (event pump + UI); this is
// the floor under it. Same guards, deliberately duplicated small rather than
// imported across the fitting boundary: execFile never a shell, hooks
// neutralised, `--` before paths, and the session-registry skip — including
// skip-when-unreadable, because not knowing is not a licence to commit blind.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { withState } from "../state-client";
import { readNodeIdentity } from "../node-identity";

const execFileAsync = promisify(execFile);

const GIT_BASE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  GIT_OPTIONAL_LOCKS: "0"
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...GIT_BASE, ...args], {
    cwd,
    env: GIT_ENV,
    timeout: 60_000,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

// The dev-root name discipline (project-source.mjs's rules): plain child name,
// no separators, no dots leading, realpath inside the root, .git required.
export function resolveProjectDir(project: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project) || project.includes("..")) {
    throw new Error(`invalid project name: ${project}`);
  }
  if (project === "garrison") {
    return path.resolve(process.cwd());
  }
  const devRoot = realpathSync(path.join(os.homedir(), "dev"));
  const dir = path.join(devRoot, project);
  const real = realpathSync(dir);
  if (real !== dir && !real.startsWith(`${devRoot}${path.sep}`)) {
    throw new Error(`project resolves outside the dev root: ${project}`);
  }
  if (!existsSync(path.join(real, ".git"))) {
    throw new Error(`not a git repo: ${project}`);
  }
  return real;
}

export interface CommitPushResult {
  project: string;
  result: "pushed" | "nothing-to-push" | "skipped-session" | "skipped-unknown-sessions";
  branch?: string;
  sha?: string;
  detail?: string;
}

export async function commitPushProject(project: string): Promise<CommitPushResult> {
  const dir = resolveProjectDir(project);

  // Session guard, fail-closed: a live session in the tree means its agent is
  // mid-write; an UNREADABLE registry means we cannot know, which is a skip
  // too, stated as its own outcome so the caller sees the difference.
  try {
    const sessions = await withState((c) => c.listSessions({ cwd: dir, activeOnly: true }));
    const live = sessions.filter((s) => s.status === "running" || s.status === "starting");
    if (live.length > 0) {
      return { project, result: "skipped-session", detail: `${live.length} live session(s)` };
    }
  } catch (err) {
    return {
      project,
      result: "skipped-unknown-sessions",
      detail: `session registry unreadable: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  const branch = (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const status = await git(dir, ["status", "--porcelain"]);
  if (status.trim()) {
    await git(dir, ["add", "-A", "--"]);
    const node = readNodeIdentity().name;
    await git(dir, ["commit", "-q", "-m", `mesh: ${node} commit-push snapshot`]);
  }
  // Push only when ahead (or with new commit). A push of nothing is a no-op
  // but the rev-list read makes the outcome honest.
  await git(dir, ["push", "-q", "origin", branch]).catch(async (err) => {
    // Non-ff or auth failure: surface, never force.
    throw new Error(`push failed on ${branch}: ${err instanceof Error ? err.message : String(err)}`);
  });
  const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return {
    project,
    result: status.trim() ? "pushed" : "nothing-to-push",
    branch,
    sha
  };
}
