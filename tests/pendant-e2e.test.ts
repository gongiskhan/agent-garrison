// Pendant Direct — the end-to-end loop (npm run e2e:pendant).
//
// A sandboxed capture service boots with every pendant flag on and all
// externals mocked (Deepgram, gateway, board, APNs absent); the phone plus
// pendant side is played by the REAL replay client subprocess speaking the
// full wire protocol, streaming committed Opus fixture audio at real 20 ms
// cadence, receiving {type:"feedback"} events and acking them exactly as the
// Companion's device/phone sinks do. Scenario matrix per the brief: the
// wake-to-card flow with latency targets, a true near-miss, duplicate
// segments, a mid-window disconnect with resume, the ambient policy, and the
// feedback-unsupported fallback.

import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import { encodeMediaFrame } from "../fittings/seed/capture-service/lib/ingress.mjs";

const execFileAsync = promisify(execFile);
const TOKEN = "pendant-e2e-token";
const REPLAY = path.join(__dirname, "..", "fittings", "seed", "capture-service", "scripts", "replay-client.mjs");
const WAKE_FINAL = "Zeca, cria uma tarefa de teste chamada olá garrison.";

function dgResults(text: string, isFinal = true, start = 0, duration = 2) {
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
          words: text.split(/\s+/).map((w, i) => ({ word: w, start: start + i * 0.2, end: start + i * 0.2 + 0.19, speaker: 0 }))
        }
      ]
    }
  });
}

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

