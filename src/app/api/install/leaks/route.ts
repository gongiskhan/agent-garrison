import { NextResponse } from "next/server";
import { checkHomeLeaks } from "@/lib/home-leaks";
import { jsonError } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return NextResponse.json(await checkHomeLeaks()); }
  catch (error) { return jsonError(error, 400); }
}
