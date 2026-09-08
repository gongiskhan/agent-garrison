import { describe, expect, it } from "vitest";
import {
  CAPTURE_REPLY_IDLE_MS,
  chunkForTts,
  cleanSpokenText,
  createFoldState,
  foldCaptureEvents,
  settleCaptureIdle,
  speakReply,
  TTS_MAX_CHARS,
  watchCaptureFeedback,
  type CaptureHeard,
  type CaptureReply,
  type ClipPlayer
} from "../packages/talk/ui/capture-feedback";
import { describePushStatus } from "../packages/talk/ui/record-button";

function started(stretchId: string) {
  return { kind: "stretch-started", payload: { stretchId } };
}
function said(text: string) {
  return { kind: "session-event", payload: { role: "assistant", blocks: [{ type: "text", text }] } };
}
function ended(stretchId: string, duty: string) {
  return { kind: "stretch-ended", payload: { stretchId, duty } };
}
const heardCapture = { kind: "user-message", payload: { origin: "capture", text: "what is this page\n\nAttached file:\n- /m/1.jpg" } };

describe("foldCaptureEvents", () => {
  it("reports what the broadcast heard and speaks only the answer to it", () => {
    const heard: CaptureHeard[] = [];
    const replies: CaptureReply[] = [];
    const state = createFoldState();
    const handlers = { onHeard: (h: CaptureHeard) => heard.push(h), onReply: (r: CaptureReply) => replies.push(r) };
    // A typed turn's answer is never spoken.
    foldCaptureEvents(state, [{ kind: "user-message", payload: { origin: "web", text: "typed" } }, started("s-0"), said("typed answer"), ended("s-0", "discuss")], handlers);
    expect(replies).toEqual([]);
    foldCaptureEvents(
      state,
      [heardCapture, started("s-t"), said("gate"), ended("s-t", "triage"), started("s-d"), said("It is the Vault page.\n[route: discuss]\n[orchestrator-active]"), ended("s-d", "discuss"), started("s-x"), said("no test"), ended("s-x", "test")],
      handlers,
      { now: 7 }
    );
    expect(heard).toEqual([{ text: "what is this page", at: 7 }]);
    expect(replies).toEqual([{ text: "It is the Vault page.", duty: "discuss", stretchId: "s-d", at: 7 }]);
    expect(state.awaiting).toBe(0);
  });

  it("speaks a triage-only answer once the conversation has sat idle, and not before (D57)", () => {
    const replies: CaptureReply[] = [];
    const awaiting: number[] = [];
    const state = createFoldState();
    const handlers = { onReply: (r: CaptureReply) => replies.push(r), onAwaiting: (n: number) => awaiting.push(n) };
    // The gateway's inference ran triage alone: it asked a question and ended "blocked".
    const plural = { kind: "user-message", payload: { origin: "capture", text: "look at this\n\nAttached files:\n- /m/1.jpg\n- /m/2.jpg" } };
    foldCaptureEvents(state, [plural, started("s-t"), said("Which page do you mean?"), ended("s-t", "triage")], handlers, { now: 1_000 });
    expect(replies).toEqual([]);
    expect(state.lastEnded?.text).toBe("Which page do you mean?");
    // Not yet idle long enough: still waiting for a discuss stretch.
    expect(settleCaptureIdle(state, handlers, { now: 1_000 + CAPTURE_REPLY_IDLE_MS - 1 })).toBeNull();
    expect(replies).toEqual([]);
    const reply = settleCaptureIdle(state, handlers, { now: 1_000 + CAPTURE_REPLY_IDLE_MS });
    expect(reply).toEqual({ text: "Which page do you mean?", duty: "triage", stretchId: "s-t", at: 1_000 + CAPTURE_REPLY_IDLE_MS });
    expect(replies).toEqual([reply]);
    expect(state.awaiting).toBe(0);
    expect(awaiting).toEqual([1, 0]);
    // Settled once: a second idle tick says nothing.
    expect(settleCaptureIdle(state, handlers, { now: 1_000_000 })).toBeNull();
  });

  it("drops the idle fallback when a follow-up stretch starts, and speaks nothing for typed turns", () => {
    const replies: CaptureReply[] = [];
    const state = createFoldState();
    const handlers = { onReply: (r: CaptureReply) => replies.push(r) };
    foldCaptureEvents(state, [heardCapture, started("s-t"), said("gate"), ended("s-t", "triage"), started("s-d")], handlers, { now: 5 });
    expect(state.lastEnded).toBeNull();
    // Running: the idle settle never speaks over a live stretch.
    expect(settleCaptureIdle(state, handlers, { now: 5 + CAPTURE_REPLY_IDLE_MS * 2 })).toBeNull();
    foldCaptureEvents(state, [said("The real answer."), ended("s-d", "discuss")], handlers, { now: 9 });
    expect(replies.map((r) => r.text)).toEqual(["The real answer."]);
    // A typed turn's triage-only answer stays silent too.
    const quiet = createFoldState();
    foldCaptureEvents(quiet, [{ kind: "user-message", payload: { origin: "web", text: "typed" } }, started("s-q"), said("?"), ended("s-q", "triage")], handlers, { now: 1 });
    expect(settleCaptureIdle(quiet, handlers, { now: 1 + CAPTURE_REPLY_IDLE_MS })).toBeNull();
    expect(replies).toHaveLength(1);
  });

  it("cleans fences and trailers and caps what is spoken", () => {
    expect(cleanSpokenText("Look:\n```\nx\n```\n[route: a]")).toBe("Look:");
    expect(cleanSpokenText("b".repeat(2000), 100)).toHaveLength(100);
  });
});

