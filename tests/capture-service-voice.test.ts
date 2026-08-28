// Zeca's voice: the ElevenLabs request shape, the cache, and the rule that a
// nicer voice may never cost an acknowledgement.
//
// The request-shape assertions are not style preferences - each one is a
// finding the 28-palavras app paid for (DECISIONS.md, 2026-08-15), where the
// user's report was "says it in Brazilian once, creepy" and a rated session
// found 9 of 66 clips had drifted to pt-BR. Anyone tempted to "upgrade" this to
// eleven_v3 should read those decisions first; v3 rejects the anchors that hold
// the accent.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Counters, CaptureStore } from "../fittings/seed/capture-service/lib/store.mjs";
import { ZecaVoice, clipId, looksPortuguese, textSeed } from "../fittings/seed/capture-service/lib/tts.mjs";

const VOICE = "RlGHmE2fztwdBDat0jYf";
const MODEL = "eleven_multilingual_v2";

function harness(overrides: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "zeca-voice-"));
  const stateDir = path.join(home, "capture");
  new CaptureStore(stateDir);
  const counters = new Counters(stateDir, "voice");
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  let respond: () => { ok: boolean; status: number; body: Buffer | string } = () => ({
    ok: true,
    status: 200,
    body: Buffer.from("ID3fake-mp3-bytes")
  });
  const cfg = {
    stateDir,
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
    fetchImpl: async (url: string, init: { body: string; headers: Record<string, string> }) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      const r = respond();
      return {
        ok: r.ok,
        status: r.status,
        arrayBuffer: async () => (Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body))),
        text: async () => String(r.body)
      };
    }
  });
  return {
    voice,
    counters,
    calls,
    cfg,
    stateDir,
    setResponse: (fn: typeof respond) => {
      respond = fn;
    },
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

describe("Zeca's voice - the ElevenLabs request", () => {
  it("uses multilingual_v2 with unspoken pt-PT anchors and a deterministic seed", async () => {
    const h = harness();
    try {
      const clip = await h.voice.clipFor("Criei a tarefa: comprar morangos.");
      expect(clip?.id).toBeTruthy();
      expect(h.calls).toHaveLength(1);
      const { url, body, headers } = h.calls[0];
      expect(url).toContain(`/text-to-speech/${VOICE}`);
      expect(headers["xi-api-key"]).toBe("sk_test_key");
      // v3 would reject previous_text/next_text - the very fields that stop a
      // short Portuguese line drifting Brazilian.
      expect(body.model_id).toBe(MODEL);
      expect(String(body.previous_text ?? "")).not.toHaveLength(0);
      expect(String(body.next_text ?? "")).not.toHaveLength(0);
      expect(body.voice_settings).toEqual({ stability: 0.75, similarity_boost: 0.75 });
      // Same line, same audio, forever: without a fixed seed the accent flips
      // between renders of the identical sentence.
      expect(body.seed).toBe(textSeed("Criei a tarefa: comprar morangos."));
    } finally {
      h.cleanup();
    }
  });

  it("leaves the Portuguese anchors off an English line", async () => {
    const h = harness();
    try {
      await h.voice.clipFor("Card created: buy strawberries.");
      expect(h.calls[0].body.previous_text).toBeUndefined();
      expect(h.calls[0].body.next_text).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it("detects Portuguese by accent AND by common words", () => {
    expect(looksPortuguese("Criei a tarefa")).toBe(true);
    expect(looksPortuguese("amanha de manha")).toBe(true);
    expect(looksPortuguese("Card created")).toBe(false);
  });
});

describe("Zeca's voice - cost and caching", () => {
  it("renders a repeated line once and serves it from disk", async () => {
    const h = harness();
    try {
      const first = await h.voice.clipFor("On it.");
      const second = await h.voice.clipFor("On it.");
      expect(second?.id).toBe(first?.id);
      // The plan is ~30k characters a MONTH and shared with another app, so a
      // repeat costing a generation would be a real bill, not a nicety.
      expect(h.calls).toHaveLength(1);
      expect(h.counters.read().tts_cache_hits).toBe(1);
      expect(h.voice.readClip(first!.id)).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("generates once when the same line is asked for concurrently", async () => {
    const h = harness();
    try {
      const [a, b] = await Promise.all([h.voice.clipFor("Feito."), h.voice.clipFor("Feito.")]);
      expect(a?.id).toBe(b?.id);
      expect(h.calls).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("misses the cache when the voice changes, instead of serving the old one", async () => {
    const a = clipId({ text: "Feito.", voiceId: VOICE, model: MODEL });
    const b = clipId({ text: "Feito.", voiceId: "someOtherVoice", model: MODEL });
    expect(a).not.toBe(b);
    expect(clipId({ text: "Feito.", voiceId: VOICE, model: "eleven_v3" })).not.toBe(a);
  });

  it("evicts oldest-first past the cap", async () => {
    const h = harness({ ttsCacheMaxClips: 2 });
    try {
      const dir = path.join(h.stateDir, "tts-cache");
      mkdirSync(dir, { recursive: true });
      for (const name of ["aaaaaaaa", "bbbbbbbb", "cccccccc"]) {
        writeFileSync(path.join(dir, `${name}.mp3`), "x");
      }
      await h.voice.clipFor("nova linha para gerar");
      expect(readdirSync(dir).length).toBeLessThanOrEqual(2);
    } finally {
      h.cleanup();
    }
  });

  it("rejects a clip id that is not a hash, rather than reading the path it names", () => {
    const h = harness();
    try {
      expect(h.voice.readClip("../../../../etc/passwd")).toBeNull();
      expect(h.voice.readClip("not-hex")).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe("Zeca's voice - never costs the acknowledgement", () => {
  // The whole fallback contract. clipFor returns null and the phone speaks the
  // line itself; a wearer who hears NOTHING cannot tell "the clip failed" from
  // "it never heard me", and that is the exact ambiguity this system has
  // already been bitten by.
  it("returns null instead of throwing when ElevenLabs errors", async () => {
    const h = harness();
    try {
      h.setResponse(() => ({ ok: false, status: 401, body: "bad key" }));
      await expect(h.voice.clipFor("Criei a tarefa.")).resolves.toBeNull();
      expect(h.counters.read().tts_failures).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("counts a quota wall separately, so a month of silent degrading is visible", async () => {
    const h = harness();
    try {
      h.setResponse(() => ({ ok: false, status: 429, body: "quota" }));
      await h.voice.clipFor("Criei a tarefa.");
      expect(h.counters.read().tts_quota_exhausted).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("stays out of the way entirely when disabled or unkeyed", async () => {
    for (const override of [{ ttsEnabled: false }, { secrets: { elevenLabsApiKey: "" } }]) {
      const h = harness(override);
      try {
        expect(await h.voice.clipFor("Criei a tarefa.")).toBeNull();
        expect(h.calls).toHaveLength(0);
      } finally {
        h.cleanup();
      }
    }
  });

  it("does not spend the budget speaking a long answer", async () => {
    const h = harness();
    try {
      expect(await h.voice.clipFor("a".repeat(601))).toBeNull();
      expect(h.counters.read().tts_skipped_too_long).toBe(1);
      expect(h.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  // The "why is the voice Brazilian" bug, and the reason it was invisible.
  //
  // Anchors were chosen by INFERRING the language from the text, and the lines
  // with no accents and no Portuguese stopwords - "Deixa comigo.", "Feito." -
  // inferred as not-Portuguese and went out unanchored. Per the 28-palavras
  // findings a short unanchored clip is exactly where the accent drifts to
  // pt-BR, and "Deixa comigo." is spoken after EVERY command, so the drift was
  // the voice the wearer heard most.
  it("anchors a Portuguese line the text alone cannot identify", async () => {
    const h = harness();
    try {
      // Proof of the trap: inference genuinely fails on this sentence.
      expect(looksPortuguese("Deixa comigo.")).toBe(false);

      await h.voice.clipFor("Deixa comigo.", { lang: "pt" });
      expect(String(h.calls[0].body.previous_text ?? "")).not.toHaveLength(0);
      expect(String(h.calls[0].body.next_text ?? "")).not.toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("leaves an English line unanchored even when the words look Portuguese-ish", async () => {
    const h = harness();
    try {
      await h.voice.clipFor("On it.", { lang: "en" });
      expect(h.calls[0].body.previous_text).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  // The language changes the AUDIO, so it has to change the cache key - or the
  // unanchored recording keeps being served after the fix.
  it("keys the cache on language, and leaves legacy ids alone", async () => {
    const base = { text: "Deixa comigo.", voiceId: VOICE, model: MODEL };
    expect(clipId({ ...base, lang: "pt" })).not.toBe(clipId(base));
    expect(clipId({ ...base, lang: "pt" })).not.toBe(clipId({ ...base, lang: "en" }));
    expect(clipId({ ...base, lang: null })).toBe(clipId(base));
  });
});