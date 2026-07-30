// Omi channel M2 — heartbeat triage acceptance (build spec):
// golden test on a fixture batch produces the expected cards; re-running
// creates zero duplicates; an EMPTY-INBOX TICK IS ASSERTED TO MAKE ZERO MODEL
// CALLS (I3, at most one call per non-empty tick); memories carry provenance;
// rule filters run before any model; overflow carries to the next tick.

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/omi-channel/lib/config.mjs";
import { OmiStore, Counters } from "../fittings/seed/omi-channel/lib/store.mjs";
import { Ingress } from "../fittings/seed/omi-channel/lib/ingress.mjs";
import {
  buildTriagePrompt,
  parseTriageReply,
  ruleFilter,
  runTriageTick
} from "../fittings/seed/omi-channel/lib/triage.mjs";
import { MemoryWriter, redactSecrets } from "../fittings/seed/omi-channel/lib/memory-writer.mjs";

const FIXTURES = path.resolve(__dirname, "..", "fittings", "seed", "omi-channel", "fixtures");
const UID = "omi_test_user_1";

type FakeBoard = {
  created: Array<Record<string, unknown>>;
  healthCalls: number;
  reachable: () => Promise<boolean>;
  findByOriginId: (id: string) => Promise<Array<Record<string, unknown>>>;
  createCard: (p: Record<string, unknown>) => Promise<Record<string, unknown>>;
  listProjects: () => Promise<string[]>;
};

function makeBoard(projects: string[] = ["garrison"]): FakeBoard {
  const board: FakeBoard = {
    created: [],
    healthCalls: 0,
    reachable: async () => {
      board.healthCalls++;
      return true;
    },
    findByOriginId: async (id) => board.created.filter((c) => c.origin_id === id),
    createCard: async (p) => {
      board.created.push(p);
      return { id: `card-${board.created.length}`, ...p };
    },
    listProjects: async () => projects
  };
  return board;
}

function makeRunFn(reply: () => string) {
  const calls: string[] = [];
  const runFn = async ({ prompt }: { prompt: string }) => {
    calls.push(prompt);
    return { reply: reply() };
  };
  return { runFn, calls };
}

// Seed the store by pushing fixtures through the real M1 normalization path.
function seedStore(home: string, fixtureNames: string[]) {
  const store = new OmiStore(path.join(home, "omi"));
  const counters = new Counters(store.root, "server");
  const cfg = loadConfig({ GARRISON_HOME: home });
  const ingress = new Ingress({
    cfg: { ...cfg, enabled: true, secrets: { ...cfg.secrets, webhookSecret: "s" } },
    store,
    counters
  });
  for (const name of fixtureNames) {
    const bodyText = readFileSync(path.join(FIXTURES, name), "utf8");
    ingress.processEntry({
      kind: name.startsWith("day-summary") ? "day_summary" : "conversation",
      uid: UID,
      bodyText,
      receivedAt: "2026-07-30T08:00:00.000Z"
    });
  }
  return store;
}

function triageCfg(home: string, overrides: Record<string, unknown> = {}) {
  const cfg = loadConfig({ GARRISON_HOME: home });
  return {
    ...cfg,
    triageEnabled: true,
    tipsEnabled: true,
    gatewayUrl: "http://gateway.test",
    ...overrides
  };
}

