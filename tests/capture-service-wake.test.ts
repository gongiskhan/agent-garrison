// Capture service — M3 wake gate over companion live segments.
//
// The full path under test: audio frames -> (mock) Deepgram finals -> echo
// guard -> the byte-identical wake bus -> pinned classifier on a stub gateway
// -> card on a stub board, capture_event + wake-results on disk, notifier
// receipts, three separate latency legs. Companion identity everywhere:
// source companion-ios, origin companion:wake:<id>, provenance
// companion_session_id (invariant I2).

import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import { encodeMediaFrame } from "../fittings/seed/capture-service/lib/ingress.mjs";

const TOKEN = "wake-test-token";
const DG_KEY = "dg-test-key";
const COMMAND = "Zeca, create a test task called hello companion.";
// The bus strips the wake token and leading punctuation before dispatch.
const COMMAND_TAIL = "create a test task called hello companion.";

function dgResults(text: string, isFinal = true, start = 0, duration = 2) {
  return JSON.stringify({
    type: "Results",
    start,
    duration,
    is_final: isFinal,
    channel: {
      alternatives: [
        { transcript: text, confidence: 0.98, words: text.split(/\s+/).map((w, i) => ({ word: w, start: start + i * 0.2, end: start + i * 0.2 + 0.19, speaker: 0 })) }
      ]
    }
  });
}

// A scriptable mock Deepgram: emits the given finals after the given number
// of binary frames.
function startMockDeepgram(script: Array<{ afterFrames: number; message: string }>) {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    let frames = 0;
    const fired = new Set<number>();
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        frames += 1;
        for (let i = 0; i < script.length; i++) {
          if (!fired.has(i) && frames >= script[i].afterFrames) {
            fired.add(i);
            ws.send(script[i].message);
          }
        }
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === "CloseStream") ws.close(1000);
    });
  });
  return { wss, url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}` };
}

// Stub gateway: answers /chat with a canned classifier reply and records the
// request bodies (to assert the routing pin).
function startStubGateway(reply: unknown) {
  const requests: any[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: typeof reply === "string" ? reply : JSON.stringify(reply) }));
    });
  });
  return new Promise<{ url: string; requests: any[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}

// Stub kanban board discovered via the sandbox home's status file.
function startStubBoard(home: string) {
  const cards: any[] = [];
  const server = createHttpServer((req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return respond(200, { ok: true });
    if (req.url === "/projects") return respond(200, { projects: ["garrison"] });
    if (req.url === "/cards" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const card = { id: `01CARD${String(cards.length + 1).padStart(4, "0")}`, ...JSON.parse(body) };
        cards.push(card);
        respond(200, { card });
      });
      return;
    }
    respond(404, { error: "not found" });
  });
  return new Promise<{ cards: any[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
      writeFileSync(
        path.join(home, "ui-fittings", "kanban-loop.json"),
        JSON.stringify({ fittingId: "kanban-loop", port, url: `http://127.0.0.1:${port}`, pid: process.pid })
      );
      resolve({ cards, close: () => server.close() });
    });
  });
}

async function waitFor(pred: () => boolean, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return pred();
}

