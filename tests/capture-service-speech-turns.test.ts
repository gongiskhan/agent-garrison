import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-ignore pure server module
import { AckSink } from "../fittings/seed/capture-service/lib/ack-sink.mjs";
import { EchoGuard } from "../fittings/seed/capture-service/lib/echo-guard.mjs";
import { WakeBus } from "../fittings/seed/capture-service/lib/wake.mjs";
import { CaptureStore, Counters } from "../fittings/seed/capture-service/lib/store.mjs";
import { confidentSpeech, REPLY_FEEDBACK_WINDOW_MS } from "../fittings/seed/capture-service/lib/speech-input.mjs";
import { speechChunks } from "../fittings/seed/capture-service/lib/tts.mjs";

const homes: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const speech = (text = "Wait, use tomorrow instead.", extra = {}) => ({ text, final: true, confidence: 0.97, start: 0, end: 1, is_user: true, ...extra });

function fixture(mode = "audio") {
  vi.useFakeTimers();
  const home = mkdtempSync(path.join(os.tmpdir(), "speech-turns-")); homes.push(home);
  const store = new CaptureStore(home);
  const counters = new Counters(home, "test");
  const guard = new EchoGuard({ now: Date.now });
  const sent: any[] = [], turns: any[] = [], notices: any[] = [];
  const session = { speechProtocol: 1, record: { id: "phone", mode }, socket: { OPEN: 1, readyState: 1, send: (msg: string) => sent.push(JSON.parse(msg)) } };
  const sink = new AckSink({ cfg: { speakEnabled: true }, store, counters, echoGuard: guard, ingress: { sessions: new Map([["phone", session]]) }, notifier: {}, now: Date.now });
  const bus = new WakeBus({ cfg: { wakeVariants: ["zeca"], wakeEnabled: true }, store, counters, now: Date.now,
    notifier: { send: async (payload: any) => { notices.push(payload); return []; } },
    board: { listProjects: async () => [] }, runFn: async () => { throw Error("must use conversation"); },
    conversationTurnFn: async (args: any) => { turns.push(args); return { ok: true }; },
    log: { log() {}, error() {} } });
  bus.session("phone");
  return { store, counters, guard, sent, turns, notices, session, sink, bus };
}

describe("speech input evidence", () => {
  it.each([
    speech("[noise]"), speech("hmm"), speech("", {}), speech("yes", { confidence: 0.6 }),
    speech("Wait please", { confidence: null }), speech("Wait please", { is_user: false }),
    speech("Wait please", { speech_duration: 0.05 }), speech("Wait please", { final: false })
  ])("rejects noise, uncertain recognition and other-speaker labels: %j", segment => expect(confidentSpeech(segment)).toBe(false));
  it("accepts clear short speech without requiring a wake word", () => {
    expect(confidentSpeech(speech("No", { end: 0.25 }))).toBe(true);
    expect(confidentSpeech(speech())).toBe(true);
  });
});

describe("interruptible playback", () => {
  it.each(["audio", "pendant"])("stops only the owning %s stream after stable, non-echo speech", async mode => {
    const h = fixture(mode);
    await h.sink.handleAck({ id: "reply", text: "The report is ready for your review." });
    const receive = (id: string, segment: any) => !h.guard.shouldSuppress(segment.text) && h.sink.considerInterruption(id, segment);
    expect(receive("phone", speech("The report is ready"))).toBe(false);
    expect(receive("phone", speech("[noise]"))).toBe(false);
    expect(receive("other", speech())).toBe(false);
    expect(receive("phone", speech("Wait, change", { final: false }))).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(receive("phone", speech("Wait, change the date", { final: false }))).toBe(true);
    expect(h.sent.at(-1)).toEqual({ type: "speech.interrupt", ack_ids: ["reply"] });
    expect(receive("phone", speech())).toBe(false);
    await vi.advanceTimersByTimeAsync(200_001);
    expect(h.counters.read().speak_receipt_timeouts ?? 0).toBe(0);
  });
  it("does not enable interruption for an older app or accept a different stream's completion", async () => {
    const h = fixture(); h.session.speechProtocol = 0;
    await h.sink.handleAck({ id: "reply", text: "The answer is ready." });
    expect(h.sink.considerInterruption("phone", speech())).toBe(false);
    expect(h.sink.handleSpokenReceipt({ spoken: "reply", ok: true }, "other")).toBe(false);
    expect(h.sink.handleSpokenReceipt({ spoken: "reply", ok: true }, "phone")).toBe(true);
  });
  it("renders every word of long answers through bounded provider clips", async () => {
    const h = fixture(); const rendered: string[] = [];
    h.sink.voice = { clipFor: async (text: string) => { rendered.push(text); return { id: String(rendered.length) }; } };
    const text = "This is a complete sentence with useful detail. ".repeat(38).trim();
    await h.sink.handleAck({ id: "long", text });
    expect(rendered.length).toBeGreaterThan(1);
    expect(rendered.every(s => s.length <= 600)).toBe(true);
    expect(rendered.join(" ")).toBe(text);
    expect(h.sent[0].ack.audioChunks.map((c: any) => c.text)).toEqual(rendered);
    expect(speechChunks("x".repeat(1201)).map(s => s.length)).toEqual([600, 600, 1]);
    h.sink.handleSpokenReceipt({ spoken: "long", ok: true }, "phone");
  });
});

