// Zeca does more than file tasks: discuss, send, automate.
//
// Every one of these is promoted OUT of the `delegate` catch-all, so the tests
// that matter most are the ones proving each still degrades back into delegate
// when its lane is unavailable. That degradation is what keeps the byte-
// identical omi-channel mirror honest: omi has no socket to speak into, passes
// no speakFn, and must behave exactly as it did before any of this existed.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Counters, CaptureStore } from "../fittings/seed/capture-service/lib/store.mjs";
import {
  DISCUSS_END,
  WakeBus,
  buildVoiceDiscussPrompt,
  parseWakeReply,
  splitForSpeech
} from "../fittings/seed/capture-service/lib/wake.mjs";

const BASE_CFG = {
  wakeEnabled: true,
  gatewayUrl: "http://127.0.0.1:1",
  wakeVariants: ["zeca"],
  wakeSilenceCloseMs: 20,
  wakeMaxCaptureMs: 500,
  wakeCommandWindowMs: 60000,
  wakeContextSegments: 0,
  wakeCardDedupeMs: 0,
  wakeReviseAfterMs: 0,
  delegateEnabled: true,
  discussEnabled: true,
  discussIdleMs: 5000,
  discussMaxTurns: 40,
  sendEnabled: true,
  sendDefaultMedium: "whatsapp",
  automateEnabled: true
};

