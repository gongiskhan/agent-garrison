// S6a — deepgram-voice LIVE relay (STT WS + streaming TTS WS) against a MOCK
// Deepgram WebSocket server. No real Deepgram key or network is required: the
// voice Fitting's Deepgram base URL is overridden (wsBase / DEEPGRAM_WS_BASE) to
// point at a local ws server that captures the upstream request (query params +
// auth header) and scripts Deepgram-shaped events back.
//
// Asserts, per the S6a task:
//   - client PCM frames forward to Deepgram with interim_results/endpointing/
//     utterance_end_ms/sample_rate query params (STT);
//   - interim + final + utterance-end events relay back to the client (STT);
//   - streaming TTS: client text (Speak/Flush) → Deepgram; audio + Flushed relay
//     back to the client;
//   - the API key NEVER appears in any client-bound frame (only the server↔DG
//     leg carries the Token auth header);
//   - closing the client tears down the Deepgram leg (both directions);
//   - 503 / error+close when the key is absent (Deepgram is never dialled);
//   - per-stage latency JSON lines (evt:"voice-latency") are emitted server-side.
//
// The web-channel-default relay hop (/api/voice/stream + /api/voice/tts-stream)
// is exercised end-to-end as browser → web-channel → voice → mock Deepgram.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

// GARRISON_HOME must be a throwaway dir BEFORE the servers are imported: both
// compute their ui-fittings status-file path at module load. Isolating it keeps
// the test off the live install's status files. The dynamic import below runs
// after this assignment.
const GHOME = mkdtempSync(path.join(tmpdir(), "voice-live-"));
process.env.GARRISON_HOME = GHOME;
mkdirSync(path.join(GHOME, "ui-fittings"), { recursive: true });

// Each startServer() registers SIGINT/SIGTERM handlers; across many tests that
// trips Node's default 10-listener warning. Lift the cap for the test process.
process.setMaxListeners(0);

// @ts-ignore — pure .mjs server, no d.ts (matches the repo's server.mjs test convention)
const voiceServerMod: any = await import("../fittings/seed/deepgram-voice/scripts/server.mjs");
// @ts-ignore — pure .mjs server
const webChannelServerMod: any = await import("../fittings/seed/web-channel-default/scripts/server.mjs");
const startVoiceServer = voiceServerMod.startServer;
const startWebChannelServer = webChannelServerMod.startServer;

const API_KEY = "dg-test-key-should-never-leak";

type MockConn = {
  ws: WebSocket;
  url: string;
  path: string;
  query: URLSearchParams;
  auth: string;
  received: { isBinary: boolean; text: string | null }[];
  closed: boolean;
};

// Mock Deepgram live WS server. Accepts connections on any path (/v1/listen or
// /v1/speak), records the request line + auth header + every frame it receives,
// and exposes the live socket so a test can push Deepgram-shaped events.
function createMockDeepgram() {
  const conns: MockConn[] = [];
  const waiters: (() => void)[] = [];
  let consumed = 0;
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (ws, req) => {
    const u = new URL(req.url || "/", "ws://mock");
    const rec: MockConn = {
      ws,
      url: req.url || "",
      path: u.pathname,
      query: u.searchParams,
      auth: String(req.headers.authorization || ""),
      received: [],
      closed: false
    };
    ws.on("message", (data: any, isBinary: boolean) =>
      rec.received.push({ isBinary: !!isBinary, text: isBinary ? null : data.toString() })
    );
    ws.on("close", () => {
      rec.closed = true;
    });
    conns.push(rec);
    const w = waiters.shift();
    if (w) w();
  });
  const listening = new Promise<void>((res) => wss.once("listening", res));
  return {
    listening,
    conns,
    wsBase() {
      return `ws://127.0.0.1:${(wss.address() as any).port}`;
    },
    async nextConn(): Promise<MockConn> {
      while (consumed >= conns.length) {
        await new Promise<void>((res) => waiters.push(res));
      }
      return conns[consumed++];
    },
    close() {
      return new Promise<void>((res) => wss.close(() => res()));
    }
  };
}

