// Capture service — M5b, the spoken-acknowledgement sink.
//
// POST /ack registers the echo fingerprint FIRST, then forwards
// {type:"speak"} to a live AUDIO-mode session socket (screen_audio never
// speaks in-session) or falls through to APNs. The app's {spoken} receipt is
// ledgered. The acceptance that matters most: speaking during a live session
// does not create a card — proven ON THE STORED TRANSCRIPT, not just on
// counters.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import { encodeMediaFrame } from "../fittings/seed/capture-service/lib/ingress.mjs";
import { ApnsSender } from "../fittings/seed/capture-service/lib/apns.mjs";
import { atomicWriteJSON } from "../fittings/seed/capture-service/lib/store.mjs";

const TOKEN = "ack-sink-token";
const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const P8_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function dgResults(text: string, start = 0) {
  return JSON.stringify({
    type: "Results",
    start,
    duration: 2,
    is_final: true,
    channel: { alternatives: [{ transcript: text, confidence: 0.9, words: [{ word: text.split(" ")[0], start, end: start + 0.2, speaker: 0 }] }] }
  });
}

// Scriptable mock Deepgram (frames threshold -> message), as in the M3 suite.
function startMockDeepgram(script: Array<{ afterFrames: number; message: string }>) {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    let frames = 0;
    const fired = new Set<number>();
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        frames += 1;
        script.forEach((step, i) => {
          if (!fired.has(i) && frames >= step.afterFrames) {
            fired.add(i);
            ws.send(step.message);
          }
        });
        return;
      }
      if (JSON.parse(data.toString()).type === "CloseStream") ws.close(1000);
    });
  });
  return { wss, url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}` };
}

function fakeHttp2(sent: any[] = []) {
  return () => {
    const session = new EventEmitter() as any;
    session.request = (headers: Record<string, string>) => {
      const req = new EventEmitter() as any;
      let body = "";
      req.setEncoding = () => {};
      req.write = (c: string) => (body += c);
      req.end = () => {
        sent.push({ headers, payload: JSON.parse(body) });
        setImmediate(() => {
          req.emit("response", { ":status": 200 });
          req.emit("end");
        });
      };
      return req;
    };
    session.destroy = () => {};
    return session;
  };
}

describe("capture-service ack sink", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function boot(dgScript: Array<{ afterFrames: number; message: string }> = [], overrides: Record<string, unknown> = {}) {
    const home = mkdtempSync(path.join(os.tmpdir(), "ack-sink-"));
    const mock = startMockDeepgram(dgScript);
    const pushes: any[] = [];
    const cfg = loadConfig({
      GARRISON_HOME: home,
      CAPTURE_TOKEN: TOKEN,
      DEEPGRAM_API_KEY: "dg-test",
      APNS_TEAM_ID: "TEAMID1234",
      APNS_KEY_ID: "KEYID12345",
      APNS_P8: P8_PEM
    });
    const handle = await startServer({
      ...cfg,
      port: 0,
      enabled: true,
      transcribeEnabled: true,
      speakEnabled: true,
      notifyEnabled: true,
      wsFactory: () => new WebSocket(mock.url),
      ...overrides
    });
    (handle as any).notifier.apns = new ApnsSender({ cfg: handle.cfg, connectFn: fakeHttp2(pushes) });
    atomicWriteJSON((handle.store as any).devicesFile, {
      tokens: [{ token: "ab".repeat(16), device_name: "t", registered_at: "2026-08-13T00:00:00Z" }]
    });
    cleanups.push(() => {
      handle.ingress.close();
      handle.server.close();
      mock.wss.close();
      rmSync(home, { recursive: true, force: true });
    });
    return { handle, home, pushes, base: `http://127.0.0.1:${handle.cfg.port}` };
  }

  // A companion app stand-in: opens a session, records speaks, replies receipts.
  async function appSession(base: string, sessionId: string, mode = "audio", { confirmSpeaks = true } = {}) {
    const ws = new WebSocket(base.replace("http", "ws") + "/capture/stream", {
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const speaks: any[] = [];
    const queue: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.type === "speak") {
        speaks.push(msg);
        if (confirmSpeaks) ws.send(JSON.stringify({ type: "spoken", spoken: msg.ack.id, ok: true }));
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
    ws.send(JSON.stringify({ type: "session_start", session_id: sessionId, mode, device_name: "t", consent: "shown" }));
    await next((m) => m.type === "session_started");
    return { ws, next, speaks };
  }

  function postAck(base: string, ack: Record<string, unknown>) {
    return fetch(`${base}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ack)
    });
  }

  async function waitFor(pred: () => boolean, ms = 5000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 30));
    }
    return pred();
  }

  it("speaks into a live audio session and ledgers the receipt; screen_audio and sink-off fall to push", async () => {
    const { handle, pushes, base } = await boot();
    const app = await appSession(base, "01ACKSESSION0001");

    const res = await (await postAck(base, {
      id: "ack-c1-created",
      kind: "created",
      severity: "info",
      templateId: "card.created",
      text: "Created a task, hello companion.",
      echo: "abcd1234abcd1234"
    })).json();
    expect(res).toMatchObject({ ok: true, registered: true, delivered: "socket" });
    await waitFor(() => app.speaks.length === 1);
    expect(app.speaks[0].ack.text).toBe("Created a task, hello companion.");
    await waitFor(() => handle.counters.read().speaks_confirmed === 1);
    expect(handle.counters.read().speak_confirm_ms_count).toBe(1);
    expect(pushes.length).toBe(0); // spoken, not buzzed

    // Sink toggled off: a ROUTINE ack no longer buzzes the phone — it takes
    // the web-channel thread, because the operative's created/completed
    // fan-out once burned the whole daily push budget and starved the
    // pushes that answer the user's own spoken commands (2026-08-15).
    (handle.cfg as any).speakEnabled = false;
    const off = await (await postAck(base, { id: "ack-c2", kind: "completed", severity: "info", text: "Finished the report." })).json();
    expect(off.delivered).toBe("web-channel");
    expect(off.receipts[0]).toMatchObject({ means: "companion-push", ok: false, skipped: "routine ack (web-channel only)" });
    expect(app.speaks.length).toBe(1);
    expect(pushes.length).toBe(0);
    (handle.cfg as any).speakEnabled = true;

    // screen_audio sessions never speak in-session (no AEC coupling, ADR §6);
    // an ERROR there still buzzes.
    app.ws.close();
    await waitFor(() => handle.ingress.sessions.get("01ACKSESSION0001") ? (handle.ingress.sessions.get("01ACKSESSION0001") as any).socket === null : true);
    const screen = await appSession(base, "01ACKSESSION0002", "screen_audio");
    const screenAck = await (await postAck(base, { id: "ack-c3", kind: "failed", severity: "error", text: "Could not create the second task." })).json();
    expect(screenAck.delivered).toBe("push");
    expect(screenAck.receipts[0]).toMatchObject({ means: "companion-push", ok: true });
    expect(screen.speaks.length).toBe(0);
    expect(pushes.length).toBe(1);

    // The app-side failure receipt is ledgered too.
    screen.ws.close();
    const app2 = await appSession(base, "01ACKSESSION0003", "audio", { confirmSpeaks: false });
    const r3 = await (await postAck(base, { id: "ack-c4", kind: "failed", severity: "error", text: "Could not finish the report." })).json();
    expect(r3.delivered).toBe("socket");
    await waitFor(() => app2.speaks.length === 1);
    app2.ws.send(JSON.stringify({ type: "spoken", spoken: "ack-c4", ok: false, reason: "muted" }));
    await waitFor(() => handle.counters.read().speaks_failed === 1);

    // Skipped acks are ignored; a textless ack is a 400.
    expect((await postAck(base, { skipped: "wake-collision" })).status).toBe(200);
    expect((await postAck(base, { id: "x" })).status).toBe(400);
  });

  it("shares the idempotency ledger with /notify so one event buzzes once", async () => {
    const { base } = await boot();
    const first = await (await fetch(`${base}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Card done", text: "Finished X.", idempotencyKey: "evt-1" })
    })).json();
    expect(first[0].ok).toBe(true);
    const ack = await (await postAck(base, { id: "ack-evt1", kind: "completed", severity: "info", text: "Finished X.", idempotencyKey: "evt-1" })).json();
    expect(ack.delivered).toBe("push");
    expect(ack.receipts[0]).toMatchObject({ deduplicated: true });
  });

  it("suppresses the app's own spoken ack from the STORED transcript while keeping real speech", async () => {
    const ACK_TEXT = "Created a task, hello companion.";
    const REAL_TEXT = "Preciso de rever o contrato com a Ana amanhã.";
    // The mock returns the ack coming back through the mic (fragmented, as
    // transcribers do) followed by genuine operator speech.
    const { handle, home, base } = await boot([
      { afterFrames: 3, message: dgResults("created a task hello companion", 0) },
      { afterFrames: 6, message: dgResults(REAL_TEXT, 2) }
    ]);
    const app = await appSession(base, "01ACKSESSION0004");

    // The ack is spoken (registered BEFORE the mic hears it).
    await postAck(base, { id: "ack-echo", kind: "created", severity: "info", text: ACK_TEXT });
    await waitFor(() => app.speaks.length === 1);

    for (let seq = 1; seq <= 8; seq++) {
      app.ws.send(encodeMediaFrame(0, seq, seq * 20, Buffer.from(`opus-${seq}`)));
      await app.next((m) => m.type === "ack" && m.seq === seq);
    }
    app.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await app.next((m) => m.type === "session_ended");

    // THE stored transcript: the echo is absent, the real sentence is there.
    const transcriptFile = path.join(home, "capture", "transcripts", "01ACKSESSION0004.json");
    expect(existsSync(transcriptFile)).toBe(true);
    const transcript = JSON.parse(readFileSync(transcriptFile, "utf8"));
    const texts = transcript.segments.map((s: any) => s.text);
    expect(texts).toEqual([REAL_TEXT]);
    expect(handle.counters.read().realtime_echo_suppressed).toBe(1);
    // And no card path was ever armed: the wake gate never saw the echo.
    expect(handle.counters.read().wake_hits ?? 0).toBe(0);
  });
});
