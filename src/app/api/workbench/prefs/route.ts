import { NextResponse, type NextRequest } from "next/server";
import { readPrefs, updatePrefs, type WorkbenchPrefs, type WorktreePrefs } from "@/lib/workbench-prefs";

export const runtime = "nodejs";

export function GET() {
  try {
    return NextResponse.json(readPrefs());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  let body: { worktrees?: Partial<WorktreePrefs> };
  try {
    body = (await request.json()) as { worktrees?: Partial<WorktreePrefs> };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const updated = updatePrefs(body as { worktrees?: Partial<WorktreePrefs> });
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