type ClientMsg = { isBinary: boolean; raw: any; json: any };

function collect(ws: WebSocket): ClientMsg[] {
  const msgs: ClientMsg[] = [];
  ws.on("message", (data: any, isBinary: boolean) => {
    let json: any = null;
    if (!isBinary) {
      try {
        json = JSON.parse(data.toString());
      } catch {
        /* non-json text frame */
      }
    }
    msgs.push({ isBinary: !!isBinary, raw: data, json });
  });
  return msgs;
}

function waitUntil(fn: () => boolean, label = "condition", timeout = 4000) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      let ok = false;
      try {
        ok = fn();
      } catch {
        ok = false;
      }
      if (ok) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(iv);
        reject(new Error(`timeout waiting for ${label}`));
      }
    }, 10);
  });
}

function assertNoKeyLeak(msgs: ClientMsg[]) {
  for (const m of msgs) {
    const s = typeof m.raw === "string" ? m.raw : Buffer.isBuffer(m.raw) ? m.raw.toString("utf8") : String(m.raw);
    expect(s.includes(API_KEY)).toBe(false);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      await c();
    } catch {
      /* best-effort teardown */
    }
  }
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port as number;
      s.close(() => resolve(p));
    });
  });
}

// port=0 lets Node pick a port (fine when the caller reads server.address()).
// Pass an explicit port when another process must discover this server through
// its status file — the server's own writeStatusFile then records the real URL,
// avoiding a race with a caller-side overwrite.
async function startVoice(apiKey: string, wsBase: string, port = 0) {
  const { server } = await startVoiceServer({
    port,
    host: "127.0.0.1",
    sttModel: "nova-2",
    ttsModel: "aura-asteria-en",
    ttsStreamModel: "aura-2-thalia-en",
    wsBase,
    apiKey
  });
  if (!server.listening) await new Promise<void>((res) => server.once("listening", res));
  cleanups.push(() => new Promise<void>((res) => server.close(() => res())));
  return { server, port: (server.address() as any).port as number };
}

function connectClient(url: string) {
  const ws = new WebSocket(url);
  cleanups.push(() => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
  return ws;
}

describe("deepgram-voice live STT relay (/stream)", () => {
  it("forwards PCM to Deepgram with the right query params + auth, and relays interim/final/utterance-end", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());
    const voice = await startVoice(API_KEY, mock.wsBase());

    const client = connectClient(`ws://127.0.0.1:${voice.port}/stream?sample_rate=16000&utterance_end_ms=1200`);
    const msgs = collect(client);

    const dg = await mock.nextConn();
    await waitUntil(() => msgs.some((m) => m.json?.type === "ready"), "client ready");

    // Query params forwarded to Deepgram's live /v1/listen.
    expect(dg.path).toBe("/v1/listen");
    expect(dg.query.get("interim_results")).toBe("true");
    expect(dg.query.get("endpointing")).toBe("300");
    expect(dg.query.get("utterance_end_ms")).toBe("1200");
    expect(dg.query.get("sample_rate")).toBe("16000");
    expect(dg.query.get("encoding")).toBe("linear16");
    expect(dg.query.get("channels")).toBe("1");
    expect(dg.query.get("model")).toBe("nova-2");
    expect(dg.query.get("vad_events")).toBe("true");
    // Auth rides the server→Deepgram leg only.
    expect(dg.auth).toBe(`Token ${API_KEY}`);

    // Client PCM forwards to Deepgram as binary.
    client.send(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]), { binary: true });
    await waitUntil(() => dg.received.some((r) => r.isBinary), "PCM forwarded to Deepgram");

    // Deepgram → client: interim, final, utterance-end.
    dg.ws.send(JSON.stringify({ type: "SpeechStarted" }));
    dg.ws.send(
      JSON.stringify({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "hello" }] } })
    );
    dg.ws.send(
      JSON.stringify({
        type: "Results",
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: "hello world" }] }
      })
    );
    dg.ws.send(JSON.stringify({ type: "UtteranceEnd" }));

    await waitUntil(() => msgs.some((m) => m.json?.type === "utterance_end"), "utterance_end relayed");

    const transcripts = msgs.filter((m) => m.json?.type === "transcript");
    expect(transcripts.some((m) => m.json.text === "hello" && m.json.isFinal === false)).toBe(true);
    expect(transcripts.some((m) => m.json.text === "hello world" && m.json.isFinal === true)).toBe(true);
    expect(msgs.some((m) => m.json?.type === "speech_started")).toBe(true);
    const uttEnd = msgs.find((m) => m.json?.type === "utterance_end");
    expect(uttEnd!.json.transcript).toBe("hello world");

    assertNoKeyLeak(msgs);
  });

  it("closing the client tears down the Deepgram leg", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());
    const voice = await startVoice(API_KEY, mock.wsBase());

    const client = connectClient(`ws://127.0.0.1:${voice.port}/stream?sample_rate=16000`);
    const msgs = collect(client);
    const dg = await mock.nextConn();
    await waitUntil(() => msgs.some((m) => m.json?.type === "ready"), "client ready");

    client.close();
    await waitUntil(() => dg.closed, "Deepgram leg closed after client disconnect");
    // Graceful flush: the server signals CloseStream to Deepgram before closing.
    expect(dg.received.some((r) => r.text?.includes("CloseStream"))).toBe(true);
  });

  it("a Deepgram-side close tears down the client", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());
    const voice = await startVoice(API_KEY, mock.wsBase());

    const client = connectClient(`ws://127.0.0.1:${voice.port}/stream?sample_rate=16000`);
    const msgs = collect(client);
    let clientClosed = false;
    client.on("close", () => {
      clientClosed = true;
    });
    const dg = await mock.nextConn();
    await waitUntil(() => msgs.some((m) => m.json?.type === "ready"), "client ready");

    dg.ws.close();
    await waitUntil(() => clientClosed, "client closed after Deepgram close");
  });
});