function bus(overrides: Record<string, unknown> = {}, cfgOver: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "voice-intents-"));
  const store = new CaptureStore(path.join(home, "capture"));
  const spoken: string[] = [];
  const notifications: string[] = [];
  const wake = new WakeBus({
    cfg: { ...BASE_CFG, ...cfgOver },
    store,
    counters: new Counters(store.root, "test"),
    runFn: async () => ({ reply: "{}" }),
    operativeFn: async () => ({ reply: "operative answered" }),
    board: { listProjects: async () => [], createCard: async () => ({ id: "c1" }), base: () => null },
    memoryWriter: { write: () => ({ ok: true }) },
    notifier: {
      send: async ({ params }: any) => {
        notifications.push(params.text);
        return [];
      },
      cardUrl: async () => null
    },
    log: { log: () => {}, error: () => {} },
    speakFn: async (text: string) => {
      spoken.push(text);
    },
    ...overrides
  });
  return { wake, spoken, notifications, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const reply = (o: Record<string, unknown>) => async () => ({ reply: JSON.stringify(o) });

describe("voice discuss", () => {
  it("opens a discussion and speaks the opener", async () => {
    const turns: Array<{ prompt: string; sessionId: string }> = [];
    const h = bus({
      runFn: reply({ intent: "discuss", topic: "a arquitectura do mesh", ack: "Vamos lá." }),
      discussFn: async ({ prompt, sessionId }: any) => {
        turns.push({ prompt, sessionId });
        return { reply: "Começo por perguntar: que problema é que isto resolve?" };
      }
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, quero discutir a arquitectura.", start: 0, end: 1 }] });
      const out = await h.wake.close("s1", "silence");
      expect(out.result.intent).toBe("discuss");
      // dispatch() already ran `after` on its own chain - do not run it twice.
      await h.wake.delegateChain;
      await h.wake.discussion("s1")?.chain;
      expect(h.wake.session("s1").state).toBe("discussing");
      expect(turns[0].prompt).toContain("under 55 words");
      expect(h.spoken).toEqual(["Começo por perguntar: que problema é que isto resolve?"]);
    } finally {
      h.cleanup();
    }
  });

  it("continues WITHOUT the wake word, on the same thread", async () => {
    const seen: string[] = [];
    const h = bus({
      runFn: reply({ intent: "discuss", topic: "x", ack: "ok" }),
      discussFn: async ({ prompt, sessionId }: any) => {
        seen.push(sessionId);
        return { reply: prompt.includes("under 55") ? "opener" : "segunda resposta" };
      }
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, vamos falar disto.", start: 0, end: 1 }] });
      await h.wake.close("s1", "silence");
      await h.wake.delegateChain;
      await h.wake.discussion("s1")?.chain;
      // No wake word - this is a reply inside the conversation.
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Acho que devíamos usar filas.", start: 2, end: 3 }] });
      await new Promise((r) => setTimeout(r, 60));
      await h.wake.discussion("s1")?.chain;
      expect(h.spoken).toContain("segunda resposta");
      expect(new Set(seen).size).toBe(1); // one thread across both turns
    } finally {
      h.cleanup();
    }
  });

  it("serialises turns so two segments cannot open two conversations", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const h = bus({
      runFn: reply({ intent: "discuss", topic: "x", ack: "ok" }),
      discussFn: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { reply: "r" };
      }
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, discute isto.", start: 0, end: 1 }] });
      await h.wake.close("s1", "silence");
      await h.wake.delegateChain;
      await h.wake.discussion("s1")?.chain;
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "primeira coisa.", start: 2, end: 3 }] });
      await new Promise((r) => setTimeout(r, 30));
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "segunda coisa.", start: 4, end: 5 }] });
      await new Promise((r) => setTimeout(r, 120));
      await h.wake.discussion("s1")?.chain;
      expect(maxConcurrent).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("ends on a closing phrase, and on the wake word", async () => {
    const h = bus({ runFn: reply({ intent: "discuss", topic: "x", ack: "ok" }), discussFn: async () => ({ reply: "r" }) });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, discute isto.", start: 0, end: 1 }] });
      await h.wake.close("s1", "silence");
      await h.wake.delegateChain;
      await h.wake.discussion("s1")?.chain;
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Pronto.", start: 2, end: 3 }] });
      expect(h.wake.discussion("s1")).toBeNull();
      expect(h.wake.session("s1").state).toBe("armed");
    } finally {
      h.cleanup();
    }
  });

  it("treats the wake word mid-discussion as an exit AND a fresh command", async () => {
    const h = bus({ runFn: reply({ intent: "discuss", topic: "x", ack: "ok" }), discussFn: async () => ({ reply: "r" }) });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, discute isto.", start: 0, end: 1 }] });
      await h.wake.close("s1", "silence");
      await h.wake.delegateChain;
      await h.wake.discussion("s1")?.chain;
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, cria uma tarefa disso.", start: 2, end: 3 }] });
      expect(h.wake.discussion("s1")).toBeNull();
      // The remainder is not lost: it opened an ordinary capture.
      expect(h.wake.session("s1").state).toBe("capturing");
    } finally {
      h.cleanup();
    }
  });

  // "pronto, mas o que achas" is a TURN. Anchoring is what makes that safe.
  it("does not end on a sentence that merely contains a closing word", () => {
    expect(DISCUSS_END.test("Pronto.")).toBe(true);
    expect(DISCUSS_END.test("pronto, mas o que achas disso")).toBe(false);
    expect(DISCUSS_END.test("I am done with this whole argument")).toBe(false);
  });

  it("falls back to delegate where there is no speak lane (the omi case)", async () => {
    const h = bus({ speakFn: null, runFn: reply({ intent: "discuss", topic: "x", ack: "on it" }) });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, discute isto.", start: 0, end: 1 }] });
      const out = await h.wake.close("s1", "silence");
      expect(out.result.intent).toBe("delegate");
    } finally {
      h.cleanup();
    }
  });

  // 600 chars is where tts.mjs stops rendering; past it the whole discussion
  // silently drops into the phone's robotic voice.
  it("splits a long reply into speakable chunks", () => {
    const long = "Uma frase bastante mais comprida do que o normal. ".repeat(40);
    const parts = splitForSpeech(long);
    expect(parts.length).toBeLessThanOrEqual(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(520);
    expect(parts[parts.length - 1].endsWith("...")).toBe(true);
    expect(buildVoiceDiscussPrompt("x")).toContain("under 55 words");
  });
});

