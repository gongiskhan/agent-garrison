// The wake bus with the Omi source (D24, 2026-09-02).
//
// omi-channel no longer carries a wake bus: its realtime segments are forwarded
// to capture-service, whose WakeBus runs them with OMI_WAKE_SOURCE - source
// "omi", origin omi:wake:<id>, provenance omi_session_id, the Omi reports
// thread. These are the omi-channel wake cases that capture-service's own suite
// (tests/capture-service-wake.test.ts: companion identity end to end,
// near-misses and duplicates, kill switch, echo suppression) did not already
// cover, run against the one remaining wake.mjs. Omi passes no speak/discuss
// lanes, so the bus behaves as the push-only channel it always was there.

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { CaptureStore, Counters, mergedCounters } from "../fittings/seed/capture-service/lib/store.mjs";
import {
  OMI_WAKE_SOURCE,
  WakeBus,
  buildDelegatePrompt,
  buildWakePrompt,
  parseWakeReply,
  vagueTimeAnchors,
  wakeRegex
} from "../fittings/seed/capture-service/lib/wake.mjs";
import { MemoryWriter } from "../fittings/seed/capture-service/lib/memory-writer.mjs";

const VARIANTS = ["zeca", "zeka", "zecca", "zéca", "ze ca"];

// The declared WakeBus type covers the server-facing surface plus the command
// entry point; these cases also drive the deferred revision pass and the
// per-session timers directly.
type OmiWakeBus = WakeBus & {
  sessions: Map<string, any>;
  runRevision(sessionId: string): Promise<unknown>;
};

function seg(text: string, start = 0, end = 1) {
  return { text, speaker: "SPEAKER_00", speakerId: 0, is_user: true, start, end };
}

