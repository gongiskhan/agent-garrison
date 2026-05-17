// Worktree CRUD endpoints, now backed by the standalone worktree-management
// Fitting on its own port (default 7080) instead of the deleted Garrison
// Next.js (deleted) /api/worktrees routes. Configure the base URL via the
// WORKTREE_FITTING_BASE_URL env var; default is http://127.0.0.1:7080.
//
// Endpoint shapes (from the worktree-management-sequoias Fitting server):
//   - GET    /worktrees?repoPath=<path>     - list
//   - POST   /worktrees {repoPath, branch, baseBranch, title}  - create
//   - DELETE /worktrees/:id                 - remove

import { logEvent } from "./log.mjs";

const DEFAULT_BASE = "http://127.0.0.1:7080";

export class WorktreesProxy {
  constructor(_nextBaseUrl) {
    // _nextBaseUrl was the legacy Garrison-Next.js base; ignored now.
    this.base = process.env.WORKTREE_FITTING_BASE_URL || DEFAULT_BASE;
    if (!this.base) {
      logEvent("stderr", { kind: "worktrees-proxy-disabled", message: "WORKTREE_FITTING_BASE_URL not set" });
    }
  }

  enabled() { return Boolean(this.base); }

  async list(project) {
    if (!this.base) throw new Error("worktrees proxy disabled");
    // The new Fitting expects repoPath, not project. Treat project arg as
    // repo path; orchestrator stores absolute paths in its project field.
    const url = new URL("/worktrees", this.base);
    if (project) url.searchParams.set("repoPath", project);
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) throw new Error(`list worktrees ${r.status}: ${await r.text()}`);
    return await r.json();
  }

  async create(input = {}) {
    if (!this.base) throw new Error("worktrees proxy disabled");
    // Accept both naming conventions from upstream callers (mcp-gateway sends
    // snake_case, older UI-tab clients used camelCase).
    const repoPath = input.repoPath ?? input.repo_path ?? input.project;
    const branch = input.branch ?? input.branch_name ?? input.task_title?.replace(/\s+/g, "-").toLowerCase();
    const baseBranch = input.baseBranch ?? input.base_branch ?? "main";
    const title = input.taskTitle ?? input.task_title ?? null;
    const payload = { repoPath, branch, baseBranch, title };
    const r = await fetch(new URL("/worktrees", this.base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`create worktree ${r.status}: ${await r.text()}`);
    return await r.json();
  }

  async getById(id) {
    if (!this.base) throw new Error("worktrees proxy disabled");
    // The new Fitting has no GET-by-id endpoint; list and filter client-side.
    const r = await fetch(new URL("/worktrees", this.base), { method: "GET" });
    if (!r.ok) throw new Error(`get worktree ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const match = (data.worktrees ?? []).find((w) => w.id === id);
    if (!match) throw new Error(`get worktree: id not found: ${id}`);
    return match;
  }

  async close({ id, action }) {
    if (!this.base) throw new Error("worktrees proxy disabled");
    // The new Fitting's DELETE :id is the equivalent of action: "discard".
    // PR / merge flows are handled by gh CLI in the orchestrator session
    // itself in the new architecture.
    if (action && action !== "discard") {
      throw new Error(`close action '${action}' not supported by worktree Fitting; only 'discard'`);
    }
    const r = await fetch(new URL(`/worktrees/${encodeURIComponent(id)}`, this.base), {
      method: "DELETE"
    });
    if (!r.ok) throw new Error(`close worktree ${r.status}: ${await r.text()}`);
    return await r.json();
  }
}
