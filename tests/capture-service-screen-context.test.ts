// The screen comes back: a spoken command that leans on what the phone is
// showing.
//
// The headline assertion is the CROSS-SESSION one. The wearer keeps the pendant
// on (mic, wake word, haptics, voice) and starts the broadcast separately, so
// the command arrives on a `pendant` session and the pixels on a live
// `screen_audio` one, with no id joining them. Proving the operative prompt
// names the SCREEN session's frame while the turn belongs to the PENDANT
// session is the whole feature in one line.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Counters, CaptureStore } from "../fittings/seed/capture-service/lib/store.mjs";
import { ScreenContextIndex } from "../fittings/seed/capture-service/lib/screen-context.mjs";
import { SessionMedia } from "../fittings/seed/capture-service/lib/media-log.mjs";
import { WakeBus, buildDelegatePrompt, buildWakePrompt } from "../fittings/seed/capture-service/lib/wake.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function fakeIngress(sessions: Array<{ id: string; mode: string; media: unknown }>) {
  return { sessions: new Map(sessions.map((s) => [s.id, { record: { id: s.id, mode: s.mode }, media: s.media }])) };
}

const frameAt = (atMs: number, seq = 1) => ({
  latestFrame: () => ({ seq, tsMs: 0, atMs, file: `/media/s/frames/${seq}.jpg` })
});

describe("ScreenContextIndex - correlating a command with a screen", () => {
  const index = (sessions: any[], cfg: Record<string, unknown> = {}, now = 10_000) =>
    new ScreenContextIndex({
      ingress: fakeIngress(sessions),
      cfg: { screenContextEnabled: true, screenContextMaxAgeMs: 30_000, ...cfg },
      counters: { bump: () => {}, observe: () => {} },
      now: () => now
    });

  it("finds the newest frame from a live screen session", () => {
    const got = index([{ id: "scr", mode: "screen_audio", media: frameAt(9_000, 4) }]).latest({ atMs: 10_000 });
    expect(got).toMatchObject({ sessionId: "scr", seq: 4, stale: false });
    expect(got?.ageMs).toBe(1_000);
  });

  it("ignores pendant and audio sessions - only a broadcast carries pixels", () => {
    expect(
      index([
        { id: "pend", mode: "pendant", media: frameAt(9_000) },
        { id: "aud", mode: "audio", media: frameAt(9_500) }
      ]).latest({ atMs: 10_000 })
    ).toBeNull();
  });

  it("takes the newest when several broadcasts are live", () => {
    const got = index([
      { id: "old", mode: "screen_audio", media: frameAt(5_000, 1) },
      { id: "new", mode: "screen_audio", media: frameAt(9_000, 2) }
    ]).latest({ atMs: 10_000 });
    expect(got?.sessionId).toBe("new");
  });

  // Age is measured from when the user SPOKE, not from dispatch: the capture
  // window runs up to 45s, so by dispatch they stopped looking long ago.
  it("measures age from the moment of the wake hit", () => {
    const idx = index([{ id: "scr", mode: "screen_audio", media: frameAt(9_000) }], {}, 60_000);
    expect(idx.latest({ atMs: 10_000 })?.ageMs).toBe(1_000);
    expect(idx.latest({ atMs: 60_000 })?.stale).toBe(true);
  });

  it("reports a stale frame as stale, WITH its real age", () => {
    const got = index([{ id: "scr", mode: "screen_audio", media: frameAt(1_000) }], {}, 130_000).latest({
      atMs: 130_000
    });
    expect(got?.stale).toBe(true);
    expect(got?.ageMs).toBe(129_000);
  });

  it("is inert when disabled", () => {
    expect(
      index([{ id: "scr", mode: "screen_audio", media: frameAt(9_999) }], { screenContextEnabled: false }).latest({
        atMs: 10_000
      })
    ).toBeNull();
  });
});

