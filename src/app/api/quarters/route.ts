import { NextResponse, type NextRequest } from "next/server";
import { getQuartersState, runQuartersAction } from "@/lib/quarters";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getQuartersState());
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await runQuartersAction(body);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return jsonError(error, 400);
  }
}
