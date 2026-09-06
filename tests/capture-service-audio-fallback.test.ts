// Exercise source arbitration through the actual ingress wire callbacks and
// SessionMedia ordering/persistence. Only transport sockets and ASR are stubs;
// no microphone, provider request, real capture directory or real clock is used.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { CaptureIngress, encodeMediaFrame } from "../fittings/seed/capture-service/lib/ingress.mjs";
import { readAudioLog, scanAudioLog } from "../fittings/seed/capture-service/lib/media-log.mjs";
import { CaptureStore, Counters } from "../fittings/seed/capture-service/lib/store.mjs";

type Mode = "pendant" | "audio" | "screen_audio";
class Socket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  messages: any[] = [];
  send(message: string) { this.messages.push(JSON.parse(message)); }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code);
  }
}

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture(screenAudioTranscribe = true) {
  const home = mkdtempSync(path.join(os.tmpdir(), "capture-source-fallback-"));
  const store = new CaptureStore(path.join(home, "capture"));
  const counters = new Counters(store.root, "fallback-test");
  let clock = 0;
  const lanes = new Map<string, EventEmitter>();
  const fed: Array<{ id: string; bytes: Buffer }> = [];
  const transcriber = {
    openSession: vi.fn((id: string) => { lanes.set(id, new EventEmitter()); return true; }),
    feed: vi.fn((id: string, bytes: Buffer) => { fed.push({ id, bytes: Buffer.from(bytes) }); }),
    end: vi.fn(async (_id: string): Promise<any[]> => []),
  };
  const ingress = new CaptureIngress({
    cfg: { ...loadConfig({ GARRISON_HOME: home }), enabled: true, pendantEnabled: true,
      capturePolicy: "wake_only", screenAudioTranscribe, sessionIdleTimeoutMs: 60_000 },
    store, counters, transcriber, now: () => clock, log: { log() {}, error() {} },
  }) as CaptureIngress & { handleConnection(socket: Socket): void };
  cleanup.push(() => { ingress.close(); rmSync(home, { recursive: true, force: true }); });
  let number = 0;
  function connect(mode: Mode, id = `source-${mode}-${++number}`) {
    const socket = new Socket();
    ingress.handleConnection(socket);
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "session_start", session_id: id, mode, device_name: "Fixture phone",
      consent: "shown", started_at: "2026-09-06T00:00:00Z",
    })), false);
    expect(socket.messages.at(-1)?.type).toMatch(/^session_(started|resumed)$/);
    return {
      id, mode, socket,
      audio(seq: number, payload = `${mode}:${seq}`, clientTimestamp = seq * 20) {
        socket.emit("message", encodeMediaFrame(0, seq, clientTimestamp, Buffer.from(payload)), true);
      },
      video(seq: number) {
        socket.emit("message", encodeMediaFrame(1, seq, seq * 1000, Buffer.from([0xff, 0xd8, 0xff, 0xd9])), true);
      },
    };
  }
  return { home, store, counters, ingress, transcriber, lanes, fed, connect,
    at: (milliseconds: number) => { clock = milliseconds; },
    ids: () => fed.map((call) => call.id),
  };
}

const ORDERS: Mode[][] = [
  ["pendant", "audio", "screen_audio"], ["pendant", "screen_audio", "audio"],
  ["audio", "pendant", "screen_audio"], ["audio", "screen_audio", "pendant"],
  ["screen_audio", "pendant", "audio"], ["screen_audio", "audio", "pendant"],
];