describe("watchCaptureFeedback", () => {
  it("starts from the conversation's current size and polls the log after it", async () => {
    const urls: string[] = [];
    const bodies = [
      { total: 40 },
      { events: [heardCapture], nextIndex: 41 },
      { events: [started("s-d"), said("Answer."), ended("s-d", "discuss")], nextIndex: 44 }
    ];
    let i = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const heard: string[] = [];
    const replies: string[] = [];
    const stop = watchCaptureFeedback("conv-1", { onHeard: (h) => heard.push(h.text), onReply: (r) => replies.push(r.text) }, { pollMs: 1, fetchImpl });
    const deadline = Date.now() + 2000;
    while (replies.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(urls.slice(0, 3)).toEqual(["/api/conversation/conv-1", "/api/conversation/conv-1/log?fromIndex=40&limit=500", "/api/conversation/conv-1/log?fromIndex=41&limit=500"]);
    expect(heard).toEqual(["what is this page"]);
    expect(replies).toEqual(["Answer."]);
  });
});

describe("speakReply", () => {
  /** A voice layer that renders any text under the cap and a player that remembers what it played. */
  function voiceLayer(opts: { tts?: number | "throw"; player?: boolean } = {}) {
    const posts: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      posts.push(`${String(url)} ${body}`);
      if (String(url) === "/api/voice/tts") {
        if (opts.tts === "throw") throw new Error("offline");
        if (opts.tts && opts.tts !== 200) return new Response(JSON.stringify({ error: "no tts" }), { status: opts.tts });
        const { text } = JSON.parse(body) as { text: string };
        if (text.length > TTS_MAX_CHARS) return new Response(JSON.stringify({ error: "chunk it" }), { status: 400 });
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg", "x-voice-backend": "deepgram" } });
      }
      return new Response("{}", { status: 202 });
    }) as typeof fetch;
    const played: number[] = [];
    const player: ClipPlayer = { play: async (blob) => { played.push(blob.size); return opts.player !== false; } };
    const spoken: string[] = [];
    const speech = {
      speak: async ({ text }: { text: string }) => { spoken.push(text); return { completed: true }; },
      settings: async () => ({ master: true })
    };
    return { posts, fetchImpl, player, played, spoken, speech };
  }

  it("registers the text with the voice layer, plays its rendered clip, and never uses the phone voice (D58)", async () => {
    const v = voiceLayer();
    expect(await speakReply(v.speech, "Answer.", { fetchImpl: v.fetchImpl, player: v.player })).toBe(true);
    expect(v.posts).toEqual([
      '/api/voice/spoken {"text":"Answer."}',
      '/api/voice/tts {"text":"Answer.","format":"mp3"}'
    ]);
    expect(v.played).toEqual([3]);
    expect(v.spoken).toEqual([]);
  });

  it("honours the master switch before touching the voice layer", async () => {
    const v = voiceLayer();
    const muted = { ...v.speech, settings: async () => ({ master: false }) };
    expect(await speakReply(muted, "Quiet.", { fetchImpl: v.fetchImpl, player: v.player })).toBe(false);
    expect(v.posts).toEqual([]);
    expect(v.played).toEqual([]);
    expect(v.spoken).toEqual([]);
  });

  it("renders a long answer in sentence-sized chunks the voice layer accepts, in order", async () => {
    const sentence = "This sentence is repeated so that the answer runs well past the cap. ";
    const text = sentence.repeat(20).trim();
    const v = voiceLayer();
    expect(await speakReply(v.speech, text, { fetchImpl: v.fetchImpl, player: v.player, lang: "en" })).toBe(true);
    const chunks = v.posts.filter((p) => p.startsWith("/api/voice/tts ")).map((p) => JSON.parse(p.slice("/api/voice/tts ".length)) as { text: string; lang?: string });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= TTS_MAX_CHARS && c.lang === "en")).toBe(true);
    expect(chunks.every((c) => c.text.endsWith("."))).toBe(true);
    expect(chunks.map((c) => c.text).join(" ")).toBe(text);
    expect(v.played).toHaveLength(chunks.length);
    expect(v.spoken).toEqual([]);
  });

  it("falls back to the phone voice only when the voice layer cannot render (no provider, offline, unplayable)", async () => {
    const cases: Array<[Parameters<typeof voiceLayer>[0], string]> = [
      [{ tts: 503 }, "voice layer 503 (no tts)"],
      [{ tts: "throw" }, "voice layer unreachable"],
      [{ player: false }, "clip would not play"]
    ];
    for (const [opts, why] of cases) {
      const v = voiceLayer(opts);
      const reasons: string[] = [];
      expect(await speakReply(v.speech, "Fallback.", { fetchImpl: v.fetchImpl, player: v.player, onFallback: (r) => reasons.push(r) })).toBe(true);
      expect(v.spoken).toEqual(["Fallback."]);
      expect(reasons).toEqual([why]);
      expect(v.posts[0]).toBe('/api/voice/spoken {"text":"Fallback."}');
    }
  });
});

