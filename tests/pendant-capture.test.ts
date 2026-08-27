// Pendant Direct — capture policy, pendant identity, and feedback loop
// (ADR D5-D8 in docs/adr-pendant-direct.md).
//
// The path under test: pendant-mode websocket session -> (mock) Deepgram
// interims + finals -> interim wake watcher (feedback-only) + the
// byte-identical wake bus with the pendant source bag -> stub gateway/board
// -> feedback events pushed to the session socket -> feedback_ack receipts
// closing the two headline latency metrics. Both capture policies proven at
// the storage layer: wake_only persists nothing but the wake path; ambient
// persists the session transcript and feeds the shared triage tick with
// pendant identity in ONE model call.

import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import { encodeMediaFrame } from "../fittings/seed/capture-service/lib/ingress.mjs";
import { FeedbackBus } from "../fittings/seed/capture-service/lib/feedback.mjs";
import { Counters } from "../fittings/seed/capture-service/lib/store.mjs";
import { OmiStore, EventsDirStore } from "../fittings/seed/omi-channel/lib/store.mjs";
import { runTriageTick } from "../fittings/seed/omi-channel/lib/triage.mjs";
import { loadConfig as loadOmiConfig } from "../fittings/seed/omi-channel/lib/config.mjs";
import { MemoryWriter } from "../fittings/seed/omi-channel/lib/memory-writer.mjs";
import { CaptureStore, atomicWriteJSON } from "../fittings/seed/capture-service/lib/store.mjs";

const TOKEN = "pendant-test-token";
const COMMAND = "Zeca, create a test task called hello garrison.";
const COMMAND_TAIL = "create a test task called hello garrison.";

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
          confidence: 0.97,
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
    if (req.url === "/projects") return respond(200, { projects: ["garrison"] });
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

async function waitFor(pred: () => boolean, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return pred();
}