describe("capture microphone source fallback", () => {
  it.each(ORDERS.map((order) => [order.join(" -> "), order] as const))(
    "prefers pendant, then Listen, then Record regardless of connection order: %s",
    async (_label, order) => {
      const f = fixture();
      const sources = Object.fromEntries(order.map((mode) => [mode, f.connect(mode)])) as Record<Mode, ReturnType<typeof f.connect>>;
      expect(f.transcriber.openSession).toHaveBeenCalledTimes(3);
      sources.pendant.audio(1);
      sources.audio.audio(1);
      sources.screen_audio.audio(1);
      expect(f.ids()).toEqual([sources.pendant.id]);
      await f.ingress.finalizeSession(sources.pendant.id, "user");
      sources.audio.audio(2);
      sources.screen_audio.audio(2);
      expect(f.ids()).toEqual([sources.pendant.id, sources.audio.id]);
      await f.ingress.finalizeSession(sources.audio.id, "user");
      sources.screen_audio.audio(3);
      expect(f.ids()).toEqual([sources.pendant.id, sources.audio.id, sources.screen_audio.id]);
    },
  );

  it("opens the Record transcription lane for an immediate subscriber even while a pendant owns audio", () => {
    const f = fixture();
    const pendant = f.connect("pendant");
    pendant.audio(1);
    const record = f.connect("screen_audio");
    // The HTTP SSE endpoint must be able to find this lane before any packet,
    // including when it is currently suppressed by a higher-priority source.
    expect(f.transcriber.openSession).toHaveBeenCalledWith(record.id, expect.any(Object));
    expect(f.lanes.has(record.id)).toBe(true);
    expect(f.fed.some((call) => call.id === record.id)).toBe(false);
    record.audio(1);
    expect(f.ids()).toEqual([pendant.id]);
    pendant.socket.close(1006);
    record.audio(2);
    expect(f.ids()).toEqual([pendant.id, record.id]);
    expect(f.transcriber.openSession.mock.calls.filter(([id]) => id === record.id)).toHaveLength(1);
  });

  it("does not let a connected pendant or Listen session with no accepted audio mute Record", () => {
    const f = fixture();
    const pendant = f.connect("pendant");
    const listen = f.connect("audio");
    const record = f.connect("screen_audio");
    pendant.video(1);
    listen.video(1);
    record.audio(1);
    expect(f.ids()).toEqual([record.id]);
    pendant.audio(1, ""); // A unique but empty payload is not a microphone.
    record.audio(2);
    expect(f.ids()).toEqual([record.id, record.id]);
  });

  it("switches an already recording phone to newly active Listen and pendant inputs without feeding both", () => {
    const f = fixture();
    const record = f.connect("screen_audio");
    record.audio(1);
    const listen = f.connect("audio");
    record.audio(2); // Connecting alone does not seize the microphone.
    listen.audio(1);
    record.audio(3);
    const pendant = f.connect("pendant");
    listen.audio(2);
    record.audio(4);
    pendant.audio(1);
    listen.audio(3);
    record.audio(5);
    expect(f.ids()).toEqual([record.id, record.id, listen.id, listen.id, pendant.id]);
    pendant.socket.close(1006);
    listen.audio(4);
    record.audio(6);
    expect(f.ids().slice(-2)).toEqual([pendant.id, listen.id]);
  });

  it("falls back after two seconds of no new audio using server arrival time, not client timestamps", () => {
    const f = fixture();
    const pendant = f.connect("pendant");
    const record = f.connect("screen_audio");
    pendant.audio(1, "pendant-active", 9e12);
    f.at(2000);
    record.audio(1, "still-suppressed", -9e12);
    expect(f.ids()).toEqual([pendant.id]);
    f.at(2001);
    record.audio(2, "phone-fallback", -9e12);
    expect(f.ids()).toEqual([pendant.id, record.id]);
    pendant.audio(2);
    record.audio(3);
    expect(f.ids()).toEqual([pendant.id, record.id, pendant.id]);
  });

  it.each(["close", "closing-state"])("yields immediately when the selected socket is unavailable (%s)", (mode) => {
    const f = fixture();
    const pendant = f.connect("pendant");
    const record = f.connect("screen_audio");
    pendant.audio(1);
    f.at(1);
    if (mode === "close") pendant.socket.close(1006);
    else pendant.socket.readyState = 2;
    record.audio(1);
    expect(f.ids()).toEqual([pendant.id, record.id]);
  });

  it("yields immediately on session end while its transcript finalization is still pending", async () => {
    const f = fixture();
    const pendant = f.connect("pendant");
    const record = f.connect("screen_audio");
    pendant.audio(1);
    let flushed: (segments: any[]) => void = () => {};
    f.transcriber.end.mockImplementationOnce(() => new Promise((resolve) => { flushed = resolve; }));
    const ending = f.ingress.finalizeSession(pendant.id, "user");
    record.audio(1);
    expect(f.ids()).toEqual([pendant.id, record.id]);
    flushed([]);
    await ending;
  });

  it("does not refresh stale priority from duplicate replay, including after reconnect", () => {
    const f = fixture();
    const pendant = f.connect("pendant");
    const record = f.connect("screen_audio");
    pendant.audio(1);
    pendant.socket.close(1006);
    record.audio(1);
    f.at(2001);
    const resumed = f.connect("pendant", pendant.id);
    expect(resumed.socket.messages.at(-1)).toMatchObject({ type: "session_resumed", audio_seq: 1 });
    resumed.audio(1, "duplicate-must-not-feed");
    expect(resumed.socket.messages.at(-1)).toMatchObject({ type: "ack", stream: "audio", seq: 1 });
    record.audio(2);
    expect(f.ids()).toEqual([pendant.id, record.id, record.id]);
    resumed.audio(2, "new-unique-audio");
    record.audio(3);
    expect(f.ids()).toEqual([pendant.id, record.id, record.id, pendant.id]);
    expect(f.counters.read().audio_frames_deduped).toBe(1);
    expect(f.fed.some((call) => call.bytes.toString() === "duplicate-must-not-feed")).toBe(false);
  });

  it("does not let an old socket close clear its replacement during reconnect", () => {
    const f = fixture();
    const original = f.connect("pendant");
    const record = f.connect("screen_audio");
    original.audio(1);
    const replacement = f.connect("pendant", original.id);
    replacement.audio(2);
    original.socket.emit("close", 1006);
    record.audio(1);
    expect(f.ids()).toEqual([original.id, original.id]);
    replacement.socket.close(1006);
    record.audio(2);
    expect(f.ids()).toEqual([original.id, original.id, record.id]);
  });

  it("does not grant priority to buffered, malformed or far-ahead audio until an ordered frame is accepted", () => {
    const f = fixture();
    const pendant = f.connect("pendant");
    const record = f.connect("screen_audio");
    pendant.audio(2); // Unique but still waiting for sequence 1.
    pendant.audio(5000);
    pendant.socket.emit("message", Buffer.from("malformed"), true);
    record.audio(1);
    expect(f.ids()).toEqual([record.id]);
    pendant.audio(1);
    record.audio(2);
    expect(f.ids()).toEqual([record.id, pendant.id, pendant.id]);
    expect(pendant.socket.messages.filter((m) => m.type === "ack").at(-1)).toMatchObject({ seq: 2 });
  });

  it.each(["pendant", "audio", "screen_audio"] as Mode[])("keeps map-order priority stable between two fresh %s sessions", (mode) => {
    const f = fixture();
    const first = f.connect(mode);
    const second = f.connect(mode);
    first.audio(1);
    second.audio(1);
    second.audio(2);
    first.audio(2);
    expect(f.ids()).toEqual([first.id, first.id]);
    f.at(2001);
    second.audio(3);
    expect(f.ids()).toEqual([first.id, first.id, second.id]);
  });

  it.each([true, false])("preserves suppressed Record media and acknowledgements (transcription enabled=%s)", async (enabled) => {
    const f = fixture(enabled);
    const pendant = f.connect("pendant");
    const record = f.connect("screen_audio");
    pendant.audio(1);
    record.audio(1, "first-stored-frame");
    record.audio(2, "second-stored-frame");
    record.audio(1, "duplicate-not-stored");
    record.video(1);
    expect(f.ids()).toEqual([pendant.id]);
    expect(record.socket.messages.filter((m) => m.type === "ack")).toEqual([
      { type: "ack", stream: "audio", seq: 1 }, { type: "ack", stream: "audio", seq: 2 },
      { type: "ack", stream: "audio", seq: 2 }, { type: "ack", stream: "video", seq: 1 },
    ]);
    const audioFile = path.join(f.store.dirs.media, record.id, "audio.log");
    expect(scanAudioLog(audioFile)).toEqual({ lastSeq: 2, records: 2 });
    expect([...readAudioLog(audioFile)].map((entry) => entry.bytes.toString())).toEqual(["first-stored-frame", "second-stored-frame"]);
    // audio_bytes reports persisted storage: two 16-byte record headers plus
    // the 37 payload bytes, rather than the compressed payloads alone.
    const storedAudioBytes = readFileSync(audioFile).byteLength;
    expect(storedAudioBytes).toBe(69);
    await f.ingress.finalizeSession(record.id, "user");
    const stored = JSON.parse(readFileSync(path.join(f.store.dirs.sessions, `${record.id}.json`), "utf8"));
    expect(stored).toMatchObject({ status: "ended", audio_seq: 2, video_seq: 1, audio_bytes: storedAudioBytes, ended: { reason: "user" } });
    expect(f.lanes.has(record.id)).toBe(enabled);
  });

  it("honors explicit broadcast transcription false after every higher-priority source has gone", async () => {
    const f = fixture(false);
    const listen = f.connect("audio");
    const record = f.connect("screen_audio");
    listen.audio(1);
    await f.ingress.finalizeSession(listen.id, "user");
    f.at(10_000);
    record.audio(1);
    expect(f.ids()).toEqual([listen.id]);
    expect(f.lanes.has(record.id)).toBe(false);
    expect(f.counters.read().screen_audio_transcription_skipped).toBe(1);
    expect(record.socket.messages.at(-1)).toMatchObject({ type: "ack", stream: "audio", seq: 1 });
  });
});
