import { NextResponse, type NextRequest } from "next/server";
import { setStandingConfig } from "../../model";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/muster/standing/config
// Body: { composition?, faculty, fittingId, key, value }
// Autosave one config value into a standing fitting's selection[].config. No
// Save button - a discrete change persists immediately; the client debounces
// text/number edits. Returns the fresh standing model.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      composition?: unknown;
      faculty?: unknown;
      fittingId?: unknown;
      key?: unknown;
      value?: unknown;
    };
    const composition = typeof body.composition === "string" ? body.composition.trim() || undefined : undefined;
    const faculty = typeof body.faculty === "string" ? body.faculty.trim() : "";
    const fittingId = typeof body.fittingId === "string" ? body.fittingId.trim() : "";
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!faculty) return jsonError(new Error("faculty is required"), 400);
    if (!fittingId) return jsonError(new Error("fittingId is required"), 400);
    if (!key) return jsonError(new Error("key is required"), 400);
    const value = body.value;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return jsonError(new Error("value must be a string, number, or boolean"), 400);
    }

    const model = await setStandingConfig(composition, faculty, fittingId, key, value);
    return NextResponse.json(model);
  } catch (error) {
    return jsonError(error, 400);
  }
}