describe("pendant capture path", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function boot(
    dgScript: Array<{ afterFrames: number; message: string }>,
    overrides: Record<string, unknown> = {}
  ) {
    const home = mkdtempSync(path.join(os.tmpdir(), "pendant-"));
    const mock = startMockDeepgram(dgScript);
    const gateway = await startStubGateway({
      intent: "create_task",
      title: "hello garrison",
      description: "A test task from the pendant."
    });
    const board = await startStubBoard(home);
    const env = {
      GARRISON_HOME: home,
      CAPTURE_TOKEN: TOKEN,
      DEEPGRAM_API_KEY: "dg-test-key",
      // Never let a note fallback reach a real memory vault on the test host.
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
      pendantEnabled: true,
      gatewayUrl: gateway.url,
      wakeSilenceCloseMs: 150,
      wakeSettledCloseMs: 60,
      wakeMaxCaptureMs: 2000,
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

  // Opens a pendant-mode session, streams `count` opus frames, auto-acks
  // every {type:"feedback"} event, and collects them in arrival order.
  async function streamPendant(
    base: string,
    sessionId: string,
    count: number,
    { mode = "pendant", codec = "opus_fs320", autoAck = true }: { mode?: string; codec?: string; autoAck?: boolean } = {}
  ) {
    const ws = new WebSocket(base.replace("http", "ws") + "/capture/stream", {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const feedback: any[] = [];
    const queue: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.type === "feedback") {
        feedback.push(msg.event);
        if (autoAck) ws.send(JSON.stringify({ type: "feedback_ack", event_id: msg.event.event_id }));
        return;
      }
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
        mode,
        codec,
        device_name: "pendant-relay",
        consent: "shown"
      })
    );
    const opened = await next((m) => m.type === "session_started" || m.type === "error");
    for (let seq = 1; seq <= count; seq++) {
      ws.send(encodeMediaFrame(0, seq, seq * 20, Buffer.from(`opus-${seq}`)));
      await next((m) => m.type === "ack" && m.seq === seq);
    }
    return { ws, next, feedback, opened };
  }

  it("refuses pendant sessions while pendant_enabled is off (independent kill switch)", async () => {
    const { handle, base } = await boot([], { pendantEnabled: false });
    const ws = new WebSocket(base.replace("http", "ws") + "/capture/stream", {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const messages: any[] = [];
    ws.on("message", (d, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(d.toString()));
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    ws.send(
      JSON.stringify({ type: "session_start", session_id: "01PENDANTOFF00001", mode: "pendant", device_name: "p", consent: "shown" })
    );
    await waitFor(() => messages.some((m) => m.type === "error"));
    expect(messages[0].error).toBe("pendant capture disabled");
    expect(handle.counters.read().rejected_pendant_disabled).toBe(1);
    // A mic-mode session on the same server still works.
    const mic = await streamPendant(base, "01MICSESSION00001", 1, { mode: "audio" });
    expect(mic.opened.type).toBe("session_started");
    mic.ws.close();
    ws.close();
  });

  it("wake_only persists nothing but the wake path, with the full feedback sequence and latency receipts", async () => {
    const { handle, home, board, base } = await boot(
      [
        // Wake final WITHOUT sentence end, then a second final that completes
        // it - exercising segment_captured inside the open window.
        { afterFrames: 3, message: dgResults("Zeca, create a test task called", true, 0, 1.5) },
        { afterFrames: 6, message: dgResults("hello garrison.", true, 2, 1) }
      ],
      // Wide silence window so the second final always lands inside the open
      // capture on a slow box; the settled close (60 ms after the sentence
      // ends) is what actually closes it.
      { wakeSilenceCloseMs: 800 }
    );
    const sessionId = "01PENDANTWAKE0001";
    const { ws, next, feedback } = await streamPendant(base, sessionId, 9);

    await waitFor(() => board.cards.length === 1);
    await waitFor(() => feedback.some((e) => e.name === "task_created"));

    // Pendant identity end to end (I2 / ADR D7).
    const card = board.cards[0];
    expect(card.origin).toBe("pendant");
    expect(card.originChannel).toEqual({ channel: "pendant", threadId: "pendant-reports" });
    expect(card.origin_id).toMatch(/^pendant:wake:/);
    expect(card.description).toContain("Source (Pendant wake command)");
    expect(card.description).toContain("Provenance: pendant wake session");

    // The wake_command event is persisted by the dispatch chain AFTER the
    // card exists (task_created fires from inside handleCommand) - wait for
    // the write, don't race it.
    const eventsDir = path.join(home, "capture", "events");
    await waitFor(() => readdirSync(eventsDir).length === 1);
    const events = readdirSync(eventsDir).map((f) => JSON.parse(readFileSync(path.join(eventsDir, f), "utf8")));
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ source: "pendant", kind: "wake_command", status: "triaged" });
    expect(events[0].provenance.pendant_session_id).toBe(sessionId);

    // The feedback tier sequence, in order.
    const names = feedback.map((e) => e.name);
    expect(names).toEqual(["wake_detected", "segment_captured", "window_closed", "task_created"]);

    // End the session; wake_only leaves NOTHING behind but the wake path.
    ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await next((m) => m.type === "session_ended");
    expect(existsSync(path.join(home, "capture", "sessions", `${sessionId}.json`))).toBe(false);
    expect(existsSync(path.join(home, "capture", "transcripts", `${sessionId}.json`))).toBe(false);
    expect(existsSync(path.join(home, "capture", "media", sessionId))).toBe(false);

    const counters = handle.counters.read();
    expect(counters.pendant_sessions_unpersisted).toBe(1);
    expect(counters.transcripts_dropped_policy).toBe(1);
    expect(counters.transcripts_stored ?? 0).toBe(0);
    // Latency receipts: one wake ack, one card ack, both inside the targets
    // even in this millisecond-scale sandbox.
    expect(counters.feedback_acks).toBe(4);
    expect(counters.wake_to_device_ack_ms_count).toBe(1);
    expect(counters.wake_to_device_ack_ms_last).toBeLessThan(1500);
    expect(counters.card_commit_to_created_ack_ms_count).toBe(1);
    expect(counters.card_commit_to_created_ack_ms_last).toBeLessThan(2000);
    ws.close();
  });

  it("fires wake feedback on the interim early, exactly once per window", async () => {
    const { handle, board, base } = await boot([
      { afterFrames: 2, message: dgResults("Zeca", false, 0, 0.5) },
      { afterFrames: 5, message: dgResults(COMMAND, true, 0, 2) }
    ]);
    const { ws, feedback } = await streamPendant(base, "01PENDANTINTERIM1", 8);
    await waitFor(() => board.cards.length === 1);
    await waitFor(() => feedback.some((e) => e.name === "task_created"));

    const wakes = feedback.filter((e) => e.name === "wake_detected");
    expect(wakes.length).toBe(1);
    expect(wakes[0].interim).toBe(true);
    const counters = handle.counters.read();
    expect(counters.pendant_interim_wake_hits).toBe(1);
    // The final-segment wake hit was swallowed by the open feedback window.
    expect(counters.feedback_wake_deduped).toBe(1);
    ws.close();
  });

  it("reports task_failed when dispatch cannot reach the gateway", async () => {
    const { handle, board, base } = await boot(
      [{ afterFrames: 3, message: dgResults(COMMAND) }],
      { gatewayUrl: null }
    );
    const { ws, feedback } = await streamPendant(base, "01PENDANTFAIL0001", 6);
    await waitFor(() => feedback.some((e) => e.name === "task_failed"));
    expect(board.cards.length).toBe(0);
    const names = feedback.map((e) => e.name);
    expect(names).toEqual(["wake_detected", "window_closed", "task_failed"]);
    expect(feedback.find((e) => e.name === "task_failed")!.reason).toBe("no gateway");
    expect(handle.counters.read().feedback_task_failed).toBe(1);
    ws.close();
  });

  it("ambient persists the pendant session transcript and record; mic sessions ignore the policy either way", async () => {
    const speech = "Preciso de comprar bilhetes de comboio para Lisboa na sexta de manhã.";
    const { handle, home, base } = await boot(
      [{ afterFrames: 3, message: dgResults(speech) }],
      { capturePolicy: "ambient", minTranscriptWords: 3 }
    );
    const sessionId = "01PENDANTAMBIENT1";
    const { ws, next } = await streamPendant(base, sessionId, 6);
    ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await next((m) => m.type === "session_ended");

    const record = JSON.parse(readFileSync(path.join(home, "capture", "sessions", `${sessionId}.json`), "utf8"));
    expect(record).toMatchObject({ source: "pendant", mode: "pendant", codec: "opus_fs320", status: "ended" });
    expect(record.transcript_ref).toBe(`transcripts/${sessionId}.json`);
    expect(existsSync(path.join(home, "capture", "media", sessionId, "audio.log"))).toBe(true);

    await waitFor(() => handle.counters.read().events_emitted === 1);
    const eventsDir = path.join(home, "capture", "events");
    const events = readdirSync(eventsDir).map((f) => JSON.parse(readFileSync(path.join(eventsDir, f), "utf8")));
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      source: "pendant",
      kind: "session",
      status: "pending",
      normalized: { title: "Pendant audio session" }
    });
    expect(events[0].provenance.pendant_session_id).toBe(sessionId);
    ws.close();
  });

  it("wake_only mic sessions still persist (the policy is pendant-scoped)", async () => {
    const { home, base } = await boot([{ afterFrames: 2, message: dgResults("Uma nota rápida sobre o projeto.") }], {
      capturePolicy: "wake_only"
    });
    const sessionId = "01MICPOLICY000001";
    const { ws, next } = await streamPendant(base, sessionId, 4, { mode: "audio" });
    ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await next((m) => m.type === "session_ended");
    expect(existsSync(path.join(home, "capture", "sessions", `${sessionId}.json`))).toBe(true);
    expect(existsSync(path.join(home, "capture", "transcripts", `${sessionId}.json`))).toBe(true);
    ws.close();
  });
});

