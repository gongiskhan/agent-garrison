import { NextResponse, type NextRequest } from "next/server";
import { findWorktreeById, setBinding } from "@/lib/garrison-sessions";
import type { WorktreeBinding } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Persist a soul→worktree binding so the Monitor (and other surfaces) can
// look up which session owns which worktree. Called by the http-gateway
// after talk_to spawns (or respawns) a soul tied to a worktreeId.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Partial<
      WorktreeBinding & {
        worktree_id?: string;
        worktreeId?: string;
        session_id?: string;
        tier_flags?: string[];
      }
    >;
    const worktreeId = (body as { worktreeId?: string; worktree_id?: string }).worktreeId
      ?? (body as { worktree_id?: string }).worktree_id;
    if (!worktreeId) {
      return NextResponse.json({ error: "worktreeId is required" }, { status: 400 });
    }
    const found = await findWorktreeById(worktreeId);
    if (!found) {
      return NextResponse.json({ error: "worktree not found", worktreeId }, { status: 404 });
    }
    if (!body.soul || (!body.sessionId && !(body as { session_id?: string }).session_id)) {
      return NextResponse.json(
        { error: "soul and sessionId are required" },
        { status: 400 }
      );
    }
    const binding: WorktreeBinding = {
      soul: body.soul,
      sessionId: body.sessionId ?? (body as { session_id?: string }).session_id ?? "",
      mode: (body.mode as "headless" | "workbench") ?? "headless",
      tier: body.tier ?? { model: "" },
      tierFlags: body.tierFlags ?? (body as { tier_flags?: string[] }).tier_flags ?? [],
      terminalTabId: body.terminalTabId ?? undefined,
      spawnedAt: body.spawnedAt ?? new Date().toISOString(),
      lastSummaryAt: body.lastSummaryAt ?? undefined
    };
    const matched = await setBinding(found.projectPath, found.branch, binding);
    return NextResponse.json({ ok: matched, worktreeId, branch: found.branch });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
