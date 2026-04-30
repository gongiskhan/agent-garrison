import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ library: await readLibrary() });
  } catch (error) {
    return jsonError(error, 500);
  }
}
