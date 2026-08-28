// Capture service — M1 ingress and wire protocol.
//
// Drives the real websocket ingress with the real `ws` client against a
// sandboxed GARRISON_HOME: token auth on the upgrade, per-stream contiguous
// acks, resume-after-drop from the last acked seq, duplicate and out-of-order
// handling, malformed sessions, device registration, idle timeout, and the
// byte-identical-store guarantee (invariant I7).

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import { encodeMediaFrame } from "../fittings/seed/capture-service/lib/ingress.mjs";
import { scanAudioLog } from "../fittings/seed/capture-service/lib/media-log.mjs";

const TOKEN = "test-capture-token";
const KIND_AUDIO = 0;
const KIND_VIDEO = 1;
// A tiny valid JPEG (SOI + EOI) — content is irrelevant to the ingress.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

type Handle = Awaited<ReturnType<typeof startServer>>;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

async function boot(overrides: Record<string, unknown> = {}): Promise<{ handle: Handle; home: string; base: string }> {
  const home = mkdtempSync(path.join(os.tmpdir(), "capture-ingress-"));
  const cfg = loadConfig({ GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN });
  const handle = await startServer({ ...cfg, port: 0, enabled: true, ...overrides });
  cleanups.push(() => {
    handle.ingress.close();
    handle.server.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { handle, home, base: `http://127.0.0.1:${handle.cfg.port}` };
}

// A ws client wrapper that queues parsed JSON messages and lets a test await
// the next one matching a predicate.
function connect(base: string, token: string | null = TOKEN) {
  const url = base.replace("http://", "ws://") + "/capture/stream";
  const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const queue: any[] = [];
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const next = (pred: (m: any) => boolean, timeoutMs = 5000): Promise<any> => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) {
          waiters.splice(at, 1);
          reject(new Error(`timed out waiting for message (have ${JSON.stringify(queue)})`));
        }
      }, timeoutMs).unref();
    });
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (err) => reject(err));
  });
  const closed = new Promise<{ code: number }>((resolve) => ws.on("close", (code) => resolve({ code })));
  return { ws, next, opened, closed };
}

function startMsg(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "session_start",
    session_id: id,
    mode: "audio",
    device_name: "Test iPhone",
    consent: "shown",
    started_at: "2026-08-13T10:00:00.000Z",
    ...extra
  });
}

function audioFrame(seq: number, payload = `opus-${seq}`) {
  return encodeMediaFrame(KIND_AUDIO, seq, 1000 + seq, Buffer.from(payload));
}

function storeHash(home: string, sessionId: string) {
  const root = path.join(home, "capture");
  const hash = createHash("sha256");
  const audio = path.join(root, "media", sessionId, "audio.log");
  if (existsSync(audio)) hash.update(readFileSync(audio));
  const framesDir = path.join(root, "media", sessionId, "frames");
  if (existsSync(framesDir)) {
    for (const f of readdirSync(framesDir).sort()) hash.update(readFileSync(path.join(framesDir, f)));
  }
  const record = path.join(root, "sessions", `${sessionId}.json`);
  if (existsSync(record)) hash.update(readFileSync(record));
  return hash.digest("hex");
}

