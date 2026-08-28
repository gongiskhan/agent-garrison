// Zeca asks back - the clarifying-question dialogue.
//
// The delegate prompt invites the operative to ask ONE question when a request
// is ambiguous, and the wearer answers by just talking: demanding the wake
// word to answer a question Zeca asked would be absurd. On an always-on
// microphone that is only safe under three rules, and each one is pinned here:
// the window ARMS only after the question was actually SPOKEN (so its own echo
// cannot answer it), the wake word always wins, and rounds are capped.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Counters, CaptureStore } from "../fittings/seed/capture-service/lib/store.mjs";
import { WakeBus, buildFollowupPrompt } from "../fittings/seed/capture-service/lib/wake.mjs";

function bus(overrides: Record<string, unknown> = {}, cfgOver: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "answer-window-"));
  const store = new CaptureStore(path.join(home, "capture"));
  const prompts: Array<{ prompt: string; sessionId: string | null }> = [];
  const notified: any[] = [];
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
      delegateEnabled: true,
      wakeFollowupWindowMs: 12000,
      wakeFollowupMaxRounds: 3,
      ...cfgOver
    },
    store,
    counters: new Counters(store.root, "test"),
    runFn: async () => ({ reply: JSON.stringify({ intent: "delegate", request: "algo de comida", ack: "Vou ver." }) }),
    operativeFn: async ({ prompt, sessionId }: any) => {
      prompts.push({ prompt, sessionId });
      return { reply: "Queres ideias para o jantar ou para o almoço?" };
    },
    board: { listProjects: async () => [], base: () => null },
    memoryWriter: { write: () => ({ ok: true }) },
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
  return { wake, store, prompts, notified, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("the answer window", () => {
  it("routes the next utterance - no wake word - into the SAME gateway session", async () => {
    const h = bus();
    try {
      h.wake.expectAnswer("s1", "ack-1", { lang: "pt", rounds: 0, eventId: "01EVENT0000000000000000000" });
      // Not armed yet: the question has not been spoken. A segment now is
      // ordinary ambient speech and must NOT be consumed.
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "para o jantar.", start: 0, end: 1 }] });
      expect(h.prompts).toHaveLength(0);

      h.wake.armAnswerWindow("ack-1");
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "para o jantar.", start: 2, end: 3 }] });
      await h.wake.delegateChain;
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0].prompt).toBe(buildFollowupPrompt("para o jantar.", { lang: "pt" }));
      // Same gateway session id = the operative keeps its context.
      expect(h.prompts[0].sessionId).toContain("s1");
    } finally {
      h.cleanup();
    }
  });

  it("lets the wake word win over an open window", async () => {
    const h = bus();
    try {
      h.wake.expectAnswer("s1", "ack-1", { lang: "pt" });
      h.wake.armAnswerWindow("ack-1");
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "Zeca, cria uma tarefa nova.", start: 0, end: 1 }] });
      // The window is gone and a normal capture opened instead.
      expect(h.prompts).toHaveLength(0);
      expect(h.wake.session("s1").state).toBe("capturing");
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "sem resposta.", start: 2, end: 3 }] });
      await h.wake.delegateChain;
      expect(h.prompts).toHaveLength(0); // still no follow-up ran
    } finally {
      h.cleanup();
    }
  });

  it("expires, and an expired window consumes nothing", async () => {
    let t = 1000;
    const h = bus({ now: () => t });
    try {
      h.wake.expectAnswer("s1", "ack-1", { lang: "pt" });
      h.wake.armAnswerWindow("ack-1");
      t += 13_000; // past wakeFollowupWindowMs
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "para o jantar.", start: 0, end: 1 }] });
      await h.wake.delegateChain;
      expect(h.prompts).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("caps the rounds - a model that keeps asking stops being answered", () => {
    const h = bus();
    try {
      h.wake.expectAnswer("s1", "ack-4", { lang: "pt", rounds: 3 });
      expect(h.wake.armAnswerWindow("ack-4")).toBeNull(); // never registered
    } finally {
      h.cleanup();
    }
  });

  it("files a follow-up under its PARENT exchange, so the transcript threads", async () => {
    const h = bus();
    try {
      h.wake.expectAnswer("s1", "ack-1", { lang: "pt", rounds: 0, eventId: "01PARENT000000000000000000" });
      h.wake.armAnswerWindow("ack-1");
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "para o jantar.", start: 0, end: 1 }] });
      await h.wake.delegateChain;
      const files = readdirSync(path.join(h.store.root, "wake-results"));
      expect(files).toContain("01PARENT000000000000000000.followup.1.json");
      const doc = JSON.parse(
        readFileSync(path.join(h.store.root, "wake-results", "01PARENT000000000000000000.followup.1.json"), "utf8")
      );
      expect(doc.request).toBe("para o jantar.");
      expect(doc.reply).toContain("jantar ou para o almo");
      // The reply itself asks again - the notifier params carry what the
      // wrapper needs to chain round 2 against the same parent.
      expect(h.notified[0].eventId).toBe("01PARENT000000000000000000");
      expect(h.notified[0].followupRounds).toBe(1);
      expect(h.notified[0].lang).toBe("pt");
    } finally {
      h.cleanup();
    }
  });

  it("never opens on the omi shape - expectAnswer is only ever called by the speak lane", async () => {
    const h = bus();
    try {
      // No expectAnswer, no armAnswerWindow (omi has no spoken receipts).
      h.wake.handleSegments({ sessionId: "s1", segments: [{ text: "uma frase qualquer.", start: 0, end: 1 }] });
      await h.wake.delegateChain;
      expect(h.prompts).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});
