// GET /api/orchestrator/autonomy?composition=<id>
//
// The router's track record per (decision category, work shape), with the band
// each one currently sits in. Read-only and derived — every number here is folded
// fresh from the append-only verdict and decision logs, so nothing it reports can
// drift away from evidence someone can go and read.

import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { COMPOSITIONS_DIR } from "@/lib/paths";
import { summariseTracks } from "@/lib/routing-tracks";
import { jsonError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const composition = request.nextUrl.searchParams.get("composition") || "default";
    // Confine to a composition directory: the id reaches us from the client.
    if (!/^[a-zA-Z0-9._-]+$/.test(composition)) {
      return jsonError(new Error("invalid composition id"), 400);
    }
    const dir = path.join(COMPOSITIONS_DIR, composition);
    const tracks = await summariseTracks(dir);
    return NextResponse.json({
      composition,
      tracks,
      // Surfaced so the panel can explain a band rather than just assert it.
      asking: tracks.filter((t) => t.band.band === "ask").length,
      autonomous: tracks.filter((t) => t.band.band === "act-inform").length
    });
  } catch (error) {
    return jsonError(error, 500);
  }
}
