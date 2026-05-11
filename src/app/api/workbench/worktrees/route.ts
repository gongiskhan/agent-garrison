import { NextResponse, type NextRequest } from "next/server";
import { listWorktrees, createWorktree, removeWorktree } from "@/lib/worktrees";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const repoPath = request.nextUrl.searchParams.get("repoPath");
  if (!repoPath) {
    return NextResponse.json({ error: "repoPath is required" }, { status: 400 });
  }
  try {
    const worktrees = await listWorktrees(repoPath);
    return NextResponse.json({ worktrees });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as {
    repoPath?: string;
    branch?: string;
    baseBranch?: string;
  };
  const { repoPath, branch, baseBranch } = body;
  if (!repoPath || !branch) {
    return NextResponse.json({ error: "repoPath and branch are required" }, { status: 400 });
  }
  try {
    const result = await createWorktree(repoPath, branch, baseBranch);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const body = (await request.json()) as {
    repoPath?: string;
    worktreePath?: string;
  };
  const { repoPath, worktreePath } = body;
  if (!repoPath || !worktreePath) {
    return NextResponse.json({ error: "repoPath and worktreePath are required" }, { status: 400 });
  }
  try {
    await removeWorktree(repoPath, worktreePath);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
