import { describe, it, expect, afterEach, vi } from "vitest";
import { DEFAULT_CHUNK_CHARS, SegmentGate, chunkSpeech, rmsLevel, pickRecorderMimeType, sttUrlFor } from "../packages/talk/ui/voice-clip";

// The pure half of the REST voice-clip path. The capture loop itself needs a
// microphone and a MediaRecorder, but every decision it makes is delegated to
// these four: the level meter, the segmentation gate, the recorder container
// choice, and the TTS text splitter. A wrong threshold here is a segment that
// never closes (the reply never comes) or one that closes on every breath, and
// a wrong split is a Deepgram 400 on long replies - none of which the UI shows
// as anything other than "voice is flaky".

const TICK = 50;

type GateOpts = ConstructorParameters<typeof SegmentGate>[0];

const baseOpts: GateOpts = {
  silenceMs: 1000,
  onsetTicks: 3,
  idleRestartMs: 10_000,
  maxUtteranceMs: 60_000,
  speechThreshold: 0.1
};

const LOUD = 0.5;
const QUIET = 0.01;

function gateAt(now = 0, overrides: Partial<GateOpts> = {}): SegmentGate {
  return new SegmentGate({ ...baseOpts, ...overrides }, now);
}

/** Feed one level per tick starting at `from`; returns verdicts and the next `now`. */
function feed(g: SegmentGate, levels: number[], from: number): { verdicts: string[]; now: number } {
  const verdicts: string[] = [];
  let now = from;
  for (const level of levels) {
    verdicts.push(g.tick(level, now));
    now += TICK;
  }
  return { verdicts, now };
}

const ticks = (level: number, n: number) => Array.from({ length: n }, () => level);

describe("rmsLevel", () => {
  it("is 0 for an empty buffer", () => {
    expect(rmsLevel(new Uint8Array(0))).toBe(0);
    expect(rmsLevel([])).toBe(0);
  });

  it("is 0 for silence, which in an 8-bit time-domain buffer is the 128 centre line", () => {
    expect(rmsLevel(new Uint8Array(1024).fill(128))).toBe(0);
  });

  it("is 1 for a full-scale square wave", () => {
    const square = Uint8Array.from({ length: 1024 }, (_, i) => (i % 2 ? 255 : 0));
    expect(rmsLevel(square)).toBeCloseTo(1, 6);
  });

  it("treats an all-zero byte buffer as a signal pinned to the negative rail, not silence", () => {
    expect(rmsLevel(new Uint8Array(256).fill(0))).toBe(1);
  });

  it("applies a x3 gain so quiet speech registers on the meter", () => {
    const quarter = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 160 : 96));
    expect(rmsLevel(quarter)).toBeCloseTo(0.75, 6);
  });

  it("grows with amplitude and clamps at 1", () => {
    const squareOf = (amp: number) => Uint8Array.from({ length: 512 }, (_, i) => 128 + (i % 2 ? amp : -amp));
    const levels = [4, 8, 16, 32].map((a) => rmsLevel(squareOf(a)));
    for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]);
    expect(rmsLevel(squareOf(64))).toBe(1);
    expect(rmsLevel(squareOf(127))).toBe(1);
  });

  it("accepts any ArrayLike, not only typed arrays", () => {
    expect(rmsLevel([96, 160, 96, 160])).toBeCloseTo(0.75, 6);
  });
});

