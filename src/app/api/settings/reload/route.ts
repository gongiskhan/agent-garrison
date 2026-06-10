import { NextResponse } from "next/server";
import { reloadSettingsView } from "@/lib/settings";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Reload from disk" (drift banner): pull the current on-disk settings AND
// advance the drift baseline so the banner clears. A plain GET /api/settings
// re-reads but never advances the baseline (by design), which is why the drift
// banner's reload needs this dedicated, side-effecting endpoint.
export async function POST() {
  try {
    return NextResponse.json(await reloadSettingsView());
  } catch (error) {
    return jsonError(error, 400);
  }
}
