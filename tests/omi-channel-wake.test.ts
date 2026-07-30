// Omi channel M4 — wake bus acceptance (build spec): scripted segment streams
// with timing trigger exactly on the configured variants and never on
// near-misses ("garrison", "hungary" must NOT trigger); duplicate segment
// delivery does not double-dispatch; the kill switch is honored mid-session;
// non-hit segments are never persisted (I5); the wake_hit_to_notification_ms
// latency metric is emitted; each intent lands in its home (card via board,
// note via memory, query via notification).

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/omi-channel/lib/config.mjs";
import { OmiStore, Counters } from "../fittings/seed/omi-channel/lib/store.mjs";
import { WakeBus, buildWakePrompt, parseWakeReply, wakeRegex } from "../fittings/seed/omi-channel/lib/wake.mjs";
import { MemoryWriter } from "../fittings/seed/omi-channel/lib/memory-writer.mjs";

const VARIANTS = ["gary", "garry", "gerry", "géri"];

function seg(text: string, start = 0, end = 1) {
  return { text, speaker: "SPEAKER_00", speakerId: 0, is_user: true, start, end };
}

function makeDeps(home: string, replyFn: () => string, cfgOverrides: Record<string, unknown> = {}) {
  const store = new OmiStore(path.join(home, "omi"));
  store.pinUid("omi_test_user_1");
  const counters = new Counters(store.root, "wake");
  const cfg = {
    ...loadConfig({ GARRISON_HOME: home }),
    wakeEnabled: true,
    gatewayUrl: "http://gateway.test",
    wakeSilenceCloseMs: 60,
    wakeMaxCaptureMs: 400,
    ...cfgOverrides
  };
  const runCalls: string[] = [];
  const board = {
    created: [] as Array<Record<string, unknown>>,
    listProjects: async () => ["garrison"],
    createCard: async (p: Record<string, unknown>) => {
      board.created.push(p);
      return { id: `card-${board.created.length}`, ...p };
    }
  };
  const sent: Array<{ template: string; params: Record<string, unknown> }> = [];
  const notifier = {
    cardUrl: async (id: string | null) => (id ? `https://board.test/#/cards/${id}` : null),
    send: async (args: { template: string; params: Record<string, unknown> }) => {
      sent.push(args);
      return [{ means: "omi-push", ok: true }];
    }
  };
  const memoryWriter = new MemoryWriter({ dir: path.join(home, "vault") });
  const bus = new WakeBus({
    cfg,
    store,
    counters,
    runFn: async ({ prompt }: { prompt: string }) => {
      runCalls.push(prompt);
      return { reply: replyFn() };
    },
    board,
    memoryWriter,
    notifier,
    log: { log: () => {}, error: () => {} }
  });
  return { store, counters, cfg, bus, board, notifier, sent, runCalls };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  if (!predicate()) throw new Error("waitFor timed out");
}

describe("wake regex gate", () => {
  const re = wakeRegex(VARIANTS)!;

  it("matches the variants on word boundaries, case-insensitively", () => {
    for (const hit of ["gary", "Gary,", "GARY?", "ok Garry do it", "gerry:", "géri faz isso", "Hey Gary"]) {
      expect(re.test(hit), hit).toBe(true);
    }
  });

  it("never matches near-misses", () => {
    for (const miss of ["garrison", "hungary", "Hungary's", "gario", "sugary", "garyish", "the garrison deploy"]) {
      expect(re.test(miss), miss).toBe(false);
    }
  });
});