describe("deepgram-voice streaming TTS relay (/tts-stream)", () => {
  it("forwards Speak/Flush to Deepgram /v1/speak and relays audio + Flushed back", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());
    const voice = await startVoice(API_KEY, mock.wsBase());

    const client = connectClient(`ws://127.0.0.1:${voice.port}/tts-stream?sample_rate=24000`);
    const msgs = collect(client);

    const dg = await mock.nextConn();
    await waitUntil(() => msgs.some((m) => m.json?.type === "ready"), "client ready");

    expect(dg.path).toBe("/v1/speak");
    expect(dg.query.get("encoding")).toBe("linear16");
    expect(dg.query.get("sample_rate")).toBe("24000");
    expect(dg.query.get("model")).toBe("aura-2-thalia-en");
    expect(dg.auth).toBe(`Token ${API_KEY}`);

    client.send(JSON.stringify({ type: "speak", text: "Hello there" }));
    client.send(JSON.stringify({ type: "flush" }));

    await waitUntil(
      () =>
        dg.received.some((r) => r.text?.includes('"Speak"') && r.text?.includes("Hello there")) &&
        dg.received.some((r) => r.text?.includes('"Flush"')),
      "Speak + Flush forwarded to Deepgram"
    );

    // Deepgram → client: streamed audio (binary), then a Flushed event.
    dg.ws.send(Buffer.from("fake-audio-chunk-pcm"), { binary: true });
    dg.ws.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));

    await waitUntil(() => msgs.some((m) => m.isBinary), "audio chunk relayed to client");
    await waitUntil(() => msgs.some((m) => m.json?.type === "flushed"), "flushed relayed to client");

    assertNoKeyLeak(msgs);

    // Client close forwards a Close to Deepgram and tears the leg down.
    client.close();
    await waitUntil(() => dg.closed, "Deepgram TTS leg closed after client disconnect");
  });

  it("surfaces a Deepgram error to the client", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());
    const voice = await startVoice(API_KEY, mock.wsBase());

    const client = connectClient(`ws://127.0.0.1:${voice.port}/tts-stream`);
    const msgs = collect(client);
    const dg = await mock.nextConn();
    await waitUntil(() => msgs.some((m) => m.json?.type === "ready"), "client ready");

    dg.ws.send(JSON.stringify({ type: "Error", description: "kaboom" }));
    await waitUntil(() => msgs.some((m) => m.json?.type === "error"), "error surfaced");
    const err = msgs.find((m) => m.json?.type === "error");
    expect(err!.json.error).toContain("kaboom");
  });
});

