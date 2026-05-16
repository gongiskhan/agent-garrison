import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { removeWorktree } from "@/lib/worktrees";
import {
  findWorktreeById,
  setWorktreeStatus
} from "@/lib/garrison-sessions";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

// Phase 9F — close a worktree by id. Three actions:
//   merge       — gh pr create --fill --head <branch> in the worktree's cwd;
//                 marks status="merged", returns pr_url. Does NOT auto-merge.
//   discard     — removeWorktree() + setWorktreeStatus("discarded").
//   leave_open  — setWorktreeStatus("active") (no-op marker).

export async function POST(request: NextRequest) {
  let body: {
    id?: string;
    action?: "merge" | "discard" | "leave_open";
    pr_title?: string;
    pr_body?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { id, action } = body;
  if (!id || !action) {
    return NextResponse.json({ error: "id and action are required" }, { status: 400 });
  }

  const found = await findWorktreeById(id);
  if (!found) {
    return NextResponse.json({ error: "worktree not found" }, { status: 404 });
  }

  try {
    if (action === "merge") {
      const args = ["pr", "create", "--fill", "--head", found.session.branch];
      if (body.pr_title) {
        args.push("--title", body.pr_title);
      }
      if (body.pr_body) {
        args.push("--body", body.pr_body);
      }
      const ghBin = process.env.GARRISON_GH_BIN ?? "gh";
      const { stdout } = await execFileAsync(ghBin, args, {
        cwd: found.session.worktreePath
      });
      const prUrl = stdout.trim().split("\n").pop() ?? "";
      await setWorktreeStatus(found.projectPath, found.session.branch, "merged");
      return NextResponse.json({ ok: true, pr_url: prUrl });
    }

    if (action === "discard") {
      await removeWorktree(found.projectPath, found.session.worktreePath);
      // removeWorktree already calls removeSession; no need to setWorktreeStatus.
      return NextResponse.json({ ok: true });
    }

    if (action === "leave_open") {
      await setWorktreeStatus(found.projectPath, found.session.branch, "active");
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
