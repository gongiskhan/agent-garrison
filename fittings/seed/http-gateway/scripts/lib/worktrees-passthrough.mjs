// Worktree CRUD endpoints proxied through to Garrison Next.js.
// The actual git/worktree/port logic lives in src/lib/worktrees.ts;
// this module is a thin HTTP forwarder so the orchestrator can talk to it
// via the mcp-gateway garrison-control tools.
//
// We hit two endpoints on the Next.js side:
//   - /api/workbench/worktrees       (existing CRUD)
//   - /api/workbench/worktrees/close (new — Phase 9F)

import { logEvent } from "./log.mjs";

export class WorktreesProxy {
  constructor(nextBaseUrl) {
    if (!nextBaseUrl) {
      logEvent("stderr", { kind: "worktrees-proxy-disabled", message: "GARRISON_NEXT_BASE_URL not set" });
    }
    this.base = nextBaseUrl;
  }

  enabled() { return Boolean(this.base); }

  async list(project) {
    if (!this.base) throw new Error("worktrees proxy disabled");
    const url = new URL("/api/workbench/worktrees", this.base);
    if (project) url.searchParams.set("project", project);
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) throw new Error(`list worktrees ${r.status}: ${await r.text()}`);
    return await r.json();
  }

  async create(input = {}) {
    if (!this.base) throw new Error("worktrees proxy disabled");
    // Accept BOTH naming conventions — mcp-gateway sends snake_case
    // (task_title/branch_name/base_branch) while older Workbench-UI clients
    // use camelCase. Normalise to the shape Next.js's POST /api/workbench/
    // worktrees expects (it also accepts both).
    const payload = {
      project: input.project,
      repoPath: input.repoPath ?? input.repo_path,
      branch: input.branch ?? input.branch_name,
      branch_name: input.branch_name ?? input.branch,
      baseBranch: input.baseBranch ?? input.base_branch,
      base_branch: input.base_branch ?? input.baseBranch,
      taskTitle: input.taskTitle ?? input.task_title,
      task_title: input.task_title ?? input.taskTitle
    };
    const r = await fetch(new URL("/api/workbench/worktrees", this.base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`create worktree ${r.status}: ${await r.text()}`);
    return await r.json();
  }

  async getById(id) {
    if (!this.base) throw new Error("worktrees proxy disabled");
    const r = await fetch(new URL(`/api/workbench/worktrees?id=${encodeURIComponent(id)}`, this.base), { method: "GET" });
    if (!r.ok) throw new Error(`get worktree ${r.status}: ${await r.text()}`);
    return await r.json();
  }

  async close({ id, action, prTitle, prBody }) {
    if (!this.base) throw new Error("worktrees proxy disabled");
    const r = await fetch(new URL("/api/workbench/worktrees/close", this.base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, action, prTitle, prBody })
    });
    if (!r.ok) throw new Error(`close worktree ${r.status}: ${await r.text()}`);
    return await r.json();
  }
}
