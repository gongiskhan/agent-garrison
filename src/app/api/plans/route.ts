import { NextResponse, type NextRequest } from "next/server";
import { listPlans, readPlan, writePlan } from "@/lib/plans";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get("name");
    if (name) return NextResponse.json(await readPlan(name));
    return NextResponse.json({ plans: await listPlans() });
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body?.name !== "string" || typeof body?.content !== "string") {
      return jsonError(new Error("name (string) and content (string) are required"), 400);
    }
    return NextResponse.json(await writePlan(body.name, body.content));
  } catch (error) {
    return jsonError(error, 400);
  }
}
