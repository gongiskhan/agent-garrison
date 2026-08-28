// The spoken cues - "Sim?" when the wake word lands, "Ok." when the window
// closes.
//
// The property that matters most here is NOT that a cue is spoken. It is that
// resolving one never touches the network: everything after the feedback send
// (the device haptic, the feedback_ack, and therefore wake_to_device_ack_ms) is
// waiting on this call, and the whole point of a wake cue is immediacy. So the
// zero-fetch assertions below are load-bearing, not incidental.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Counters, CaptureStore } from "../fittings/seed/capture-service/lib/store.mjs";
import { ZecaVoice, clipId } from "../fittings/seed/capture-service/lib/tts.mjs";
import { Cues, CUE_TEXT } from "../fittings/seed/capture-service/lib/cues.mjs";
import { EchoGuard } from "../fittings/seed/capture-service/lib/echo-guard.mjs";

const VOICE = "RlGHmE2fztwdBDat0jYf";
const MODEL = "eleven_multilingual_v2";

function harness(overrides: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "zeca-cues-"));
  const stateDir = path.join(home, "capture");
  new CaptureStore(stateDir);
  const counters = new Counters(stateDir, "cues");
  const calls: string[] = [];
  const cfg = {
    stateDir,
    cueEnabled: true,
    ttsEnabled: true,
    ttsVoiceId: VOICE,
    ttsModel: MODEL,
    ttsCacheMaxClips: 500,
    secrets: { elevenLabsApiKey: "sk_test_key" },
    ...overrides
  };
  const voice = new ZecaVoice({
    cfg,
    counters,
    log: { log: () => {}, error: () => {} },
    fetchImpl: async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from("ID3fake-mp3"),
        text: async () => ""
      };
    }
  });
  const cues = new Cues({ cfg, voice, counters, log: { log: () => {}, error: () => {} } });
  return { cues, voice, counters, calls, cfg, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("cues - the catalog", () => {
  it("speaks the wake word and the window close, in either language", () => {
    const h = harness();
    try {
      expect(h.cues.speechFor("wake_detected", "pt")?.text).toBe("Sim?");
      expect(h.cues.speechFor("wake_detected", "en")?.text).toBe("Yes?");
      expect(h.cues.speechFor("window_closed", "pt")?.text).toBe("Ok.");
      expect(h.cues.speechFor("window_closed", "en")?.text).toBe("Okay.");
    } finally {
      h.cleanup();
    }
  });

  // Each of these would actively make the product worse, so they are pinned
  // rather than left to whoever next edits the table.
  it("stays silent for the events that must not speak", () => {
    const h = harness();
    try {
      // Fires repeatedly, mid-sentence - it would talk over the wearer.
      expect(h.cues.speechFor("segment_captured", "pt")).toBeNull();
      // The ack lane already speaks these; a cue would say it twice, seconds
      // apart, in two different voices.
      expect(h.cues.speechFor("task_created", "pt")).toBeNull();
      expect(h.cues.speechFor("task_failed", "pt")).toBeNull();
      // Present in the table but deliberately not yet spoken.
      expect(CUE_TEXT.wake_lapsed).toBeNull();
      expect(h.cues.speechFor("wake_lapsed", "pt")).toBeNull();
      expect(h.cues.speechFor("not_an_event", "pt")).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("is inert when disabled", () => {
    const h = harness({ cueEnabled: false });
    try {
      expect(h.cues.speechFor("wake_detected", "pt")).toBeNull();
      expect(h.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("cues - never on the network", () => {
  it("returns text with NO clip on a cold cache, synchronously", () => {
    const h = harness();
    try {
      // Not awaited, and it cannot be: this runs on the path to the device
      // haptic. A cold cue costs the phone's own voice, never a delayed one.
      const speak = h.cues.speechFor("wake_detected", "pt");
      expect(speak?.text).toBe("Sim?");
      expect(speak?.audio_path).toBeUndefined();
      expect(h.counters.read().cue_clip_misses).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("repairs a cold cue in the background so the next one is warm", async () => {
    const h = harness();
    try {
      expect(h.cues.speechFor("wake_detected", "pt")?.audio_path).toBeUndefined();
      // The miss fired a render behind the caller's back. An eviction therefore
      // costs exactly ONE cue in the phone's own voice, then heals itself.
      await new Promise((r) => setTimeout(r, 10));
      expect(h.calls.length).toBeGreaterThan(0);
      expect(h.cues.speechFor("wake_detected", "pt")?.audio_path).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });

  it("attaches the clip once it is warm, still without a request", async () => {
    const h = harness();
    try {
      await h.cues.prewarm();
      const fetchesAfterWarm = h.calls.length;
      expect(fetchesAfterWarm).toBeGreaterThan(0);
      const speak = h.cues.speechFor("wake_detected", "pt");
      expect(speak?.audio_path).toBe(`/speak/${clipId({ text: "Sim?", voiceId: VOICE, model: MODEL })}.mp3`);
      // The whole point: serving a warm cue costs zero round trips.
      expect(h.calls).toHaveLength(fetchesAfterWarm);
      expect(h.counters.read().cue_clip_hits).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("renders every cue exactly once across both languages", async () => {
    const h = harness();
    try {
      await h.cues.prewarm();
      const first = h.calls.length;
      await h.cues.prewarm();
      expect(h.calls).toHaveLength(first); // all cached the second time
      expect(first).toBe(4); // two cues x two languages, forever
    } finally {
      h.cleanup();
    }
  });

  // pruneCache is oldest-mtime-first, so without pinning a cue rendered at boot
  // is GUARANTEED to fall out behind ttsCacheMaxClips ordinary card titles, and
  // then be missing at the moment latency matters most.
  it("pins cue clips against the oldest-first prune", async () => {
    const h = harness({ ttsCacheMaxClips: 1 });
    try {
      await h.cues.prewarm();
      await h.voice.clipFor("uma tarefa qualquer com um titulo comprido");
      await h.voice.clipFor("outra tarefa diferente ainda mais comprida");
      expect(h.cues.speechFor("wake_detected", "pt")?.audio_path).toBeTruthy();
      expect(h.cues.speechFor("window_closed", "pt")?.audio_path).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });
});

describe("cues - the echo they create", () => {
  // The hazard the whole feature turns on. The cue plays through the phone
  // speaker WHILE the capture window is open, so the pendant mic hears it. Left
  // alone, "Sim" is appended to the command being assembled and re-arms the
  // silence timer - corrupting the command and adding seconds of latency, which
  // is the very thing the cue exists to fix.
  it("suppresses its own voice coming back, without eating a sentence", () => {
    const h = harness();
    try {
      const guard = new EchoGuard();
      const speak = h.cues.speechFor("wake_detected", "pt")!;
      h.cues.registerEcho(guard, speak);
      expect(guard.shouldSuppress("Sim")).toBe(true);
      expect(guard.shouldSuppress("sim.")).toBe(true);
      // A real command that merely STARTS with the cue word must survive - the
      // exact-match rule is what makes that safe.
      expect(guard.shouldSuppress("Sim, compra o comando para a televisão")).toBe(false);
      expect(guard.shouldSuppress("comprar pão amanhã de manhã")).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
