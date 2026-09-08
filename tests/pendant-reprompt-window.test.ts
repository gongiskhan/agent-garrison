// "Didn't catch that" has to keep listening (D61).
//
// The wearer says the name, says the thing, and Zeca answers that it did not
// understand - and then closed the microphone, so the only way forward was to
// say "Zeca" again and repeat the whole command. The line IS the invitation to
// repeat, so it opens the same kind of window a clarifying question opens, with
// two differences that matter: what follows is a COMMAND said again (it goes
// through the classifier, not the clarification lane), and Zeca's own line
// coming back through the microphone must not be read as the repeat.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Counters, CaptureStore } from "../fittings/seed/capture-service/lib/store.mjs";
import { WakeBus } from "../fittings/seed/capture-service/lib/wake.mjs";

const UNHEARD_PT = "Não percebi - repete?";

function bus(overrides: Record<string, unknown> = {}, cfgOver: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "reprompt-window-"));
  const store = new CaptureStore(path.join(home, "capture"));
  const classified: string[] = [];
  const delegated: string[] = [];
  const notified: any[] = [];
  const notes: any[] = [];
  const wake = new WakeBus({
    cfg: {
      wakeEnabled: true,
      gatewayUrl: "http://127.0.0.1:1",
      wakeVariants: ["zeca"],
      wakeSilenceCloseMs: 20,
      wakeMaxCaptureMs: 500,
      wakeCommandWindowMs: 60000,
      wakeContextSegments: 0,
      wakeCardDedupeMs: 0,
      wakeUnheardEnabled: true,
      delegateEnabled: true,
      wakeFollowupWindowMs: 12000,
      wakeRepromptWindowMs: 20000,
      wakeFollowupMaxRounds: 3,
      ...cfgOver
    },
    store,
    counters: new Counters(store.root, "test"),
    runFn: async ({ prompt }: any) => {
      classified.push(prompt);
      return { reply: JSON.stringify({ intent: "unknown" }) };
    },
    operativeFn: async ({ prompt }: any) => {
      delegated.push(prompt);
      return { reply: "uma resposta" };
    },
    board: { listProjects: async () => [], base: () => null },
    memoryWriter: {
      write: (note: any) => {
        notes.push(note);
        return { ok: true };
      }
    },
    notifier: {
      send: async ({ params }: any) => {
        notified.push(params);
        return [];
      },
      cardUrl: async () => null
    },
    log: { log: () => {}, error: () => {} },
    ...overrides
  });
  return { wake, store, classified, delegated, notified, notes, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// The window the notifier opens is keyed on the ack it is about to speak, so a
// test that wants an OPEN re-prompt window does what the server does: register
// the expectation, then arm it as the phone's spoken receipt would.
function openReprompt(h: ReturnType<typeof bus>, sessionId: string, { rounds = 0, spoken = UNHEARD_PT } = {}) {
  h.wake.expectAnswer(sessionId, `ack-${rounds}`, { lang: "pt", rounds, reprompt: true, spoken });
  return h.wake.armAnswerWindow(`ack-${rounds}`);
}

describe("the re-prompt window", () => {
  it("asks for one: the unheard line carries reprompt, not a question mark", async () => {
    const h = bus();
    try {
      h.wake.session("s1");
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca.", start: 0, end: 1 }] });
      await h.wake.close("s1", "silence");
      const line = h.notified.find((p) => /percebi|catch/i.test(String(p.text)));
      expect(line, "the empty capture speaks the unheard line").toBeTruthy();
      // speakOnly is still true (an unheard capture is not worth a banner) -
      // it used to be exactly what disqualified this line from re-opening.
      expect(line.speakOnly).toBe(true);
      expect(line.reprompt).toBe(true);
      expect(line.followupRounds).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("routes the repeat through the command lane, not the clarification lane", async () => {
    const h = bus();
    try {
      h.wake.session("s1");
      expect(openReprompt(h, "s1")).toBe("s1");
      h.wake.handleSegments({
        sessionId: "s1",
        segments: [{ text: "Cria uma tarefa para ligar ao João.", start: 0, end: 2 }]
      });
      await h.wake.dispatchChain;
      expect(h.classified, "the repeat is classified as a fresh command").toHaveLength(1);
      expect(h.classified[0]).toContain("ligar ao João");
      expect(h.delegated, "and never handed to the clarification lane").toHaveLength(0);
      expect(h.wake.counters.read().wake_reprompt_answers).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("does not eat its own voice: the spoken line coming back leaves the window open", async () => {
    const h = bus();
    try {
      h.wake.session("s1");
      openReprompt(h, "s1");
      // Deepgram splits the spoken line into short fragments, all of them under
      // the echo guard's token floor.
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Não percebi", start: 0, end: 1 }] });
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "repete?", start: 1, end: 2 }] });
      await h.wake.dispatchChain;
      expect(h.classified, "nothing dispatched on an echo").toHaveLength(0);
      expect(h.wake.counters.read().wake_reprompt_echo_ignored).toBe(2);
      // The window survived the echo, so the wearer's actual repeat still lands.
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Guarda uma nota sobre o contrato.", start: 3, end: 4 }] });
      await h.wake.dispatchChain;
      expect(h.classified).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("keeps the wide window: a repeat takes longer than an answer", async () => {
    let t = 1000;
    const h = bus({ now: () => t });
    try {
      h.wake.session("s1");
      openReprompt(h, "s1");
      t += 15_000; // past wakeFollowupWindowMs, inside wakeRepromptWindowMs
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Cria uma tarefa.", start: 0, end: 1 }] });
      await h.wake.dispatchChain;
      expect(h.classified).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("caps the rounds - two of them trading 'didn't catch that' forever is not a conversation", async () => {
    const h = bus();
    try {
      h.wake.session("s1");
      expect(openReprompt(h, "s1", { rounds: 3 })).toBeNull();
      expect(h.wake.counters.read().wake_followup_rounds_capped).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("counts a round per repeat, and a fresh wake hit starts over", async () => {
    const h = bus();
    try {
      h.wake.session("s1");
      openReprompt(h, "s1", { rounds: 1 });
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Cria uma tarefa.", start: 0, end: 1 }] });
      await h.wake.dispatchChain;
      // The classifier said "unknown" again, so the outcome re-prompts - and it
      // carries the NEXT round, or the cap would never bite.
      const line = h.notified.find((p) => p.reprompt === true && p.eventId);
      expect(line.followupRounds).toBe(2);
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca.", start: 4, end: 5 }] });
      expect(h.wake.session("s1").repromptRounds).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("re-prompts when it did not understand, and does not when the gateway is simply down", async () => {
    const h = bus({
      runFn: async () => {
        throw new Error("gateway down");
      }
    });
    try {
      h.wake.session("s1");
      await h.wake.dispatch({ sessionId: "s1", command: "uma coisa qualquer para fazer", wakeHitAt: Date.now() });
      const line = h.notified.find((p) => p.eventId);
      expect(line.reprompt, "repeating yourself at a dead gateway is wasted breath").toBe(false);
    } finally {
      h.cleanup();
    }

    const h2 = bus();
    try {
      h2.wake.session("s2");
      await h2.wake.dispatch({ sessionId: "s2", command: "uma coisa qualquer para fazer", wakeHitAt: Date.now() });
      const line = h2.notified.find((p) => p.eventId);
      expect(line.reprompt, "an unknown intent saved as a note still invites a rephrase").toBe(true);
    } finally {
      h2.cleanup();
    }
  });
});
