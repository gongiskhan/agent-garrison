import { describe, expect, it } from "vitest";
import {
  LISTEN_TIMEOUT_MS,
  SPEAK_TIMEOUT_MS,
  UpstreamError,
  speakClip,
  transcribeClip,
  upstreamSignal
} from "../fittings/seed/capture-service/lib/deepgram-rest.mjs";

// The Deepgram REST lane's contract with its callers: bounded upstream calls
// (a stalled Deepgram must not hang a /stt or /tts request open forever), and
// a failure that carries the upstream status and a text excerpt - never the
// audio, never the key.

const cfg = {
  secrets: { deepgramApiKey: "dg-secret-key" },
  dgRestBaseUrl: "http://dg.test",
  sttRestLanguage: "en",
  sttLanguage: "en",
  sttModel: "nova-3",
  ttsDeepgramModel: "aura-2-thalia-en"
};

type Init = { headers: Record<string, string>; signal?: AbortSignal; body: unknown };

describe("deepgram REST lane", () => {
  it("bounds every upstream call with a timeout signal by default", async () => {
    const seen: Init[] = [];
    const fetchImpl = async (_url: string, init: Init) => {
      seen.push(init);
      return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "hi", confidence: 0.9 }] }] } }), { status: 200 });
    };
    await transcribeClip({ cfg, bytes: Buffer.from("abc"), fetchImpl });
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(seen[0].signal?.aborted).toBe(false);

    const speakFetch = async (_url: string, init: Init) => {
      seen.push(init);
      return new Response(new Uint8Array([1]), { status: 200 });
    };
    await speakClip({ cfg, text: "hello", fetchImpl: speakFetch });
    expect(seen[1].signal).toBeInstanceOf(AbortSignal);
    expect(LISTEN_TIMEOUT_MS).toBeGreaterThan(SPEAK_TIMEOUT_MS);
  });

  it("a timed-out upstream surfaces as an unreachable UpstreamError, not a hang", async () => {
    const fetchImpl = (_url: string, init: Init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
      });
    const started = Date.now();
    const err = await transcribeClip({ cfg, bytes: Buffer.from("abc"), fetchImpl, timeoutMs: 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/deepgram unreachable/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("upstreamSignal is off for a non-positive budget", () => {
    expect(upstreamSignal(0)).toBeUndefined();
    expect(upstreamSignal(Number.NaN)).toBeUndefined();
    expect(upstreamSignal(10)).toBeInstanceOf(AbortSignal);
  });

  it("an upstream failure carries status and a text excerpt but never the key", async () => {
    const fetchImpl = async () => new Response("bad request: no such model", { status: 400 });
    const err = await speakClip({ cfg, text: "hello", fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("deepgram 400: bad request: no such model");
    expect(JSON.stringify({ message: err.message, detail: err.detail })).not.toContain("dg-secret-key");
  });
});