describe("chunkForTts", () => {
  it("keeps a short answer whole and never cuts inside a word", () => {
    expect(chunkForTts("Short answer.")).toEqual(["Short answer."]);
    expect(chunkForTts("   ")).toEqual([]);
    const words = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkForTts(words, 100);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(" ")).toBe(words);
  });

  it("prefers sentence ends, then clauses, then spaces, and splits an overlong word only when it must", () => {
    expect(chunkForTts("One two. Three four. Five six.", 18)).toEqual(["One two.", "Three four.", "Five six."]);
    expect(chunkForTts("alpha, beta, gamma, delta", 13)).toEqual(["alpha, beta,", "gamma, delta"]);
    expect(chunkForTts("a".repeat(25), 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });
});

describe("describePushStatus", () => {
  it("says what stands between the phone and Zeca's pushed answers", () => {
    expect(describePushStatus(null)).toBeNull();
    expect(describePushStatus({ authorization: "authorized", registered: true, detail: "registered" })).toBeNull();
    expect(describePushStatus({ authorization: "notDetermined", registered: false, detail: "not registered" })?.action).toBe("enable");
    const denied = describePushStatus({ authorization: "denied", registered: false, detail: "not registered" });
    expect(denied?.action).toBeNull();
    expect(denied?.text).toMatch(/Settings > Garrison > Notifications/);
    expect(describePushStatus({ authorization: "authorized", registered: false, detail: "requesting token" })?.action).toBeNull();
    const failed = describePushStatus({ authorization: "authorized", registered: false, detail: "upload failed: 503" });
    expect(failed?.action).toBe("retry");
    expect(failed?.text).toContain("upload failed: 503");
  });
});
