// Composed run video (walkthrough merge): the pure plan/remap/caption math
// behind the mp4 assembly. No ffmpeg, no filesystem — buildRunVideo's I/O
// degrades warn-never-throw and falls back to the tighten cut at the server
// seam; everything decision-shaped lives here.
import { describe, it, expect } from "vitest";

import {
  COMPOSE_DEFAULTS,
  buildComposePlan,
  composedDurationSec,
  remapComposedOffset,
  buildCaptions,
  captionsToSrt,
  srtTimestamp
} from "../fittings/seed/drill/lib/video-compose.mjs";
import { computeActivityWindows } from "../fittings/seed/drill/lib/video-tighten.mjs";

const windows = (...pairs: Array<[number, number]>) => pairs;

describe("buildComposePlan", () => {
  it("covers the whole recording — nothing is dropped, idle is sped up", () => {
    const plan = buildComposePlan({ windows: windows([9, 11.5], [109, 111.5]), durationSec: 200 });
    // Full coverage, in order, no gaps or overlaps.
    expect(plan[0].start).toBe(0);
    expect(plan[plan.length - 1].end).toBe(200);
    for (let i = 1; i < plan.length; i += 1) expect(plan[i].start).toBeCloseTo(plan[i - 1].end);
    // The two active windows play at 1×; the long stretches between are timelapsed.
    const active = plan.filter((s) => s.speed === 1);
    const lapsed = plan.filter((s) => s.speed > 1);
    expect(active.length).toBeGreaterThanOrEqual(2);
    expect(lapsed.length).toBeGreaterThanOrEqual(2);
    for (const seg of lapsed) {
      expect(seg.speed).toBeGreaterThanOrEqual(COMPOSE_DEFAULTS.minSpeed);
      expect(seg.speed).toBeLessThanOrEqual(COMPOSE_DEFAULTS.maxSpeed);
    }
  });

  it("folds a sub-threshold gap into 1× instead of a blink-length timelapse", () => {
    const plan = buildComposePlan({ windows: windows([0, 5], [7, 12]), durationSec: 12 });
    // The 2s gap is below minGapSec, so the whole thing plays at 1×.
    expect(plan).toEqual([{ start: 0, end: 12, speed: 1 }]);
  });

  it("plays everything at 1× when there is no activity signal", () => {
    const plan = buildComposePlan({ windows: [], durationSec: 30 });
    expect(plan).toEqual([{ start: 0, end: 30, speed: 1 }]);
  });

  it("compresses a long gap to roughly the target play time", () => {
    const plan = buildComposePlan({ windows: windows([0, 2], [102, 104]), durationSec: 104 });
    const gap = plan.find((s) => s.speed > 1)!;
    expect(gap.start).toBe(2);
    expect(gap.end).toBe(102);
    // 100s gap at speed ≤ maxSpeed: composed play time stays a few seconds.
    expect((gap.end - gap.start) / gap.speed).toBeLessThanOrEqual(3);
  });

  it("composes with the tighten window math end-to-end", () => {
    const frames = Array.from({ length: 10 }, (_, i) => ({ tMs: i * 60_000 }));
    const w = computeActivityWindows({ frames, steps: [], durationSec: 600 });
    const plan = buildComposePlan({ windows: w, durationSec: 600 });
    expect(plan[0].start).toBe(0);
    expect(plan[plan.length - 1].end).toBe(600);
    expect(composedDurationSec(plan)).toBeLessThan(600);
  });
});

describe("remapComposedOffset", () => {
  const plan = [
    { start: 0, end: 10, speed: 1 },
    { start: 10, end: 110, speed: 20 },
    { start: 110, end: 120, speed: 1 }
  ];

  it("is identity inside a 1× segment", () => {
    expect(remapComposedOffset(plan, 5)).toBeCloseTo(5);
  });

  it("compresses proportionally inside a timelapse segment", () => {
    // 40s into the 20× stretch = 2s of composed time past the 10s intro.
    expect(remapComposedOffset(plan, 50)).toBeCloseTo(10 + 2);
  });

  it("accumulates across segments and clamps past the end", () => {
    expect(remapComposedOffset(plan, 115)).toBeCloseTo(10 + 5 + 5);
    expect(remapComposedOffset(plan, 999)).toBeCloseTo(10 + 5 + 10);
  });

  it("is monotonic", () => {
    let last = -1;
    for (let t = 0; t <= 120; t += 1) {
      const v = remapComposedOffset(plan, t)!;
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it("returns null for a non-finite input", () => {
    expect(remapComposedOffset(plan, Number.NaN)).toBeNull();
  });
});

describe("buildCaptions", () => {
  const plan = [
    { start: 0, end: 10, speed: 1 },
    { start: 10, end: 110, speed: 20 },
    { start: 110, end: 120, speed: 1 }
  ];

  it("labels checks on the composed timeline, title offset included", () => {
    const captions = buildCaptions({
      plan,
      steps: [{ pageId: "home", stepId: "c1", startMs: 2000, status: "completed", title: "Header renders" }],
      titleSec: 2
    });
    const check = captions.find((c) => c.text === "Header renders")!;
    expect(check.start).toBeCloseTo(4); // 2s title + 2s into the 1× intro
  });

  it("prefixes failures and falls back to ids when there is no title", () => {
    const captions = buildCaptions({
      plan,
      steps: [{ pageId: "home", stepId: "c9", startMs: 0, status: "failed" }],
      titleSec: 0
    });
    expect(captions[0].text).toBe("FAILED: home · c9");
  });

  it("marks timelapse stretches with their speed", () => {
    const captions = buildCaptions({ plan, steps: [], titleSec: 0 });
    expect(captions.some((c) => c.text === "idle · fast-forward 20x")).toBe(true);
  });

  it("never lets entries overlap", () => {
    const captions = buildCaptions({
      plan,
      steps: [
        { pageId: "p", stepId: "a", startMs: 0, status: "completed", title: "A" },
        { pageId: "p", stepId: "b", startMs: 1000, status: "completed", title: "B" },
        { pageId: "p", stepId: "c", startMs: 2000, status: "completed", title: "C" }
      ],
      titleSec: 0
    });
    for (let i = 1; i < captions.length; i += 1) {
      expect(captions[i].start).toBeGreaterThanOrEqual(captions[i - 1].end);
    }
    for (const c of captions) expect(c.end).toBeGreaterThan(c.start);
  });
});

describe("srt output", () => {
  it("formats timestamps in SRT shape", () => {
    expect(srtTimestamp(0)).toBe("00:00:00,000");
    expect(srtTimestamp(61.25)).toBe("00:01:01,250");
    expect(srtTimestamp(3600)).toBe("01:00:00,000");
  });

  it("renders numbered cue blocks", () => {
    const srt = captionsToSrt([{ start: 1, end: 2.5, text: "Header renders" }]);
    expect(srt).toContain("1\n00:00:01,000 --> 00:00:02,500\nHeader renders");
  });
});
