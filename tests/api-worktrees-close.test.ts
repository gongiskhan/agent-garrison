import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";

let stateFile: string;
let repoDir: string;
let ghBin: string;
let priorStatePath: string | undefined;
let priorGhBin: string | undefined;

async function mkRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-close-route-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  await fsp.writeFile(path.join(dir, "README.md"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

beforeEach(async () => {
  repoDir = await mkRepo();
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-close-state-"));
  stateFile = path.join(stateDir, "state.json");
  priorStatePath = process.env.GARRISON_STATE_PATH;
  process.env.GARRISON_STATE_PATH = stateFile;

  // Fake gh — prints a canned PR URL on the last stdout line.
  ghBin = path.join(stateDir, "fake-gh");
  await fsp.writeFile(
    ghBin,
    `#!/bin/sh\necho "$@" 1>&2\necho "Creating pull request..."\necho "https://github.com/test/repo/pull/42"\n`,
    { mode: 0o755 }
  );
  priorGhBin = process.env.GARRISON_GH_BIN;
  process.env.GARRISON_GH_BIN = ghBin;
});

afterEach(async () => {
  if (priorStatePath !== undefined) {
    process.env.GARRISON_STATE_PATH = priorStatePath;
  } else {
    delete process.env.GARRISON_STATE_PATH;
  }
  if (priorGhBin !== undefined) {
    process.env.GARRISON_GH_BIN = priorGhBin;
  } else {
    delete process.env.GARRISON_GH_BIN;
  }
  if (repoDir) await fsp.rm(repoDir, { recursive: true, force: true }).catch(() => null);
  if (stateFile) {
    await fsp.rm(path.dirname(stateFile), { recursive: true, force: true }).catch(() => null);
  }
  await fsp.rm(path.join(os.homedir(), ".worktrees", path.basename(repoDir)), {
    recursive: true,
    force: true
  }).catch(() => null);
});

async function seedWorktree(opts: { title: string; branch: string }) {
  const { createWorktree } = await import("@/lib/worktrees");
  return await createWorktree(repoDir, opts.branch, "main", { title: opts.title });
}

function makeRequest(body: object): NextRequest {
  return new NextRequest("http://localhost:3000/api/workbench/worktrees/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("Phase 9I L2 — /api/workbench/worktrees/close", () => {
  it("action=merge invokes gh pr create and flips status to merged", async () => {
    const { POST } = await import("@/app/api/workbench/worktrees/close/route");
    const wt = await seedWorktree({ title: "Fix regex", branch: "feat/fix-regex" });

    const res = await POST(makeRequest({ id: wt.id, action: "merge" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; pr_url: string };
    expect(data.ok).toBe(true);
    expect(data.pr_url).toBe("https://github.com/test/repo/pull/42");

    const { findWorktreeById } = await import("@/lib/garrison-sessions");
    const found = await findWorktreeById(wt.id);
    expect(found?.session.status).toBe("merged");
  });

  it("action=discard removes the worktree and clears the session record", async () => {
    const { POST } = await import("@/app/api/workbench/worktrees/close/route");
    const wt = await seedWorktree({ title: "Drop me", branch: "feat/drop" });

    const res = await POST(makeRequest({ id: wt.id, action: "discard" }));
    expect(res.status).toBe(200);

    const { findWorktreeById } = await import("@/lib/garrison-sessions");
    const found = await findWorktreeById(wt.id);
    expect(found).toBeNull();
  });

  it("action=leave_open marks status active (no-op for already-active)", async () => {
    const { POST } = await import("@/app/api/workbench/worktrees/close/route");
    const wt = await seedWorktree({ title: "Keep me", branch: "feat/keep" });

    const res = await POST(makeRequest({ id: wt.id, action: "leave_open" }));
    expect(res.status).toBe(200);

    const { findWorktreeById } = await import("@/lib/garrison-sessions");
    const found = await findWorktreeById(wt.id);
    expect(found?.session.status).toBe("active");
  });

  it("returns 404 when the worktree id is unknown", async () => {
    const { POST } = await import("@/app/api/workbench/worktrees/close/route");
    const res = await POST(makeRequest({ id: "00000000-0000-0000-0000-000000000000", action: "merge" }));
    expect(res.status).toBe(404);
  });

  it("returns 400 for an unknown action", async () => {
    const { POST } = await import("@/app/api/workbench/worktrees/close/route");
    const wt = await seedWorktree({ title: "X", branch: "feat/x" });
    const res = await POST(makeRequest({ id: wt.id, action: "explode" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when id or action is missing", async () => {
    const { POST } = await import("@/app/api/workbench/worktrees/close/route");
    const r1 = await POST(makeRequest({ action: "merge" }));
    expect(r1.status).toBe(400);
    const r2 = await POST(makeRequest({ id: "abc" }));
    expect(r2.status).toBe(400);
  });
});