describe("omi-channel triage", () => {
  it("golden: a fixture batch produces the expected cards, memories, tips", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-triage-"));
    try {
      const store = seedStore(home, [
        "conversation-basic.json",
        "conversation-discarded.json",
        "conversation-pt-no-actions.json",
        "conversation-mixed-lang.json",
        "day-summary.json"
      ]);
      const counters = new Counters(store.root, "triage");
      const board = makeBoard(["garrison", "ekoa-code"]);
      const vaultDir = path.join(home, "vault");
      const memoryWriter = new MemoryWriter({ dir: vaultDir });

      const pending = store.listEvents("pending");
      const byConv = new Map(pending.map((e) => [e.provenance.omi_conversation_id ?? "", e.id]));
      const basicId = byConv.get("conv_omi_0001")!;
      const ptId = byConv.get("conv_omi_0003")!;
      const mixedId = byConv.get("conv_omi_0004")!;

      const { runFn, calls } = makeRunFn(() =>
        JSON.stringify({
          cards: [
            {
              event_id: basicId,
              action_index: 1,
              title: "Email the beta list",
              description: "Send the launch email to the beta list before Friday.",
              project: "garrison"
            },
            {
              event_id: mixedId,
              action_index: 0,
              title: "Marcar a revisao do carro",
              description: "Marcar a revisao do carro para a proxima semana.",
              project: "made-up-project"
            },
            {
              event_id: ptId,
              action_index: 0,
              title: "Should be suppressed",
              description: "This event has no open action items."
            }
          ],
          memories: [
            {
              event_id: ptId,
              title: "Training is back on track",
              content: "Knee pain is gone; 40-minute steady runs are comfortable again.",
              tags: ["health"]
            }
          ],
          tips: [{ event_id: basicId, text: "Beta invites convert best on Tuesday mornings." }]
        })
      );

      const summary = await runTriageTick({
        cfg: triageCfg(home),
        store,
        counters,
        runFn,
        board,
        memoryWriter
      });

      // One batched model call for the whole tick (I3).
      expect(calls).toHaveLength(1);
      expect(summary.modelCalls).toBe(1);

      // The discarded conversation was dropped by RULE - before the model saw
      // anything; the prompt must not contain it.
      expect(summary.dropped).toBe(1);
      expect(calls[0]).not.toContain("Short hallway noise");
      expect(store.getEvent(byConv.get("conv_omi_0002")!)?.status).toBe("dropped");

      // Cards: valid project kept, unknown project nulled, no-action event
      // suppressed (task path skipped, memory path still ran).
      expect(summary.cardsCreated).toBe(2);
      expect(summary.cardsSuppressed).toBe(1);
      const emailCard = board.created.find((c) => c.origin_id === "omi:conv_omi_0001:1");
      expect(emailCard).toBeTruthy();
      expect(emailCard!.origin).toBe("omi");
      expect(emailCard!.project).toBe("garrison");
      expect(String(emailCard!.description)).toContain('Source (Omi): "Email the beta list before Friday"');
      expect(String(emailCard!.description)).toContain("Provenance: omi conversation conv_omi_0001");
      const carCard = board.created.find((c) => c.origin_id === "omi:conv_omi_0004:0");
      expect(carCard).toBeTruthy();
      expect(carCard!.project).toBeUndefined();

      // Memory written with provenance bullets.
      expect(summary.memoriesWritten).toBe(1);
      const notes = readdirSync(path.join(vaultDir));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/^omi-/);
      const note = readFileSync(path.join(vaultDir, notes[0]), "utf8");
      expect(note).toContain("title: Training is back on track");
      expect(note).toContain("tags: [omi, health, personal]");
      expect(note).toContain("- **omi conversation**: conv_omi_0003");
      expect(note).toContain(`- **capture event**: ${ptId}`);

      // Tip queued (delivery is M3).
      expect(summary.tipsQueued).toBe(1);
      expect(readdirSync(path.join(store.root, "tips-queue"))).toHaveLength(1);

      // Batch marked triaged with a durable result ref.
      expect(store.listEvents("pending")).toHaveLength(0);
      const triaged = store.listEvents("triaged");
      expect(triaged).toHaveLength(4);
      const ref = triaged[0].triage_result_ref!;
      expect(existsSync(path.join(store.root, ref))).toBe(true);

      // Re-run after resetting events to pending: origin_id dedupe means ZERO
      // new cards even though the model proposes the same candidates again.
      for (const ev of triaged) store.updateEvent(ev.id, (e) => ({ ...e, status: "pending" }));
      const summary2 = await runTriageTick({
        cfg: triageCfg(home),
        store,
        counters,
        runFn,
        board,
        memoryWriter
      });
      expect(summary2.cardsCreated).toBe(0);
      expect(summary2.cardsDeduped).toBe(2);
      expect(board.created).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an empty-inbox tick makes ZERO model calls and contacts nothing (I3)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-triage-empty-"));
    try {
      const store = new OmiStore(path.join(home, "omi"));
      const counters = new Counters(store.root, "triage");
      const board = makeBoard();
      const { runFn, calls } = makeRunFn(() => "{}");
      const summary = await runTriageTick({
        cfg: triageCfg(home),
        store,
        counters,
        runFn,
        board,
        memoryWriter: new MemoryWriter({ dir: path.join(home, "vault") })
      });
      expect(summary.modelCalls).toBe(0);
      expect(summary.skipped).toBe("empty inbox");
      expect(calls).toHaveLength(0);
      expect(board.healthCalls).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a tick with only rule-dropped events makes zero model calls", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-triage-rules-"));
    try {
      const store = seedStore(home, ["conversation-discarded.json"]);
      const counters = new Counters(store.root, "triage");
      const { runFn, calls } = makeRunFn(() => "{}");
      const summary = await runTriageTick({
        cfg: triageCfg(home),
        store,
        counters,
        runFn,
        board: makeBoard(),
        memoryWriter: new MemoryWriter({ dir: path.join(home, "vault") })
      });
      expect(summary.modelCalls).toBe(0);
      expect(summary.dropped).toBe(1);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("caps the batch and carries overflow to the next tick", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-triage-cap-"));
    try {
      const store = seedStore(home, [
        "conversation-basic.json",
        "conversation-pt-no-actions.json",
        "conversation-mixed-lang.json"
      ]);
      const counters = new Counters(store.root, "triage");
      const { runFn, calls } = makeRunFn(() => JSON.stringify({ cards: [], memories: [], tips: [] }));
      const summary = await runTriageTick({
        cfg: triageCfg(home, { triageBatchCap: 2 }),
        store,
        counters,
        runFn,
        board: makeBoard(),
        memoryWriter: new MemoryWriter({ dir: path.join(home, "vault") })
      });
      expect(calls).toHaveLength(1);
      expect(summary.triaged).toBe(2);
      expect(summary.overflow).toBe(1);
      expect(store.listEvents("pending")).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a transport error leaves events pending (retry next tick, no attempts burned)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-triage-transport-"));
    try {
      const store = seedStore(home, ["conversation-basic.json"]);
      const counters = new Counters(store.root, "triage");
      const runFn = async () => {
        const err = new Error("gateway restarting") as Error & { transport: boolean };
        err.transport = true;
        throw err;
      };
      const summary = await runTriageTick({
        cfg: triageCfg(home),
        store,
        counters,
        runFn,
        board: makeBoard(),
        memoryWriter: new MemoryWriter({ dir: path.join(home, "vault") })
      });
      expect(summary.error).toBe("transport");
      const pending = store.listEvents("pending");
      expect(pending).toHaveLength(1);
      expect(pending[0].triage_attempts).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("an unparseable reply consumes attempts and eventually parks the batch as failed", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-triage-parse-"));
    try {
      const store = seedStore(home, ["conversation-basic.json"]);
      const counters = new Counters(store.root, "triage");
      const { runFn } = makeRunFn(() => "sorry, no json here");
      for (let i = 0; i < 5; i++) {
        await runTriageTick({
          cfg: triageCfg(home),
          store,
          counters,
          runFn,
          board: makeBoard(),
          memoryWriter: new MemoryWriter({ dir: path.join(home, "vault") })
        });
      }
      expect(store.listEvents("pending")).toHaveLength(0);
      const failed = store.listEvents("failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].triage_attempts).toBe(5);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("enforces the per-day tips cap", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-triage-tips-"));
    try {
      const store = seedStore(home, ["conversation-basic.json", "conversation-mixed-lang.json"]);
      const counters = new Counters(store.root, "triage");
      const pending = store.listEvents("pending");
      const { runFn } = makeRunFn(() =>
        JSON.stringify({
          cards: [],
          memories: [],
          tips: pending.map((e) => ({ event_id: e.id, text: `tip for ${e.id}` }))
        })
      );
      const summary = await runTriageTick({
        cfg: triageCfg(home, { tipsMaxPerDay: 1 }),
        store,
        counters,
        runFn,
        board: makeBoard(),
        memoryWriter: new MemoryWriter({ dir: path.join(home, "vault") })
      });
      expect(summary.tipsQueued).toBe(1);
      expect(summary.tipsCapped).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("omi-channel triage units", () => {
  it("ruleFilter applies scope filters without any model", () => {
    const cfg = {
      dropDiscarded: true,
      blockedFolders: ["Private"],
      allowedCategories: ["work"]
    };
    const base = {
      kind: "conversation",
      normalized: {
        discarded: false,
        folder: null,
        category: "work",
        action_items: [{ description: "x", completed: false }]
      }
    };
    expect(ruleFilter(base, cfg)).toEqual({ action: "keep", taskPath: true });
    expect(ruleFilter({ ...base, normalized: { ...base.normalized, discarded: true } }, cfg).action).toBe("drop");
    expect(ruleFilter({ ...base, normalized: { ...base.normalized, folder: "Private" } }, cfg).action).toBe("drop");
    expect(ruleFilter({ ...base, normalized: { ...base.normalized, category: "personal" } }, cfg).action).toBe("drop");
    expect(
      ruleFilter(
        { ...base, normalized: { ...base.normalized, action_items: [{ description: "x", completed: true }] } },
        cfg
      )
    ).toEqual({ action: "keep", taskPath: false });
  });

  it("parseTriageReply tolerates fences and prose, rejects garbage", () => {
    expect(parseTriageReply('```json\n{"cards":[],"memories":[],"tips":[]}\n```')).toEqual({
      cards: [],
      memories: [],
      tips: []
    });
    expect(parseTriageReply('Here you go: {"cards":[{"event_id":"E"}]} hope that helps')).toMatchObject({
      cards: [{ event_id: "E" }]
    });
    expect(parseTriageReply("nope")).toBeNull();
    expect(parseTriageReply("")).toBeNull();
  });

  it("buildTriagePrompt marks task-ineligible events and caps transcripts", () => {
    const longTranscript = "You: hello\n".repeat(500);
    const prompt = buildTriagePrompt({
      batch: [
        {
          taskPath: false,
          event: {
            id: "E1",
            kind: "conversation",
            occurred_at: "2026-07-29T10:00:00Z",
            normalized: {
              title: "T",
              overview: "O",
              category: "personal",
              folder: null,
              action_items: [],
              decisions: [],
              questions: [],
              insights: [],
              transcript_text: longTranscript
            }
          }
        }
      ],
      projects: ["garrison"]
    });
    expect(prompt).toContain("task-eligible: no");
    expect(prompt).toContain("[garrison]");
    expect(prompt.length).toBeLessThan(longTranscript.length);
  });

  it("redactSecrets strips key-shaped strings", () => {
    expect(redactSecrets("key sk-abc123def456ghi and token xoxb-1234-abcdefgh")).not.toContain("sk-abc123");
    expect(redactSecrets("omi_dev_supersecretvalue1")).toContain("[REDACTED]");
  });
});
