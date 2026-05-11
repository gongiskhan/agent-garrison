import { NextResponse, type NextRequest } from "next/server";
import { installHooks, hooksAreInstalled, restoreHooks } from "@/lib/claude-hooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST: install Garrison's Claude Code hooks into ~/.claude/settings.json.
// Hook URL is derived from the request origin so hooks always target the
// running Garrison instance. Setup scripts call this; it's idempotent.
export async function POST(request: NextRequest) {
  try {
    const origin = request.nextUrl.origin;
    const hookUrl = `${origin}/api/workbench/sessions/hook`;
    await installHooks({ hookUrl });
    const installed = hooksAreInstalled();
    if (!installed) {
      return NextResponse.json(
        { error: "hooks install reported success but marker not found" },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true, hookUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE: restore the user's original settings.json from snapshot.
export async function DELETE() {
  try {
    await restoreHooks();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
