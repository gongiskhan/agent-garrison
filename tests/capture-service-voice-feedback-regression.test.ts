import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EchoGuard } from "../fittings/seed/capture-service/lib/echo-guard.mjs";
import { LanguageMemory } from "../fittings/seed/capture-service/lib/language-memory.mjs";
// @ts-ignore pure server module
import { AckSink } from "../fittings/seed/capture-service/lib/ack-sink.mjs";
import { Cues } from "../fittings/seed/capture-service/lib/cues.mjs";

const homes: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "voice-feedback-"));
  homes.push(home);
  let now = 0;
  const clock = () => now;
  const guard = new EchoGuard({ now: clock });
  const language = new LanguageMemory({ stateDir: home, now: clock });
  const sends: any[] = [];
  const session = { record: { id: "pendant", mode: "pendant" }, socket: { OPEN: 1, readyState: 1, send: (msg: string) => sends.push(JSON.parse(msg)) } };
  const sink = new AckSink({ cfg: { speakEnabled: true }, store: { root: home }, counters: { bump() {}, observe() {} }, echoGuard: guard,
    ingress: { sessions: new Map([["pendant", session]]) }, notifier: {}, languageMemory: language, now: clock });
  return { home, guard, language, sends, sink, session, advance: (ms: number) => { now += ms; } };
}

describe("voice feedback regressions", () => {
  it("protects long native playback and short STT fragments beyond the old 30-second expiry", async () => {
    vi.useFakeTimers();
    const h = fixture();
    await h.sink.handleAck({ id: "long", text: "Sou o Zeca e já terminei o relatório pedido." });
    h.advance(45_000);
    for (const fragment of ["Zeca", "terminei", "o relatório", "já terminei o relatório pedido"]) {
      expect(h.guard.shouldSuppress(fragment), fragment).toBe(true);
    }
    for (const user of ["Sim", "Não", "Zeca, para e ouve o que estou a dizer", "Preciso de marcar o jantar amanhã"]) {
      expect(h.guard.shouldSuppress(user), user).toBe(false);
    }
    h.sink.handleSpokenReceipt({ spoken: "long", ok: true });
    expect(h.guard.shouldSuppress("Zeca")).toBe(true);
    h.advance(1_501);
    expect(h.guard.shouldSuppress("Zeca")).toBe(false);
  });

  it("starts protection after slow TTS and deduplicates concurrent/retried acknowledgements", async () => {
    vi.useFakeTimers();
    const h = fixture();
    let resolve!: (value: null) => void;
    h.sink.voice = { clipFor: () => new Promise((done) => { resolve = done; }) };
    const ack = { id: "once", text: "O relatório está pronto para revisão." };
    const first = h.sink.handleAck(ack);
    const second = h.sink.handleAck(ack);
    h.advance(45_000);
    resolve(null);
    await Promise.all([first, second]);
    expect(h.sends).toHaveLength(1);
    expect(h.guard.shouldSuppress("O relatório está pronto")).toBe(true);
    h.sink.handleSpokenReceipt({ spoken: "once", ok: true });
    await h.sink.handleAck(ack);
    expect(h.sends).toHaveLength(1);
  });

  it("bounds a lost receipt and releases failed playback without permanently suppressing the wearer", () => {
    const h = fixture();
    h.guard.startPlayback("lost", "O Zeca terminou o relatório.");
    h.advance(120_001);
    expect(h.guard.shouldSuppress("Zeca")).toBe(false);
    h.guard.startPlayback("stopped", "O Zeca terminou o relatório.");
    h.guard.finishPlayback("stopped");
    h.advance(1_501);
    expect(h.guard.shouldSuppress("Zeca")).toBe(false);
  });

  it("keeps Sim after unrelated English output and restores only user-derived language", async () => {
    vi.useFakeTimers();
    const h = fixture();
    h.language.note("pendant", "Zeca, preciso de falar contigo.");
    await h.sink.handleAck({ id: "background", text: "Finished the report.", lang: "en" });
    const cues = new Cues({ cfg: { cueEnabled: true } });
    expect(cues.speechFor("wake_detected", h.language.current())?.text).toBe("Sim?");
    h.sink.handleSpokenReceipt({ spoken: "background", ok: true });
    h.language.note("pendant", "Zeca, can you check the report?");
    expect(cues.speechFor("wake_detected", h.language.current())?.text).toBe("Yes?");
    expect(new LanguageMemory({ stateDir: h.home, now: () => 1 }).current()).toBe("en");
    writeFileSync(path.join(h.home, "language.json"), JSON.stringify({ lang: "en", at: 0 }));
    expect(new LanguageMemory({ stateDir: h.home, now: () => 1 }).current()).toBe("pt");
  });

  it("gives one reply one speaker regardless of polling order or language", () => {
    const h = fixture();
    expect(h.sink.claimReply("conversation:stretch", "page")).toBe(false);
    expect(h.sink.claimReply("conversation:stretch", "native")).toBe(true);
    h.session.socket.readyState = 3;
    expect(h.sink.claimReply("conversation:stretch", "page")).toBe(false);
    expect(h.sink.claimReply("conversation:next", "page")).toBe(true);
    h.session.socket.readyState = 1;
    expect(h.sink.claimReply("conversation:next", "native")).toBe(false);
    expect(h.sink.claimReply("conversation:next", "page")).toBe(false);
  });
});
