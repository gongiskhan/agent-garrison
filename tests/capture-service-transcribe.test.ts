// Capture service — M2 live transcription through a MOCK Deepgram endpoint.
//
// The mock is a real websocket server speaking the verified Results shape
// (docs/api-notes.md); the lane's wsFactory is pointed at it while the URL
// and Token-scheme auth header it WOULD have used are captured and asserted.
// Covers: fixture replay -> stored transcript + session-record refs, the live
// SSE view streaming interim/final segments, the flag-off and keyless skip
// paths, and the I5 rule that no transcript text ever reaches the logs.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import { encodeMediaFrame } from "../fittings/seed/capture-service/lib/ingress.mjs";
import { segmentFromResults, deepgramUrl } from "../fittings/seed/capture-service/lib/deepgram-live.mjs";

const TOKEN = "transcribe-test-token";
const DG_KEY = "dg-test-key-123";
const PT_INTERIM = "Zeca cria uma tarefa";
const PT_FINAL = "Zeca, cria uma tarefa de teste chamada olá companion.";
const PT_FLUSH = "Obrigado.";

function results(text: string, isFinal: boolean, start = 0, duration = 2, speaker: number | null = 0) {
  return JSON.stringify({
    type: "Results",
    start,
    duration,
    is_final: isFinal,
    channel: {
      alternatives: [
        {
          transcript: text,
          confidence: 0.98,
          words: text
            .split(/\s+/)
            .map((w, i) => ({ word: w, start: start + i * 0.2, end: start + i * 0.2 + 0.19, ...(speaker === null ? {} : { speaker }) }))
        }
      ]
    }
  });
}

// A mock Deepgram live endpoint: after 10 audio packets it emits an interim
// then a final; on CloseStream it flushes one last final and closes.
function startMockDeepgram() {
  const wss = new WebSocketServer({ port: 0 });
  const state = { connections: 0, binaryFrames: 0 };
  wss.on("connection", (ws) => {
    state.connections += 1;
    let sent = false;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        state.binaryFrames += 1;
        if (state.binaryFrames >= 10 && !sent) {
          sent = true;
          ws.send(results(PT_INTERIM, false, 0, 1.2));
          ws.send(results(PT_FINAL, true, 0, 2.4));
        }
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === "CloseStream") {
        ws.send(results(PT_FLUSH, true, 2.4, 0.6, 1));
        ws.close(1000);
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return { wss, url: `ws://127.0.0.1:${port}`, state };
}

async function streamSession(base: string, sessionId: string, packetCount = 15) {
  const ws = new WebSocket(base.replace("http", "ws") + "/capture/stream", {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  const queue: any[] = [];
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const next = (pred: (m: any) => boolean): Promise<any> => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error("timeout")), 8000).unref();
    });
  };
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.send(
    JSON.stringify({
      type: "session_start",
      session_id: sessionId,
      mode: "audio",
      device_name: "test",
      consent: "shown",
      started_at: "2026-08-13T10:00:00.000Z"
    })
  );
  await next((m) => m.type === "session_started" || m.type === "session_resumed");
  const packets = readFixture().slice(0, packetCount);
  for (const p of packets) {
    ws.send(encodeMediaFrame(0, p.seq, p.ts, p.bytes));
    await next((m) => m.type === "ack" && m.seq === p.seq);
  }
  return { ws, next };
}

function readFixture() {
  const file = path.join(
    __dirname,
    "..",
    "fittings",
    "seed",
    "capture-service",
    "fixtures",
    "audio-pt-command.jsonl"
  );
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .map((p) => ({ seq: p.seq, ts: p.ts, bytes: Buffer.from(p.bytes, "base64") }));
}