describe("feedback bus unit behaviour", () => {
  it("dedupes wake_detected inside a window, tracks acks, and expires the pseudo-window", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "feedback-"));
    try {
      let nowMs = 1000;
      const counters = new Counters(home, "t");
      const bus = new FeedbackBus({ counters, now: () => nowMs, wakeWindowTtlMs: 500 });
      const first = bus.emit("wake_detected", { sessionId: "S1", at: nowMs });
      expect(first).not.toBeNull();
      // Second hit inside the window (the final after an interim): swallowed.
      nowMs += 100;
      expect(bus.emit("wake_detected", { sessionId: "S1", at: nowMs })).toBeNull();
      expect(counters.read().feedback_wake_deduped).toBe(1);
      // window_closed reopens the gate.
      bus.emit("window_closed", { sessionId: "S1", reason: "silence", at: nowMs });
      nowMs += 10;
      expect(bus.emit("wake_detected", { sessionId: "S1", at: nowMs })).not.toBeNull();
      // TTL expiry covers an interim hit that never finalized.
      nowMs += 600;
      expect(bus.emit("wake_detected", { sessionId: "S1", at: nowMs })).not.toBeNull();

      // Ack accounting: wake acks land on the headline metric; unknown ids
      // are counted, never thrown.
      const ack = bus.recordDeviceAck(first!.event_id, { atMs: 1400 });
      expect(ack).toEqual({ name: "wake_detected", latencyMs: 400 });
      expect(counters.read().wake_to_device_ack_ms_last).toBe(400);
      expect(bus.recordDeviceAck("nope")).toBeNull();
      expect(counters.read().feedback_acks_unknown).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Regression (2026-08-27): the wearer reported the pendant "missing the wake
// word a lot". It was not missing it - it was refusing to say so. The dedupe
// window that stops one wake producing two buzzes was opened by an unstable
// INTERIM guess and cleared only by an authoritative window_closed, so an
// interim that never became a real wake held the gate shut for
// wakeMaxCaptureMs + wakeSilenceCloseMs - 60s after the 2026-08-22 retune.
// Every "Zeca" spoken in that minute, including the ones the system genuinely
// heard, was swallowed with no pulse at all.
describe("wake pulse suppression is scoped to what actually opened it", () => {
  const boot = (home: string, extra: Record<string, unknown> = {}) => {
    const counters = new Counters(home, "t");
    const bus = new FeedbackBus({ counters, wakeWindowTtlMs: 5000, wakeProvisionalTtlMs: 60, ...extra });
    return { counters, bus };
  };

  it("an interim wake that never confirms stops muting the next real wake", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "feedback-orphan-"));
    try {
      const { counters, bus } = boot(home);
      expect(bus.emit("wake_detected", { sessionId: "S1", interim: true })).not.toBeNull();
      // The final drops the name: no capture window, so no window_closed ever
      // arrives to clear the gate. Only the provisional TTL can.
      await new Promise((r) => setTimeout(r, 140));
      // ...and the wearer's next attempt is felt, rather than swallowed for a
      // full capture window.
      expect(bus.emit("wake_detected", { sessionId: "S1", interim: true })).not.toBeNull();
      expect(counters.read().feedback_wake_unconfirmed).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("tells the wearer the wake lapsed, so a pulse cannot promise a capture that never opened", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "feedback-lapse-"));
    try {
      const { bus } = boot(home);
      const seen: string[] = [];
      bus.subscribeAll((e) => seen.push(String(e.name)));
      bus.emit("wake_detected", { sessionId: "S2", interim: true });
      await new Promise((r) => setTimeout(r, 140));
      expect(seen).toEqual(["wake_detected", "wake_lapsed"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a confirmed wake keeps the FULL window and never lapses", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "feedback-confirm-"));
    try {
      const { counters, bus } = boot(home);
      const seen: string[] = [];
      bus.subscribeAll((e) => seen.push(String(e.name)));
      // interim guess, then the authoritative final agrees.
      bus.emit("wake_detected", { sessionId: "S3", interim: true });
      expect(bus.emit("wake_detected", { sessionId: "S3" })).toBeNull(); // already felt
      expect(counters.read().feedback_wake_confirmed).toBe(1);

      // Past the PROVISIONAL ttl the window must still be held - the capture is
      // genuinely running, and a "Zeca" inside the command is not a new wake.
      await new Promise((r) => setTimeout(r, 140));
      expect(seen).toEqual(["wake_detected"]); // no lapse fired
      expect(bus.emit("wake_detected", { sessionId: "S3", interim: true })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("still buzzes exactly once for one wake - the interim/final double stays deduped", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "feedback-once-"));
    try {
      const { bus } = boot(home);
      const seen: string[] = [];
      bus.subscribeAll((e) => seen.push(String(e.name)));
      // The common shape: ~3 interims per utterance, then the final.
      bus.emit("wake_detected", { sessionId: "S4", interim: true });
      bus.emit("wake_detected", { sessionId: "S4", interim: true });
      bus.emit("wake_detected", { sessionId: "S4", interim: true });
      bus.emit("wake_detected", { sessionId: "S4" });
      bus.emit("window_closed", { sessionId: "S4", reason: "silence" });
      expect(seen).toEqual(["wake_detected", "window_closed"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("pendant triage identity (shared tick)", () => {
  it("triages a pendant ambient session event with pendant identity in one model call", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "pendant-triage-"));
    try {
      const omiStore = new OmiStore(path.join(home, "omi"));
      const captureRoot = path.join(home, "capture");
      new CaptureStore(captureRoot); // creates the layout
      const captureTickStore = new EventsDirStore(captureRoot);
      atomicWriteJSON(path.join(captureRoot, "events", "01PENDANTEVENT01.json"), {
        id: "01PENDANTEVENT01",
        source: "pendant",
        uid: null,
        received_at: new Date().toISOString(),
        occurred_at: new Date().toISOString(),
        kind: "session",
        normalized: {
          title: "Pendant audio session",
          transcript_text: "You: preciso de marcar consulta no dentista esta semana.",
          stats: { words: 9, segments: 1, hold_floor: 3 },
          action_items: [],
          decisions: [],
          questions: [],
          highlights: [],
          insights: []
        },
        provenance: { pendant_session_id: "01PENDANTSESSION1", mode: "pendant", consent: "shown" },
        status: "pending",
        triage_result_ref: null
      });

      const cards: any[] = [];
      const board = {
        reachable: async () => true,
        listProjects: async () => [],
        findByOriginId: async () => [],
        createCard: async (payload: any) => {
          const card = { id: `C${cards.length + 1}`, ...payload };
          cards.push(card);
          return card;
        }
      };
      const prompts: string[] = [];
      const pendantSent: any[] = [];
      const cfg = {
        ...loadOmiConfig({ GARRISON_HOME: home, GARRISON_OMICHANNEL_TRIAGE_ENABLED: "true" }),
        gatewayUrl: "http://gateway.test"
      };
      const summary = await runTriageTick({
        cfg,
        store: omiStore,
        counters: new Counters(home, "t"),
        board,
        memoryWriter: new MemoryWriter({ dir: path.join(home, "vault") }),
        notifier: { cardUrl: async () => null, send: async () => [{ means: "omi-push", ok: true }] },
        extraStores: [captureTickStore],
        memoryWriterFor: () => new MemoryWriter({ dir: path.join(home, "vault") }),
        notifierFor: (event: any) => ({
          cardUrl: async () => null,
          send: async (msg: any) => {
            pendantSent.push({ source: event?.source, msg });
            return [{ means: "companion-push", ok: true }];
          }
        }),
        runFn: async ({ prompt }: { prompt: string }) => {
          prompts.push(prompt);
          return {
            reply: JSON.stringify({
              cards: [
                {
                  event_id: "01PENDANTEVENT01",
                  action_index: 0,
                  title: "Marcar consulta no dentista",
                  description: "Marcar para esta semana.",
                  project: null
                }
              ],
              memories: [],
              tips: []
            })
          };
        }
      });

      expect(summary.modelCalls).toBe(1);
      expect(prompts.length).toBe(1);
      expect(cards.length).toBe(1);
      expect(cards[0].origin).toBe("pendant");
      expect(cards[0].originChannel).toEqual({ channel: "pendant", threadId: "pendant-reports" });
      expect(cards[0].origin_id).toMatch(/^pendant:01PENDANTSESSION1:/);
      expect(cards[0].description).toContain("Provenance: pendant session 01PENDANTSESSION1");
      expect(pendantSent.length).toBeGreaterThan(0);
      expect(pendantSent[0].source).toBe("pendant");
      // The event flipped to triaged in the capture store.
      const stored = JSON.parse(
        readFileSync(path.join(captureRoot, "events", "01PENDANTEVENT01.json"), "utf8")
      );
      expect(stored.status).toBe("triaged");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
