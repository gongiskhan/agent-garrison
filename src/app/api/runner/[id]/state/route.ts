import { NextResponse, type NextRequest } from "next/server";
import { getRunnerState } from "@/lib/runner";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  return NextResponse.json({ state: getRunnerState(params.id) });
}
