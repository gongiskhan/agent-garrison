import { NextResponse } from "next/server";
import { loadAllSessions } from "@/lib/garrison-sessions";

export const runtime = "nodejs";

export async function GET() {
  try {
    const sessions = await loadAllSessions();
    return NextResponse.json({ sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