describe("SessionMedia - the newest complete frame", () => {
  it("names a frame only after its bytes are on disk", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "media-frames-"));
    try {
      const media = new SessionMedia(dir, "s1", { counters: { bump: () => {} } });
      expect(media.latestFrame()).toBeNull();
      media.acceptVideo(1, 0, JPEG);
      media.acceptVideo(2, 667, JPEG);
      const latest = media.latestFrame();
      expect(latest?.seq).toBe(2);
      expect(latest?.file).toContain(path.join("s1", "frames", "2.jpg"));
      const { readFileSync } = require("node:fs");
      expect(readFileSync(latest!.file).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fusing a spoken command with the screen", () => {
  function bus(over: Record<string, unknown> = {}, cfgOver: Record<string, unknown> = {}) {
    const home = mkdtempSync(path.join(os.tmpdir(), "screen-fuse-"));
    const store = new CaptureStore(path.join(home, "capture"));
    const prompts: string[] = [];
    const wake = new WakeBus({
      cfg: {
        wakeEnabled: true,
        gatewayUrl: "http://127.0.0.1:1",
        wakeVariants: ["zeca"],
        wakeSilenceCloseMs: 20,
        wakeMaxCaptureMs: 500,
        wakeCommandWindowMs: 60000,
        wakeContextSegments: 0,
        wakeCardDedupeMs: 0,
        delegateEnabled: true,
        ...cfgOver
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: JSON.stringify({ intent: "delegate", request: "reply to her", needs_screen: true, ack: "ok" }) }),
      operativeFn: async ({ prompt }: any) => {
        prompts.push(prompt);
        return { reply: "sent" };
      },
      board: { listProjects: async () => [], base: () => null },
      memoryWriter: { write: () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null },
      log: { log: () => {}, error: () => {} },
      ...over
    });
    return { wake, prompts, cleanup: () => rmSync(home, { recursive: true, force: true }) };
  }

  // THE headline test: the pixels come from one session, the command from
  // another, and the operative gets both.
  it("hands the operative a frame from a DIFFERENT session than the command", async () => {
    const h = bus({
      screenContextFn: () => ({ stale: false, sessionId: "screen-session", seq: 7, file: "/m/screen-session/frames/7.jpg", ageMs: 2000 })
    });
    try {
      h.wake.handleSegments({ sessionId: "pendant-session", segments: [{ text: "Zeca, responde-lhe que é melhor amanhã.", start: 0, end: 1 }] });
      await h.wake.close("pendant-session", "silence");
      await h.wake.delegateChain;
      expect(h.prompts[0]).toContain("/m/screen-session/frames/7.jpg");
      expect(h.prompts[0]).toContain("AT THE MOMENT THEY SPOKE");
      expect(h.prompts[0]).toContain("2 seconds ago");
    } finally {
      h.cleanup();
    }
  });

  // A command that quietly loses its screen and acts on a guess is the
  // dangerous failure. It must never reach the operative.
  it("REFUSES a screen-dependent command when there is no screen", async () => {
    const h = bus({ screenContextFn: () => null });
    try {
      h.wake.handleSegments({ sessionId: "p", segments: [{ text: "Zeca, responde-lhe que é melhor amanhã.", start: 0, end: 1 }] });
      const out = await h.wake.close("p", "silence");
      await h.wake.delegateChain;
      expect(out.result.intent).toBe("delegate_blocked");
      expect(out.result.reason).toBe("screen_context_missing");
      expect(h.prompts).toHaveLength(0); // the operative was never called
      expect(out.confirmation).toMatch(/ecrã|screen/i);
    } finally {
      h.cleanup();
    }
  });

  it("refuses on a stale screen too, and says how old it is", async () => {
    const h = bus({
      screenContextFn: () => ({ stale: true, sessionId: "scr", seq: 1, file: "/m/1.jpg", ageMs: 120_000 })
    });
    try {
      h.wake.handleSegments({ sessionId: "p", segments: [{ text: "Zeca, responde-lhe.", start: 0, end: 1 }] });
      const out = await h.wake.close("p", "silence");
      expect(out.result.reason).toBe("screen_context_stale");
      expect(out.confirmation).toContain("120");
      expect(h.prompts).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("attaches a screen to a self-contained command as weak context", async () => {
    const h = bus({
      runFn: async () => ({ reply: JSON.stringify({ intent: "delegate", request: "what is on my board", needs_screen: false, ack: "ok" }) }),
      screenContextFn: () => ({ stale: false, sessionId: "scr", seq: 3, file: "/m/3.jpg", ageMs: 500 })
    });
    try {
      h.wake.handleSegments({ sessionId: "p", segments: [{ text: "Zeca, o que está no meu quadro?", start: 0, end: 1 }] });
      await h.wake.close("p", "silence");
      await h.wake.delegateChain;
      expect(h.prompts[0]).toContain("/m/3.jpg");
    } finally {
      h.cleanup();
    }
  });

  // omi has no broadcast lane. Without screenContextFn the prompts must be
  // character-for-character what they always were.
  it("leaves the prompts byte-identical when there is no screen lane", () => {
    const now = new Date(2026, 7, 22, 16, 24);
    expect(buildWakePrompt("x", [], [], "", now)).not.toContain("needs_screen");
    expect(buildDelegatePrompt("r", { boardUrl: null })).not.toContain("screenshot");
    expect(buildWakePrompt("x", [], [], "", now)).toBe(buildWakePrompt("x", [], [], "", now, {}));
  });
});
