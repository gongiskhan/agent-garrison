import { NextResponse, type NextRequest } from "next/server";
import { getUserQuartersState, parseUserRuntime, runUserQuartersAction } from "@/lib/quarters-user";
import { jsonError } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try { return NextResponse.json(await getUserQuartersState(parseUserRuntime(request.nextUrl.searchParams.get("runtime") || "claude-code"))); }
  catch (error) { return jsonError(error, 400); }
}
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== request.nextUrl.host) return jsonError(new Error("Cross-origin request refused"), 403);
    const body = await request.json();
    return NextResponse.json(await runUserQuartersAction(parseUserRuntime(body.runtime), String(body.action), String(body.id)));
  } catch (error) { return jsonError(error, 400); }
}
