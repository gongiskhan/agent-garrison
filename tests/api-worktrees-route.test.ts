import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { NextRequest } from "next/server";

let repoDir: string;
let stateFile: string;
let priorStatePath: string | undefined;

async function mkRepo(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-route-"));
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
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-route-state-"));
  stateFile = path.join(stateDir, "state.json");
  priorStatePath = process.env.GARRISON_STATE_PATH;
  process.env.GARRISON_STATE_PATH = stateFile;
});

afterEach(async () => {
  if (priorStatePath !== undefined) {
    process.env.GARRISON_STATE_PATH = priorStatePath;
  } else {
    delete process.env.GARRISON_STATE_PATH;
  }
  if (repoDir) await fsp.rm(repoDir, { recursive: true, force: true }).catch(() => null);
  if (stateFile) await fsp.rm(path.dirname(stateFile), { recursive: true, force: true }).catch(() => null);
  await fsp.rm(path.join(os.homedir(), ".worktrees", path.basename(repoDir)), {
    recursive: true,
    force: true
  }).catch(() => null);
});

async function seedWorktree(opts: { title: string; branch: string }) {
  const { createWorktree } = await import("@/lib/worktrees");
  return await createWorktree(repoDir, opts.branch, "main", { title: opts.title });
}

function get(url: string) {
  return new NextRequest(url);
}
function post(url: string, body: object) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("Phase 9I L2 — /api/workbench/worktrees", () => {
  it("GET ?id=<uuid> returns the enriched record", async () => {
    const { GET } = await import("@/app/api/workbench/worktrees/route");
    const wt = await seedWorktree({ title: "T1", branch: "feat/t1" });
    const res = await GET(get(`http://localhost/api/workbench/worktrees?id=${wt.id}`));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      id: wt.id,
      title: "T1",
      branch: "feat/t1",
      baseBranch: "main",
      status: "active"
    });
    expect(data.urls).toBeTypeOf("object");
  });

  it("GET ?id= returns 404 for unknown id", async () => {
    const { GET } = await import("@/app/api/workbench/worktrees/route");
    const res = await GET(get(`http://localhost/api/workbench/worktrees?id=00000000-0000-0000-0000-000000000000`));
    expect(res.status).toBe(404);
  });

  it("GET ?repoPath=<path> enriches each row with title/urls/status/bindings", async () => {
    const { GET } = await import("@/app/api/workbench/worktrees/route");
    await seedWorktree({ title: "alpha task", branch: "feat/alpha" });
    await seedWorktree({ title: "beta task", branch: "feat/beta" });
    const res = await GET(
      get(`http://localhost/api/workbench/worktrees?repoPath=${encodeURIComponent(repoDir)}`)
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { worktrees: Array<{ branch: string; title?: string; status?: string; urls?: object }> };
    expect(data.worktrees.length).toBeGreaterThanOrEqual(2);
    const alpha = data.worktrees.find((w) => w.branch === "feat/alpha");
    expect(alpha?.title).toBe("alpha task");
    expect(alpha?.status).toBe("active");
    expect(alpha?.urls).toBeTypeOf("object");
  });

  it("POST { project, task_title } creates a worktree via project-id resolution", async () => {
    const { POST } = await import("@/app/api/workbench/worktrees/route");
    // Pre-seed the home project config so resolveProjectRepoPath finds our test repo.
    const projectId = path.basename(repoDir);
    const homeProjectsDir = path.join(os.homedir(), ".garrison", "projects");
    await fsp.mkdir(homeProjectsDir, { recursive: true });
    const projectFile = path.join(homeProjectsDir, `${projectId}.yml`);
    const priorExists = await fsp.access(projectFile).then(() => true).catch(() => false);
    let priorContent: string | null = null;
    if (priorExists) priorContent = await fsp.readFile(projectFile, "utf8");
    await fsp.writeFile(projectFile, `id: ${projectId}\nname: ${projectId}\nrootPath: ${repoDir}\n`);

    try {
      const res = await POST(
        post("http://localhost/api/workbench/worktrees", {
          project: projectId,
          task_title: "Fix the validation regex in LoginForm"
        })
      );
      expect(res.status).toBe(201);
      const data = (await res.json()) as { id: string; title: string; baseBranch: string; urls: object };
      expect(data.id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(data.title).toBe("Fix the validation regex in LoginForm");
      expect(data.baseBranch).toBe("main");
      expect(data.urls).toBeTypeOf("object");
    } finally {
      if (priorExists && priorContent !== null) {
        await fsp.writeFile(projectFile, priorContent);
      } else {
        await fsp.unlink(projectFile).catch(() => null);
      }
    }
  });

  it("POST legacy shape { repoPath, branch } still creates a worktree (backwards compat)", async () => {
    const { POST } = await import("@/app/api/workbench/worktrees/route");
    const res = await POST(
      post("http://localhost/api/workbench/worktrees", {
        repoPath: repoDir,
        branch: "feat/legacy"
      })
    );
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("POST without either { project, task_title } or { repoPath, branch } returns 400", async () => {
    const { POST } = await import("@/app/api/workbench/worktrees/route");
    const res = await POST(post("http://localhost/api/workbench/worktrees", { foo: "bar" }));
    expect(res.status).toBe(400);
  });
});
