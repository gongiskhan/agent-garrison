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

// Body: { patch: { <key>: <value> }, remove?: ["<key>", ...] }. `remove` exists
// because JSON.stringify silently DROPS undefined values — a client cannot say
// "delete this key" inside `patch` alone. Keys in `remove` are merged into the
// patch as undefined, which writeSettingsPatch deletes.
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const patch = body?.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return jsonError(new Error("Body must be { patch: { <key>: <value> } }"), 400);
    }
    const remove = body?.remove ?? [];
    if (!Array.isArray(remove) || remove.some((k) => typeof k !== "string")) {
      return jsonError(new Error("remove must be an array of key names"), 400);
    }
    const full = { ...patch } as Record<string, unknown>;
    for (const key of remove) full[key] = undefined;
    return NextResponse.json(await writeSettingsPatch(full));
  } catch (error) {
    return jsonError(error, 400);
  }
}