describe("15-second reply feedback", () => {
  it("accepts a clear yes or no even when the reply included that word", async () => {
    const h = fixture();
    h.bus.expectAnswer("phone", "reply", { conversationId: "zeca-thread", spoken: "No other changes are needed." });
    h.bus.armAnswerWindow("reply");
    h.bus.handleSegments({ sessionId: "phone", segments: [speech("No.", { end: 0.25 })] });
    await vi.advanceTimersByTimeAsync(901);
    await h.bus.dispatchChain;
    expect(h.turns[0]?.command).toBe("No.");
  });
  it("opens after playback, filters noise and echo, and posts the complete follow-up to the same conversation", async () => {
    const h = fixture();
    h.bus.expectAnswer("phone", "reply", { conversationId: "zeca-thread", spoken: "The report is ready.", rounds: 99 });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(h.bus.openAnswerWindow("phone")).toBeNull();
    h.bus.armAnswerWindow("reply");
    h.bus.handleSegments({ sessionId: "phone", segments: [speech("[noise]"), speech("The report is ready.")] });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(h.turns).toEqual([]);
    h.bus.handleSegments({ sessionId: "phone", segments: [speech("Please change the date", { start: 15, end: 16 })] });
    await vi.advanceTimersByTimeAsync(600);
    h.bus.handleSegments({ sessionId: "phone", segments: [speech("to next Friday.", { start: 17, end: 18 })] });
    await vi.advanceTimersByTimeAsync(901);
    await h.bus.dispatchChain;
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]).toMatchObject({ conversationId: "zeca-thread", command: "Please change the date to next Friday." });
    expect(h.notices).toEqual([]);
  });
  it("lets speech begun near expiry finish and never sends interim text", async () => {
    const h = fixture();
    h.bus.expectAnswer("phone", "reply", { conversationId: "zeca-thread" });
    h.bus.armAnswerWindow("reply");
    await vi.advanceTimersByTimeAsync(14_800);
    h.bus.observeFeedbackInterim("phone", speech("Please change", { final: false }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.turns).toEqual([]);
    h.bus.handleSegments({ sessionId: "phone", segments: [speech("Please change the date.")] });
    await vi.advanceTimersByTimeAsync(901);
    await h.bus.dispatchChain;
    expect(h.turns[0]?.command).toBe("Please change the date.");
  });
  it("waits for a final utterance instead of sending an unfinished fragment", async () => {
    const h = fixture();
    h.bus.expectAnswer("phone", "reply", { conversationId: "zeca-thread" });
    h.bus.armAnswerWindow("reply");
    h.bus.handleSegments({ sessionId: "phone", segments: [speech("Please change", { speech_final: false })] });
    await vi.advanceTimersByTimeAsync(1100);
    h.bus.observeFeedbackInterim("phone", speech("the date", { final: false }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(h.turns).toEqual([]);
    h.bus.handleSegments({ sessionId: "phone", segments: [speech("the date to Friday.", { start: 2, end: 3, speech_final: true })] });
    await vi.advanceTimersByTimeAsync(901);
    await h.bus.dispatchChain;
    expect(h.turns[0]?.command).toBe("Please change the date to Friday.");
  });
  it("expires exactly 15 seconds after the reply finishes", async () => {
    const h = fixture();
    h.bus.expectAnswer("phone", "reply", { conversationId: "zeca-thread" });
    h.bus.armAnswerWindow("reply");
    await vi.advanceTimersByTimeAsync(REPLY_FEEDBACK_WINDOW_MS - 1);
    expect(h.bus.openAnswerWindow("phone")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.bus.openAnswerWindow("phone")).toBeNull();
    h.bus.handleSegments({ sessionId: "phone", segments: [speech()] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.turns).toEqual([]);
  });
});
