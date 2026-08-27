// Spoken card commands + spoken scheduling on the wake bus (2026-08-01).
// A scheduled card's due notification tells the wearer exactly:
//   Tell Zeca: "run card <REF>" to start it, or "snooze card <REF> for 2 hours"
// (REF = last 4 chars of the card ULID, uppercase). This suite covers the
// reply half: the classifier's card_command intent (resolve via GET
// /cards/resolve, then POST /start or /snooze - ambiguity is read back, never
// guessed among) and the create_task spoken schedule (scheduled_for /
// schedule_action -> createCard scheduledFor / scheduleAction).
//
// Deterministic surface only, per the wake testing convention: the model reply
// is faked JSON and the board is a stub - what is under test is the handling
// of the classifier's output, still one model call per wake hit (I3).

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/omi-channel/lib/config.mjs";
import { OmiStore, Counters } from "../fittings/seed/omi-channel/lib/store.mjs";
import { WakeBus, parseWakeReply } from "../fittings/seed/omi-channel/lib/wake.mjs";

// A ULID whose last 4 chars are the spoken ref from the notification text.
const CARD_ID = "01K1KJ0Z9GXW5B3T2R8D4F7Q2M";

type ResolveResult = {
  status: number;
  card?: Record<string, unknown>;
  candidates?: Array<Record<string, unknown>>;
  error?: string;
};

function makeDeps(
  home: string,
  reply: () => string,
  resolve?: ResolveResult,
  opts: { now?: () => number } = {}
) {
  const store = new OmiStore(path.join(home, "omi"));
  const counters = new Counters(store.root, "wake");
  const cfg = {
    ...loadConfig({ GARRISON_HOME: home }),
    wakeEnabled: true,
    gatewayUrl: "http://gateway.test",
    wakeCardDedupeMs: 0
  };
  const prompts: string[] = [];
  const board = {
    started: [] as string[],
    snoozed: [] as Array<{ id: string; body: Record<string, unknown> }>,
    created: [] as Array<Record<string, unknown>>,
    listProjects: async () => ["garrison"],
    resolveCard: async () => resolve ?? { status: 404, error: "no card matches" },
    startCard: async (id: string) => {
      board.started.push(id);
      return { id };
    },
    snoozeCard: async (id: string, body: Record<string, unknown>) => {
      board.snoozed.push({ id, body });
      return { id, scheduledFor: body.until ?? null };
    },
    createCard: async (p: Record<string, unknown>) => {
      board.created.push(p);
      return { id: CARD_ID, ...p };
    }
  };
  const notifier = {
    cardUrl: async (id: string | null) => (id ? `https://board.test/#/cards/${id}` : null),
    send: async () => []
  };
  const bus = new WakeBus({
    cfg,
    store,
    counters,
    runFn: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt);
      return { reply: reply() };
    },
    board,
    memoryWriter: { write: () => ({ ok: true }) },
    notifier,
    log: { log: () => {}, error: () => {} },
    ...(opts.now ? { now: opts.now } : {})
  });
  return { bus, board, counters, prompts };
}