// The same shape omi-channel's server used to build: pinned classifier lane
// only, no operativeFn unless a case says so, a push-style notifier.
function makeDeps(home: string, replyFn: () => string, cfgOverrides: Record<string, unknown> = {}) {
  const store = new CaptureStore(path.join(home, "capture"));
  const counters = new Counters(store.root, "wake");
  const cfg = {
    ...loadConfig({ GARRISON_HOME: home }),
    wakeEnabled: true,
    gatewayUrl: "http://gateway.test",
    wakeVariants: VARIANTS,
    wakeSilenceCloseMs: 60,
    wakeSettledCloseMs: 60,
    wakeMaxCaptureMs: 400,
    wakeUnheardEnabled: false,
    ...cfgOverrides
  };
  const runCalls: string[] = [];
  const board = {
    created: [] as Array<Record<string, unknown>>,
    base: () => null as string | null,
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
    source: OMI_WAKE_SOURCE,
    log: { log: () => {}, error: () => {}, warn: () => {} }
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

describe("OMI_WAKE_SOURCE", () => {
  it("is the default source and names the omi identity end to end", () => {
    expect(OMI_WAKE_SOURCE).toEqual({
      id: "omi",
      label: "Omi",
      originPrefix: "omi",
      originChannel: { channel: "omi", threadId: "omi-reports" },
      sessionProvenanceKey: "omi_session_id",
      logPrefix: "omi-channel"
    });
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-src-default-"));
    try {
      const store = new CaptureStore(path.join(home, "capture"));
      const bus = new WakeBus({
        cfg: { ...loadConfig({ GARRISON_HOME: home }), wakeVariants: VARIANTS },
        store,
        counters: new Counters(store.root, "t"),
        runFn: null,
        board: {},
        memoryWriter: {},
        notifier: {}
      });
      expect((bus as any).source).toEqual(OMI_WAKE_SOURCE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("wake token match", () => {
  const re = wakeRegex(VARIANTS)!;

  it("matches the configured spellings on word boundaries, case-insensitively", () => {
    for (const hit of ["zeca", "Zeca,", "ZECA?", "ok Zeka do it", "zecca:", "zéca faz isso", "Hey Zeca"]) {
      expect(re.test(hit), hit).toBe(true);
    }
  });

  // Deepgram breaks a two-syllable name across a separator often enough that the
  // split form is a shipped variant; a space in a variant matches a hyphen too.
  it("tolerates the transcriber splitting the name", () => {
    for (const hit of ["Ze ca, cria uma tarefa", "ze-ca do it", "Ze  Ca?"]) {
      expect(re.test(hit), hit).toBe(true);
    }
  });

  it("never matches near-misses or the name inside a longer word", () => {
    for (const miss of [
      "garrison",
      "the garrison deploy",
      "zecar",
      "azeca",
      "zecas",
      "rebeca",
      "biblioteca",
      // Near-homophones that are ordinary words are deliberately NOT variants:
      // an always-on mic would wake on them constantly.
      "a roupa está seca",
      "joguei na sega"
    ]) {
      expect(re.test(miss), miss).toBe(false);
    }
  });

  it("does not match the retired name", () => {
    for (const miss of ["gary", "Gary,", "Hey Gary", "ok Garry do it", "géri faz isso"]) {
      expect(re.test(miss), miss).toBe(false);
    }
  });
});

// Position is deliberately NOT part of the gate: the operator's call is that the
// name essentially never occurs in ambient speech here, so a mid-sentence hit is
// a real command far more often than it is a false wake.
describe("wake fires on the token anywhere in the segment", () => {
  const re = wakeRegex(VARIANTS)!;

  it("fires when the name opens the utterance", () => {
    for (const hit of ["Zeca, cria uma tarefa", "zeca create a task", "Zeca? Lembra-me de ligar ao banco"]) {
      expect(re.test(hit), hit).toBe(true);
    }
  });

  it("fires after a vocative lead-in, in either language", () => {
    for (const hit of ["Ó Zeca, marca a reunião", "olha Zeca faz isso", "hey Zeca do that", "ok zeka lembra isto"]) {
      expect(re.test(hit), hit).toBe(true);
    }
  });

  it("fires on the name mid-sentence and in object position", () => {
    for (const hit of [
      "depois manda ao Zeca a factura",
      "I told Zeca about the deploy",
      "acho que o Zeca tratou disso ontem",
      "manda ao zeca"
    ]) {
      expect(re.test(hit), hit).toBe(true);
    }
  });
});

describe("wake bus sessions with the omi source", () => {
  it("captures a command across segments, dispatches after silence, creates the card with omi identity, confirms with the deep link, and emits the latency metric", async () => {
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
      bus.handleSegments({ sessionId: "s1", segments: [seg("Zeca, create a test task", 10, 12)] });
      bus.handleSegments({ sessionId: "s1", segments: [seg("called hello garrison", 12.5, 14)] });

      await waitFor(() => sent.length === 1);
      expect(board.created).toHaveLength(1);
      expect(board.created[0].origin).toBe("omi");
      expect(String(board.created[0].origin_id)).toMatch(/^omi:wake:/);
      expect(board.created[0].originChannel).toEqual({ channel: "omi", threadId: "omi-reports" });
      expect(String(board.created[0].description)).toContain(
        'Source (Omi wake command): "create a test task called hello garrison"'
      );
      expect(sent[0].template).toBe("wake_confirmation");
      expect(String(sent[0].params.text)).toContain("Card created");
      expect(String(sent[0].params.cardUrl)).toContain("/#/cards/");

      // Only the assembled command persists (I5): one wake_command event whose
      // title is the command, stamped with the omi provenance key.
      const events = store.listEvents();
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("wake_command");
      expect(events[0].source).toBe("omi");
      expect((events[0].normalized as { title: string }).title).toBe("create a test task called hello garrison");
      expect(events[0].provenance).toEqual({ omi_session_id: "s1" });

      const c = counters.read();
      expect(c.wake_hits).toBe(1);
      expect(c.wake_hit_to_notification_ms_count).toBe(1);
      expect(c.wake_hit_to_notification_ms_last).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The behavioural counterpart of the regex tests above, through the real bus:
  // a mid-sentence mention is a WAKE and gets captured like any other command.
  it("a mid-sentence hit opens a capture window like any other", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-mid-"));
    try {
      const { bus, counters, sent } = makeDeps(home, () =>
        JSON.stringify({ intent: "note", title: "factura", note_content: "Send the invoice." })
      );
      bus.handleSegments({ sessionId: "s-mid", segments: [seg("depois manda ao Zeca a factura da oficina", 0, 2)] });
      await waitFor(() => sent.length === 1);
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
        { wakeSilenceCloseMs: 10_000, wakeSettledCloseMs: 10_000, wakeMaxCaptureMs: 120 }
      );
      bus.handleSegments({ sessionId: "s4", segments: [seg("zeca note this down", 0, 1)] });
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

  it("query intent pushes the answer; note intent writes a memory with omi provenance; unknown saves a note and says so", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-intents-"));
    try {
      const replies = [
        JSON.stringify({ intent: "query", answer: "You have 3 open cards; the beta email is due Friday." }),
        JSON.stringify({ intent: "note", title: "Prefers PT emails", note_content: "User prefers Portuguese for email drafts." }),
        JSON.stringify({ intent: "unknown" })
      ];
      const { bus, sent } = makeDeps(home, () => replies.shift() ?? "{}");

      bus.handleSegments({ sessionId: "q1", segments: [seg("zeca how is the board looking", 0, 1)] });
      await waitFor(() => sent.length === 1);
      expect(String(sent[0].params.text)).toContain("3 open cards");

      bus.handleSegments({ sessionId: "q2", segments: [seg("zeca remember I prefer portuguese emails", 0, 1)] });
      await waitFor(() => sent.length === 2);
      expect(String(sent[1].params.text)).toContain("Noted");
      const vault = path.join(home, "vault");
      expect(readdirSync(vault)).toHaveLength(1);
      const note = readFileSync(path.join(vault, readdirSync(vault)[0]), "utf8");
      expect(note).toContain("- **source**: omi wake command");

      // A command with no language evidence falls back to the configured
      // default (pt here, from loadConfig); either catalog entry is the same
      // honest sentence.
      bus.handleSegments({ sessionId: "q3", segments: [seg("zeca blorp fizzle", 0, 1)] });
      await waitFor(() => sent.length === 3);
      expect(String(sent[2].params.text)).toMatch(/saved it as a note|guardei como nota/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Regression (2026-08-22, live pendant session): two wake hits assembled an
  // EMPTY command, dispatched anyway because pre-wake context existed, came back
  // "unknown", and were each written into the vault as a zero-content note and
  // announced as "I saved it as a note" - which was false. A context-only
  // capture still dispatches (the intent is often recoverable from what
  // surrounded a bare "Zeca"); what is gone is turning "recovered nothing" into
  // a note.
  it("discards an empty capture the classifier could not recover, instead of saving an empty note", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-empty-"));
    try {
      const { bus, sent, store, counters } = makeDeps(home, () => JSON.stringify({ intent: "unknown" }));
      bus.handleSegments({ sessionId: "e1", segments: [seg("estava a falar do jantar de ontem", 0, 2)] });
      bus.handleSegments({ sessionId: "e1", segments: [seg("zeca", 3, 4)] });

      await waitFor(() => store.listEvents().length === 1);
      await new Promise((r) => setTimeout(r, 150));

      expect(sent).toHaveLength(0);
      expect(counters.read().wake_unrecoverable_captures).toBe(1);
      expect(counters.read().wake_notes_saved ?? 0).toBe(0);
      expect(existsSync(path.join(home, "vault"))).toBe(false);

      // The forensic trail survives: this record is the ONLY trace a wake hit
      // leaves, and it is what made this diagnosable.
      const results = readdirSync(path.join(store.root, "wake-results"));
      expect(results).toHaveLength(1);
      const record = JSON.parse(readFileSync(path.join(store.root, "wake-results", results[0]), "utf8"));
      expect(record.intent).toBe("discarded");
      expect(record.command).toBe("");
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
        log: { log: () => {}, error: () => {}, warn: () => {} }
      });
      failingBus.handleSegments({ sessionId: "f1", segments: [seg("zeca ship the release notes", 0, 1)] });
      await waitFor(() => deps.sent.length === 1);
      expect(String(deps.sent[0].params.text)).toContain("saved your command as a note");
      expect(readdirSync(path.join(home, "vault"))).toHaveLength(1);
      const events = deps.store.listEvents();
      expect(events).toHaveLength(1);
      const ref = String(events[0].triage_result_ref);
      const result = JSON.parse(readFileSync(path.join(deps.store.root, ref), "utf8"));
      expect(result.intent).toBe("note_fallback");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Regression, 2026-08-13, found by driving the live channel with speak.mjs: a
// spoken "what is on my board?" answered "your board is empty - I checked the
// task list". THERE IS NO KANBAN MCP TOOL - the board is the kanban-loop
// fitting's HTTP API, so an assistant that is not told the address falls back
// to TaskList, its own empty session scratchpad. The address is INTERPOLATED
// rather than baked, since every baked port in this repo has crossed instances.
describe("delegate prompts point at the real board, not the session scratchpad", () => {
  const build = (u: string | null) => buildDelegatePrompt("what is on my board?", { boardUrl: u });

  it("interpolates the resolved board URL rather than baking a port", () => {
    const prompt = build("http://127.0.0.1:9999");
    expect(prompt).toContain("http://127.0.0.1:9999/cards");
    // The committed port family must never appear on its own.
    expect(prompt).not.toMatch(/8089|7089/);
  });

  it("falls back to the status file, never to a guessed port, when the board is down", () => {
    const prompt = build(null);
    expect(prompt).toContain("ui-fittings/kanban-loop.json");
    expect(prompt).not.toMatch(/127\.0\.0\.1:\d+/);
  });

  it("rules out the assistant's own task list by name", () => {
    const prompt = build("http://127.0.0.1:9999");
    expect(prompt).toMatch(/TaskList/);
    expect(prompt).toMatch(/scratchpad/i);
    expect(prompt).toMatch(/no kanban MCP tool/i);
  });

  it("still carries the request itself", () => {
    expect(build("http://x")).toContain("what is on my board?");
  });
});

describe("wake units", () => {
  it("buildWakePrompt carries the command and project vocabulary", () => {
    const prompt = buildWakePrompt("marca a revisao do carro", ["garrison", "ekoa-code"]);
    expect(prompt).toContain("marca a revisao do carro");
    expect(prompt).toContain("[garrison, ekoa-code]");
  });

  // Regression (2026-08-22): "Zeca, vamos comer morangos com limão mais logo"
  // came back as a card with no schedule, or as a note. The anchors are resolved
  // in code precisely so this is testable without a model - the classifier
  // copies a timestamp, it does not compute one.
  describe("vague spoken times", () => {
    // Built from LOCAL components on purpose: every anchor is a local
    // wall-clock rule, so a test pinned to a literal UTC offset would assert
    // Lisbon's answer on a UTC runner and fail there.
    const local = (h: number, m = 0) => new Date(2026, 7, 22, h, m, 0, 0);
    const rowFor = (now: Date, phrase: string) =>
      vagueTimeAnchors(now).find((r) => r.phrases.includes(`"${phrase}"`))!;

    it("resolves 'mais logo' to two hours out and a part of day to its clock time", () => {
      const now = local(16, 24);
      expect(Date.parse(rowFor(now, "mais logo").iso)).toBe(local(18, 24).getTime());
      expect(Date.parse(rowFor(now, "daqui a pouco").iso)).toBe(local(16, 54).getTime());
      expect(Date.parse(rowFor(now, "a noite").iso)).toBe(local(21).getTime());
      expect(Date.parse(rowFor(now, "ao jantar").iso)).toBe(local(20).getTime());
    });

    it("rolls a part of day that already passed to tomorrow", () => {
      const morning = new Date(Date.parse(rowFor(local(16, 24), "de manha").iso));
      expect(morning.getHours()).toBe(9);
      expect(morning.getDate()).toBe(23);
    });

    it("never resolves 'later' into the small hours or into the past", () => {
      expect(Date.parse(rowFor(local(21, 30), "later").iso)).toBe(local(22).getTime());
      expect(Date.parse(rowFor(local(23, 10), "later").iso)).toBe(local(23, 40).getTime());
    });

    it("hands the classifier the resolved anchors and says a vague time still schedules", () => {
      const now = local(16, 24);
      const prompt = buildWakePrompt("vamos comer morangos com limão mais logo", ["garrison"], [], "", now);
      expect(prompt).toContain('"mais logo"');
      expect(prompt).toContain(rowFor(now, "mais logo").iso);
      expect(prompt).toMatch(/VAGUE TIME IS STILL A TIME/);
      expect(prompt).toMatch(/copy the timestamp VERBATIM/);
    });

    it("tells the classifier a spoken plan is a task, not a note", () => {
      const prompt = buildWakePrompt("x", [], [], "", local(16, 24));
      expect(prompt).toMatch(/PLAN or an INTENTION counts/);
      expect(prompt).toMatch(/do NOT demote that to a note/);
      expect(prompt).toMatch(/Anything with an action in it is a create_task/);
    });
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

// Feature (2026-07-31): Omi fragments speech across segments and mis-attributes
// speakers, so the detail a command refers to often sits in a segment BEFORE the
// wake word. The classifier gets a bounded pre-wake context window.
describe("wake pre-wake context window", () => {
  const cfgFor = (home: string, extra: Record<string, unknown> = {}) => ({
    ...loadConfig({ GARRISON_HOME: home }),
    wakeEnabled: true,
    wakeVariants: VARIANTS,
    // Without a gatewayUrl handleCommand short-circuits to the note fallback
    // and the classifier prompt is never built.
    gatewayUrl: "http://127.0.0.1:1",
    wakeSilenceCloseMs: 20,
    wakeMaxCaptureMs: 200,
    wakeUnheardEnabled: false,
    ...extra
  });

  function bus(home: string, extra: Record<string, unknown> = {}, now?: () => number) {
    const cfg = cfgFor(home, extra);
    const store = new CaptureStore(path.join(home, "capture"));
    const counters = new Counters(store.root, "test");
    const prompts: string[] = [];
    const wake = new WakeBus({
      cfg,
      store,
      counters,
      runFn: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        return { reply: JSON.stringify({ intent: "note", note_content: "ok", title: "t" }) };
      },
      board: { base: () => null, listProjects: async () => ["garrison"], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null },
      ...(now ? { now } : {})
    });
    return { wake, prompts, store };
  }

  const ctxSeg = (text: string, start: number, isUser = true) => ({
    text, speaker: "SPEAKER_00", speakerId: 0, is_user: isUser, start, end: start + 1
  });

  it("carries pre-wake segments into the classifier prompt", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-ctx-"));
    const { wake, prompts } = bus(home);
    wake.handleSegments({ sessionId: "s1", segments: [ctxSeg("tomorrow it could rain", 0)] });
    wake.handleSegments({ sessionId: "s1", segments: [ctxSeg("Zeca, create a task saying", 2)] });
    await wake.close("s1", "silence");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("tomorrow it could rain");
    expect(prompts[0]).toContain("create a task saying");
    // Context must be labelled as context, not folded into the command.
    expect(prompts[0]).toMatch(/BEFORE the wake word/);
    rmSync(home, { recursive: true, force: true });
  });

  it("bounds the window by segment count", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-ctx-cap-"));
    const { wake, prompts } = bus(home, { wakeContextSegments: 2 });
    for (let i = 0; i < 5; i++) {
      wake.handleSegments({ sessionId: "s1", segments: [ctxSeg(`filler ${i}`, i)] });
    }
    wake.handleSegments({ sessionId: "s1", segments: [ctxSeg("Zeca do it", 9)] });
    await wake.close("s1", "silence");
    expect(prompts[0]).toContain("filler 4");
    expect(prompts[0]).toContain("filler 3");
    expect(prompts[0]).not.toContain("filler 0");
    rmSync(home, { recursive: true, force: true });
  });

  it("drops context that is too old to be the same conversation", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-ctx-age-"));
    let clock = 1_000_000;
    const { wake, prompts } = bus(home, { wakeContextMaxAgeMs: 5000 }, () => clock);
    wake.handleSegments({ sessionId: "s1", segments: [ctxSeg("stale talk", 0)] });
    clock += 60_000; // a minute later - unrelated conversation
    wake.handleSegments({ sessionId: "s1", segments: [ctxSeg("Zeca do it", 9)] });
    await wake.close("s1", "silence");
    expect(prompts[0]).not.toContain("stale talk");
    rmSync(home, { recursive: true, force: true });
  });

  it("still records nothing when a session never wakes (I5)", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-ctx-i5-"));
    const { wake, store } = bus(home);
    wake.handleSegments({ sessionId: "s1", segments: [ctxSeg("private conversation", 0)] });
    expect(store.listEvents()).toHaveLength(0);
    for (const dir of Object.values(store.dirs)) {
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }
    rmSync(home, { recursive: true, force: true });
  });
});

// Feature (2026-07-31): Omi delivers one spoken sentence across bursts with real
// gaps, so the first quiet moment is not the end of the command - holding the
// window open is what stops the truncation.
describe("wake minimum capture window", () => {
  function bus(home: string, extra: Record<string, unknown>, reply: Record<string, unknown>, now?: () => number) {
    const store = new CaptureStore(path.join(home, "capture"));
    const prompts: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        wakeVariants: VARIANTS,
        gatewayUrl: "http://127.0.0.1:1",
        wakeUnheardEnabled: false,
        ...extra
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        return { reply: JSON.stringify(reply) };
      },
      board: { base: () => null, listProjects: async () => ["garrison"], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null },
      ...(now ? { now } : {})
    });
    return { wake, prompts };
  }

  it("holds the window open through silence, then still respects the cap", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-min-"));
    let clock = 1_000_000;
    const { wake, prompts } = bus(
      home,
      { wakeSilenceCloseMs: 1000, wakeMinCaptureMs: 15000, wakeMaxCaptureMs: 20000 },
      { intent: "create_task", title: "t", description: "d" },
      () => clock
    );

    wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca, create a task saying", 0, 1)] });
    // Silence arrives long before the minimum - must NOT dispatch yet.
    clock += 2000;
    await wake.close("s1", "silence");
    expect(prompts).toHaveLength(0);

    // The rest of the sentence lands during the held-open window.
    wake.handleSegments({ sessionId: "s1", segments: [seg("remind me it could rain tomorrow", 3, 4)] });
    clock += 14000; // past the minimum
    await wake.close("s1", "silence");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("create a task saying");
    expect(prompts[0]).toContain("remind me it could rain tomorrow");
    rmSync(home, { recursive: true, force: true });
  });

  it("max-capture still closes the window regardless of the minimum", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-min-cap-"));
    const { wake, prompts } = bus(
      home,
      { wakeSilenceCloseMs: 1000, wakeMinCaptureMs: 999999, wakeMaxCaptureMs: 20000 },
      { intent: "note", note_content: "n", title: "t" }
    );
    wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca do the thing", 0, 1)] });
    await wake.close("s1", "max-capture");
    expect(prompts).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });
});

// Regression (2026-07-31): a spoken command takes ~25s to become a card, so the
// user repeats it - and the repeat is DIFFERENT transcript text, so no upstream
// dedupe catches it. Observed live: two identical cards 44s apart.
describe("wake duplicate card suppression", () => {
  function bus(home: string, titleFn: () => string) {
    const store = new CaptureStore(path.join(home, "capture"));
    const created: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        wakeVariants: VARIANTS,
        gatewayUrl: "http://127.0.0.1:1",
        wakeCardDedupeMs: 600000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: JSON.stringify({ intent: "create_task", title: titleFn(), description: "d" }) }),
      board: {
        base: () => null,
        listProjects: async () => [],
        createCard: async (c: { title: string }) => {
          created.push(c.title);
          return { id: `c${created.length}`, url: null };
        }
      },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null }
    }) as OmiWakeBus;
    return { wake, created, store };
  }

  it("suppresses a repeat of the same resolved title, despite different wording", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-dupe-"));
    const { wake, created, store } = bus(home, () => "Tomorrow it will be sunny");
    await wake.handleCommand({ command: "Create a task. Vamos, vamos. Saying that tomorrow it will be sunny.", eventId: "e1" });
    await wake.handleCommand({ command: "create a task saying that tomorrow it will be sunny. Porque...", eventId: "e2" });
    expect(created).toEqual(["Tomorrow it will be sunny"]);
    expect(mergedCounters(store.root).wake_duplicate_suppressed).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("treats accents, case and punctuation as the same title", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-dupe-acc-"));
    let title = "Lembrar que amanhã pode chover";
    const { wake, created } = bus(home, () => title);
    await wake.handleCommand({ command: "a", eventId: "e1" });
    title = "lembrar que amanha pode chover!";
    await wake.handleCommand({ command: "b", eventId: "e2" });
    expect(created).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("still creates a genuinely different task", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-dupe-diff-"));
    let title = "Tomorrow it will be sunny";
    const { wake, created } = bus(home, () => title);
    await wake.handleCommand({ command: "a", eventId: "e1" });
    title = "Ir ao Fado";
    await wake.handleCommand({ command: "b", eventId: "e2" });
    expect(created).toEqual(["Tomorrow it will be sunny", "Ir ao Fado"]);
    rmSync(home, { recursive: true, force: true });
  });
});

// Feature (2026-07-31): with a TV on, silence never arrives, so the capture
// window runs for minutes. Only the speech near the wake word counts as the
// COMMAND - the rest is trailing context.
describe("wake command window vs trailing context", () => {
  it("splits speech near the wake word from what the mic caught later", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-window-"));
    let clock = 1_000_000;
    const store = new CaptureStore(path.join(home, "capture"));
    const prompts: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        wakeVariants: VARIANTS,
        gatewayUrl: "http://127.0.0.1:1",
        wakeSilenceCloseMs: 20000,
        wakeMinCaptureMs: 0,
        wakeMaxCaptureMs: 600000,
        wakeCommandWindowMs: 60000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        return { reply: JSON.stringify({ intent: "create_task", title: "t", description: "d" }) };
      },
      board: { base: () => null, listProjects: async () => [], createCard: async () => ({ id: "c", url: null }) },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null },
      now: () => clock
    });

    wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca, create a task to book the car service")] });
    clock += 10_000; // still inside the command window
    wake.handleSegments({ sessionId: "s1", segments: [seg("for next Tuesday morning")] });
    clock += 300_000; // five minutes of television later
    wake.handleSegments({ sessionId: "s1", segments: [seg("and now the weather for the weekend")] });
    await wake.close("s1", "max-capture");

    expect(prompts).toHaveLength(1);
    const p = prompts[0];
    expect(p).toMatch(/Command \(spoken right after the wake word\): "[^"]*book the car service[^"]*next Tuesday morning/);
    expect(p).toContain("CONTINUED afterwards");
    expect(p).toContain("weather for the weekend");
    expect(p).not.toMatch(/Command \(spoken right after the wake word\): "[^"]*weather for the weekend/);
    rmSync(home, { recursive: true, force: true });
  });
});

// Feature (2026-07-31): the card is created fast so it can be SEEN, then a
// single deferred pass reads what was said afterwards and corrects it.
describe("wake revision pass", () => {
  function harness(home: string, revisionReply: string) {
    const store = new CaptureStore(path.join(home, "capture"));
    const revised: Array<{ cardId: string; patch: Record<string, unknown> }> = [];
    let call = 0;
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        wakeVariants: VARIANTS,
        gatewayUrl: "http://127.0.0.1:1",
        wakeReviseAfterMs: 600000,
        wakeReviseMaxSegments: 50,
        wakeCardDedupeMs: 0
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => {
        call += 1;
        return call === 1
          ? { reply: JSON.stringify({ intent: "create_task", title: "Book car service", description: "d" }) }
          : { reply: revisionReply };
      },
      board: {
        base: () => null,
        listProjects: async () => [],
        createCard: async () => ({ id: "card-1", url: null }),
        reviseCard: async (cardId: string, patch: Record<string, unknown>) => {
          revised.push({ cardId, patch });
          return { ok: true, mode: "patched" };
        }
      },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null }
    }) as OmiWakeBus;
    return { wake, revised, store };
  }

  it("applies a spoken correction to the card it just created", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-rev-"));
    const { wake, revised, store } = harness(
      home,
      JSON.stringify({ action: "revise", title: "Book car service Wednesday", description: "d2", note: "Moved to Wednesday" })
    );
    await wake.handleCommand({ command: "create a task to book the car service", eventId: "e1", sessionId: "s1" });
    wake.handleSegments({ sessionId: "s1", segments: [seg("no Zeca, make that Wednesday not Tuesday")] });
    await wake.runRevision("s1");
    expect(revised).toHaveLength(1);
    expect(revised[0].cardId).toBe("card-1");
    expect(revised[0].patch.title).toBe("Book car service Wednesday");
    expect(mergedCounters(store.root).wake_revisions_applied).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("leaves the card alone when the talk afterwards is unrelated", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-rev-none-"));
    const { wake, revised, store } = harness(home, JSON.stringify({ action: "none" }));
    await wake.handleCommand({ command: "create a task to book the car service", eventId: "e1", sessionId: "s1" });
    wake.handleSegments({ sessionId: "s1", segments: [seg("and now the weather for the weekend")] });
    await wake.runRevision("s1");
    expect(revised).toHaveLength(0);
    expect(mergedCounters(store.root).wake_revisions_none).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("never rewrites a card on an unparseable revision reply", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-rev-bad-"));
    const { wake, revised } = harness(home, "the model rambled instead of answering");
    await wake.handleCommand({ command: "c", eventId: "e1", sessionId: "s1" });
    wake.handleSegments({ sessionId: "s1", segments: [seg("something")] });
    await wake.runRevision("s1");
    expect(revised).toHaveLength(0);
    rmSync(home, { recursive: true, force: true });
  });

  it("makes no model call when nothing was said afterwards", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-rev-quiet-"));
    const { wake, store } = harness(home, JSON.stringify({ action: "revise", title: "x" }));
    await wake.handleCommand({ command: "c", eventId: "e1", sessionId: "s1" });
    await wake.runRevision("s1");
    expect(mergedCounters(store.root).wake_revisions_checked ?? 0).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("wake settled close (punctuated end of command)", () => {
  function bus(home: string) {
    const store = new CaptureStore(path.join(home, "capture"));
    return new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        wakeVariants: VARIANTS,
        gatewayUrl: "http://127.0.0.1:1",
        wakeSilenceCloseMs: 15000,
        wakeSettledCloseMs: 5000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: JSON.stringify({ intent: "note", note_content: "n" }) }),
      board: { base: () => null, listProjects: async () => [], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null }
    }) as OmiWakeBus;
  }
  const idleTimeout = (wake: OmiWakeBus, id: string) => String(wake.sessions.get(id).silenceTimer._idleTimeout);

  it("closes on the short settle when the command ends a sentence, and the full window otherwise", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-settle-"));
    const wake = bus(home);
    // A finished sentence must not wait the full 15s window.
    wake.handleSegments({ sessionId: "s-done", segments: [seg("Zeca, cria uma tarefa para comprar peixe.")] });
    // An unfinished one still gets the full window - truncating it is the
    // failure this window exists to prevent.
    wake.handleSegments({ sessionId: "s-open", segments: [seg("Zeca, cria uma tarefa a dizer")] });
    expect([idleTimeout(wake, "s-done"), idleTimeout(wake, "s-open")]).toEqual(["5000", "15000"]);
    for (const id of ["s-done", "s-open"]) clearTimeout(wake.sessions.get(id).silenceTimer);
    rmSync(home, { recursive: true, force: true });
  });

  it("a bare wake word waits the full window even though it ends in punctuation", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-settle-bare-"));
    const wake = bus(home);
    wake.handleSegments({ sessionId: "s-bare", segments: [seg("Zeca?")] });
    expect(idleTimeout(wake, "s-bare")).toBe("15000");
    clearTimeout(wake.sessions.get("s-bare").silenceTimer);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("wake delegation on the omi source", () => {
  function bus(home: string, opts: { delegateEnabled: boolean; operativeFn: (a: unknown) => Promise<{ reply: string }>; reply: Record<string, unknown> }) {
    const store = new CaptureStore(path.join(home, "capture"));
    const notifications: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        wakeVariants: VARIANTS,
        delegateEnabled: opts.delegateEnabled,
        gatewayUrl: "http://127.0.0.1:1",
        wakeSilenceCloseMs: 1000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: JSON.stringify(opts.reply) }),
      operativeFn: opts.operativeFn,
      board: { base: () => null, listProjects: async () => [], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: () => ({ ok: true }) },
      notifier: {
        send: async ({ params }: any) => {
          if (!params.progress) notifications.push(params.text);
          return [];
        },
        cardUrl: async () => null
      }
    });
    return { wake, notifications, store };
  }

  it("acknowledges immediately, then notifies with the delegated answer", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-delegate-"));
    let operativeCalls = 0;
    let releaseOperative: () => void = () => {};
    const release = new Promise<void>((resolve) => {
      releaseOperative = resolve;
    });
    const { wake, notifications, store } = bus(home, {
      delegateEnabled: true,
      reply: { intent: "delegate", request: "Send Ana a message on Slack", ack: "On it - messaging Ana." },
      // Held open so the assertion below is about ORDERING, not about winning a
      // race: a real turn takes tens of seconds, and the ack must be out first.
      operativeFn: async () => {
        operativeCalls++;
        await release;
        return { reply: "Sent it to Ana on Slack." };
      }
    });

    wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca, manda uma mensagem à Ana no Slack.")] });
    await wake.close("s1", "max-capture");
    expect(notifications).toEqual(["On it - messaging Ana."]);

    releaseOperative();
    await wake.delegateChain;
    expect(operativeCalls).toBe(1);
    expect(notifications).toEqual(["On it - messaging Ana.", "Sent it to Ana on Slack."]);

    const written = readdirSync(path.join(store.root, "wake-results")).filter((f) => f.endsWith(".delegate.json"));
    expect(written).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("falls back to a note, in the command's language, when delegation is switched off", async () => {
    const pt = mkdtempSync(path.join(os.tmpdir(), "omi-delegate-off-"));
    const en = mkdtempSync(path.join(os.tmpdir(), "omi-delegate-en-"));
    const make = (home: string) =>
      bus(home, {
        delegateEnabled: false,
        reply: { intent: "delegate", request: "do a thing" },
        operativeFn: async () => ({ reply: "should never run" })
      });
    const a = make(pt);
    a.wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca, faz uma coisa qualquer.")] });
    await a.wake.close("s1", "max-capture");
    expect(a.notifications[0]).toBe("Não consigo falar com o Zeca para isso agora - guardei como nota.");

    const b = make(en);
    b.wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca, please send the invoice to the lawyer.")] });
    await b.wake.close("s1", "max-capture");
    expect(b.notifications[0]).toBe("I can't reach Zeca for that right now - saved it as a note.");
    rmSync(pt, { recursive: true, force: true });
    rmSync(en, { recursive: true, force: true });
  });
});
