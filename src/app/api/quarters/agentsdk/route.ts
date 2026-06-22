import { NextResponse } from "next/server";
import { getAgentSdkState } from "@/lib/agentsdk-state";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getAgentSdkState());
  } catch (error) {
    return jsonError(error, 400);
  }
}
