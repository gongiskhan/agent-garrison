// The cold-start seed (brief §7.3): the Phase 0 mined task volumes, shipped as
// data, expanded into seedFromHistory entries with a hard cap per shape.
//
// The cap is the load-bearing part. Seeded weight lands in `positive`, which
// SILENCE_CAP does not bound, so uncapped mined volumes (280 fix commits) would
// buy act-inform from inferred history alone — the exact invariant
// routing-autonomy's own docs say must never break. At the default silence
// weight, 50 entries land confidence exactly ON the lower threshold: the shape
// starts above ask and below act-inform. These tests pin that arithmetic to the
// SHIPPED seed file, so editing the counts or the weight without rethinking the
// posture fails loudly.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  expandAutonomySeed,
  SEED_CAP_DEFAULT,
  SEED_CATEGORIES
} from "../fittings/seed/orchestrator/lib/autonomy-seed.mjs";
import {
  seedFromHistory,
  confidenceOf,
  bandFor,
  trackKey,
  CATEGORIES,
  DEFAULT_THRESHOLDS
} from "../fittings/seed/orchestrator/lib/routing-autonomy.mjs";

interface SeedEntry {
  shape: string;
  category: string;
}

const SEED_PATH = path.join(process.cwd(), "fittings/seed/orchestrator/config/autonomy-seed.json");
const ROUTING_SEED_PATH = path.join(process.cwd(), "fittings/seed/orchestrator/config/routing.seed.json");
const seedDoc = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));

describe("expandAutonomySeed", () => {
  it("emits one entry per historical task per category, capped", () => {
    const entries: SeedEntry[] = expandAutonomySeed({ cap: 3, shapes: { fix: 10, research: 2 } });
    const fixFlow = entries.filter((e) => e.shape === "fix" && e.category === "flow");
    const fixLevel = entries.filter((e) => e.shape === "fix" && e.category === "level");
    const research = entries.filter((e) => e.shape === "research");
    expect(fixFlow).toHaveLength(3);
    expect(fixLevel).toHaveLength(3);
    // Below the cap the true count survives — a rare shape must not be inflated.
    expect(research).toHaveLength(2 * SEED_CATEGORIES.length);
  });

  it("degrades malformed input to a cold start, never a crash", () => {
    expect(expandAutonomySeed(null)).toEqual([]);
    expect(expandAutonomySeed([])).toEqual([]);
    expect(expandAutonomySeed({ shapes: null })).toEqual([]);
    expect(
      (expandAutonomySeed({ shapes: { fix: "many", "": 5, ops: -2, docs: 1.9 } }) as SeedEntry[]).map((e) => e.shape)
    ).toEqual(["docs", "docs"]); // only the one clean count survives, truncated, both categories
  });

  it("defaults the cap when the document names none", () => {
    const entries: SeedEntry[] = expandAutonomySeed({ shapes: { fix: 500 } });
    expect(entries.filter((e) => e.category === "flow")).toHaveLength(SEED_CAP_DEFAULT);
  });

  it("keeps its category list in lockstep with routing-autonomy", () => {
    expect([...SEED_CATEGORIES]).toEqual([...CATEGORIES]);
  });
});

describe("the shipped seed document", () => {
  it("parses, and names only shapes the shipped flow library defines", () => {
    const flows = Object.keys(JSON.parse(fs.readFileSync(ROUTING_SEED_PATH, "utf8")).flows);
    for (const shape of Object.keys(seedDoc.shapes)) {
      expect(flows, `seed shape "${shape}" is not a shipped flow`).toContain(shape);
    }
  });

  it("starts the common shapes at act-revert — above ask, never act-inform", () => {
    const tracks = seedFromHistory(expandAutonomySeed(seedDoc));
    for (const shape of ["fix", "feature", "docs", "chore"]) {
      for (const category of CATEGORIES) {
        const track = tracks[trackKey(category, shape)];
        expect(track, `${category}/${shape} missing from seed fold`).toBeTruthy();
        const band = bandFor(track, { action: "code-change" });
        expect(band.band, `${category}/${shape}`).toBe("act-revert");
        // The cap lands exactly on the lower threshold; drifting above it means
        // someone raised the cap or the weight without redoing this arithmetic.
        expect(confidenceOf(track)).toBeLessThanOrEqual(DEFAULT_THRESHOLDS.lower + 1e-9);
      }
    }
  });

  it("leaves genuinely rare shapes asking", () => {
    const tracks = seedFromHistory(expandAutonomySeed(seedDoc));
    for (const shape of ["research", "ops", "image"]) {
      const track = tracks[trackKey("flow", shape)];
      expect(track).toBeTruthy();
      expect(bandFor(track, { action: "code-change" }).band).toBe("ask");
    }
  });
});