describe("card_command: run", () => {
  it("resolves the spoken ref and POSTs /start, confirming with the title and short ref", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-card-run-"));
    try {
      const { bus, board } = makeDeps(
        home,
        () => JSON.stringify({ intent: "card_command", action: "run", card_ref: "7Q2M" }),
        { status: 200, card: { id: CARD_ID, title: "Fix the login flow" } }
      );
      const outcome = await bus.handleCommand({ command: "run card 7Q2M", eventId: "e1" });
      expect(board.started).toEqual([CARD_ID]);
      expect(board.snoozed).toHaveLength(0);
      expect(outcome.confirmation).toBe('Started "Fix the login flow" (card 7Q2M)');
      expect(outcome.cardUrl).toContain(CARD_ID);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("card_command: snooze", () => {
  it("snoozes with minutes and confirms a human until-time", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-card-snooze-"));
    try {
      const { bus, board } = makeDeps(
        home,
        () => JSON.stringify({ intent: "card_command", action: "snooze", card_ref: "7Q2M", minutes: 120 }),
        { status: 200, card: { id: CARD_ID, title: "Fix the login flow" } }
      );
      const outcome = await bus.handleCommand({ command: "snooze card 7Q2M for two hours", eventId: "e1" });
      expect(board.snoozed).toEqual([{ id: CARD_ID, body: { minutes: 120 } }]);
      expect(board.started).toHaveLength(0);
      expect(outcome.confirmation).toContain('Snoozed "Fix the login flow" until ');
      expect(outcome.confirmation).toContain("(card 7Q2M)");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("snoozes with an absolute until, normalized to ISO", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-card-until-"));
    try {
      const { bus, board } = makeDeps(
        home,
        () =>
          JSON.stringify({
            intent: "card_command",
            action: "snooze",
            card_ref: "7Q2M",
            until: "2026-08-02T09:00:00+02:00"
          }),
        { status: 200, card: { id: CARD_ID, title: "Fix the login flow" } }
      );
      const outcome = await bus.handleCommand({ command: "snooze card 7Q2M until tomorrow morning", eventId: "e1" });
      expect(board.snoozed).toEqual([
        { id: CARD_ID, body: { until: new Date("2026-08-02T09:00:00+02:00").toISOString() } }
      ]);
      expect(outcome.confirmation).toContain('Snoozed "Fix the login flow" until ');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to snooze on an unusable time instead of inventing one", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-card-badsnooze-"));
    try {
      const { bus, board } = makeDeps(
        home,
        () =>
          JSON.stringify({ intent: "card_command", action: "snooze", card_ref: "7Q2M", until: "tomorrow morning" }),
        { status: 200, card: { id: CARD_ID, title: "Fix the login flow" } }
      );
      const outcome = await bus.handleCommand({ command: "snooze card 7Q2M until tomorrow morning", eventId: "e1" });
      expect(board.snoozed).toHaveLength(0);
      expect(outcome.confirmation).toContain("couldn't make out the snooze time");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("card_command: resolution outcomes", () => {
  it("404 notifies that nothing matches and does not act", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-card-404-"));
    try {
      const { bus, board } = makeDeps(
        home,
        () => JSON.stringify({ intent: "card_command", action: "run", card_ref: "9ZZZ" })
        // default resolve = 404
      );
      const outcome = await bus.handleCommand({ command: "run card 9ZZZ", eventId: "e1" });
      expect(outcome.confirmation).toBe("No card matches 9ZZZ.");
      expect(board.started).toHaveLength(0);
      expect(board.snoozed).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("409 lists at most 3 candidates with their short refs and never guesses", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-card-409-"));
    try {
      const candidates = [
        { id: "01AAAAAAAAAAAAAAAAAAAAAAA1", title: "One", list: "backlog" },
        { id: "01BBBBBBBBBBBBBBBBBBBBBBB2", title: "Two", list: "scheduled" },
        { id: "01CCCCCCCCCCCCCCCCCCCCCCC3", title: "Three", list: "done" },
        { id: "01DDDDDDDDDDDDDDDDDDDDDDD4", title: "Four", list: "backlog" }
      ];
      const { bus, board, counters } = makeDeps(
        home,
        () => JSON.stringify({ intent: "card_command", action: "run", card_ref: "7Q2" }),
        { status: 409, error: "ambiguous", candidates }
      );
      const outcome = await bus.handleCommand({ command: "run card 7Q2", eventId: "e1" });
      expect(board.started).toHaveLength(0);
      expect(board.snoozed).toHaveLength(0);
      expect(outcome.confirmation).toContain('AAA1 "One" (backlog)');
      expect(outcome.confirmation).toContain('BBB2 "Two" (scheduled)');
      expect(outcome.confirmation).toContain('CCC3 "Three" (done)');
      expect(outcome.confirmation).not.toContain("Four");
      expect(counters.read().wake_card_command_ambiguous).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("create_task spoken schedule", () => {
  it("passes a valid scheduled_for through to createCard and confirms the schedule", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-sched-"));
    try {
      const { bus, board } = makeDeps(home, () =>
        JSON.stringify({
          intent: "create_task",
          title: "Call the bank",
          description: "Call the bank about the mortgage.",
          scheduled_for: "2026-08-02T09:00:00+02:00",
          schedule_action: "notify"
        })
      );
      const outcome = await bus.handleCommand({
        command: "remind me tomorrow at 9 to call the bank",
        eventId: "e1"
      });
      expect(board.created).toHaveLength(1);
      expect(board.created[0].scheduledFor).toBe(new Date("2026-08-02T09:00:00+02:00").toISOString());
      expect(board.created[0].scheduleAction).toBe("notify");
      expect(outcome.confirmation).toContain("Card created: Call the bank");
      expect(outcome.confirmation).toContain("scheduled for ");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('carries schedule_action "run" when the model says the task should run itself', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-sched-run-"));
    try {
      const { bus, board } = makeDeps(home, () =>
        JSON.stringify({
          intent: "create_task",
          title: "Deploy the fix",
          description: "Deploy the fix at six.",
          scheduled_for: "2026-08-01T18:00:00+02:00",
          schedule_action: "run"
        })
      );
      await bus.handleCommand({ command: "run the deploy task at 6pm", eventId: "e1" });
      expect(board.created[0].scheduleAction).toBe("run");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("drops an unparseable model ISO, still creates the card, and says so", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-sched-bad-"));
    try {
      const { bus, board } = makeDeps(home, () =>
        JSON.stringify({
          intent: "create_task",
          title: "Call the bank",
          description: "Call the bank about the mortgage.",
          scheduled_for: "tomorrow at nine",
          schedule_action: "notify"
        })
      );
      const outcome = await bus.handleCommand({
        command: "remind me tomorrow at 9 to call the bank",
        eventId: "e1"
      });
      expect(board.created).toHaveLength(1);
      expect(board.created[0]).not.toHaveProperty("scheduledFor");
      expect(board.created[0]).not.toHaveProperty("scheduleAction");
      expect(outcome.confirmation).toContain("Card created: Call the bank");
      expect(outcome.confirmation).toContain("not scheduled");
      expect(outcome.result.scheduleDropped).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("classifier prompt and reply plumbing", () => {
  it("the prompt carries the current local time and the new intent vocabulary", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-prompt-time-"));
    try {
      const fixed = new Date(2026, 7, 1, 14, 30); // local Saturday 2026-08-01 14:30
      const { bus, prompts } = makeDeps(
        home,
        () => JSON.stringify({ intent: "unknown" }),
        undefined,
        { now: () => fixed.getTime() }
      );
      await bus.handleCommand({ command: "run card 7Q2M", eventId: "e1" });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Current local time: Saturday 2026-08-01T14:30");
      expect(prompts[0]).toContain('"card_command"');
      expect(prompts[0]).toContain("scheduled_for");
      expect(prompts[0]).toContain("card_ref");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("parseWakeReply normalizes the card fields and rejects junk", () => {
    const p = parseWakeReply(
      JSON.stringify({ intent: "card_command", action: "snooze", card_ref: " 7Q2M ", minutes: "120", until: 42 })
    ) as unknown as Record<string, unknown>;
    expect(p.intent).toBe("card_command");
    expect(p.action).toBe("snooze");
    expect(p.card_ref).toBe("7Q2M");
    expect(p.minutes).toBe(120);
    expect(p.until).toBe("");

    const bad = parseWakeReply(
      JSON.stringify({ intent: "card_command", action: "explode", minutes: "soon", schedule_action: "maybe" })
    ) as unknown as Record<string, unknown>;
    expect(bad.action).toBeNull();
    expect(bad.minutes).toBeNull();
    expect(bad.schedule_action).toBe("notify");
  });
});
