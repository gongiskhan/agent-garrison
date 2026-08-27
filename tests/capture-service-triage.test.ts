// Capture service — M4 triage generalization.
//
// One brain, one triage: companion session events join omi's tick through a
// second store root. Proven here: session-end emission with dedupe-by-session
// and consent provenance; a MIXED batch (omi + companion) triaged in ONE
// model call with per-source identity on cards, memories and notifications;
// re-runs creating zero duplicates; the wait-for-context hold (a thin
// fragment alone is held with zero model calls, rides along once context
// arrives, and age-releases); an empty tick making zero calls.

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmiStore, EventsDirStore } from "../fittings/seed/omi-channel/lib/store.mjs";
import { runTriageTick, ruleFilter, HOLD_MAX_MS } from "../fittings/seed/omi-channel/lib/triage.mjs";
import { loadConfig as loadOmiConfig } from "../fittings/seed/omi-channel/lib/config.mjs";
import { MemoryWriter } from "../fittings/seed/omi-channel/lib/memory-writer.mjs";
import { CaptureStore, Counters } from "../fittings/seed/capture-service/lib/store.mjs";
import { loadConfig as loadCaptureConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { emitSessionEvent, transcriptProse } from "../fittings/seed/capture-service/lib/events.mjs";
import { atomicWriteJSON } from "../fittings/seed/capture-service/lib/store.mjs";

function omiConversationEvent(id: string, conversationId: string) {
  return {
    id,
    source: "omi",
    uid: "u1",
    received_at: new Date().toISOString(),
    occurred_at: new Date().toISOString(),
    kind: "conversation" as const,
    normalized: {
      title: "Kitchen chat",
      overview: null,
      category: "personal",
      folder: null,
      discarded: false,
      transcript_text: "You: preciso de ligar ao banco amanhã.",
      action_items: [{ description: "Ligar ao banco", completed: false, source_ref: null }],
      events: [],
      decisions: [],
      questions: [],
      highlights: [],
      insights: []
    },
    provenance: { omi_conversation_id: conversationId },
    status: "pending" as const,
    triage_result_ref: null
  };
}

function companionSessionEvent(id: string, sessionId: string, words: number, floor = 12, receivedAt = new Date()) {
  return {
    id,
    source: "companion-ios",
    uid: null,
    received_at: receivedAt.toISOString(),
    occurred_at: receivedAt.toISOString(),
    kind: "session" as const,
    normalized: {
      title: "Companion audio session",
      overview: null,
      category: null,
      folder: null,
      discarded: false,
      transcript_text: "You: " + Array.from({ length: words }, (_, i) => `palavra${i}`).join(" "),
      stats: { words, segments: 1, hold_floor: floor },
      action_items: [],
      events: [],
      decisions: [],
      questions: [],
      highlights: [],
      insights: []
    },
    provenance: { companion_session_id: sessionId, mode: "audio", consent: "shown", device_name: "iPhone" },
    status: "pending" as const,
    triage_result_ref: null
  };
}

function makeBoard() {
  const cards: any[] = [];
  return {
    cards,
    reachable: async () => true,
    listProjects: async () => ["garrison"],
    findByOriginId: async (originId: string) => cards.filter((c) => c.origin_id === originId),
    createCard: async (payload: any) => {
      const card = { id: `C${cards.length + 1}`, ...payload };
      cards.push(card);
      return card;
    }
  };
}

function makeCounters(dir: string) {
  return new Counters(dir, "triage-test");
}

function tickDeps(home: string) {
  const omiStore = new OmiStore(path.join(home, "omi"));
  const captureRoot = path.join(home, "capture");
  const captureStore = new CaptureStore(captureRoot); // creates the layout
  const captureTickStore = new EventsDirStore(captureRoot); // what the tick uses
  const board = makeBoard();
  const prompts: string[] = [];
  const companionSent: any[] = [];
  const omiSent: any[] = [];
  const omiVault = path.join(home, "vault-omi");
  const companionVault = path.join(home, "vault-companion");
  const cfg = {
    ...loadOmiConfig({ GARRISON_HOME: home, GARRISON_OMICHANNEL_TRIAGE_ENABLED: "true" }),
    gatewayUrl: "http://gateway.test"
  };
  const deps = {
    cfg,
    store: omiStore,
    counters: makeCounters(home),
    board,
    memoryWriter: new MemoryWriter({ dir: omiVault }),
    notifier: {
      cardUrl: async () => null,
      send: async (msg: any) => {
        omiSent.push(msg);
        return [{ means: "omi-push", ok: true }];
      }
    },
    extraStores: [captureTickStore],
    memoryWriterFor: (event: any) =>
      event?.source === "companion-ios"
        ? new MemoryWriter({ dir: companionVault, prefix: "companion", label: "Companion" })
        : new MemoryWriter({ dir: omiVault }),
    notifierFor: (event: any) =>
      event?.source === "companion-ios"
        ? {
            cardUrl: async () => null,
            send: async (msg: any) => {
              companionSent.push(msg);
              return [{ means: "companion-push", ok: false, skipped: "m5" }];
            }
          }
        : deps.notifier
  };
  return { omiStore, captureStore, captureTickStore, board, prompts, companionSent, omiSent, cfg, deps, omiVault, companionVault };
}

function runWith(deps: any, prompts: string[], reply: unknown) {
  return runTriageTick({
    ...deps,
    runFn: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { reply: typeof reply === "string" ? reply : JSON.stringify(reply) };
    }
  });
}