describe("deepgram-voice key-absent guard", () => {
  it("STT /stream errors + closes without dialling Deepgram when the key is missing", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());
    const voice = await startVoice("", mock.wsBase());

    const client = connectClient(`ws://127.0.0.1:${voice.port}/stream?sample_rate=16000`);
    const msgs = collect(client);
    let closed = false;
    client.on("close", () => {
      closed = true;
    });

    await waitUntil(() => msgs.some((m) => m.json?.type === "error"), "error emitted");
    await waitUntil(() => closed, "client closed");
    expect(msgs.find((m) => m.json?.type === "error")!.json.error).toContain("DEEPGRAM_API_KEY");
    expect(mock.conns.length).toBe(0); // Deepgram never dialled
  });

  it("TTS /tts-stream errors + closes without dialling Deepgram when the key is missing", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());
    const voice = await startVoice("", mock.wsBase());

    const client = connectClient(`ws://127.0.0.1:${voice.port}/tts-stream`);
    const msgs = collect(client);
    let closed = false;
    client.on("close", () => {
      closed = true;
    });

    await waitUntil(() => msgs.some((m) => m.json?.type === "error"), "error emitted");
    await waitUntil(() => closed, "client closed");
    expect(mock.conns.length).toBe(0);
  });
});

describe("deepgram-voice latency instrumentation", () => {
  it("emits per-stage voice-latency JSON lines for an STT + TTS round trip", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());

    const latency: any[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      const line = args[0];
      if (typeof line === "string") {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.evt === "voice-latency") latency.push(parsed);
        } catch {
          /* non-json log line */
        }
      }
    });
    cleanups.push(() => spy.mockRestore());

    const voice = await startVoice(API_KEY, mock.wsBase());

    // STT round trip → audio_in, first_interim, utterance_end.
    const stt = connectClient(`ws://127.0.0.1:${voice.port}/stream?sample_rate=16000&utterance_end_ms=1000`);
    const sttMsgs = collect(stt);
    const dgStt = await mock.nextConn();
    await waitUntil(() => sttMsgs.some((m) => m.json?.type === "ready"), "stt ready");
    stt.send(Buffer.from([9, 9, 9, 9]), { binary: true });
    await waitUntil(() => dgStt.received.some((r) => r.isBinary), "pcm in");
    dgStt.ws.send(
      JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "hi" }] } })
    );
    dgStt.ws.send(JSON.stringify({ type: "UtteranceEnd" }));
    await waitUntil(() => sttMsgs.some((m) => m.json?.type === "utterance_end"), "utterance end");

    // TTS round trip → tts_text_in, tts_first_audio.
    const tts = connectClient(`ws://127.0.0.1:${voice.port}/tts-stream?sample_rate=24000`);
    const ttsMsgs = collect(tts);
    const dgTts = await mock.nextConn();
    await waitUntil(() => ttsMsgs.some((m) => m.json?.type === "ready"), "tts ready");
    tts.send(JSON.stringify({ type: "speak", text: "hi" }));
    await waitUntil(() => dgTts.received.some((r) => r.text?.includes("Speak")), "speak in");
    dgTts.ws.send(Buffer.from("audio"), { binary: true });

    await waitUntil(
      () =>
        latency.some((l) => l.stage === "audio_in") &&
        latency.some((l) => l.stage === "first_interim") &&
        latency.some((l) => l.stage === "utterance_end") &&
        latency.some((l) => l.stage === "tts_text_in") &&
        latency.some((l) => l.stage === "tts_first_audio"),
      "all latency stages emitted"
    );

    for (const l of latency) {
      expect(typeof l.ts).toBe("number");
      expect(typeof l.session).toBe("string");
    }
  });
});

