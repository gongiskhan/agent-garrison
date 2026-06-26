import { describe, expect, it } from "vitest";
import { CATALOG, runAction } from "../fittings/seed/deepgram-voice/scripts/connector.mjs";

// C3 — Deepgram dual connector (also a voice surface). The connector half does
// transcribe/synthesize via the Deepgram API with a scoped api key.

const ENV = { DEEPGRAM_API_KEY: "dg-key" };

function mockFetch(cap: { url?: string; opts?: any }, body: unknown) {
  return async (url: string, opts?: any) => {
    cap.url = url;
    cap.opts = opts;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new TextEncoder().encode("audio").buffer
    };
  };
}

describe("deepgram connector (C3)", () => {
  it("catalog has transcribe + synthesize", () => {
    expect(CATALOG.service).toBe("deepgram");
    expect(CATALOG.actions.map((a: any) => a.name)).toEqual(expect.arrayContaining(["transcribe", "synthesize"]));
  });

  it("transcribe POSTs audio with a Token auth header and returns the transcript", async () => {
    const cap: { url?: string; opts?: any } = {};
    const body = { results: { channels: [{ alternatives: [{ transcript: "hello world" }] }] } };
    const result = (await runAction({
      action: "transcribe",
      args: { audio_base64: Buffer.from("x").toString("base64"), mime_type: "audio/wav" },
      env: ENV,
      fetchImpl: mockFetch(cap, body)
    })) as any;
    expect(cap.url).toContain("api.deepgram.com/v1/listen");
    expect(cap.opts!.headers.Authorization).toBe("Token dg-key");
    expect(result.transcript).toBe("hello world");
  });

  it("throws awaiting_connector when the key is missing", async () => {
    await expect(runAction({ action: "transcribe", args: {}, env: {}, fetchImpl: mockFetch({}, {}) })).rejects.toMatchObject({
      awaiting_connector: true
    });
  });
});