describe("capture-service ingress", () => {
  const SID = "01TESTSESSION0001";

  it("runs a session end to end: start, per-stream acks, end, deterministic record", async () => {
    const { handle, home, base } = await boot();
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg(SID, { mode: "screen_audio" }));
    expect((await c.next((m) => m.type === "session_started")).session_id).toBe(SID);

    for (let seq = 1; seq <= 5; seq++) c.ws.send(audioFrame(seq));
    const ack5 = await c.next((m) => m.type === "ack" && m.stream === "audio" && m.seq === 5);
    expect(ack5.seq).toBe(5);

    c.ws.send(encodeMediaFrame(KIND_VIDEO, 1, 2001, JPEG));
    c.ws.send(encodeMediaFrame(KIND_VIDEO, 2, 2002, JPEG));
    await c.next((m) => m.type === "ack" && m.stream === "video" && m.seq === 2);

    c.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await c.next((m) => m.type === "session_ended");
    await c.closed;

    const record = JSON.parse(readFileSync(path.join(home, "capture", "sessions", `${SID}.json`), "utf8"));
    expect(record).toMatchObject({
      id: SID,
      source: "companion-ios",
      mode: "screen_audio",
      consent: "shown",
      status: "ended",
      audio_seq: 5,
      video_seq: 2,
      ended: { reason: "user" }
    });
    // The record carries no server wall-clock: replaying the same fixture
    // yields byte-identical state (I7).
    expect(JSON.stringify(record)).not.toMatch(/receivedAt|updatedAt/);

    const log = scanAudioLog(path.join(home, "capture", "media", SID, "audio.log"));
    expect(log).toEqual({ lastSeq: 5, records: 5 });
    expect(readdirSync(path.join(home, "capture", "media", SID, "frames")).sort()).toEqual(["1.jpg", "2.jpg"]);
    expect(handle.counters.read().sessions_started).toBe(1);
    expect(handle.counters.read().sessions_ended).toBe(1);
  });

  it("drops duplicates while acking the edge, and a replay after end is refused with the store untouched", async () => {
    const { handle, home, base } = await boot();
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg(SID));
    await c.next((m) => m.type === "session_started");
    for (let seq = 1; seq <= 3; seq++) {
      c.ws.send(audioFrame(seq));
      await c.next((m) => m.type === "ack" && m.seq === seq);
    }
    const hashMid = storeHash(home, SID);

    // Duplicate replay inside the live session: dropped, still acked at 3.
    for (let seq = 1; seq <= 3; seq++) c.ws.send(audioFrame(seq));
    const dupAcks = [
      await c.next((m) => m.type === "ack"),
      await c.next((m) => m.type === "ack"),
      await c.next((m) => m.type === "ack")
    ];
    expect(dupAcks.every((a) => a.seq === 3 && a.stream === "audio")).toBe(true);
    expect(storeHash(home, SID)).toBe(hashMid);

    c.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await c.next((m) => m.type === "session_ended");
    await c.closed;
    const hashEnd = storeHash(home, SID);

    // Whole-session replay: dedupe by session id (I7) — refused, unchanged.
    const c2 = connect(base);
    await c2.opened;
    c2.ws.send(startMsg(SID));
    const err = await c2.next((m) => m.type === "error");
    expect(err.error).toContain("already ended");
    await c2.closed;
    expect(storeHash(home, SID)).toBe(hashEnd);
    expect(handle.counters.read().audio_frames_deduped).toBe(3);
    expect(handle.counters.read().sessions_rejected_ended).toBe(1);
  });

  it("resumes from the last acked seq after a hard socket drop", async () => {
    const { home, base } = await boot();
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg(SID));
    await c.next((m) => m.type === "session_started");
    for (let seq = 1; seq <= 3; seq++) c.ws.send(audioFrame(seq));
    await c.next((m) => m.type === "ack" && m.seq === 3);
    c.ws.terminate(); // no close frame — a network drop

    const c2 = connect(base);
    await c2.opened;
    c2.ws.send(startMsg(SID));
    const resumed = await c2.next((m) => m.type === "session_resumed");
    expect(resumed).toMatchObject({ session_id: SID, audio_seq: 3, video_seq: 0 });

    for (let seq = 4; seq <= 6; seq++) c2.ws.send(audioFrame(seq));
    await c2.next((m) => m.type === "ack" && m.seq === 6);
    c2.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await c2.next((m) => m.type === "session_ended");

    const log = scanAudioLog(path.join(home, "capture", "media", SID, "audio.log"));
    expect(log).toEqual({ lastSeq: 6, records: 6 });
  });

  it("reassembles out-of-order frames within the reorder window", async () => {
    const { home, base } = await boot();
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg(SID));
    await c.next((m) => m.type === "session_started");

    c.ws.send(audioFrame(2));
    const held = await c.next((m) => m.type === "ack");
    expect(held.seq).toBe(0); // buffered, nothing contiguous yet
    c.ws.send(audioFrame(1));
    const drained = await c.next((m) => m.type === "ack" && m.seq === 2);
    expect(drained.seq).toBe(2);

    c.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await c.next((m) => m.type === "session_ended");
    const log = scanAudioLog(path.join(home, "capture", "media", SID, "audio.log"));
    expect(log).toEqual({ lastSeq: 2, records: 2 });
  });

  it("rejects a bad token on the upgrade and counts it", async () => {
    const { handle, base } = await boot();
    const c = connect(base, "wrong-token");
    await expect(c.opened).rejects.toThrow(/401/);
    expect(handle.counters.read().rejected_auth).toBe(1);

    const c2 = connect(base, null);
    await expect(c2.opened).rejects.toThrow(/401/);
    expect(handle.counters.read().rejected_auth).toBe(2);
  });

  it("answers 403 on the upgrade when the master flag is off", async () => {
    const { handle, base } = await boot({ enabled: false });
    const c = connect(base);
    await expect(c.opened).rejects.toThrow(/403/);
    expect(handle.counters.read().rejected_disabled).toBe(1);
  });

  it("closes a malformed session_start without creating state", async () => {
    const { handle, home, base } = await boot();
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg(SID, { mode: "always_on" }));
    const err = await c.next((m) => m.type === "error");
    expect(err.error).toContain("mode");
    const { code } = await c.closed;
    expect(code).toBe(1008);
    expect(existsSync(path.join(home, "capture", "sessions", `${SID}.json`))).toBe(false);
    expect(handle.counters.read().sessions_malformed).toBe(1);

    // Media before session_start is a protocol error, not a crash.
    const c2 = connect(base);
    await c2.opened;
    c2.ws.send(audioFrame(1));
    await c2.next((m) => m.type === "error" && m.error.includes("session_start"));
    const closed2 = await c2.closed;
    expect(closed2.code).toBe(1008);
  });

  it("registers devices idempotently over authed HTTP", async () => {
    const { handle, base } = await boot();
    const post = (body: unknown, token = TOKEN) =>
      fetch(`${base}/capture/devices`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    const token64 = "ab".repeat(32);
    expect((await post({ apns_token: token64, device_name: "iPhone 17" })).status).toBe(200);
    const dup = await (await post({ apns_token: token64, device_name: "iPhone 17 renamed" })).json();
    expect(dup.count).toBe(1);
    expect((await post({ apns_token: "not-hex!" })).status).toBe(400);
    expect((await post({ apns_token: token64 }, "bad")).status).toBe(401);
    expect(handle.counters.read().devices_registered).toBe(1);
    expect(handle.counters.read().devices_deduped).toBe(1);

    const sessions = await fetch(`${base}/capture/sessions`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    }).then((r) => r.json());
    expect(sessions.sessions).toEqual([]);
  });

  it("times out an idle session with reason timeout", async () => {
    const { home, base } = await boot({ sessionIdleTimeoutMs: 120 });
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg(SID));
    await c.next((m) => m.type === "session_started");
    await c.closed; // server closes the socket when the session times out

    const record = JSON.parse(readFileSync(path.join(home, "capture", "sessions", `${SID}.json`), "utf8"));
    expect(record.status).toBe("ended");
    expect(record.ended).toEqual({ reason: "timeout" });
  });
});

