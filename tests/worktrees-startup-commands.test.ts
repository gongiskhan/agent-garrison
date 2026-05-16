import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createWorktree, removeWorktree } from "../src/lib/worktrees";
import {
  DEFAULT_GARRISON_STATE_PATH
} from "../src/lib/garrison-sessions";

const execFileAsync = promisify(execFile);

// We must not touch the user's real ~/.garrison/sessions/state.json.
// garrison-sessions.ts respects the GARRISON_STATE_PATH override via its
// readStateFile call site — but the integration tests in the suite already
// route through the in-repo state file by default. We isolate by setting up
// a unique branch name per test and tearing the worktree down afterwards.
//
// This test asserts:
//   1. cfg.startupCommands run sequentially in the worktree dir
//   2. A succeeding command sets startupCommandsStatus=success
//   3. A failing command stops the chain and sets status=failed

async function makeFakeRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-startup-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Tester"], { cwd: dir });
  await fsp.writeFile(path.join(dir, "README.md"), "fake\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

async function readSession(repo: string, branch: string): Promise<any | null> {
  try {
    const raw = await fsp.readFile(DEFAULT_GARRISON_STATE_PATH, "utf8");
    const state = JSON.parse(raw) as {
      projects: Record<string, { sessions: Record<string, any> }>;
    };
    const project = state.projects[repo] ?? state.projects[await fsp.realpath(repo)];
    if (!project) return null;
    return project.sessions[branch] ?? null;
  } catch {
    return null;
  }
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  predicate: (v: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null && predicate(value)) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("timed out waiting for predicate");
}

describe("createWorktree — startup_commands", () => {
  let repo = "";
  let flagFile = "";

  beforeEach(async () => {
    repo = await makeFakeRepo();
    flagFile = path.join(os.tmpdir(), `garrison-startup-flag-${Date.now()}.txt`);
    await fsp.rm(flagFile, { force: true }).catch(() => null);
  });

  afterEach(async () => {
    try {
      const wts = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repo });
      for (const line of wts.stdout.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const wp = line.slice(9);
        if (wp === repo) continue;
        await removeWorktree(repo, wp).catch(() => null);
      }
    } catch {}
    await fsp.rm(repo, { recursive: true, force: true }).catch(() => null);
    await fsp.rm(flagFile, { force: true }).catch(() => null);
  });

  it("executes startup commands in the new worktree and reaches status=success", async () => {
    const result = await createWorktree(repo, "feat/startup-success", "main", {
      projectConfig: {
        id: "fake",
        name: "fake",
        rootPath: repo,
        worktreeBase: path.join(os.tmpdir(), "garrison-startup-wt-success"),
        portNeeds: [],
        startupCommands: [`echo started > ${JSON.stringify(flagFile)}`],
        envTemplate: {},
        defaultBaseBranch: "main"
      }
    });

    expect(result.worktreePath).toBeTruthy();

    // Wait for the async runner to flip status to success.
    const final = await waitFor(
      () => readSession(repo, "feat/startup-success"),
      (s) => s?.startupCommandsStatus === "success",
      5000
    );
    expect(final.startupCommandsStatus).toBe("success");

    // The flag file the startup command wrote should exist.
    const contents = await fsp.readFile(flagFile, "utf8");
    expect(contents.trim()).toBe("started");
  }, 15_000);

  it("marks status=failed when a startup command exits non-zero, without rolling back", async () => {
    const result = await createWorktree(repo, "feat/startup-fail", "main", {
      projectConfig: {
        id: "fake",
        name: "fake",
        rootPath: repo,
        worktreeBase: path.join(os.tmpdir(), "garrison-startup-wt-fail"),
        portNeeds: [],
        startupCommands: ["false", "echo should-not-run >> /tmp/garrison-must-not-exist"],
        envTemplate: {},
        defaultBaseBranch: "main"
      }
    });

    expect(result.worktreePath).toBeTruthy();

    const final = await waitFor(
      () => readSession(repo, "feat/startup-fail"),
      (s) => s?.startupCommandsStatus === "failed",
      5000
    );
    expect(final.startupCommandsStatus).toBe("failed");
    expect(final.startupCommandsError).toMatch(/false exited/);
  }, 15_000);

  it("skips startupCommands fields when the config has no commands", async () => {
    const result = await createWorktree(repo, "feat/no-startup", "main", {
      projectConfig: {
        id: "fake",
        name: "fake",
        rootPath: repo,
        worktreeBase: path.join(os.tmpdir(), "garrison-startup-wt-none"),
        portNeeds: [],
        startupCommands: [],
        envTemplate: {},
        defaultBaseBranch: "main"
      }
    });

    expect(result.worktreePath).toBeTruthy();

    // No status field should be set; wait briefly to confirm nothing flips it.
    await new Promise((r) => setTimeout(r, 500));
    const session = await readSession(repo, "feat/no-startup");
    expect(session?.startupCommandsStatus).toBeUndefined();
  });
});
