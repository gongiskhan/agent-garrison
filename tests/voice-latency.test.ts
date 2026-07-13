import { describe, it, expect } from "vitest";
import {
  LatencyTracker,
  FIRST_AUDIO_BUDGET_MS
} from "../fittings/seed/web-channel-default/ui/voice-latency";

// S6b / #28 - unit tests for the end-of-speech -> first-audio latency tracker.
// Pure + host-agnostic: timestamps are injected, so the 2s budget verdict and
// the per-stage breakdown are deterministic with no clock.

describe("LatencyTracker marks", () => {
  it("records and returns a copy of the marks", () => {
    const t = new LatencyTracker();
    t.mark("a", 100);
    t.mark("b", 250);
    const marks = t.getMarks();
    expect(marks).toEqual([
      { stage: "a", ts: 100 },
      { stage: "b", ts: 250 }
    ]);
    // getMarks returns a copy - mutating it does not corrupt the tracker.
    marks.push({ stage: "x", ts: 0 });
    expect(t.getMarks()).toHaveLength(2);
  });

  it("reset clears the marks", () => {
    const t = new LatencyTracker();
    t.mark("a", 1);
    t.reset();
    expect(t.getMarks()).toEqual([]);
  });
});

describe("between()", () => {
  it("measures the LAST from-mark to the FIRST to-mark that follows it", () => {
    const t = new LatencyTracker();
    t.mark("utterance_end", 100);
    t.mark("utterance_end", 500); // a re-arm; the last one wins
    t.mark("tts_first_audio", 900);
    t.mark("tts_first_audio", 1500);
    expect(t.between("utterance_end", "tts_first_audio")).toBe(400); // 900 - 500
  });

  it("is null when the from-mark is absent", () => {
    const t = new LatencyTracker();
    t.mark("tts_first_audio", 100);
    expect(t.between("utterance_end", "tts_first_audio")).toBeNull();
  });

  it("is null when the to-mark never occurs at/after the from-mark", () => {
    const t = new LatencyTracker();
    t.mark("tts_first_audio", 50); // before
    t.mark("utterance_end", 100);
    expect(t.between("utterance_end", "tts_first_audio")).toBeNull();
  });
});

describe("budget verdict", () => {
  it("exposes the 2s default budget", () => {
    expect(FIRST_AUDIO_BUDGET_MS).toBe(2000);
  });

  it("is ok within budget with overBy 0", () => {
    const t = new LatencyTracker();
    t.mark("utterance_end", 0);
    t.mark("tts_first_audio", 1200);
    const v = t.budget();
    expect(v).toEqual({ ms: 1200, ok: true, budgetMs: 2000, overBy: 0 });
  });

  it("is not ok over budget and reports overBy", () => {
    const t = new LatencyTracker();
    t.mark("utterance_end", 0);
    t.mark("tts_first_audio", 2600);
    const v = t.budget();
    expect(v.ms).toBe(2600);
    expect(v.ok).toBe(false);
    expect(v.overBy).toBe(600);
  });

  it("honors a custom budget", () => {
    const t = new LatencyTracker();
    t.mark("utterance_end", 0);
    t.mark("tts_first_audio", 900);
    expect(t.budget(800)).toMatchObject({ ok: false, overBy: 100 });
  });

  it("is unmeasurable (all null) when a required mark is missing", () => {
    const t = new LatencyTracker();
    t.mark("utterance_end", 0);
    expect(t.budget()).toEqual({ ms: null, ok: null, budgetMs: 2000, overBy: null });
  });

  it("endOfSpeechToFirstAudioMs is the headline metric", () => {
    const t = new LatencyTracker();
    t.mark("utterance_end", 100);
    t.mark("tts_first_audio", 1700);
    expect(t.endOfSpeechToFirstAudioMs()).toBe(1600);
  });
});

describe("per-stage breakdown", () => {
  it("reports each stage relative to end-of-speech", () => {
    const t = new LatencyTracker();
    t.mark("utterance_end", 1000);
    t.mark("send", 1050);
    t.mark("reply_ready", 1600);
    t.mark("tts_first_audio", 1800);
    expect(t.stages()).toEqual([
      { stage: "send", ms: 50 },
      { stage: "reply_ready", ms: 600 },
      { stage: "tts_first_audio", ms: 800 }
    ]);
  });

  it("excludes marks before end-of-speech and the base mark itself", () => {
    const t = new LatencyTracker();
    t.mark("audio_in", 500); // before end-of-speech
    t.mark("utterance_end", 1000);
    t.mark("tts_first_audio", 1400);
    expect(t.stages()).toEqual([{ stage: "tts_first_audio", ms: 400 }]);
  });

  it("is empty when there is no end-of-speech base", () => {
    const t = new LatencyTracker();
    t.mark("tts_first_audio", 400);
    expect(t.stages()).toEqual([]);
  });
});
