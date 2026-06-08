import { NextResponse } from "next/server";
import { computeSettingsDrift } from "@/lib/settings";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only drift probe for the live banner. The SettingsPanel polls this while
// idle (visibility-gated) so an external edit to settings.json (Claude Code's
// /model, permission approvals, a hand-edit) surfaces without a manual reload.
// computeSettingsDrift never establishes a baseline, so polling has no side
// effects and Garrison's own saves stay echo-suppressed.
export async function GET() {
  try {
    return NextResponse.json(await computeSettingsDrift());
  } catch (error) {
    return jsonError(error, 400);
  }
}
