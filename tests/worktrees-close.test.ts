import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createWorktree } from "@/lib/worktrees";
import { findWorktreeById, setWorktreeStatus, loadAllSessions } from "@/lib/garrison-sessions";

let repoDir: string;
let stateFile: string;

beforeEach(async () => {
  repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-close-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
  await fsp.writeFile(path.join(repoDir, "README.md"), "x");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });

  stateFile = path.join(repoDir, "state.json");
});

afterEach(async () => {
  if (repoDir) {
    await fsp.rm(repoDir, { recursive: true, force: true }).catch(() => null);
  }
  await fsp.rm(path.join(os.homedir(), ".worktrees", path.basename(repoDir)), {
    recursive: true,
    force: true
  }).catch(() => null);
});

describe("Phase 9F — worktree close flow (state-level)", () => {
  it("setWorktreeStatus('merged') flips status; findWorktreeById returns merged record", async () => {
    const result = await createWorktree(repoDir, "feat/close-test", "main", {
      title: "test merge flow"
    });
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.title).toBe("test merge flow");

    let found = await findWorktreeById(result.id);
    expect(found?.session.status).toBe("active");
    expect(found?.session.title).toBe("test merge flow");

    await setWorktreeStatus(repoDir, "feat/close-test", "merged");
    found = await findWorktreeById(result.id);
    expect(found?.session.status).toBe("merged");
  });

  it("loadAllSessions returns the merged record alongside active ones", async () => {
    await createWorktree(repoDir, "feat/active", "main", { title: "active task" });
    const closing = await createWorktree(repoDir, "feat/done", "main", { title: "done task" });
    await setWorktreeStatus(repoDir, "feat/done", "merged");

    const sessions = await loadAllSessions();
    const projectSessions = sessions.filter((s) => s.projectPath === repoDir);
    expect(projectSessions.some((s) => s.branch === "feat/active")).toBe(true);
    expect(projectSessions.some((s) => s.branch === "feat/done")).toBe(true);

    const found = await findWorktreeById(closing.id);
    expect(found?.session.status).toBe("merged");
  });
});
