import { NextResponse, type NextRequest } from "next/server";
import { readClaudeMd, writeClaudeMd, type ClaudeMdScope } from "@/lib/claude-md";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseScope(value: unknown): ClaudeMdScope {
  return value === "project" ? "project" : "user";
}

export async function GET(request: NextRequest) {
  try {
    const scope = parseScope(request.nextUrl.searchParams.get("scope"));
    return NextResponse.json(await readClaudeMd(scope));
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const scope = parseScope(body?.scope);
    if (typeof body?.content !== "string") {
      return jsonError(new Error("content (string) is required"), 400);
    }
    const result = await writeClaudeMd(scope, body.content, { baselineSha: body?.baselineSha });
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