describe("voice sends", () => {
  const sendReply = reply({
    intent: "send_message",
    recipient: "Marília",
    body: "é melhor amanhã",
    ack: "Vou enviar."
  });

  it("resolves the contact and PARKS the send rather than sending it", async () => {
    const calls: Array<[string, string, any]> = [];
    const h = bus({
      runFn: sendReply,
      connectorFn: async (id: string, action: string, args: any) => {
        calls.push([id, action, args]);
        if (action === "resolve_contact") return { result: { contacts: [{ id: "351900@s.whatsapp.net", name: "Marília Costa" }] } };
        return { result: { queued: true, id: "ob-1" } };
      }
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, manda mensagem à Marília.", start: 0, end: 1 }] });
      const out = await h.wake.close("s1", "silence");
      expect(out.result.intent).toBe("send_message");
      expect(calls.map((c) => c[1])).toEqual(["resolve_contact", "send_text"]);
      // The read-back names WHO and WHAT, so a wrong referent is audible.
      expect(out.confirmation).toContain("Marília Costa");
      expect(out.confirmation).toContain("é melhor amanhã");
      expect(out.confirmation.toLowerCase()).toContain("cancela");
    } finally {
      h.cleanup();
    }
  });

  it("never guesses among candidates", async () => {
    const h = bus({
      runFn: sendReply,
      connectorFn: async (_id: string, action: string) => {
        if (action === "resolve_contact") {
          return { result: { contacts: [{ id: "a", name: "Marília Costa" }, { id: "b", name: "Marília Ramos" }] } };
        }
        throw new Error("must not send");
      }
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, manda mensagem à Marília.", start: 0, end: 1 }] });
      const out = await h.wake.close("s1", "silence");
      expect(out.result.ok).toBe(false);
      expect(out.confirmation).toContain("Marília Costa");
      expect(out.confirmation).toContain("Marília Ramos");
    } finally {
      h.cleanup();
    }
  });

  it("hands an unresolvable contact to delegate rather than inventing one", async () => {
    const h = bus({
      runFn: sendReply,
      connectorFn: async () => ({ result: { contacts: [] } })
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, manda mensagem à Marília.", start: 0, end: 1 }] });
      const out = await h.wake.close("s1", "silence");
      expect(out.result.intent).toBe("delegate");
    } finally {
      h.cleanup();
    }
  });

  // Email is the one send with no daemon and no cancel window of its own, so
  // an UNSPOKEN medium must never land there.
  it("never resolves an unspoken medium to email", async () => {
    const h = bus({ runFn: sendReply, connectorFn: async () => ({ result: { contacts: [{ id: "x", name: "M" }] } }) });
    try {
      expect(parseWakeReply(JSON.stringify({ intent: "send_message" }))?.medium).toBeNull();
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, manda mensagem à Marília.", start: 0, end: 1 }] });
      const out = await h.wake.close("s1", "silence");
      expect(out.result.medium).toBe("whatsapp");
    } finally {
      h.cleanup();
    }
  });

  it("degrades to delegate when sending is switched off", async () => {
    const h = bus({ runFn: sendReply }, { sendEnabled: false });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, manda mensagem à Marília.", start: 0, end: 1 }] });
      expect((await h.wake.close("s1", "silence")).result.intent).toBe("delegate");
    } finally {
      h.cleanup();
    }
  });
});

describe("voice automations", () => {
  const automateReply = reply({ intent: "automate", automation: "backup nocturno", ack: "ok" });

  it("runs a resolved automation with an idempotency key", async () => {
    const runs: any[] = [];
    const h = bus({
      runFn: automateReply,
      cortexFn: {
        resolve: async () => ({ status: "ok", id: "a1", name: "Backup nocturno" }),
        run: async (id: string, inputs: any, key: string) => {
          runs.push({ id, inputs, key });
          return { runId: "r1", created: true };
        }
      }
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, corre a automação backup nocturno.", start: 0, end: 1 }] });
      const out = await h.wake.close("s1", "silence");
      expect(out.result.ok).toBe(true);
      // At-most-once for a re-sent utterance is the whole reason this intent
      // lives in the fitting rather than in a delegated turn.
      expect(runs[0].key).toMatch(/^voice-/);
    } finally {
      h.cleanup();
    }
  });

  it("says a replay was a replay", async () => {
    const h = bus({
      runFn: automateReply,
      cortexFn: {
        resolve: async () => ({ status: "ok", id: "a1", name: "Backup" }),
        run: async () => ({ runId: "r1", created: false })
      }
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, corre o backup.", start: 0, end: 1 }] });
      const out = await h.wake.close("s1", "silence");
      expect(out.confirmation).toMatch(/já estava|already/i);
    } finally {
      h.cleanup();
    }
  });

  it("refuses to choose among several, and reports a missing Cortex as a state", async () => {
    const ambiguous = bus({
      runFn: automateReply,
      cortexFn: { resolve: async () => ({ status: "ambiguous", candidates: ["Backup nocturno", "Backup semanal"] }), run: async () => ({}) }
    });
    try {
      ambiguous.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, corre o backup.", start: 0, end: 1 }] });
      const out = await ambiguous.wake.close("s1", "silence");
      expect(out.result.ok).toBe(false);
      expect(out.confirmation).toContain("Backup nocturno");
    } finally {
      ambiguous.cleanup();
    }

    // Shipping without Cortex installed is the DEFAULT, not a fault.
    const missing = bus({
      runFn: automateReply,
      cortexFn: { resolve: async () => ({ status: "unavailable" }), run: async () => ({}) }
    });
    try {
      missing.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, corre o backup.", start: 0, end: 1 }] });
      const out = await missing.wake.close("s1", "silence");
      expect(out.result.ok).toBe(false);
      expect(out.confirmation).toMatch(/Cortex/);
    } finally {
      missing.cleanup();
    }
  });

  it("falls back to delegate for a name Cortex does not know", async () => {
    const h = bus({
      runFn: automateReply,
      cortexFn: { resolve: async () => ({ status: "none" }), run: async () => ({}) }
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, corre o inexistente.", start: 0, end: 1 }] });
      // The operative holds the LOCAL automations engine's tools; a voice path
      // that silently picks between two runners is how you run the wrong thing.
      expect((await h.wake.close("s1", "silence")).result.intent).toBe("delegate");
    } finally {
      h.cleanup();
    }
  });
});

describe("what the voice never says", () => {
  // The gateway appends "[route: cc-opus | ...]" to replies. In a terminal,
  // metadata; read ALOUD, bracket soup after every single answer.
  it("strips the gateway's routing footer before a reply is spoken or stored", async () => {
    const notified: any[] = [];
    const h = bus({
      runFn: reply({ intent: "delegate", request: "restaurante", ack: "Vou ver." }),
      operativeFn: async () => ({
        reply: "É bom: 4,6 em 5.\n\n[route: cc-opus | rule: research-l1 | profile: personal]\n[orchestrator-active]"
      }),
      notifier: {
        send: async ({ params }: any) => {
          notified.push(params);
          return [];
        },
        cardUrl: async () => null
      }
    });
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, o restaurante é bom?", start: 0, end: 1 }] });
      await h.wake.close("s1", "silence");
      await h.wake.delegateChain;
      const answer = notified.find((p) => p.text?.includes("4,6"));
      expect(answer.text).toBe("É bom: 4,6 em 5.");
      expect(answer.text).not.toContain("[route");
      // Brackets INSIDE prose survive - only the trailing metadata block goes.
      expect(WakeBus.stripRoutingFooter("Uso [este] formato.")).toBe("Uso [este] formato.");
    } finally {
      h.cleanup();
    }
  });

  // "Sim. Olha achas que..." - the cue's echo, fused by the transcriber onto
  // the front of the user's first words, where the exact-match echo lane
  // cannot reach without eating real speech.
  it("strips a leading cue echo off the command, and only off the front", async () => {
    const classified: string[] = [];
    const h = bus(
      {
        runFn: async ({ prompt }: any) => {
          classified.push(prompt);
          return { reply: JSON.stringify({ intent: "query", answer: "ok" }) };
        }
      },
      { wakeEchoPrefixes: ["sim", "deixa comigo", "ok"] }
    );
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca.", start: 0, end: 1 }] });
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Sim. Olha, achas que o Porta 67 é bom?", start: 1, end: 2 }] });
      await h.wake.close("s1", "silence");
      expect(classified[0]).toContain('Command (spoken right after the wake word): "Olha, achas que o Porta 67 é bom?"');
      // A word merely STARTING with a prefix survives.
      expect(h.wake.stripLeadingCueEcho("Simplesmente faz")).toBe("Simplesmente faz");
      expect(h.wake.stripLeadingCueEcho("Cria uma tarefa sim")).toBe("Cria uma tarefa sim");
    } finally {
      h.cleanup();
    }
  });

  // "Ainda estou a tratar disso." every interval while the operative works -
  // the wearer's silence-reading is binary, and a minute of nothing means it
  // died. Spoken only: params.progress makes the wrapper skip the push.
  it("speaks a progress line while a long delegate turn runs, then stops", async () => {
    const notified: any[] = [];
    const h = bus(
      {
        runFn: reply({ intent: "delegate", request: "demorado", ack: "Vou ver." }),
        operativeFn: async () => {
          await new Promise((r) => setTimeout(r, 120));
          return { reply: "feito" };
        },
        notifier: {
          send: async ({ params }: any) => {
            notified.push(params);
            return [];
          },
          cardUrl: async () => null
        }
      },
      { wakeProgressIntervalMs: 40 }
    );
    try {
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, faz uma coisa demorada.", start: 0, end: 1 }] });
      await h.wake.close("s1", "silence");
      await h.wake.delegateChain;
      const progress = notified.filter((p) => p.progress === true);
      expect(progress.length).toBeGreaterThanOrEqual(2);
      expect(progress[0].text).toBe("Ainda estou a tratar disso.");
      // And it STOPS with the turn - nothing new after the answer.
      const count = notified.filter((p) => p.progress === true).length;
      await new Promise((r) => setTimeout(r, 100));
      expect(notified.filter((p) => p.progress === true).length).toBe(count);
    } finally {
      h.cleanup();
    }
  });

  // Both of these filed durable memory notes today, with a spoken "guardei
  // como nota" - untrue in spirit (nothing was asked) and noise in the vault.
  it("does not turn a bare wake word or a one-word interjection into a note", async () => {
    for (const text of ["Zeca.", "Boa."]) {
      const h = bus({ runFn: reply({ intent: "unknown" }) }, { wakeUnheardEnabled: true });
      try {
        h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca.", start: 0, end: 1 }] });
        h.wake.handleSegments({ sessionId: "s1", segments: [{ text, start: 2, end: 3 }] });
        const out = await h.wake.close("s1", "silence");
        expect(out.result.intent).toBe("discarded");
        expect(out.confirmation).toMatch(/percebi|catch/i);
      } finally {
        h.cleanup();
      }
    }
  });

  // Overnight the 6h language memory expires; falling back to English for a
  // Portuguese household is the worse guess, and the STT pin is the one thing
  // always true about this deployment.
  it("falls back to the transcriber's language, not English", async () => {
    const h = bus({}, { sttLanguage: "pt", wakeLanguage: null });
    try {
      expect(h.wake.resolveLanguage("")).toBe("pt");
    } finally {
      h.cleanup();
    }
    const en = bus({}, { sttLanguage: "en", wakeLanguage: null });
    try {
      expect(en.wake.resolveLanguage("")).toBe("en");
    } finally {
      en.cleanup();
    }
  });
});