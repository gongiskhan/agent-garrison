// Omi channel M4 — wake bus acceptance (build spec): scripted segment streams
// with timing trigger exactly on the configured variants and never on
// near-misses ("garrison", "seca", "biblioteca" must NOT trigger) but DO trigger
// on the name anywhere in a segment, mid-sentence included; duplicate segment
// delivery does not double-dispatch; the kill switch is honored mid-session;
// non-hit segments are never persisted (I5); the wake_hit_to_notification_ms
// latency metric is emitted; each intent lands in its home (card via board,
// note via memory, query via notification).

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/omi-channel/lib/config.mjs";
import { OmiStore, Counters, mergedCounters } from "../fittings/seed/omi-channel/lib/store.mjs";
import { Ingress } from "../fittings/seed/omi-channel/lib/ingress.mjs";
import {
  WakeBus,
  buildWakePrompt,
  buildDelegatePrompt,
  parseWakeReply,
  wakeRegex
} from "../fittings/seed/omi-channel/lib/wake.mjs";
import { buildAskDelegatePrompt } from "../fittings/seed/omi-channel/lib/chat.mjs";
import { MemoryWriter } from "../fittings/seed/omi-channel/lib/memory-writer.mjs";

const VARIANTS = ["zeca", "zeka", "zecca", "zéca", "ze ca"];

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
// a real command far more often than it is a false wake. These pin that the
// anywhere-match is intended behaviour and not an oversight to be "fixed" later.
describe("wake fires on the token anywhere in the segment", () => {
  const re = wakeRegex(VARIANTS)!;

  it("fires when the name opens the utterance", () => {
    for (const hit of [
      "Zeca, create a test task called hello garrison",
      "Zeca do it",
      "Zeca?",
      "zeca cria uma tarefa para comprar peixe"
    ]) {
      expect(re.test(hit), hit).toBe(true);
    }
  });

  it("fires after a vocative lead-in, in either language", () => {
    for (const hit of [
      "Hey Zeca, what is on my board?",
      "ok Zeca do it",
      "no Zeca, make that Wednesday not Tuesday",
      "não Zeca, quarta-feira",
      "então Zeca, marca a revisão do carro",
      "ó Zeca!"
    ]) {
      expect(re.test(hit), hit).toBe(true);
    }
  });

  // The cases an address-position rule would reject. They MUST wake: an
  // address-only gate was built, tested live, and removed because the missed
  // wakes were the real cost and the false wakes were theoretical.
  it("fires on the name mid-sentence and in object position", () => {
    for (const hit of [
      "manda ao Zeca a factura da oficina",
      "depois pergunta ao Zeca sobre isso",
      "o Zeca que trate disto",
      "I'll ask Zeca about the invoice tomorrow",
      "yesterday Zeca called me about it"
    ]) {
      expect(re.test(hit), hit).toBe(true);
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
        segments: [seg("Zeca, create a test task", 10, 12)]
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

  it("near-misses and homophones never open a session or persist anything", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-miss-"));
    try {
      const { bus, store, counters, sent } = makeDeps(home, () => "{}");
      bus.handleSegments({
        sessionId: "s2",
        segments: [
          seg("the garrison deploy finished", 0, 2),
          // Ordinary words that carry the name's sound or its letters. These are
          // the ONLY class of non-hit now that position is not part of the gate,
          // which is exactly why the variant list excludes "seca" and "sega".
          seg("a roupa ainda está seca", 3, 5),
          seg("fui à biblioteca com a Rebeca", 6, 8)
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

  // The behavioural counterpart of the regex tests above, through the real bus:
  // a mid-sentence mention is a WAKE and gets captured like any other command.
  it("a mid-sentence hit opens a capture window like any other", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-mid-"));
    try {
      const { bus, counters, sent } = makeDeps(home, () =>
        JSON.stringify({ intent: "note", title: "factura", note_content: "Send the invoice." })
      );
      bus.handleSegments({
        sessionId: "s-mid",
        segments: [seg("depois manda ao Zeca a factura da oficina", 0, 2)]
      });
      await waitFor(() => sent.length === 1);
      expect(counters.read().wake_hits).toBe(1);
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
      const hit = seg("Zeca remember the dup test", 20, 22);
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

  it("honors the kill switch mid-session: no dispatch, no persistence", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-wake-kill-"));
    try {
      const { bus, cfg, sent, store, counters } = makeDeps(home, () => "{}");
      bus.handleSegments({ sessionId: "s5", segments: [seg("zeca do something", 0, 1)] });
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

      bus.handleSegments({ sessionId: "q1", segments: [seg("zeca how is the board looking", 0, 1)] });
      await waitFor(() => sent.length === 1);
      expect(String(sent[0].params.text)).toContain("3 open cards");

      bus.handleSegments({ sessionId: "q2", segments: [seg("zeca remember I prefer portuguese emails", 0, 1)] });
      await waitFor(() => sent.length === 2);
      expect(String(sent[1].params.text)).toContain("Noted");
      const vault = path.join(home, "vault");
      expect(readdirSync(vault).some((f) => f.startsWith("omi-"))).toBe(true);
      const note = readFileSync(path.join(vault, readdirSync(vault)[0]), "utf8");
      expect(note).toContain("- **source**: omi wake command");

      bus.handleSegments({ sessionId: "q3", segments: [seg("zeca blorp fizzle", 0, 1)] });
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
      failingBus.handleSegments({ sessionId: "f1", segments: [seg("zeca ship the release notes", 0, 1)] });
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

// Regression, 2026-08-13. The wake lane's delegate prompt said only "using your
// tools and connected services" while the chat lane's named the Kanban board.
// Same operative, same operativeFn object, same minute: spoken "what is on my
// board?" answered "your board is empty - I checked the task list" (its own
// in-session to-do list, which really was empty) while the chat lane correctly
// reported 10 To Do / 41 Backlog. Nothing downstream can catch that - the answer
// is confident, well-formed and wrong - so both prompts are pinned here.
describe("delegate prompts name the user's real surfaces", () => {
  const prompts: Array<[string, string]> = [
    ["wake", buildDelegatePrompt("what is on my board?")],
    ["chat", buildAskDelegatePrompt("what is on my board?")]
  ];

  it("names the Kanban board explicitly on every lane", () => {
    for (const [lane, prompt] of prompts) {
      expect(prompt, lane).toMatch(/Kanban board/i);
    }
  });

  it("rules out the operative's own to-do list on every lane", () => {
    for (const [lane, prompt] of prompts) {
      expect(prompt, lane).toMatch(/to-do list/i);
      expect(prompt, lane).toMatch(/never report an empty tool of your own/i);
    }
  });

  it("still carries the request itself", () => {
    for (const [lane, prompt] of prompts) {
      expect(prompt, lane).toContain("what is on my board?");
    }
  });
});

describe("wake units", () => {
  it("buildWakePrompt carries the command and project vocabulary", () => {
    const prompt = buildWakePrompt("marca a revisao do carro", ["garrison", "ekoa-code"]);
    expect(prompt).toContain('marca a revisao do carro');
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

// Regression (2026-07-31): live Omi realtime deliveries counted as
// `realtime_malformed` because the parser only accepted a BARE array, which is
// what the docs promise. Separately, a mangled webhook URL can drop session_id,
// and without one the wake gate was skipped silently - so auth could be fixed
// and the wake bus still do nothing.
describe("realtime payload envelopes and session id recovery", () => {
  const segs = [
    { text: "Zeca, create a task called envelope test.", speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: 0, end: 2 }
  ];

  function harness(home: string) {
    const cfg = { ...loadConfig({ GARRISON_HOME: home }), enabled: true, wakeEnabled: true };
    const store = new OmiStore(path.join(home, "omi"));
    const counters = new Counters(store.root, "test");
    const seen: Array<{ sessionId: string }> = [];
    const wakeBus = { handleSegments: (a: { sessionId: string }) => seen.push(a) };
    return { ingress: new Ingress({ cfg, store, counters, wakeBus }), counters, seen, store };
  }

  it("accepts {segments:[...]} and {transcript_segments:[...]}, not just a bare array", () => {
    for (const body of [
      JSON.stringify(segs),
      JSON.stringify({ segments: segs }),
      JSON.stringify({ transcript_segments: segs })
    ]) {
      const home = mkdtempSync(path.join(os.tmpdir(), "omi-env-"));
      const h = harness(home);
      h.ingress.acceptRealtime({ bodyText: body, sessionId: "s1" });
      expect(mergedCounters(h.store.root).realtime_malformed ?? 0).toBe(0);
      expect(h.seen).toHaveLength(1);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("recovers session_id from the body when the URL lost it", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-sess-"));
    const h = harness(home);
    h.ingress.acceptRealtime({
      bodyText: JSON.stringify({ session_id: "from-body", segments: segs }),
      sessionId: null
    });
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0].sessionId).toBe("from-body");
    rmSync(home, { recursive: true, force: true });
  });

  it("counts an unusable payload rather than pretending it worked", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-bad-"));
    const h = harness(home);
    h.ingress.acceptRealtime({ bodyText: JSON.stringify({ nope: 1 }), sessionId: "s1" });
    expect(mergedCounters(h.store.root).realtime_malformed).toBe(1);
    expect(h.seen).toHaveLength(0);
    rmSync(home, { recursive: true, force: true });
  });
});

// Feature (2026-07-31, user-requested): Omi fragments speech across segments and
// mis-attributes speakers, so the detail a command refers to often sits in a
// segment BEFORE the wake word - which the gate dropped. The classifier now gets
// a bounded pre-wake context window. Real case: "Zeca, create a task saying"
// arrived with the subject ("tomorrow it could rain") in an earlier segment, and
// classified as unknown because the command alone was meaningless.
describe("wake pre-wake context window", () => {
  const cfgFor = (home: string, extra: Record<string, unknown> = {}) => ({
    ...loadConfig({ GARRISON_HOME: home }),
    wakeEnabled: true,
    // Without a gatewayUrl handleCommand short-circuits to the note fallback
    // and the classifier prompt is never built.
    gatewayUrl: "http://127.0.0.1:1",
    wakeSilenceCloseMs: 20,
    wakeMaxCaptureMs: 200,
    ...extra
  });

  function bus(home: string, extra: Record<string, unknown> = {}) {
    const cfg = cfgFor(home, extra);
    const store = new OmiStore(path.join(home, "omi"));
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
      board: { listProjects: async () => ["garrison"], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [] }
    });
    return { wake, prompts, store };
  }

  const seg = (text: string, start: number, isUser = true) => ({
    text, speaker: "SPEAKER_00", speakerId: 0, is_user: isUser, start, end: start + 1
  });

  it("carries pre-wake segments into the classifier prompt", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-ctx-"));
    const { wake, prompts } = bus(home);
    // The subject arrives BEFORE the wake word, as it did live.
    wake.handleSegments({ sessionId: "s1", segments: [seg("tomorrow it could rain", 0)] });
    wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca, create a task saying", 2)] });
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
      wake.handleSegments({ sessionId: "s1", segments: [seg(`filler ${i}`, i)] });
    }
    wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca do it", 9)] });
    await wake.close("s1", "silence");
    expect(prompts[0]).toContain("filler 4");
    expect(prompts[0]).toContain("filler 3");
    expect(prompts[0]).not.toContain("filler 0");
    rmSync(home, { recursive: true, force: true });
  });

  it("drops context that is too old to be the same conversation", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-ctx-age-"));
    let clock = 1_000_000;
    const cfg = cfgFor(home, { wakeContextMaxAgeMs: 5000 });
    const store = new OmiStore(path.join(home, "omi"));
    const prompts: string[] = [];
    const wake = new WakeBus({
      cfg,
      store,
      counters: new Counters(store.root, "test"),
      runFn: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        return { reply: JSON.stringify({ intent: "note", note_content: "ok", title: "t" }) };
      },
      board: { listProjects: async () => ["garrison"], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [] },
      now: () => clock
    });
    wake.handleSegments({ sessionId: "s1", segments: [seg("stale talk", 0)] });
    clock += 60_000; // a minute later - unrelated conversation
    wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca do it", 9)] });
    await wake.close("s1", "silence");
    expect(prompts[0]).not.toContain("stale talk");
    rmSync(home, { recursive: true, force: true });
  });

  it("still records nothing when a session never wakes (I5)", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-ctx-i5-"));
    const { wake, store } = bus(home);
    wake.handleSegments({ sessionId: "s1", segments: [seg("private conversation", 0)] });
    const files = existsSync(path.join(store.root, "events"))
      ? readdirSync(path.join(store.root, "events"))
      : [];
    expect(files).toHaveLength(0);
    rmSync(home, { recursive: true, force: true });
  });
});

// Feature (2026-07-31, user-requested): "after the keyword it should wait for
// 15-20 seconds of more messages before deciding". Omi delivers one spoken
// sentence across bursts with real gaps, so the first quiet moment is not the
// end of the command - holding the window open is what stops the truncation.
describe("wake minimum capture window", () => {
  it("holds the window open through silence, then still respects the cap", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-min-"));
    let clock = 1_000_000;
    const store = new OmiStore(path.join(home, "omi"));
    const prompts: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        gatewayUrl: "http://127.0.0.1:1",
        wakeSilenceCloseMs: 1000,
        wakeMinCaptureMs: 15000,
        wakeMaxCaptureMs: 20000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        return { reply: JSON.stringify({ intent: "create_task", title: "t", description: "d" }) };
      },
      board: { listProjects: async () => ["garrison"], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [] },
      now: () => clock
    });

    wake.handleSegments({
      sessionId: "s1",
      segments: [{ text: "Zeca, create a task saying", speaker: "S", speakerId: 0, is_user: true, start: 0, end: 1 }]
    });
    // Silence arrives long before the minimum - must NOT dispatch yet.
    clock += 2000;
    await wake.close("s1", "silence");
    expect(prompts).toHaveLength(0);

    // The rest of the sentence lands during the held-open window.
    wake.handleSegments({
      sessionId: "s1",
      segments: [{ text: "remind me it could rain tomorrow", speaker: "S", speakerId: 0, is_user: true, start: 3, end: 4 }]
    });
    clock += 14000; // past the minimum
    await wake.close("s1", "silence");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("create a task saying");
    expect(prompts[0]).toContain("remind me it could rain tomorrow");
    rmSync(home, { recursive: true, force: true });
  });

  it("max-capture still closes the window regardless of the minimum", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-min-cap-"));
    const store = new OmiStore(path.join(home, "omi"));
    const prompts: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        gatewayUrl: "http://127.0.0.1:1",
        wakeSilenceCloseMs: 1000,
        wakeMinCaptureMs: 999999,
        wakeMaxCaptureMs: 20000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        return { reply: JSON.stringify({ intent: "note", note_content: "n", title: "t" }) };
      },
      board: { listProjects: async () => [], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [] }
    });
    wake.handleSegments({
      sessionId: "s1",
      segments: [{ text: "Zeca do the thing", speaker: "S", speakerId: 0, is_user: true, start: 0, end: 1 }]
    });
    await wake.close("s1", "max-capture");
    expect(prompts).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });
});

// Regression (2026-07-31): a spoken command takes ~25s to become a card, so the
// user repeats it - and the repeat is DIFFERENT transcript text ("Create a task.
// Vamos, vamos. Saying that tomorrow it will be sunny." vs "create a task saying
// that tomorrow it will be sunny...") so no upstream dedupe catches it. Observed
// live: two identical "Tomorrow it will be sunny" cards 44s apart.
describe("wake duplicate card suppression", () => {
  function bus(home: string, title: string, extra: Record<string, unknown> = {}) {
    const store = new OmiStore(path.join(home, "omi"));
    const created: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        gatewayUrl: "http://127.0.0.1:1",
        wakeCardDedupeMs: 600000,
        ...extra
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: JSON.stringify({ intent: "create_task", title, description: "d" }) }),
      board: {
        listProjects: async () => [],
        createCard: async (c: { title: string }) => {
          created.push(c.title);
          return { id: `c${created.length}`, url: null };
        }
      },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null }
    });
    return { wake, created, store };
  }

  it("suppresses a repeat of the same resolved title, despite different wording", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-dupe-"));
    const { wake, created, store } = bus(home, "Tomorrow it will be sunny");
    await wake.handleCommand({ command: "Create a task. Vamos, vamos. Saying that tomorrow it will be sunny.", eventId: "e1" });
    await wake.handleCommand({ command: "create a task saying that tomorrow it will be sunny. Porque...", eventId: "e2" });
    expect(created).toEqual(["Tomorrow it will be sunny"]);
    expect(mergedCounters(store.root).wake_duplicate_suppressed).toBe(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("treats accents, case and punctuation as the same title", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-dupe-acc-"));
    const store = new OmiStore(path.join(home, "omi"));
    let title = "Lembrar que amanhã pode chover";
    const created: string[] = [];
    const wake = new WakeBus({
      cfg: { ...loadConfig({ GARRISON_HOME: home }), wakeEnabled: true, gatewayUrl: "http://x", wakeCardDedupeMs: 600000 },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: JSON.stringify({ intent: "create_task", title, description: "d" }) }),
      board: {
        listProjects: async () => [],
        createCard: async (c: { title: string }) => { created.push(c.title); return { id: "c", url: null }; }
      },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null }
    });
    await wake.handleCommand({ command: "a", eventId: "e1" });
    title = "lembrar que amanha pode chover!";
    await wake.handleCommand({ command: "b", eventId: "e2" });
    expect(created).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("still creates a genuinely different task", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-dupe-diff-"));
    const store = new OmiStore(path.join(home, "omi"));
    let title = "Tomorrow it will be sunny";
    const created: string[] = [];
    const wake = new WakeBus({
      cfg: { ...loadConfig({ GARRISON_HOME: home }), wakeEnabled: true, gatewayUrl: "http://x", wakeCardDedupeMs: 600000 },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: JSON.stringify({ intent: "create_task", title, description: "d" }) }),
      board: {
        listProjects: async () => [],
        createCard: async (c: { title: string }) => { created.push(c.title); return { id: "c", url: null }; }
      },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null }
    });
    await wake.handleCommand({ command: "a", eventId: "e1" });
    title = "Ir ao Fado";
    await wake.handleCommand({ command: "b", eventId: "e2" });
    expect(created).toEqual(["Tomorrow it will be sunny", "Ir ao Fado"]);
    rmSync(home, { recursive: true, force: true });
  });
});

