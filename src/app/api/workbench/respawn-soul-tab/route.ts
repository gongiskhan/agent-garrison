import { NextResponse, type NextRequest } from "next/server";
import { workbenchServerBus } from "@/lib/workbench-server-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 9E — tier-aware respawn for workbench-mode souls. The Workbench UI
// receives the bus event, kills the running claude inside the same tab, and
// re-runs the new command.
//
// Body: { session_id, terminal_tab_id, args, message? }

export async function POST(request: NextRequest) {
  let body: {
    session_id?: string;
    terminal_tab_id?: string;
    args?: string[];
    message?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { session_id, terminal_tab_id, args } = body;
  if (!session_id || !terminal_tab_id || !Array.isArray(args)) {
    return NextResponse.json(
      { error: "session_id, terminal_tab_id, and args[] are required" },
      { status: 400 }
    );
  }

  workbenchServerBus().emitRespawn({
    sessionId: session_id,
    terminalTabId: terminal_tab_id,
    args,
    message: body.message
  });

  return NextResponse.json({ ok: true });
}
