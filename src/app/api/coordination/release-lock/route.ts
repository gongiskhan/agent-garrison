import { NextResponse, type NextRequest } from "next/server";
import { runCoord } from "@/lib/coord-cli";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/coordination/release-lock  body: { repo: "/abs/path" }
// Force-releases a repo's planning lock (the guarded action — the UI confirms
// first, since releasing a session mid-plan is consequential).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const repo = body?.repo;
    if (!repo || typeof repo !== "string") {
      return jsonError(new Error("Body must be { repo: <abs path> }"), 400);
    }
    const { code, stdout, stderr } = await runCoord(["release-lock", `--repo=${repo}`]);
    if (code !== 0) return jsonError(new Error(stderr.trim() || `release-lock exited ${code}`), 500);
    return NextResponse.json({ ok: true, ...JSON.parse(stdout || "{}") });
  } catch (error) {
    return jsonError(error, 400);
  }
}