describe("pickRecorderMimeType", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubRecorder = (supported: string[] | null) => {
    vi.stubGlobal("window", {
      MediaRecorder: supported === null ? {} : { isTypeSupported: (t: string) => supported.includes(t) }
    });
  };

  it("returns an empty string outside a browser", () => {
    expect(typeof (globalThis as any).window).toBe("undefined");
    expect(pickRecorderMimeType()).toBe("");
  });

  it("returns an empty string when MediaRecorder is missing or cannot answer", () => {
    vi.stubGlobal("window", {});
    expect(pickRecorderMimeType()).toBe("");
    stubRecorder(null);
    expect(pickRecorderMimeType()).toBe("");
  });

  it("prefers webm/opus, then plain webm, then mp4, then ogg/opus", () => {
    const all = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    stubRecorder(all);
    expect(pickRecorderMimeType()).toBe("audio/webm;codecs=opus");
    stubRecorder(["audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]);
    expect(pickRecorderMimeType()).toBe("audio/webm");
    stubRecorder(["audio/ogg;codecs=opus", "audio/mp4"]);
    expect(pickRecorderMimeType()).toBe("audio/mp4");
    stubRecorder(["audio/ogg;codecs=opus"]);
    expect(pickRecorderMimeType()).toBe("audio/ogg;codecs=opus");
  });

  it("returns an empty string when the browser supports none of the accepted containers", () => {
    stubRecorder(["audio/wav", "video/webm"]);
    expect(pickRecorderMimeType()).toBe("");
  });
});

describe("SegmentGate onset", () => {
  it("reports onset on the tick that completes onsetTicks consecutive loud samples", () => {
    const g = gateAt();
    const { verdicts } = feed(g, ticks(LOUD, 3), 0);
    expect(verdicts).toEqual(["none", "none", "onset"]);
    expect(g.hasSpeech).toBe(true);
  });

  it("a quiet tick between loud ticks restarts the onset count", () => {
    const g = gateAt();
    const { verdicts, now } = feed(g, [LOUD, LOUD, QUIET, LOUD, LOUD], 0);
    expect(verdicts).toEqual(["none", "none", "none", "none", "none"]);
    expect(g.hasSpeech).toBe(false);
    expect(g.tick(LOUD, now)).toBe("onset");
  });

  it("a level equal to the threshold is quiet", () => {
    const g = gateAt(0, { speechThreshold: 0.1 });
    const { verdicts } = feed(g, ticks(0.1, 6), 0);
    expect(verdicts.every((v) => v === "none")).toBe(true);
    expect(g.hasSpeech).toBe(false);
  });

  it("reports onset once per segment, even when speech pauses and resumes", () => {
    const g = gateAt();
    let r = feed(g, ticks(LOUD, 6), 0);
    expect(r.verdicts.filter((v) => v === "onset")).toHaveLength(1);
    // A pause shorter than silenceMs, then speech again: no second onset.
    r = feed(g, ticks(QUIET, 4), r.now);
    expect(r.verdicts.every((v) => v === "none")).toBe(true);
    r = feed(g, ticks(LOUD, 6), r.now);
    expect(r.verdicts.every((v) => v === "none")).toBe(true);
  });
});

describe("SegmentGate silence cut", () => {
  it("cuts exactly silenceMs after the last loud tick that counted as speech", () => {
    const g = gateAt();
    const loud = feed(g, ticks(LOUD, 5), 0);
    const lastLoudAt = loud.now - TICK;
    let now = loud.now;
    const before: string[] = [];
    while (now < lastLoudAt + baseOpts.silenceMs) {
      before.push(g.tick(QUIET, now));
      now += TICK;
    }
    expect(before.every((v) => v === "none")).toBe(true);
    expect(now).toBe(lastLoudAt + baseOpts.silenceMs);
    expect(g.tick(QUIET, now)).toBe("cut");
  });

  it("a gap shorter than silenceMs does not cut; the timer restarts from the resumed speech", () => {
    const g = gateAt();
    let r = feed(g, ticks(LOUD, 4), 0);
    r = feed(g, ticks(QUIET, 10), r.now);
    expect(r.verdicts.every((v) => v === "none")).toBe(true);
    r = feed(g, ticks(LOUD, 4), r.now);
    expect(r.verdicts.every((v) => v === "none")).toBe(true);
    const resumedLastLoudAt = r.now - TICK;
    let now = r.now;
    let cutAt = -1;
    for (let i = 0; i < 40 && cutAt < 0; i++) {
      if (g.tick(QUIET, now) === "cut") cutAt = now;
      now += TICK;
    }
    expect(cutAt).toBe(resumedLastLoudAt + baseOpts.silenceMs);
  });

  it("cut fires once per gap; continued silence after it is quiet", () => {
    const g = gateAt();
    let r = feed(g, ticks(LOUD, 4), 0);
    r = feed(g, ticks(QUIET, 30), r.now);
    expect(r.verdicts.filter((v) => v === "cut")).toHaveLength(1);
    const after = feed(g, ticks(QUIET, 20), r.now);
    expect(after.verdicts.every((v) => v === "none")).toBe(true);
    expect(g.hasSpeech).toBe(true);
  });

  it("silence before any speech never cuts", () => {
    const g = gateAt();
    const { verdicts } = feed(g, ticks(QUIET, 100), 0);
    expect(verdicts.includes("cut")).toBe(false);
  });
});

describe("SegmentGate bounds", () => {
  it("cuts speech that never pauses at maxUtteranceMs from the segment start", () => {
    const g = gateAt(0, { maxUtteranceMs: 2000 });
    let now = 0;
    const seen: Array<[number, string]> = [];
    while (now <= 2000) {
      seen.push([now, g.tick(LOUD, now)]);
      now += TICK;
    }
    const cuts = seen.filter(([, v]) => v === "cut");
    expect(cuts).toEqual([[2000, "cut"]]);
    expect(seen.filter(([, v]) => v === "onset")).toHaveLength(1);
  });

  it("discards a segment with no speech at idleRestartMs", () => {
    const g = gateAt(0, { idleRestartMs: 1000 });
    let now = 0;
    const seen: Array<[number, string]> = [];
    while (now <= 1000) {
      seen.push([now, g.tick(QUIET, now)]);
      now += TICK;
    }
    expect(seen.filter(([, v]) => v !== "none")).toEqual([[1000, "discard"]]);
    expect(g.hasSpeech).toBe(false);
  });

  it("sub-onset blips do not count as speech, so the segment is still discarded", () => {
    const g = gateAt(0, { idleRestartMs: 1000, onsetTicks: 3 });
    const pattern = Array.from({ length: 21 }, (_, i) => (i % 3 === 2 ? QUIET : LOUD));
    const { verdicts } = feed(g, pattern, 0);
    expect(verdicts.includes("onset")).toBe(false);
    expect(verdicts[verdicts.length - 1]).toBe("discard");
    expect(g.hasSpeech).toBe(false);
  });

  it("a segment that has speech is never discarded", () => {
    const g = gateAt(0, { idleRestartMs: 1000, maxUtteranceMs: 60_000 });
    const r = feed(g, ticks(LOUD, 3), 0);
    const quiet = feed(g, ticks(QUIET, 100), r.now);
    expect(quiet.verdicts.includes("discard")).toBe(false);
    expect(quiet.verdicts.filter((v) => v === "cut")).toHaveLength(1);
  });
});

describe("SegmentGate restart", () => {
  it("clears hasSpeech and lets onset fire again", () => {
    const g = gateAt();
    let r = feed(g, ticks(LOUD, 4), 0);
    r = feed(g, ticks(QUIET, 30), r.now);
    expect(g.hasSpeech).toBe(true);
    g.restart(r.now);
    expect(g.hasSpeech).toBe(false);
    const again = feed(g, ticks(LOUD, 3), r.now);
    expect(again.verdicts).toEqual(["none", "none", "onset"]);
  });

  it("restarts the idle and max-utterance clocks from the new segment start", () => {
    const g = gateAt(0, { idleRestartMs: 1000, maxUtteranceMs: 2000 });
    feed(g, ticks(QUIET, 10), 0);
    g.restart(5000);
    let now = 5000;
    const idle: Array<[number, string]> = [];
    while (now <= 6000) {
      idle.push([now, g.tick(QUIET, now)]);
      now += TICK;
    }
    expect(idle.filter(([, v]) => v !== "none")).toEqual([[6000, "discard"]]);

    g.restart(10_000);
    now = 10_000;
    const spoken: Array<[number, string]> = [];
    while (now <= 12_000) {
      spoken.push([now, g.tick(LOUD, now)]);
      now += TICK;
    }
    expect(spoken.filter(([, v]) => v === "cut")).toEqual([[12_000, "cut"]]);
  });

  it("drops a half-counted onset", () => {
    const g = gateAt();
    feed(g, ticks(LOUD, 2), 0);
    g.restart(100);
    expect(g.tick(LOUD, 100)).toBe("none");
    expect(g.tick(LOUD, 150)).toBe("none");
    expect(g.tick(LOUD, 200)).toBe("onset");
  });
});

describe("SegmentGate adaptive threshold", () => {
  const adaptive: GateOpts = { silenceMs: 1000, onsetTicks: 3, idleRestartMs: 10_000, maxUtteranceMs: 60_000 };

  it("a fresh gate treats a modest level as speech", () => {
    const g = new SegmentGate(adaptive, 0);
    expect(g.threshold).toBeGreaterThan(0.02);
    expect(g.threshold).toBeLessThan(0.05);
    expect(feed(g, ticks(0.05, 3), 0).verdicts).toEqual(["none", "none", "onset"]);
  });

  it("a noisy room raises the threshold above levels a quiet room would call speech", () => {
    const g = new SegmentGate(adaptive, 0);
    const fresh = g.threshold;
    feed(g, ticks(0.03, 200), 0);
    expect(g.threshold).toBeGreaterThan(fresh);
    expect(g.threshold).toBeGreaterThan(0.05);
    expect(g.hasSpeech).toBe(false);
    const r = feed(g, ticks(0.05, 10), 10_000);
    expect(r.verdicts.includes("onset")).toBe(false);
  });

  it("never lets the floor pull the threshold under the minimum", () => {
    const g = new SegmentGate(adaptive, 0);
    feed(g, ticks(0, 500), 0);
    expect(g.threshold).toBeCloseTo(0.02, 6);
  });

  it("loud ticks do not move the floor", () => {
    const g = new SegmentGate(adaptive, 0);
    const before = g.threshold;
    feed(g, ticks(0.9, 40), 0);
    expect(g.threshold).toBe(before);
  });

  it("an explicit speechThreshold is fixed regardless of the room", () => {
    const g = gateAt(0, { speechThreshold: 0.1 });
    feed(g, ticks(0.09, 300), 0);
    expect(g.threshold).toBe(0.1);
    feed(g, ticks(0, 300), 15_000);
    expect(g.threshold).toBe(0.1);
  });
});

describe("chunkSpeech", () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean);

  it("returns no chunks for empty or whitespace-only text", () => {
    expect(chunkSpeech("")).toEqual([]);
    expect(chunkSpeech("   \n\t ")).toEqual([]);
    expect(chunkSpeech(undefined as unknown as string)).toEqual([]);
  });

  it("collapses whitespace and returns one chunk when the text fits", () => {
    expect(chunkSpeech("  Hello   world.\n\nBye.  ", 100)).toEqual(["Hello world. Bye."]);
  });

  it("a text exactly at the limit is one chunk", () => {
    expect(chunkSpeech("x".repeat(10), 10)).toEqual(["x".repeat(10)]);
  });

  it("splits at sentence ends, packing as many sentences as fit", () => {
    expect(chunkSpeech("First sentence here. Second sentence here. Third one.", 40)).toEqual([
      "First sentence here.",
      "Second sentence here. Third one."
    ]);
  });

  it("question and exclamation marks end sentences", () => {
    expect(chunkSpeech("Really?! Yes. Okay then.", 10)).toEqual(["Really?!", "Yes.", "Okay then."]);
  });

  it("keeps a closing quote with its sentence", () => {
    expect(chunkSpeech('He said "Go." Then left.', 15)).toEqual(['He said "Go."', "Then left."]);
  });

  it("every chunk of a long multi-sentence text respects the limit and no word is lost", () => {
    const sentences = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} has ${"more ".repeat(i % 7)}words in it.`);
    const text = sentences.join(" ");
    const out = chunkSpeech(text, 120);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(120);
      expect(c).toBe(c.trim());
      expect(c.endsWith(".")).toBe(true);
    }
    expect(words(out.join(" "))).toEqual(words(text));
  });

  it("cuts an overlong sentence at clause marks", () => {
    const text = "a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y, z";
    const out = chunkSpeech(text, 20);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(20);
    for (const c of out.slice(0, -1)) expect(c.endsWith(",")).toBe(true);
    expect(out.join(" ")).toBe(text);
  });

  it("cuts an overlong unpunctuated run at spaces without splitting words", () => {
    const text = "one two three four five six";
    const out = chunkSpeech(text, 10);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(10);
    expect(out.join(" ")).toBe(text);
  });

  it("hard-cuts an unbroken token at the limit", () => {
    expect(chunkSpeech("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("a short sentence followed by an overlong one keeps both under the limit", () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const out = chunkSpeech(`Short one. ${long}`, 40);
    expect(out[0]).toBe("Short one.");
    for (const c of out) expect(c.length).toBeLessThanOrEqual(40);
    expect(words(out.join(" "))).toEqual(words(`Short one. ${long}`));
  });

  it("keeps a space between an overlong sentence's remainder and the next sentence", () => {
    // The remainder is trimmed when the overlong sentence is cut; without the
    // separator being restored, "tail.Next" is spoken as one word.
    const long = `${"alpha ".repeat(8)}tail.`;
    const out = chunkSpeech(`${long} Next. Last.`, 30);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(30);
    expect(out.join(" ")).not.toMatch(/\.[A-Za-z]/);
    expect(words(out.join(" "))).toEqual(words(`${long} Next. Last.`));
  });

  it("defaults to the voice layer's 600-character /tts budget", () => {
    expect(DEFAULT_CHUNK_CHARS).toBe(600);
    const text = Array.from({ length: 120 }, (_, i) => `This is reply sentence ${i}, spoken aloud by the assistant.`).join(" ");
    expect(text.length).toBeGreaterThan(4000);
    const out = chunkSpeech(text);
    expect(out.length).toBeGreaterThan(6);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(600);
    expect(words(out.join(" "))).toEqual(words(text));
    expect(chunkSpeech("short reply.")).toEqual(["short reply."]);
  });

  it("splits a reply of about a thousand characters into pieces the service will accept", () => {
    // The shape that 400ed in review: one long reply, fine for Deepgram's
    // 2000-character limit, over the service's per-request budget.
    const text = Array.from({ length: 18 }, (_, i) => `Point ${i + 1}: the runner heals a keyless fitting on unlock.`).join(" ");
    expect(text.length).toBeGreaterThan(900);
    expect(text.length).toBeLessThan(1200);
    const out = chunkSpeech(text);
    expect(out.length).toBeGreaterThanOrEqual(2);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(600);
    expect(words(out.join(" "))).toEqual(words(text));
    // The advertised cap wins over the default when the health probe named one.
    for (const c of chunkSpeech(text, 400)) expect(c.length).toBeLessThanOrEqual(400);
  });
});

// The language hint (D52): the server pins its wake lane to Portuguese, so the
// typed lane says which language the browser's clips are in on every request.
describe("sttUrlFor", () => {
  it("appends the language as a query parameter", () => {
    expect(sttUrlFor("/api/voice/stt", "en")).toBe("/api/voice/stt?language=en");
  });
  it("joins an existing query with &", () => {
    expect(sttUrlFor("/api/voice/stt?x=1", "pt")).toBe("/api/voice/stt?x=1&language=pt");
  });
  it("consults a function per call so a mid-dictation switch reaches the next clip", () => {
    let lang = "en";
    const pick = () => lang;
    expect(sttUrlFor("/stt", pick)).toBe("/stt?language=en");
    lang = "multi";
    expect(sttUrlFor("/stt", pick)).toBe("/stt?language=multi");
  });
  it("leaves the URL alone without a hint", () => {
    expect(sttUrlFor("/stt", undefined)).toBe("/stt");
    expect(sttUrlFor("/stt", () => null)).toBe("/stt");
    expect(sttUrlFor("/stt", "  ")).toBe("/stt");
  });
});