// Pendant + broadcast is the configuration the user actually wears: the pendant
// carries mic, wake word, haptics and voice, and the broadcast supplies pixels.
// Both streams used to transcribe, so ONE spoken sentence reached two
// microphones in the same room, hit two separate WakeBus instances (which no
// instance-local dedupe can bridge), and dispatched twice - two cards, or two
// WhatsApp messages.
describe("screen_audio transcription gate", () => {
  // The gate itself is what is pinned here, through its counter, so the
  // assertion holds whether or not a Deepgram lane is actually reachable in
  // this environment.
  it("skips transcription for a broadcast when the flag is off", async () => {
    const { handle, base } = await boot({ screenAudioTranscribe: false });
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg("01SCREENONLY00001", { mode: "screen_audio" }));
    await c.next((m) => m.type === "session_started");
    expect(handle.counters.read().screen_audio_transcription_skipped).toBe(1);
    c.ws.close();
  });

  it("does not skip an audio session, whatever the flag says", async () => {
    const { handle, base } = await boot({ screenAudioTranscribe: false });
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg("01AUDIOSESSION001", { mode: "audio" }));
    await c.next((m) => m.type === "session_started");
    expect(handle.counters.read().screen_audio_transcription_skipped ?? 0).toBe(0);
    c.ws.close();
  });

  it("does not skip a broadcast when the flag is on (the documented default)", async () => {
    const { handle, base } = await boot({ screenAudioTranscribe: true });
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg("01SCREENBOTH00001", { mode: "screen_audio" }));
    await c.next((m) => m.type === "session_started");
    expect(handle.counters.read().screen_audio_transcription_skipped ?? 0).toBe(0);
    c.ws.close();
  });
});
