import { NextResponse, type NextRequest } from "next/server";
import { listWorktrees, createWorktree, removeWorktree, InvalidArgumentError } from "@/lib/worktrees";
import { expandHome, parseTarget, outpostRpc } from "@/lib/outpost-rpc";

export const runtime = "nodejs";

interface BridgeWorktree {
  path: string;
  branch: string;
  commit: string;
  is_main: boolean;
  ports?: Record<string, number>;
  env_files?: string[];
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const repoPath = params.get("repoPath");
  const target = parseTarget(params.get("target"));

  if (!repoPath) {
    return NextResponse.json({ error: "repoPath is required" }, { status: 400 });
  }

  try {
    if (target.kind === "local") {
      const worktrees = await listWorktrees(repoPath);
      return NextResponse.json({ worktrees });
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
  };
  const { repoPath, branch, baseBranch } = body;
  const target = parseTarget(body.target ?? null);

  if (!repoPath || !branch) {
    return NextResponse.json({ error: "repoPath and branch are required" }, { status: 400 });
  }

  try {
    if (target.kind === "local") {
      const result = await createWorktree(repoPath, branch, baseBranch);
      return NextResponse.json(result, { status: 201 });
    }

    const payload = (await outpostRpc(target.name, "git.create_worktree", {
      repo_path: expandHome(repoPath),
      branch,
      base_branch: baseBranch ?? "main",
    })) as { path?: string } | undefined;

    return NextResponse.json(
      { worktreePath: payload?.path ?? "", envFiles: [], ports: {} },
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
