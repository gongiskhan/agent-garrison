import { NextResponse, type NextRequest } from "next/server";
import { dev } from "@/lib/runner";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json({ state: await dev(params.id) });
  } catch (error) {
    return jsonError(error, 400);
  }
}
