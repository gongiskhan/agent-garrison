import { NextResponse, type NextRequest } from "next/server";
import { readSettingsView, writeSettingsPatch } from "@/lib/settings";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await readSettingsView());
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const patch = body?.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return jsonError(new Error("Body must be { patch: { <key>: <value> } }"), 400);
    }
    return NextResponse.json(await writeSettingsPatch(patch));
  } catch (error) {
    return jsonError(error, 400);
  }
}