describe("capture-service wake gate", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function boot(dgScript: Array<{ afterFrames: number; message: string }>, overrides: Record<string, unknown> = {}) {
    const home = mkdtempSync(path.join(os.tmpdir(), "capture-wake-"));
    const mock = startMockDeepgram(dgScript);
    const gateway = await startStubGateway({ intent: "create_task", title: "hello companion", description: "A test task from the companion." });
    const board = await startStubBoard(home);
    const env = { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN, DEEPGRAM_API_KEY: DG_KEY };
    const cfg = loadConfig(env);
    const handle = await startServer({
      ...cfg,
      env, // BoardClient/MemoryWriter/notifier resolve the sandbox home from this
      port: 0,
      enabled: true,
      transcribeEnabled: true,
      wakeEnabled: true,
      notifyEnabled: true, // exercises the honest not-implemented receipt
      gatewayUrl: gateway.url,
      wakeSilenceCloseMs: 150,
      wakeSettledCloseMs: 60,
      wakeMaxCaptureMs: 2000,
      wakeCardDedupeMs: 600000,
      wsFactory: () => new WebSocket(mock.url),
      ...overrides
    });
    cleanups.push(() => {
      handle.ingress.close();
      handle.server.close();
      mock.wss.close();
      gateway.close();
      board.close();
      rmSync(home, { recursive: true, force: true });
    });
    return { handle, home, gateway, board, base: `http://127.0.0.1:${handle.cfg.port}` };
  }

  async function streamAudio(base: string, sessionId: string, count: number) {
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
      JSON.stringify({ type: "session_start", session_id: sessionId, mode: "audio", device_name: "t", consent: "shown" })
    );
    await next((m) => m.type === "session_started");
    for (let seq = 1; seq <= count; seq++) {
      ws.send(encodeMediaFrame(0, seq, seq * 20, Buffer.from(`opus-${seq}`)));
      await next((m) => m.type === "ack" && m.seq === seq);
    }
    return { ws, next };
  }

  it("dispatches the spoken command exactly once with companion identity end to end", async () => {
    const { handle, home, gateway, board, base } = await boot([{ afterFrames: 5, message: dgResults(COMMAND) }]);
    const { ws } = await streamAudio(base, "01WAKESESSION0001", 8);

    await waitFor(() => board.cards.length === 1);
    // Give the dedupe window a beat to prove no second dispatch follows.
    await new Promise((r) => setTimeout(r, 300));
    expect(board.cards.length).toBe(1);

    const card = board.cards[0];
    expect(card.title).toBe("hello companion");
    expect(card.origin).toBe("companion");
    expect(card.originChannel).toEqual({ channel: "companion", threadId: "companion-reports" });
    expect(card.origin_id).toMatch(/^companion:wake:/);
    expect(card.description).toContain("Source (Companion wake command)");
    expect(card.description).toContain(`"${COMMAND_TAIL}"`);
    expect(card.description).toContain("Provenance: companion-ios wake session");

    // The classifier call was PINNED to the cheap lane (the 82s lesson).
    const chat = gateway.requests.find((r) => r.url === "/chat");
    expect(chat.body.routing).toEqual({ target: "cc-haiku-low" });
    expect(chat.body.channel).toBe("garrison");
    expect(chat.body.suppressContinuations).toBe(true);

    // Exactly one wake_command capture_event, companion-shaped (I2).
    const eventsDir = path.join(home, "capture", "events");
    const events = readdirSync(eventsDir).map((f) => JSON.parse(readFileSync(path.join(eventsDir, f), "utf8")));
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      source: "companion-ios",
      kind: "wake_command",
      status: "triaged",
      normalized: { title: COMMAND_TAIL }
    });
    expect(events[0].provenance.companion_session_id).toBe("01WAKESESSION0001");
    expect(existsSync(path.join(home, "capture", events[0].triage_result_ref))).toBe(true);

    // Three separate latency legs (never one number).
    const counters = handle.counters.read();
    expect(counters.wake_hits).toBe(1);
    expect(counters.wake_dispatches).toBe(1);
    expect(counters.wake_cards_created).toBe(1);
    expect(counters.wake_capture_ms_count).toBe(1);
    expect(counters.wake_command_ms_count).toBe(1);
    expect(counters.wake_notify_ms_count).toBe(1);
    expect(counters.wake_hit_to_notification_ms_count).toBe(1);
    // The notifier answered honestly: no push exists until M5.
    expect(counters.notify_skipped_unimplemented).toBe(1);
    ws.close();
  });

  it("ignores near-misses and duplicate segments", async () => {
    const { handle, board, base } = await boot([
      { afterFrames: 2, message: dgResults("A seca este ano está terrível.", true, 0, 1) },
      { afterFrames: 4, message: dgResults("Vamos zecar isto amanhã.", true, 1, 1) },
      // The same wake segment delivered twice: fingerprint-deduped, one capture.
      { afterFrames: 6, message: dgResults(COMMAND, true, 2, 2) },
      { afterFrames: 8, message: dgResults(COMMAND, true, 2, 2) }
    ]);
    const { ws } = await streamAudio(base, "01WAKESESSION0002", 10);

    await waitFor(() => board.cards.length === 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(board.cards.length).toBe(1);
    const counters = handle.counters.read();
    expect(counters.wake_hits).toBe(1);
    expect(counters.wake_segments_deduped).toBe(1);
    expect(counters.wake_segments_dropped).toBe(2); // the two near-misses
    ws.close();
  });

  it("honours the kill switch mid-session", async () => {
    // Wide close windows: the flag must demonstrably flip BEFORE the capture
    // closes, or the test races its own subject.
    const { handle, board, base } = await boot([{ afterFrames: 3, message: dgResults(COMMAND) }], {
      wakeSettledCloseMs: 400,
      wakeSilenceCloseMs: 500
    });
    await streamAudio(base, "01WAKESESSION0003", 3);
    await waitFor(() => handle.counters.read().wake_hits === 1);
    // Config flips OFF while the capture window is still open.
    (handle.cfg as any).wakeEnabled = false;
    await waitFor(() => handle.counters.read().wake_killed_mid_session === 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(board.cards.length).toBe(0);
    expect(handle.counters.read().wake_dispatches ?? 0).toBe(0);
  });

  it("suppresses a registered echo before the wake gate", async () => {
    const { handle, board, base } = await boot([{ afterFrames: 3, message: dgResults(`${COMMAND.replace("Zeca, c", "C")}`) }]);
    // The sink is about to "speak" a sentence that quotes the operator's
    // request; its fingerprint is registered BEFORE any audio returns.
    (handle as any).echoGuard.register({ text: "Created a test task called hello companion." });
    await streamAudio(base, "01WAKESESSION0004", 5);
    await new Promise((r) => setTimeout(r, 400));
    expect(handle.counters.read().realtime_echo_suppressed).toBe(1);
    expect(handle.counters.read().wake_hits ?? 0).toBe(0);
    expect(board.cards.length).toBe(0);
  });
});
