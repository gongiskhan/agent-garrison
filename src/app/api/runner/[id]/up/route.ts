import { NextResponse, type NextRequest } from "next/server";
import { up } from "@/lib/runner";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json({ state: await up(params.id) });
  } catch (error) {
    return jsonError(error, 400);
  }
}
