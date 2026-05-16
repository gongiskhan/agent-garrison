import { NextResponse, type NextRequest } from "next/server";
import { workbenchServerBus } from "@/lib/workbench-server-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 9E — POST from http-gateway. Opens a new TrenchesPanel-style tab in
// /workbench with the soul's claude command pre-typed.
//
// Body: {
//   session_id, soul, cwd, args, message?, worktree_id?, mcp_config_path?
// }

export async function POST(request: NextRequest) {
  let body: {
    session_id?: string;
    soul?: string;
    cwd?: string;
    args?: string[];
    message?: string;
    worktree_id?: string;
    mcp_config_path?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { session_id, soul, cwd, args } = body;
  if (!session_id || !soul || !cwd || !Array.isArray(args) || args.length === 0) {
    return NextResponse.json(
      { error: "session_id, soul, cwd, and args[] are required" },
      { status: 400 }
    );
  }

  const terminalTabId = workbenchServerBus().emitLaunch({
    sessionId: session_id,
    soul,
    cwd,
    args,
    message: body.message,
    worktreeId: body.worktree_id,
    mcpConfigPath: body.mcp_config_path
  });

  return NextResponse.json({ terminal_tab_id: terminalTabId });
}
