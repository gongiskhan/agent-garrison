import { describe, it, expect, afterEach, vi } from "vitest";
import { DEFAULT_CHUNK_CHARS, chunkCharsFor, chunkSpeech, createVoiceClient } from "../packages/claude-chat/src/voice";
import { chunkSpeech as talkChunkSpeech, DEFAULT_CHUNK_CHARS as TALK_DEFAULT } from "../packages/talk/ui/voice-clip";

// The rich chat's voice client: what it keeps from the host's /voice/health body
// and how it sizes read-aloud requests. The host body names the provider
// fitting, never its machine-local URL (the page is usually on another machine),
// and advertises the provider's per-request /tts budget, which is the ONLY
// number the client may chunk against.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("claude-chat voice client health", () => {
  it("keeps fitting and maxTextChars and never a provider url", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      jsonResponse({
        available: true,
        keyConfigured: true,
        tts: true,
        backend: "deepgram",
        maxTextChars: 600,
        fitting: "capture-service",
        url: "http://127.0.0.1:8097",
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const h = await createVoiceClient("/sessions/s1").health();
    expect(fetchMock.mock.calls[0][0]).toBe("/sessions/s1/voice/health");
    expect(h).toEqual({
      available: true,
      fitting: "capture-service",
      keyConfigured: true,
      tts: true,
      maxTextChars: 600,
      reason: undefined,
    });
    expect(JSON.stringify(h)).not.toContain("127.0.0.1");
    expect("url" in h).toBe(false);
  });

  it("reports null maxTextChars when the host did not advertise a budget", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ available: true, keyConfigured: true, tts: true })));
    const h = await createVoiceClient("").health();
    expect(h.maxTextChars).toBeNull();
    expect(chunkCharsFor(h)).toBe(DEFAULT_CHUNK_CHARS);
  });

  it("carries the host's reason through on an unavailable body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ available: false, reason: "voice locked", fitting: "capture-service" })));
    const h = await createVoiceClient("").health();
    expect(h).toMatchObject({ available: false, reason: "voice locked", fitting: "capture-service" });
  });

  it("reads as unavailable when the probe itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    expect(await createVoiceClient("").health()).toEqual({ available: false });
  });
});

describe("read-aloud chunk sizing", () => {
  it("uses the advertised budget when it is a positive integer, else the default", () => {
    expect(chunkCharsFor({ maxTextChars: 250 })).toBe(250);
    expect(chunkCharsFor({ maxTextChars: 0 })).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkCharsFor({ maxTextChars: -1 })).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkCharsFor({ maxTextChars: 12.5 })).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkCharsFor({ maxTextChars: null })).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkCharsFor(null)).toBe(DEFAULT_CHUNK_CHARS);
  });

  it("defaults to the voice layer's 600-character /tts budget", () => {
    expect(DEFAULT_CHUNK_CHARS).toBe(600);
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i + 1} of the reply keeps the runner honest about its fittings.`).join(" ");
    const chunks = chunkSpeech(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(600);
    expect(chunks.join(" ")).toBe(long);
  });

  it("is the same splitter the Conversations read-aloud path uses", () => {
    // One implementation for both read-aloud paths: talk re-exports this one.
    expect(talkChunkSpeech).toBe(chunkSpeech);
    expect(TALK_DEFAULT).toBe(DEFAULT_CHUNK_CHARS);
  });
});

describe("claude-chat voice client tts", () => {
  it("posts one chunk as {text, format} and honours an abort signal", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createVoiceClient("/sessions/s1");
    const blob = await client.tts("Hello there.");
    expect(blob.size).toBe(3);
    expect(fetchMock.mock.calls[0][0]).toBe("/sessions/s1/voice/tts");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({ text: "Hello there.", format: "mp3" });

    const ac = new AbortController();
    ac.abort();
    await expect(client.tts("Cancelled.", { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces the proxy's status and detail on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "voice locked" }), { status: 503 })));
    await expect(createVoiceClient("").tts("x")).rejects.toThrow(/tts 503: .*voice locked/);
  });
});