describe("wake bus sessions", () => {
  it("captures a command across segments, dispatches after silence, creates the card, confirms with the deep link, and emits the latency metric", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-"));
    try {
      const { bus, store, counters, board, sent } = makeDeps(home, () =>
        JSON.stringify({
          intent: "create_task",
          title: "Create a test task called hello garrison",
          description: "Create the hello garrison test task.",
          project: "garrison"
        })
      );

      // The wake token arrives mid-segment; the command continues in a second
      // segment. "garrison" INSIDE the capture must not re-trigger anything.
      bus.handleSegments({
        sessionId: "s1",
        segments: [seg("Gary, create a test task", 10, 12)]
      });
      bus.handleSegments({
        sessionId: "s1",
        segments: [seg("called hello garrison", 12.5, 14)]
      });

      await waitFor(() => sent.length === 1);
      expect(board.created).toHaveLength(1);
      expect(board.created[0].origin).toBe("omi");
      expect(String(board.created[0].origin_id)).toMatch(/^omi:wake:/);
      expect(String(board.created[0].description)).toContain(
        'Source (Omi wake command): "create a test task called hello garrison"'
      );
      expect(sent[0].template).toBe("wake_confirmation");
      expect(String(sent[0].params.text)).toContain("Card created");
      expect(String(sent[0].params.cardUrl)).toContain("/#/cards/");

      // Only the assembled command persists (I5): one wake_command event whose
      // title is the command; no raw files.
      const events = store.listEvents();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("wake_command");
      expect(events[0].normalized!.title).toBe("create a test task called hello garrison");
      expect(readdirSync(path.join(store.root, "raw"))).toHaveLength(0);

      const c = counters.read();
      expect(c.wake_hits).toBe(1);
      expect(c.wake_hit_to_notification_ms_count).toBe(1);
      expect(c.wake_hit_to_notification_ms_last).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("near-misses and ordinary speech never open a session or persist anything", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-miss-"));
    try {
      const { bus, store, counters, sent } = makeDeps(home, () => "{}");
      bus.handleSegments({
        sessionId: "s2",
        segments: [
          seg("the garrison deploy finished", 0, 2),
          seg("we should visit Hungary next year", 3, 5),
          seg("sugary snacks are the worst", 6, 8)
        ]
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(sent).toHaveLength(0);
      expect(store.listEvents()).toHaveLength(0);
      const c = counters.read();
      expect(c.wake_hits ?? 0).toBe(0);
      expect(c.wake_segments_dropped).toBe(3);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("duplicate segment delivery does not double-dispatch", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-dup-"));
    try {
      const { bus, sent, counters, store } = makeDeps(home, () =>
        JSON.stringify({ intent: "note", title: "Dup test", note_content: "x" })
      );
      const hit = seg("Gary remember the dup test", 20, 22);
      bus.handleSegments({ sessionId: "s3", segments: [hit] });
      // Omi redelivers the same segment in the next call (documented behavior).
      bus.handleSegments({ sessionId: "s3", segments: [hit] });
      await waitFor(() => sent.length >= 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(sent).toHaveLength(1);
      expect(store.listEvents()).toHaveLength(1);
      expect(counters.read().wake_segments_deduped).toBe(1);
      expect(counters.read().wake_hits).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the max-capture cap closes a session that keeps talking", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-cap-"));
    try {
      const { bus, sent } = makeDeps(
        home,
        () => JSON.stringify({ intent: "note", title: "t", note_content: "c" }),
        { wakeSilenceCloseMs: 10_000, wakeMaxCaptureMs: 120 }
      );
      bus.handleSegments({ sessionId: "s4", segments: [seg("gary note this down", 0, 1)] });
      // Keep feeding segments faster than the (huge) silence window; only the
      // hard cap can close the session.
      const feeder = setInterval(() => {
        bus.handleSegments({ sessionId: "s4", segments: [seg(`more words ${Math.random()}`, 2, 3)] });
      }, 30);
      try {
        await waitFor(() => sent.length === 1, 2000);
      } finally {
        clearInterval(feeder);
      }
      expect(sent).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("honors the kill switch mid-session: no dispatch, no persistence", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-kill-"));
    try {
      const { bus, cfg, sent, store, counters } = makeDeps(home, () => "{}");
      bus.handleSegments({ sessionId: "s5", segments: [seg("gary do something", 0, 1)] });
      (cfg as { wakeEnabled: boolean }).wakeEnabled = false; // flag flipped between hit and close
      await new Promise((r) => setTimeout(r, 250));
      expect(sent).toHaveLength(0);
      expect(store.listEvents()).toHaveLength(0);
      expect(counters.read().wake_killed_mid_session).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("query intent pushes the answer; note intent writes a memory; unknown saves a note and says so", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-intents-"));
    try {
      const replies = [
        JSON.stringify({ intent: "query", answer: "You have 3 open cards; the beta email is due Friday." }),
        JSON.stringify({ intent: "note", title: "Prefers PT emails", note_content: "User prefers Portuguese for email drafts." }),
        JSON.stringify({ intent: "unknown" })
      ];
      const { bus, sent } = makeDeps(home, () => replies.shift() ?? "{}");

      bus.handleSegments({ sessionId: "q1", segments: [seg("gary how is the board looking", 0, 1)] });
      await waitFor(() => sent.length === 1);
      expect(String(sent[0].params.text)).toContain("3 open cards");

      bus.handleSegments({ sessionId: "q2", segments: [seg("gary remember I prefer portuguese emails", 0, 1)] });
      await waitFor(() => sent.length === 2);
      expect(String(sent[1].params.text)).toContain("Noted");
      const vault = path.join(home, "vault");
      expect(readdirSync(vault).some((f) => f.startsWith("omi-"))).toBe(true);
      const note = readFileSync(path.join(vault, readdirSync(vault)[0]), "utf8");
      expect(note).toContain("- **source**: omi wake command");

      bus.handleSegments({ sessionId: "q3", segments: [seg("gary blorp fizzle", 0, 1)] });
      await waitFor(() => sent.length === 3);
      expect(String(sent[2].params.text)).toContain("saved it as a note");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("degrades to a saved note with an honest confirmation when the gateway call fails", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-degrade-"));
    try {
      const deps = makeDeps(home, () => "irrelevant");
      const failingBus = new WakeBus({
        cfg: deps.cfg,
        store: deps.store,
        counters: deps.counters,
        runFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        board: deps.board,
        memoryWriter: new MemoryWriter({ dir: path.join(home, "vault") }),
        notifier: deps.notifier,
        log: { log: () => {}, error: () => {} }
      });
      failingBus.handleSegments({ sessionId: "f1", segments: [seg("gary ship the release notes", 0, 1)] });
      await waitFor(() => deps.sent.length === 1);
      expect(String(deps.sent[0].params.text)).toContain("saved your command as a note");
      expect(readdirSync(path.join(home, "vault"))).toHaveLength(1);
      const events = deps.store.listEvents();
      expect(events).toHaveLength(1);
      const ref = events[0].triage_result_ref!;
      const result = JSON.parse(readFileSync(path.join(deps.store.root, ref), "utf8"));
      expect(result.intent).toBe("note_fallback");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("wake units", () => {
  it("buildWakePrompt carries the command and project vocabulary", () => {
    const prompt = buildWakePrompt("marca a revisao do carro", ["garrison", "ekoa-code"]);
    expect(prompt).toContain('Command: "marca a revisao do carro"');
    expect(prompt).toContain("[garrison, ekoa-code]");
  });

  it("parseWakeReply normalizes intents and tolerates fences", () => {
    expect(parseWakeReply('```json\n{"intent":"query","answer":"42"}\n```')).toMatchObject({
      intent: "query",
      answer: "42"
    });
    expect(parseWakeReply('{"intent":"weird"}')).toMatchObject({ intent: "unknown" });
    expect(parseWakeReply("nope")).toBeNull();
  });
});
