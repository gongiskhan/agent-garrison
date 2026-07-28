// Run-video tightening (S1): the pure window/remap math behind the highlight
// cut. No ffmpeg, no filesystem — buildTightVideo's I/O is exercised by the
// evidence e2e test; everything decision-shaped lives here.
import { describe, it, expect } from "vitest";

import {
  TIGHTEN_DEFAULTS,
  computeActivityWindows,
  segmentsDuration,
  remapOffset,
  buildSelectFilter
} from "../fittings/seed/drill/lib/video-tighten.mjs";

const frames = (...secs: number[]) => secs.map((s) => ({ tMs: s * 1000 }));
const steps = (...secs: number[]) => secs.map((s, i) => ({ stepId: `c${i}`, startMs: s * 1000 }));

describe("computeActivityWindows", () => {
  it("keeps a window around each change and drops the dead air between", () => {
    // Two changes 100s apart in a 200s recording: the result must be two short
    // segments, not one long one.
    const segs = computeActivityWindows({ frames: frames(10, 110), steps: [], durationSec: 200 });
    expect(segs).toHaveLength(2);
    expect(segs[0][0]).toBeCloseTo(9.0);
    expect(segs[0][1]).toBeCloseTo(11.5);
    expect(segmentsDuration(segs)).toBeCloseTo(5.0);
  });

  it("merges windows that nearly touch instead of emitting a jump cut", () => {
    // 10s and 12s: gap between windows is 12-1 - (10+1.5) = 0.5s < mergeGapSec.
    const segs = computeActivityWindows({ frames: frames(10, 12), steps: [], durationSec: 100 });
    expect(segs).toHaveLength(1);
    expect(segs[0][0]).toBeCloseTo(9.0);
    expect(segs[0][1]).toBeCloseTo(13.5);
  });

  it("gives every check an anchor window so no chapter is orphaned", () => {
    // The check at 50s produced no spotter frames at all.
    const segs = computeActivityWindows({ frames: frames(5), steps: steps(5, 50), durationSec: 100 });
    expect(segs).toHaveLength(2);
    const remapped = remapOffset(segs, 50);
    expect(remapped).toBeGreaterThan(0);
    expect(remapped).toBeLessThan(segmentsDuration(segs));
  });

  it("clamps windows to the real recording and ignores frames past its end", () => {
    // Wall-clock offsets drift past the video timeline; those frames must not
    // widen the cut or produce a negative/oversized window.
    const segs = computeActivityWindows({ frames: frames(0.2, 999), steps: [], durationSec: 10 });
    expect(segs).toHaveLength(1);
    expect(segs[0][0]).toBe(0);
    expect(segs[0][1]).toBeLessThanOrEqual(10);
  });

  it("coarsens rather than emitting an unbounded segment list", () => {
    const many = frames(...Array.from({ length: 3000 }, (_, i) => i * 10));
    const segs = computeActivityWindows({ frames: many, steps: [], durationSec: 30_000 });
    expect(segs.length).toBeLessThanOrEqual(TIGHTEN_DEFAULTS.maxSegments);
  });

  it("returns nothing when there is no usable duration or signal", () => {
    expect(computeActivityWindows({ frames: frames(1), steps: [], durationSec: 0 })).toEqual([]);
    expect(computeActivityWindows({ frames: [], steps: [], durationSec: 100 })).toEqual([]);
    expect(computeActivityWindows({ frames: [{ tMs: NaN } as any], steps: [], durationSec: 100 })).toEqual([]);
  });
});

describe("remapOffset", () => {
  const segs = [
    [10, 20],
    [100, 110]
  ] as Array<[number, number]>;

  it("maps a time inside a kept segment to its position in the cut", () => {
    expect(remapOffset(segs, 15)).toBeCloseTo(5);
    expect(remapOffset(segs, 105)).toBeCloseTo(15);
  });

  it("maps a time in dropped dead air forward to the next kept moment", () => {
    // Seeking to 60s (dead air) must land at the start of the next real
    // activity, not silently at 0 or past the end.
    expect(remapOffset(segs, 60)).toBeCloseTo(10);
  });

  it("maps before-the-first and after-the-last to the cut's bounds", () => {
    expect(remapOffset(segs, 0)).toBe(0);
    expect(remapOffset(segs, 5000)).toBeCloseTo(segmentsDuration(segs));
  });

  it("is monotonic — a later original moment never maps earlier", () => {
    let prev = -1;
    for (let t = 0; t <= 130; t += 0.5) {
      const r = remapOffset(segs, t)!;
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it("rejects a non-finite offset rather than returning a bogus number", () => {
    expect(remapOffset(segs, NaN)).toBeNull();
  });
});

describe("buildSelectFilter", () => {
  it("emits a frame-exact between() union (keyframe placement is ~5s, far coarser than a window)", () => {
    expect(buildSelectFilter([[1.5, 2.25]])).toBe("between(t,1.500,2.250)");
    expect(buildSelectFilter([[0, 1], [5, 6]])).toBe("between(t,0.000,1.000)+between(t,5.000,6.000)");
  });

  it("emits an empty expression for no segments (caller must not invoke ffmpeg)", () => {
    expect(buildSelectFilter([])).toBe("");
  });
});