describe("capture-service transcription", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function boot(overrides: Record<string, unknown> = {}) {
    const home = mkdtempSync(path.join(os.tmpdir(), "capture-dg-"));
    const mock = startMockDeepgram();
    const captured: Array<{ url: string; auth: string | undefined }> = [];
    const cfg = loadConfig({ GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN, DEEPGRAM_API_KEY: DG_KEY });
    const handle = await startServer({
      ...cfg,
      port: 0,
      enabled: true,
      transcribeEnabled: true,
      wsFactory: (url: string, opts: { headers?: Record<string, string> }) => {
        captured.push({ url, auth: opts?.headers?.authorization });
        return new WebSocket(mock.url);
      },
      ...overrides
    });
    cleanups.push(() => {
      handle.ingress.close();
      handle.server.close();
      mock.wss.close();
      rmSync(home, { recursive: true, force: true });
    });
    return { handle, home, mock, captured, base: `http://127.0.0.1:${handle.cfg.port}` };
  }

  it("maps Results frames to the shared segment shape", () => {
    const seg = segmentFromResults(JSON.parse(results(PT_FINAL, true, 1, 2, 3)));
    expect(seg).toMatchObject({ start: 1, end: 3, text: PT_FINAL, speaker: 3, is_user: false, final: true });
    expect(segmentFromResults(JSON.parse(results("", true)))).toBeNull();
    const own = segmentFromResults(JSON.parse(results("hello", false, 0, 1, null)));
    expect(own).toMatchObject({ is_user: true, speaker: null, final: false });
  });

  it("builds the verified URL and Token-scheme auth", async () => {
    const { captured, base } = await boot();
    const { ws, next } = await streamSession(base, "01DGSESSION00001");
    ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await next((m) => m.type === "session_ended");
    expect(captured.length).toBe(1);
    const url = new URL(captured[0].url);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("api.deepgram.com");
    expect(url.pathname).toBe("/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: "nova-3",
      language: "multi",
      encoding: "opus",
      sample_rate: "16000",
      diarize: "true",
      interim_results: "true"
    });
    expect(captured[0].auth).toBe(`Token ${DG_KEY}`);
    expect(deepgramUrl(loadConfig({ DEEPGRAM_API_KEY: DG_KEY }))).toContain("model=nova-3");
  });

  it("stores the transcript on session end and references it from the record, with no text in logs", async () => {
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    const { handle, home, mock, base } = await boot();
    const sessionId = "01DGSESSION00002";
    const { ws, next } = await streamSession(base, sessionId);
    ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await next((m) => m.type === "session_ended");

    expect(mock.state.binaryFrames).toBe(15);
    const transcriptFile = path.join(home, "capture", "transcripts", `${sessionId}.json`);
    expect(existsSync(transcriptFile)).toBe(true);
    const transcript = JSON.parse(readFileSync(transcriptFile, "utf8"));
    expect(transcript.segments.map((s: any) => s.text)).toEqual([PT_FINAL, PT_FLUSH]);
    expect(transcript.words).toBeGreaterThan(5);

    const record = JSON.parse(
      readFileSync(path.join(home, "capture", "sessions", `${sessionId}.json`), "utf8")
    );
    expect(record.transcript_ref).toBe(`transcripts/${sessionId}.json`);
    expect(record.transcript_words).toBe(transcript.words);

    // The API surfaces the refs; the own-port view renders the content.
    const api = await fetch(`${base}/capture/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    }).then((r) => r.json());
    expect(api.session.transcript_words).toBe(transcript.words);
    const page = await fetch(`${base}/sessions/${sessionId}`).then((r) => r.text());
    expect(page).toContain("olá companion");

    // Invariant I5: transcript text never reaches the logs.
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join("\n");
    expect(logged).not.toContain("olá companion");
    expect(logged).not.toContain(PT_FLUSH);
    expect(handle.counters.read().transcripts_stored).toBe(1);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("streams interim and final segments to the live SSE view", async () => {
    const { base } = await boot();
    const sessionId = "01DGSESSION00003";
    // Open the session and stream 9 packets — below the mock's threshold, so
    // nothing has been emitted when the SSE subscriber attaches.
    const { ws, next } = await streamSession(base, sessionId, 9);

    const events: any[] = [];
    const controller = new AbortController();
    const ssePromise = fetch(`${base}/sessions/${sessionId}/events`, { signal: controller.signal }).then(
      async (res) => {
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (events.filter((e) => e.final).length < 1) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (line) events.push(JSON.parse(line.slice(6)));
          }
        }
      }
    );

    // Cross the mock's 10-packet threshold: interim + final arrive live.
    const packets = readFixture().slice(9, 12);
    for (const p of packets) {
      ws.send(encodeMediaFrame(0, p.seq, p.ts, p.bytes));
      await next((m) => m.type === "ack" && m.seq === p.seq);
    }
    await ssePromise;
    controller.abort();

    const interim = events.find((e) => !e.final);
    const final = events.find((e) => e.final);
    expect(interim?.text).toBe(PT_INTERIM);
    expect(final?.text).toBe(PT_FINAL);

    ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await next((m) => m.type === "session_ended");
  });

  it("skips cleanly when the flag is off or the key is missing", async () => {
    const off = await boot({ transcribeEnabled: false });
    const s1 = await streamSession(off.base, "01DGSESSION00004", 12);
    s1.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await s1.next((m) => m.type === "session_ended");
    expect(off.captured.length).toBe(0);
    expect(off.handle.counters.read().transcribe_skipped).toBe(1);
    const record1 = await fetch(`${off.base}/capture/sessions/01DGSESSION00004`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    }).then((r) => r.json());
    expect(record1.session.transcript_ref).toBeUndefined();

    // Key missing: cfg.secrets built from an env without DEEPGRAM_API_KEY.
    const homeless = mkdtempSync(path.join(os.tmpdir(), "capture-dg-nokey-"));
    const cfg = loadConfig({ GARRISON_HOME: homeless, CAPTURE_TOKEN: TOKEN });
    const keyless = await startServer({ ...cfg, port: 0, enabled: true, transcribeEnabled: true });
    cleanups.push(() => {
      keyless.ingress.close();
      keyless.server.close();
      rmSync(homeless, { recursive: true, force: true });
    });
    const s2 = await streamSession(`http://127.0.0.1:${keyless.cfg.port}`, "01DGSESSION00005", 3);
    s2.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await s2.next((m) => m.type === "session_ended");
    expect(keyless.counters.read().transcribe_skipped).toBe(1);
  });
});