function startStubBoard(home: string) {
  const cards: any[] = [];
  const server = createHttpServer((req, res) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return respond(200, { ok: true });
    if (req.url === "/projects") return respond(200, { projects: [] });
    if (req.url?.startsWith("/cards?origin_id=")) return respond(200, { cards: [] });
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

async function waitFor(pred: () => boolean, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

describe("e2e:pendant - the full loop from a clean sandbox", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function boot(
    dgScript: Array<{ afterFrames: number; message: string }>,
    overrides: Record<string, unknown> = {}
  ) {
    const home = mkdtempSync(path.join(os.tmpdir(), "pendant-e2e-"));
    const mock = startMockDeepgram(dgScript);
    const gateway = await startStubGateway({
      intent: "create_task",
      title: "olá garrison",
      description: "Tarefa de teste criada por voz."
    });
    const board = await startStubBoard(home);
    const env = {
      GARRISON_HOME: home,
      CAPTURE_TOKEN: TOKEN,
      DEEPGRAM_API_KEY: "dg-e2e-key",
      BASIC_MEMORY_VAULT_DIR: path.join(home, "no-vault")
    };
    const cfg = loadConfig(env);
    const handle = await startServer({
      ...cfg,
      env,
      port: 0,
      enabled: true,
      transcribeEnabled: true,
      wakeEnabled: true,
      notifyEnabled: true,
      pendantEnabled: true,
      gatewayUrl: gateway.url,
      // Realistic-but-test-sized window: settled close at 300 ms after a
      // punctuated final, 1 s silence otherwise, 20 s cap.
      wakeSilenceCloseMs: 1000,
      wakeSettledCloseMs: 300,
      wakeMaxCaptureMs: 20000,
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

  function replay(base: string, args: string[]) {
    return execFileAsync(
      process.execPath,
      [REPLAY, "run", "--base", base, "--token", TOKEN, ...args],
      { timeout: 120000 }
    );
  }

  it("wake-to-card at real cadence: tier sequence, timestamps, and latency targets", async () => {
    const { handle, home, board, base } = await boot([
      // STT timing modeled on real nova-3 behaviour: an interim carrying the
      // wake word ~1.1 s in, the full punctuated final ~1.8 s in.
      { afterFrames: 55, message: dgResults("Zeca", false, 0, 1.1) },
      { afterFrames: 90, message: dgResults(WAKE_FINAL, true, 0, 1.9) }
    ]);
    const { stdout } = await replay(base, [
      "--mode",
      "pendant",
      "--fixture",
      "pt-hellogarrison",
      "--cadence",
      "real",
      "--session",
      "01E2EPENDANT0001",
      "--settle-ms",
      "3000"
    ]);

    // Surface the replay client's feedback log (the device write log of this
    // run) into the vitest output - the report quotes it from here.
    console.log(`[e2e:pendant wake-to-card]\n${stdout}`);

    // The tier sequence, from the client's own feedback log (the device and
    // phone sink stand-in), with arrival offsets.
    expect(stdout).toMatch(/feedback \+\d+ms: wake_detected.*\[interim\]/);
    expect(stdout).toMatch(/feedback \+\d+ms: window_closed/);
    expect(stdout).toMatch(/feedback \+\d+ms: task_created/);
    expect(stdout).toContain("no session record stored - the wake_only capture policy at work");
    expect(stdout).toContain("every packet acked");

    // Exactly one card, pendant identity end to end.
    expect(board.cards.length).toBe(1);
    expect(board.cards[0].origin).toBe("pendant");
    expect(board.cards[0].origin_id).toMatch(/^pendant:wake:/);

    // Latency targets from the brief, measured through the whole loop.
    const counters = handle.counters.read();
    expect(counters.wake_to_device_ack_ms_count).toBe(1);
    expect(counters.wake_to_device_ack_ms_last).toBeLessThan(1500);
    expect(counters.card_commit_to_created_ack_ms_count).toBe(1);
    expect(counters.card_commit_to_created_ack_ms_last).toBeLessThan(2000);
    expect(counters.pendant_interim_wake_hits).toBe(1);

    // wake_only storage proof: only the wake path persisted.
    expect(existsSync(path.join(home, "capture", "sessions", "01E2EPENDANT0001.json"))).toBe(false);
    expect(existsSync(path.join(home, "capture", "transcripts", "01E2EPENDANT0001.json"))).toBe(false);
    const events = readdirSync(path.join(home, "capture", "events"));
    expect(events.length).toBe(1);
  }, 120000);

  it("near-miss audio never wakes and leaves nothing behind", async () => {
    const { handle, board, base } = await boot([
      { afterFrames: 40, message: dgResults("A biblioteca estava seca e a Rebeca ficou em casa.", true, 0, 3) }
    ]);
    const { stdout } = await replay(base, [
      "--mode",
      "pendant",
      "--fixture",
      "pt-truemiss",
      "--session",
      "01E2EPENDANT0002",
      "--settle-ms",
      "1500"
    ]);
    expect(stdout).toContain("feedback: none received");
    expect(board.cards.length).toBe(0);
    const counters = handle.counters.read();
    expect(counters.wake_hits ?? 0).toBe(0);
    expect(counters.pendant_interim_wake_hits ?? 0).toBe(0);
    expect(counters.events_emitted ?? 0).toBe(0);
  }, 60000);

  it("duplicate segments dispatch exactly once", async () => {
    const { handle, board, base } = await boot([
      { afterFrames: 40, message: dgResults(WAKE_FINAL, true, 0, 2) },
      { afterFrames: 60, message: dgResults(WAKE_FINAL, true, 0, 2) } // same fingerprint
    ]);
    await replay(base, [
      "--mode",
      "pendant",
      "--fixture",
      "pt-hellogarrison",
      "--session",
      "01E2EPENDANT0003",
      "--settle-ms",
      "2500"
    ]);
    expect(board.cards.length).toBe(1);
    expect(handle.counters.read().wake_segments_deduped).toBe(1);
  }, 60000);

  it("a mid-stream disconnect resumes from the last ack and still yields one card", async () => {
    const { handle, board, base } = await boot([
      { afterFrames: 40, message: dgResults(WAKE_FINAL, true, 0, 2) }
    ]);
    const { stdout } = await replay(base, [
      "--mode",
      "pendant",
      "--fixture",
      "pt-hellogarrison",
      "--session",
      "01E2EPENDANT0004",
      "--drop-at",
      "120",
      "--settle-ms",
      "2500"
    ]);
    expect(stdout).toContain("reconnecting");
    expect(stdout).toContain("every packet acked");
    await waitFor(() => board.cards.length === 1);
    expect(board.cards.length).toBe(1);
    expect(handle.counters.read().sessions_resumed).toBe(1);
  }, 60000);

  it("ambient policy stores the session transcript with pendant identity", async () => {
    const speech = "Amanhã de manhã tenho de levar o carro à revisão e depois passar na farmácia.";
    const { handle, home, base } = await boot(
      [{ afterFrames: 40, message: dgResults(speech, true, 0, 3) }],
      { capturePolicy: "ambient", minTranscriptWords: 3 }
    );
    await replay(base, [
      "--mode",
      "pendant",
      "--fixture",
      "pt-ambient",
      "--session",
      "01E2EPENDANT0005",
      "--settle-ms",
      "500"
    ]);
    await waitFor(() => handle.counters.read().events_emitted === 1);
    const record = JSON.parse(
      readFileSync(path.join(home, "capture", "sessions", "01E2EPENDANT0005.json"), "utf8")
    );
    expect(record.source).toBe("pendant");
    expect(record.transcript_ref).toBe("transcripts/01E2EPENDANT0005.json");
    const events = readdirSync(path.join(home, "capture", "events")).map((f) =>
      JSON.parse(readFileSync(path.join(home, "capture", "events", f), "utf8"))
    );
    expect(events[0]).toMatchObject({ source: "pendant", kind: "session", status: "pending" });
  }, 60000);

  it("feedback-unsupported fallback: an unacking client still gets the card; the loop degrades honestly", async () => {
    const { handle, board, base } = await boot([
      { afterFrames: 6, message: dgResults(WAKE_FINAL, true, 0, 2) }
    ]);
    // A raw client that NEVER acks feedback (a devkit1 with no haptic and a
    // silenced phone): events push, acks never come, the card still lands.
    const ws = new WebSocket(base.replace("http", "ws") + "/capture/stream", {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const messages: any[] = [];
    ws.on("message", (d, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(d.toString()));
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(
      JSON.stringify({ type: "session_start", session_id: "01E2EPENDANT0006", mode: "pendant", device_name: "p", consent: "shown" })
    );
    await waitFor(() => messages.some((m) => m.type === "session_started"));
    for (let seq = 1; seq <= 10; seq++) {
      ws.send(encodeMediaFrame(0, seq, seq * 20, Buffer.from(`opus-${seq}`)));
    }
    await waitFor(() => board.cards.length === 1);
    await waitFor(() => messages.filter((m) => m.type === "feedback").length >= 3);
    const counters = handle.counters.read();
    expect(counters.feedback_pushed).toBeGreaterThanOrEqual(3);
    expect(counters.feedback_acks ?? 0).toBe(0);
    expect(counters.wake_to_device_ack_ms_count ?? 0).toBe(0);
    ws.close();
  }, 60000);
});