describe("capture-service session event emission", () => {
  it("emits one pending event per session with consent provenance, deduped forever", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "capture-emit-"));
    try {
      const store = new CaptureStore(path.join(home, "capture"));
      const counters = makeCounters(home);
      const cfg = loadCaptureConfig({ GARRISON_HOME: home });
      const transcript = {
        session_id: "01EMITSESSION001",
        segments: [
          { start: 0, end: 2, text: "Preciso de enviar o relatório à Ana.", speaker: 0, is_user: true, final: true }
        ],
        words: 7
      };
      atomicWriteJSON(path.join(store.root, "transcripts", "01EMITSESSION001.json"), transcript);
      const record = {
        id: "01EMITSESSION001",
        source: "companion-ios",
        mode: "audio",
        device_name: "iPhone 17",
        consent: "suppressed",
        started_at: "2026-08-13T09:00:00.000Z",
        status: "ended",
        transcript_ref: "transcripts/01EMITSESSION001.json",
        transcript_words: 7,
        ended: { reason: "user" }
      };

      const event = emitSessionEvent({ record, store, counters, cfg, log: { log() {} } });
      expect(event).not.toBeNull();
      expect(event!.status).toBe("pending");
      expect(event!.source).toBe("companion-ios");
      expect(event!.normalized.stats).toEqual({ words: 7, segments: 1, hold_floor: cfg.minTranscriptWords });
      expect(event!.normalized.transcript_text).toContain("You: Preciso de enviar");
      expect(event!.provenance).toMatchObject({
        companion_session_id: "01EMITSESSION001",
        consent: "suppressed",
        mode: "audio",
        end_reason: "user"
      });

      // Replay of the same session end: dedupe by session id (I7).
      expect(emitSessionEvent({ record, store, counters, cfg, log: { log() {} } })).toBeNull();
      expect(store.listEvents().length).toBe(1);
      expect(counters.read().events_deduped_session).toBe(1);

      // No transcript = nothing for triage.
      const bare = { ...record, id: "01EMITSESSION002", transcript_ref: undefined };
      expect(emitSessionEvent({ record: bare, store, counters, cfg, log: { log() {} } })).toBeNull();
      expect(counters.read().events_skipped_no_transcript).toBe(1);
      expect(transcriptProse([{ is_user: false, speaker: 2, text: "olá" }])).toBe("Speaker 2: olá");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("generalized triage tick", () => {
  it("triages a mixed omi + companion batch in ONE model call with per-source identity, and re-runs create zero duplicates", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "capture-triage-"));
    try {
      const t = tickDeps(home);
      t.omiStore.writeEvent(omiConversationEvent("01OMIEVENT000001", "conv-1"));
      atomicWriteJSON(
        path.join(t.captureStore.root, "events", "01CAPEVENT000001.json"),
        companionSessionEvent("01CAPEVENT000001", "01SESSIONX000001", 40)
      );

      const reply = {
        cards: [
          { event_id: "01OMIEVENT000001", action_index: 0, title: "Ligar ao banco", description: "Telefonar ao banco.", project: null },
          { event_id: "01CAPEVENT000001", action_index: 0, title: "Enviar relatório à Ana", description: "Enviar o relatório.", project: "garrison" }
        ],
        memories: [
          { event_id: "01CAPEVENT000001", title: "Relatórios vão para a Ana", content: "A Ana recebe os relatórios.", tags: ["work"] }
        ],
        tips: []
      };
      const summary = await runWith(t.deps, t.prompts, reply);

      expect(summary.modelCalls).toBe(1);
      expect(t.prompts.length).toBe(1);
      expect(t.prompts[0]).toContain("the user's always-on wearable");
      expect(t.prompts[0]).toContain("a deliberate companion-app capture session");
      expect(t.prompts[0]).toContain("palavra0");
      expect(summary.cardsCreated).toBe(2);

      const omiCard = t.board.cards.find((c) => c.origin === "omi");
      expect(omiCard.origin_id).toBe("omi:conv-1:0");
      expect(omiCard.originChannel).toEqual({ channel: "omi", threadId: "omi-reports" });
      expect(omiCard.description).toContain("Source (Omi):");

      const compCard = t.board.cards.find((c) => c.origin === "companion");
      expect(compCard.origin_id).toBe("companion:01SESSIONX000001:0");
      expect(compCard.originChannel).toEqual({ channel: "companion", threadId: "companion-reports" });
      expect(compCard.description).toContain("Source (Companion):");
      expect(compCard.description).toContain("Provenance: companion session 01SESSIONX000001");

      // Per-source memories and notifications.
      const companionMemories = readdirSync(path.join(home, "vault-companion"));
      expect(companionMemories.length).toBe(1);
      expect(companionMemories[0]).toMatch(/^companion-/);
      const memoryBody = readFileSync(path.join(home, "vault-companion", companionMemories[0]), "utf8");
      expect(memoryBody).toContain("source**: companion-ios");
      expect(memoryBody).toContain("companion session**: 01SESSIONX000001");
      expect(t.companionSent.map((m) => m.template)).toEqual(["card_created"]);
      expect(t.omiSent.map((m) => m.template)).toEqual(["card_created"]);

      // Both events triaged in their OWN stores, result doc in both roots.
      const omiEvent = t.omiStore.listEvents()[0];
      const capEvent = t.captureTickStore.listEvents()[0];
      expect(omiEvent.status).toBe("triaged");
      expect(capEvent.status).toBe("triaged");
      expect(existsSync(path.join(t.omiStore.root, omiEvent.triage_result_ref!))).toBe(true);
      expect(existsSync(path.join(t.captureStore.root, String(capEvent.triage_result_ref)))).toBe(true);

      // Re-run with the events forced pending again: origin dedupe, no new
      // cards, no duplicate memories... the board already holds both origins.
      t.omiStore.updateEvent(omiEvent.id, (ev: any) => ({ ...ev, status: "pending" }));
      t.captureTickStore.updateEvent(capEvent.id, (ev: any) => ({ ...ev, status: "pending" }));
      const rerun = await runWith(t.deps, t.prompts, reply);
      expect(rerun.modelCalls).toBe(1);
      expect(rerun.cardsCreated).toBe(0);
      expect(rerun.cardsDeduped).toBe(2);
      expect(t.board.cards.length).toBe(2);

      // Empty tick: zero model calls (I3).
      const empty = await runWith(t.deps, t.prompts, reply);
      expect(empty.skipped).toBe("empty inbox");
      expect(empty.modelCalls).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("holds a thin fragment alone, releases it when context arrives, and age-releases", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "capture-hold-"));
    try {
      const t = tickDeps(home);
      atomicWriteJSON(
        path.join(t.captureStore.root, "events", "01THINEVENT00001.json"),
        companionSessionEvent("01THINEVENT00001", "01THINSESSION001", 3)
      );

      // Alone: held, pending, ZERO model calls.
      const held = await runWith(t.deps, t.prompts, { cards: [], memories: [], tips: [] });
      expect(held.skipped).toBe("held thin fragments");
      expect(held.held).toBe(1);
      expect(held.modelCalls).toBe(0);
      expect(t.captureTickStore.listEvents("pending").length).toBe(1);

      // Context arrives (an omi event): the thin fragment rides along - ONE
      // model call for both, and the thin session cards exactly once.
      t.omiStore.writeEvent(omiConversationEvent("01OMIEVENT000002", "conv-2"));
      const reply = {
        cards: [{ event_id: "01THINEVENT00001", action_index: 0, title: "Fragmento", description: "Do fragmento.", project: null }],
        memories: [],
        tips: []
      };
      const together = await runWith(t.deps, t.prompts, reply);
      expect(together.modelCalls).toBe(1);
      expect(t.prompts.at(-1)).toContain("01THINEVENT00001");
      expect(together.cardsCreated).toBe(1);
      expect(t.board.cards[0].origin_id).toBe("companion:01THINSESSION001:0");
      expect(t.captureTickStore.listEvents("triaged").length).toBe(1);

      // Age release: a thin fragment past the hold window triages alone.
      atomicWriteJSON(
        path.join(t.captureStore.root, "events", "01THINEVENT00002.json"),
        companionSessionEvent("01THINEVENT00002", "01THINSESSION002", 3, 12, new Date(Date.now() - HOLD_MAX_MS - 1000))
      );
      const aged = await runWith(t.deps, t.prompts, { cards: [], memories: [], tips: [] });
      expect(aged.modelCalls).toBe(1);
      expect(aged.held).toBe(0);
      expect(t.captureTickStore.listEvents("pending").length).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the rule-layer verdicts stable for both sources", () => {
    const cfg = { dropDiscarded: true, blockedFolders: [], allowedCategories: [] };
    const omiEvent = omiConversationEvent("01X", "c");
    expect(ruleFilter(omiEvent, cfg)).toEqual({ action: "keep", taskPath: true });
    omiEvent.normalized.action_items = [{ description: "x", completed: true, source_ref: null }];
    expect(ruleFilter(omiEvent, cfg)).toEqual({ action: "keep", taskPath: false });

    const fat = companionSessionEvent("01Y", "s", 40);
    expect(ruleFilter(fat, cfg)).toEqual({ action: "keep", taskPath: true });
    const thin = companionSessionEvent("01Z", "s2", 3);
    expect(ruleFilter(thin, cfg).action).toBe("hold");
    const agedThin = companionSessionEvent("01W", "s3", 3, 12, new Date(Date.now() - HOLD_MAX_MS - 1000));
    expect(ruleFilter(agedThin, cfg)).toEqual({ action: "keep", taskPath: true });
  });
});
