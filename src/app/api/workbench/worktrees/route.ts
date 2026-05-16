import { NextResponse, type NextRequest } from "next/server";
import {
  listWorktrees,
  createWorktree,
  removeWorktree,
  slugifyBranch,
  InvalidArgumentError
} from "@/lib/worktrees";
import { expandHome, parseTarget, outpostRpc } from "@/lib/outpost-rpc";
import { loadProjectConfig, resolveProjectRepoPath } from "@/lib/project-config";
import { findWorktreeById, loadAllSessions, loadProjectSessionsRich } from "@/lib/garrison-sessions";

export const runtime = "nodejs";

interface BridgeWorktree {
  path: string;
  branch: string;
  commit: string;
  is_main: boolean;
  ports?: Record<string, number>;
  env_files?: string[];
}

function defaultBranchSlugForTitle(title: string): string {
  const lower = title.toLowerCase();
  const prefix = /^(fix|bug|hotfix)\b/.test(lower) ? "fix" : "feat";
  const slug = slugifyBranch(title.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  return `${prefix}/${slug || `worktree-${Date.now().toString(36)}`}`;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = params.get("id");
  const project = params.get("project");
  const repoPath = params.get("repoPath");
  const target = parseTarget(params.get("target"));

  try {
    // Phase 9F — orchestrator lookup by id
    if (id) {
      const found = await findWorktreeById(id);
      if (!found) return NextResponse.json({ error: "worktree not found" }, { status: 404 });
      return NextResponse.json({
        id: found.session.id,
        title: found.session.title,
        branch: found.session.branch,
        baseBranch: found.session.baseBranch,
        worktreePath: found.session.worktreePath,
        ports: found.session.ports,
        urls: found.session.urls,
        status: found.session.status,
        bindings: found.session.bindings,
        projectPath: found.projectPath
      });
    }

    // Phase 9F — orchestrator list by project id (lists Garrison-tracked sessions
    // for that project, sorted by lastStatusAt desc).
    if (project) {
      const sessions = await loadAllSessions();
      const filtered = sessions
        .filter((s) => s.projectName === project)
        .sort((a, b) => (b.lastStatusAt > a.lastStatusAt ? 1 : -1));
      return NextResponse.json({ worktrees: filtered });
    }

    if (!repoPath) {
      return NextResponse.json({ error: "id, project, or repoPath is required" }, { status: 400 });
    }
    if (target.kind === "local") {
      const worktrees = await listWorktrees(repoPath);
      // Phase 9H — enrich with state.json fields (id, title, status, urls, bindings).
      const sessionRecords = await loadProjectSessionsRich(repoPath);
      const enriched = worktrees.map((wt) => {
        const session = sessionRecords.get(wt.branch);
        if (!session) return wt;
        return {
          ...wt,
          id: session.id,
          title: session.title,
          baseBranch: session.baseBranch,
          status: session.status,
          ports: session.ports,
          urls: session.urls,
          bindings: session.bindings
        };
      });
      return NextResponse.json({ worktrees: enriched });
    }

    const payload = (await outpostRpc(target.name, "git.list_worktrees", {
      repo_path: expandHome(repoPath),
    })) as { worktrees?: BridgeWorktree[] } | undefined;

    const worktrees = (payload?.worktrees ?? []).map((wt) => ({
      worktreePath: wt.path,
      branch: wt.branch,
      commit: wt.commit,
      isMain: wt.is_main,
    }));
    return NextResponse.json({ worktrees });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    target?: string;
    repoPath?: string;
    branch?: string;
    baseBranch?: string;
    project?: string;
    task_title?: string;
    branch_name?: string;
    base_branch?: string;
    taskTitle?: string;
  };
  const target = parseTarget(body.target ?? null);

  // Phase 9F — orchestrator/MCP-side request: { project, task_title, branch_name?, base_branch? }
  if (body.project && (body.task_title || body.taskTitle)) {
    try {
      const repoPath = await resolveProjectRepoPath(body.project);
      const projectConfig = await loadProjectConfig(repoPath);
      const title = String(body.task_title ?? body.taskTitle ?? "").trim();
      const branchName =
        body.branch_name?.trim() || body.branch?.trim() || defaultBranchSlugForTitle(title);
      const baseBranch =
        body.base_branch?.trim() || body.baseBranch?.trim() || projectConfig.defaultBaseBranch;
      const result = await createWorktree(repoPath, branchName, baseBranch, {
        title,
        projectConfig
      });
      return NextResponse.json(
        {
          ...result,
          projectPath: repoPath
        },
        { status: 201 }
      );
    } catch (err) {
      if (err instanceof InvalidArgumentError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // Legacy Workbench-UI path: { repoPath, branch, baseBranch }
  const { repoPath, branch, baseBranch } = body;
  if (!repoPath || !branch) {
    return NextResponse.json(
      { error: "either { project, task_title } or { repoPath, branch } is required" },
      { status: 400 }
    );
  }

  try {
    if (target.kind === "local") {
      let projectConfig;
      try {
        projectConfig = await loadProjectConfig(repoPath);
      } catch { /* leave undefined */ }
      const result = await createWorktree(repoPath, branch, baseBranch, { projectConfig });
      return NextResponse.json(result, { status: 201 });
    }

    const payload = (await outpostRpc(target.name, "git.create_worktree", {
      repo_path: expandHome(repoPath),
      branch,
      base_branch: baseBranch ?? "main",
    })) as { path?: string } | undefined;

    return NextResponse.json(
      {
        worktreePath: payload?.path ?? "",
        envFiles: [],
        ports: {},
        urls: {},
        id: "",
        baseBranch: baseBranch ?? "main"
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof InvalidArgumentError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const body = (await request.json()) as {
    target?: string;
    repoPath?: string;
    worktreePath?: string;
  };
  const { repoPath, worktreePath } = body;
  const target = parseTarget(body.target ?? null);

  if (!repoPath || !worktreePath) {
    return NextResponse.json({ error: "repoPath and worktreePath are required" }, { status: 400 });
  }

  try {
    if (target.kind === "local") {
      await removeWorktree(repoPath, worktreePath);
      return NextResponse.json({ ok: true });
    }

    await outpostRpc(target.name, "git.delete_worktree", {
      worktree_path: worktreePath,
      repo_path: expandHome(repoPath),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
