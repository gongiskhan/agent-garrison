import { NextResponse } from "next/server";
import { readBoardSummary } from "@/lib/board-summary";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readBoardSummary());
  } catch (error) {
    return jsonError(error, 500);
  }
}
