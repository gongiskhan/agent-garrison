import { NextResponse, type NextRequest } from "next/server";
import {
  findSessionByCwd,
  setSessionStatus,
  statusFromHookEvent
} from "@/lib/garrison-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receiver for Claude Code hooks (UserPromptSubmit/Stop/Notification/
// PostToolUse). The hook installer at scripts/install-hooks.ts wires every
// event to POST { event, cwd } to this URL.

export async function POST(request: NextRequest) {
  let body: { event?: string; cwd?: string };
  try {
    body = (await request.json()) as { event?: string; cwd?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const event = (body.event ?? "").trim();
  const cwd = (body.cwd ?? "").trim();
  if (!event || !cwd) {
    return NextResponse.json({ error: "event and cwd required" }, { status: 400 });
  }
  const status = statusFromHookEvent(event);
  if (!status) {
    // Unknown event — accept it so the curl exits 0 but no-op the store.
    return NextResponse.json({ ok: true, matched: false, reason: "unmapped-event" });
  }
  const session = await findSessionByCwd(cwd);
  if (!session) {
    return NextResponse.json({ ok: true, matched: false });
  }
  await setSessionStatus(session.projectPath, session.branch, status, event);
  return NextResponse.json({ ok: true, matched: true, branch: session.branch });
}