// Feature (2026-07-31, user-requested): with a TV on, silence never arrives, so
// the capture window runs for minutes. Everything is still captured, but only
// the speech near the wake word counts as the COMMAND - the rest is trailing
// context, or ten minutes of television would drown two sentences of intent.
describe("wake command window vs trailing context", () => {
  it("splits speech near the wake word from what the mic caught later", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-window-"));
    let clock = 1_000_000;
    const store = new OmiStore(path.join(home, "omi"));
    const prompts: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
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
      board: { listProjects: async () => [], createCard: async () => ({ id: "c", url: null }) },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null },
      now: () => clock
    });

    const seg = (text: string) => ({ text, speaker: "S", speakerId: 0, is_user: true, start: 0, end: 1 });
    wake.handleSegments({ sessionId: "s1", segments: [seg("Zeca, create a task to book the car service")] });
    clock += 10_000; // still inside the command window
    wake.handleSegments({ sessionId: "s1", segments: [seg("for next Tuesday morning")] });
    clock += 300_000; // five minutes of television later
    wake.handleSegments({ sessionId: "s1", segments: [seg("and now the weather for the weekend")] });
    await wake.close("s1", "max-capture");

    expect(prompts).toHaveLength(1);
    const p = prompts[0];
    // Both parts of the real command are in the command line...
    expect(p).toMatch(/Command \(spoken right after the wake word\): "[^"]*book the car service[^"]*next Tuesday morning/);
    // ...and the television is present but quarantined as trailing context.
    expect(p).toContain("CONTINUED afterwards");
    expect(p).toContain("weather for the weekend");
    expect(p).not.toMatch(/Command \(spoken right after the wake word\): "[^"]*weather for the weekend/);
    rmSync(home, { recursive: true, force: true });
  });
});