describe("web-channel-default voice relay hop", () => {
  async function startWebChannelAgainstVoice(voicePort: number) {
    // web-channel reads the voice URL from the ui-fittings status file.
    writeFileSync(
      path.join(GHOME, "ui-fittings", "deepgram-voice.json"),
      JSON.stringify({ fittingId: "deepgram-voice", port: voicePort, url: `http://127.0.0.1:${voicePort}`, pid: process.pid })
    );
    const { server } = await startWebChannelServer({
      port: 0,
      host: "127.0.0.1",
      gatewayUrl: "http://127.0.0.1:1",
      tlsCert: "",
      tlsKey: ""
    });
    if (!server.listening) await new Promise<void>((res) => server.once("listening", res));
    cleanups.push(() => new Promise<void>((res) => server.close(() => res())));
    return (server.address() as any).port as number;
  }

  it("relays /api/voice/stream → voice /stream → Deepgram /v1/listen", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());
    const voice = await startVoice(API_KEY, mock.wsBase(), await getFreePort());
    const wcPort = await startWebChannelAgainstVoice(voice.port);

    const client = connectClient(`ws://127.0.0.1:${wcPort}/api/voice/stream?sample_rate=16000`);
    const msgs = collect(client);
    const dg = await mock.nextConn();
    await waitUntil(() => msgs.some((m) => m.json?.type === "ready"), "client ready through relay");
    expect(dg.path).toBe("/v1/listen");
    expect(dg.query.get("sample_rate")).toBe("16000");
    assertNoKeyLeak(msgs);
  });

  it("relays /api/voice/tts-stream → voice /tts-stream → Deepgram /v1/speak", async () => {
    const mock = createMockDeepgram();
    await mock.listening;
    cleanups.push(() => mock.close());
    const voice = await startVoice(API_KEY, mock.wsBase(), await getFreePort());
    const wcPort = await startWebChannelAgainstVoice(voice.port);

    const client = connectClient(`ws://127.0.0.1:${wcPort}/api/voice/tts-stream?sample_rate=24000`);
    const msgs = collect(client);
    const dg = await mock.nextConn();
    await waitUntil(() => msgs.some((m) => m.json?.type === "ready"), "client ready through relay");
    expect(dg.path).toBe("/v1/speak");
    expect(dg.query.get("sample_rate")).toBe("24000");

    client.send(JSON.stringify({ type: "speak", text: "relayed" }));
    await waitUntil(() => dg.received.some((r) => r.text?.includes("relayed")), "speak forwarded through relay");
    assertNoKeyLeak(msgs);
  });
});

describe("S6a codex hardening — Metadata sanitization + bounded pre-open buffer", () => {
  it("sanitizeMetadata forwards only safe scalar fields, never an echoed token", () => {
    const out = voiceServerMod.sanitizeMetadata({
      type: "Metadata",
      request_id: "req-123",
      duration: 1.5,
      authorization: "Token sk-DEEPGRAM-SECRET",
      apiKey: "sk-DEEPGRAM-SECRET"
    });
    expect(out.request_id).toBe("req-123");
    expect(out.duration).toBe(1.5);
    expect(JSON.stringify(out)).not.toContain("sk-DEEPGRAM-SECRET");
    expect(out).not.toHaveProperty("authorization");
    expect(out).not.toHaveProperty("apiKey");
  });

  it("boundedPending refuses to grow past the cap (memory-DoS guard)", () => {
    const buf = voiceServerMod.boundedPending(3);
    expect(buf.push("a")).toBe(true);
    expect(buf.push("b")).toBe(true);
    expect(buf.push("c")).toBe(true);
    expect(buf.push("d")).toBe(false); // overflow
    expect(buf.length).toBe(3);
    expect(buf.drain()).toEqual(["a", "b", "c"]);
    expect(buf.length).toBe(0);
  });
})

describe("codex checkpoint — scrubSecret strips the key from client-bound errors", () => {
  it("redacts the literal key + Token echo", () => {
    const out = voiceServerMod.scrubSecret("deepgram: bad Token dg-secret-123", "dg-secret-123");
    expect(out).not.toContain("dg-secret-123");
    expect(out).toContain("[redacted]");
  });
})
