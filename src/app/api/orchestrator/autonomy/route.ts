// GET /api/orchestrator/autonomy?composition=<id>
//
// The router's track record per (decision category, work shape), with the band
// each one currently sits in. Read-only and derived — every number here is folded
// fresh from the append-only verdict and decision logs, so nothing it reports can
// drift away from evidence someone can go and read.
//
// The fold starts from the COLD-START SEED (brief §7.3): the Phase 0 mined task
// volumes, capped by the expander so inferred history can reach act-revert on the
// common shapes but never act-inform. A composition may carry its own
// .garrison/autonomy-seed.json; the shipped orchestrator seed is the fallback.
// A missing or unreadable seed degrades to a cold start, never to an error —
// asking too often is an annoyance, failing the panel is a lie about the tracks.

import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { COMPOSITIONS_DIR } from "@/lib/paths";
import { summariseTracks } from "@/lib/routing-tracks";
import { jsonError } from "@/lib/http";

const SEED_EXPANDER_PATH = path.join(
  process.cwd(),
  "fittings/seed/orchestrator/lib/autonomy-seed.mjs"
);
const SHIPPED_SEED_PATH = path.join(
  process.cwd(),
  "fittings/seed/orchestrator/config/autonomy-seed.json"
);

interface SeedExpander {
  expandAutonomySeed: (doc: unknown, opts?: Record<string, unknown>) => { shape: string; category: string }[];
}

let expander: Promise<SeedExpander> | null = null;
function loadExpander(): Promise<SeedExpander> {
  expander ??= import(/* webpackIgnore: true */ pathToFileURL(SEED_EXPANDER_PATH).href) as Promise<SeedExpander>;
  return expander;
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function loadSeedEntries(compositionDir: string): Promise<{ shape: string; category: string }[]> {
  try {
    const doc =
      (await readJson(path.join(compositionDir, ".garrison", "autonomy-seed.json"))) ??
      (await readJson(SHIPPED_SEED_PATH));
    if (!doc) return [];
    const { expandAutonomySeed } = await loadExpander();
    return expandAutonomySeed(doc);
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  try {
    const composition = request.nextUrl.searchParams.get("composition") || "default";
    // Confine to a composition directory: the id reaches us from the client.
    if (!/^[a-zA-Z0-9._-]+$/.test(composition)) {
      return jsonError(new Error("invalid composition id"), 400);
    }
    const dir = path.join(COMPOSITIONS_DIR, composition);
    const seed = await loadSeedEntries(dir);
    const tracks = await summariseTracks(dir, { seed });
    return NextResponse.json({
      composition,
      tracks,
      seeded: seed.length > 0,
      // Surfaced so the panel can explain a band rather than just assert it.
      asking: tracks.filter((t) => t.band.band === "ask").length,
      autonomous: tracks.filter((t) => t.band.band === "act-inform").length
    });
  } catch (error) {
    return jsonError(error, 500);
  }
}