// Feature (2026-07-31, user-requested): the card is created fast (~45s) so it can
// be SEEN, then a single deferred pass reads what was said afterwards and
// corrects it - "I can see if the card was created correctly. I can ask to
// adjust if it wasn't, with voice."
describe("wake revision pass", () => {
  function harness(home: string, revisionReply: string) {
    const store = new OmiStore(path.join(home, "omi"));
    const revised: Array<{ cardId: string; patch: Record<string, unknown> }> = [];
    let call = 0;
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
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
        listProjects: async () => [],
        createCard: async () => ({ id: "card-1", url: null }),
        reviseCard: async (cardId: string, patch: Record<string, unknown>) => {
          revised.push({ cardId, patch });
          return { ok: true, mode: "patched" };
        }
      },
      memoryWriter: { write: async () => ({ ok: true }) },
      notifier: { send: async () => [], cardUrl: async () => null }
    });
    return { wake, revised, store };
  }

  const seg = (text: string) => ({ text, speaker: "S", speakerId: 0, is_user: true, start: 0, end: 1 });

  it("applies a spoken correction to the card it just created", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-rev-"));
    const { wake, revised, store } = harness(
      home,
      JSON.stringify({ action: "revise", title: "Book car service Wednesday", description: "d2", note: "Moved to Wednesday" })
    );
    await wake.handleCommand({ command: "create a task to book the car service", eventId: "e1", sessionId: "s1" });
    // The correction arrives afterwards, in the same session.
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
  it("closes on the short settle when the command ends a sentence, and the full window otherwise", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-settle-"));
    const store = new OmiStore(path.join(home, "omi"));
    const closed: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        gatewayUrl: "http://127.0.0.1:1",
        wakeSilenceCloseMs: 15000,
        wakeSettledCloseMs: 5000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: JSON.stringify({ intent: "note", note_content: "n" }) }),
      board: { listProjects: async () => [], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: () => ({ ok: true }) },
      notifier: { send: async () => [] }
    });

    // A finished sentence must not wait the full 15s window.
    wake.handleSegments({
      sessionId: "s-done",
      segments: [{ text: "Zeca, cria uma tarefa para comprar peixe.", speaker: "S", speakerId: 0, is_user: true, start: 0, end: 1 }]
    });
    closed.push(String((wake as any).sessions.get("s-done").silenceTimer._idleTimeout));

    // An unfinished one still gets the full window - truncating it is the
    // failure this window exists to prevent.
    wake.handleSegments({
      sessionId: "s-open",
      segments: [{ text: "Zeca, cria uma tarefa a dizer", speaker: "S", speakerId: 0, is_user: true, start: 0, end: 1 }]
    });
    closed.push(String((wake as any).sessions.get("s-open").silenceTimer._idleTimeout));

    expect(closed).toEqual(["5000", "15000"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("a bare wake word waits the full window even though it ends in punctuation", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-settle-bare-"));
    const store = new OmiStore(path.join(home, "omi"));
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        gatewayUrl: "http://127.0.0.1:1",
        wakeSilenceCloseMs: 15000,
        wakeSettledCloseMs: 5000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: "{}" }),
      board: { listProjects: async () => [], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: () => ({ ok: true }) },
      notifier: { send: async () => [] }
    });
    wake.handleSegments({
      sessionId: "s-bare",
      segments: [{ text: "Zeca?", speaker: "S", speakerId: 0, is_user: true, start: 0, end: 1 }]
    });
    expect(String((wake as any).sessions.get("s-bare").silenceTimer._idleTimeout)).toBe("15000");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("wake delegation to the operative", () => {
  it("acknowledges immediately, then notifies with the operative's answer", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-delegate-"));
    const store = new OmiStore(path.join(home, "omi"));
    const notifications: string[] = [];
    let operativeCalls = 0;
    let releaseOperative: () => void = () => {};
    const release = new Promise<void>((resolve) => {
      releaseOperative = resolve;
    });
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        delegateEnabled: true,
        gatewayUrl: "http://127.0.0.1:1",
        wakeSilenceCloseMs: 1000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({
        reply: JSON.stringify({
          intent: "delegate",
          request: "Send Ana a message on Slack",
          ack: "On it - messaging Ana."
        })
      }),
      // Held open so the assertion below is about ORDERING, not about winning a
      // race: a real operative turn takes tens of seconds, and the ack must be
      // out before it finishes.
      operativeFn: async () => {
        operativeCalls++;
        await release;
        return { reply: "Sent it to Ana on Slack." };
      },
      board: { listProjects: async () => [], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: () => ({ ok: true }) },
      notifier: {
        send: async ({ params }: any) => {
          notifications.push(params.text);
          return [];
        },
        cardUrl: async () => null
      }
    });

    wake.handleSegments({
      sessionId: "s1",
      segments: [{ text: "Zeca, manda uma mensagem à Ana no Slack.", speaker: "S", speakerId: 0, is_user: true, start: 0, end: 1 }]
    });
    await wake.close("s1", "max-capture");
    // The acknowledgement must be out before the operative is done - the whole
    // point is that the wearer is not left waiting on a minute-long turn.
    expect(notifications).toEqual(["On it - messaging Ana."]);

    releaseOperative();
    await (wake as any).delegateChain;
    expect(operativeCalls).toBe(1);
    expect(notifications).toEqual(["On it - messaging Ana.", "Sent it to Ana on Slack."]);

    const written = readdirSync(path.join(store.root, "wake-results")).filter((f) => f.endsWith(".delegate.json"));
    expect(written).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("falls back to a note when delegation is switched off", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-delegate-off-"));
    const store = new OmiStore(path.join(home, "omi"));
    const notifications: string[] = [];
    const wake = new WakeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: home }),
        wakeEnabled: true,
        delegateEnabled: false,
        gatewayUrl: "http://127.0.0.1:1",
        wakeSilenceCloseMs: 1000
      },
      store,
      counters: new Counters(store.root, "test"),
      runFn: async () => ({ reply: JSON.stringify({ intent: "delegate", request: "do a thing" }) }),
      operativeFn: async () => ({ reply: "should never run" }),
      board: { listProjects: async () => [], createCard: async () => ({ id: "c1", url: null }) },
      memoryWriter: { write: () => ({ ok: true }) },
      notifier: {
        send: async ({ params }: any) => {
          notifications.push(params.text);
          return [];
        },
        cardUrl: async () => null
      }
    });
    wake.handleSegments({
      sessionId: "s1",
      segments: [{ text: "Zeca, faz uma coisa qualquer.", speaker: "S", speakerId: 0, is_user: true, start: 0, end: 1 }]
    });
    await wake.close("s1", "max-capture");
    expect(notifications[0]).toContain("saved it as a note");
    rmSync(home, { recursive: true, force: true });
  });
});
