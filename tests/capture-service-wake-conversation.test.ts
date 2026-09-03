// The REC button's broadcast as a conversation microphone (D49, 2026-09-03).
//
// A capture session that carries a conversation_id is the microphone of that
// conversation: a wake hit becomes a USER turn there - the words after the
// wake word plus the latest screen frames - posted through the router's input
// door, with no classifier, no card and no note in between. Sessions without a
// conversation keep the classifier lanes untouched.

import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { CaptureStore, Counters } from "../fittings/seed/capture-service/lib/store.mjs";
import { WakeBus } from "../fittings/seed/capture-service/lib/wake.mjs";
import { MemoryWriter } from "../fittings/seed/capture-service/lib/memory-writer.mjs";
import { SessionMedia } from "../fittings/seed/capture-service/lib/media-log.mjs";
import { conversationTurnMessage, postConversationTurn } from "../fittings/seed/capture-service/lib/digest.mjs";

const SOURCE = {
  id: "companion-ios",
  label: "Companion",
  originPrefix: "companion",
  originChannel: { channel: "companion", threadId: "companion-reports" },
  sessionProvenanceKey: "companion_session_id",
  logPrefix: "capture-service"
};
const THREAD = "chat-mf0abc-xyz123";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeBus(overrides: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "wake-conv-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new CaptureStore(path.join(home, "capture"));
  const counters = new Counters(store.root, "wake");
  const cfg = { ...loadConfig({ GARRISON_HOME: home }), wakeEnabled: true, gatewayUrl: "http://gateway.test", wakeUnheardEnabled: false };
  const runCalls: string[] = [];
  const sent: Array<{ template: string; params: Record<string, unknown> }> = [];
  const turns: Array<Record<string, unknown>> = [];
  const board = { base: () => null, listProjects: async () => ["garrison"], createCard: async (p: Record<string, unknown>) => ({ id: "card-1", ...p }) };
  const bus = new WakeBus({
    cfg,
    store,
    counters,
    runFn: async ({ prompt }: { prompt: string }) => {
      runCalls.push(prompt);
      return { reply: JSON.stringify({ intent: "note", title: "x" }) };
    },
    board,
    memoryWriter: new MemoryWriter({ dir: path.join(home, "vault") }),
    notifier: { cardUrl: async () => null, send: async (a: any) => { sent.push(a); return [{ means: "push", ok: true }]; } },
    source: SOURCE,
    log: { log: () => {}, error: () => {}, warn: () => {} },
    conversationFn: (sessionId: string) => (sessionId === "rec-1" ? THREAD : null),
    conversationTurnFn: async (args: Record<string, unknown>) => {
      turns.push(args);
      return { ok: true, inputId: "in-1", url: `http://app.test/talk/${THREAD}` };
    },
    screenFramesFn: () => ({
      stale: false,
      sessionId: "rec-1",
      frames: [
        { seq: 9, file: "/m/rec-1/frames/9.jpg", ageMs: 100 },
        { seq: 6, file: "/m/rec-1/frames/6.jpg", ageMs: 2100 }
      ]
    }),
    ...overrides
  });
  return { bus, counters, runCalls, sent, turns, home };
}

describe("wake hit inside a broadcast started from a conversation", () => {
  it("posts the words as a user turn with the recent frames and never classifies", async () => {
    const { bus, counters, runCalls, turns } = makeBus();
    const outcome = await bus.handleCommand({ command: "explain what this error means", eventId: "ev1", sessionId: "rec-1", wakeHitAt: 1000 });
    expect(runCalls).toEqual([]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ conversationId: THREAD, command: "explain what this error means", eventId: "ev1" });
    expect((turns[0].frames as any[]).map((f) => f.file)).toEqual(["/m/rec-1/frames/9.jpg", "/m/rec-1/frames/6.jpg"]);
    expect(outcome.result).toMatchObject({ intent: "conversation_turn", conversation_id: THREAD, input_id: "in-1" });
    expect(outcome.confirmation).toBe("Sent to the conversation: explain what this error means");
    expect(outcome.path).toBe(`/talk/${THREAD}`);
    expect(counters.read().wake_conversation_turns).toBe(1);
  });

  it("keeps the conversation bound at the wake hit when the broadcast stops before the window closes", async () => {
    // The observed failure (2026-09-03): "Zeca, escreve comprar morangos", then
    // the user stopped REC. By the time the capture window closed the ingress
    // had dropped the session, the late lookup returned null, and the words
    // became a Kanban card instead of a turn in the conversation.
    let live = true;
    const { bus, counters, runCalls, turns, sent } = makeBus({
      cfg: {
        ...loadConfig({ GARRISON_HOME: mkdtempSync(path.join(os.tmpdir(), "wake-conv-cfg-")) }),
        wakeEnabled: true,
        gatewayUrl: "http://gateway.test",
        wakeUnheardEnabled: false,
        wakeSilenceCloseMs: 60,
        wakeSettledCloseMs: 60,
        wakeMinCaptureMs: 0
      },
      conversationFn: (sessionId: string) => (live && sessionId === "rec-1" ? THREAD : null)
    });
    bus.handleSegments({
      sessionId: "rec-1",
      segments: [{ text: "Zeca escreve comprar morangos.", speaker: "SPEAKER_00", speakerId: 0, is_user: true, start: 0, end: 2 }]
    });
    // The broadcast ends while the window is still open.
    live = false;
    const deadline = Date.now() + 3000;
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(turns).toHaveLength(1);
    expect(turns[0].conversationId).toBe(THREAD);
    expect(turns[0].command).toBe("escreve comprar morangos.");
    expect(runCalls).toEqual([]);
    expect(counters.read().wake_conversation_turns).toBe(1);
    expect(sent[0].params.path).toBe(`/talk/${THREAD}`);
  });

  it("watches the ledger for the answer and pushes it back as conversation_reply", async () => {
    const urls: string[] = [];
    const pages = [
      { events: [{ kind: "stretch-started", payload: { stretchId: "s-triage" } }, { kind: "stretch-ended", payload: { stretchId: "s-triage", duty: "triage" } }], nextIndex: 22 },
      {
        events: [
          { kind: "stretch-started", payload: { stretchId: "s-discuss" } },
          { kind: "session-event", payload: { role: "assistant", blocks: [{ type: "text", text: "That is the Vault page.\n[route: discuss]" }] } },
          { kind: "stretch-ended", payload: { stretchId: "s-discuss", duty: "discuss" } }
        ],
        nextIndex: 25
      }
    ];
    let page = 0;
    const fetchImpl = async (url: string) => {
      urls.push(url);
      const body = pages[Math.min(page, pages.length - 1)];
      page += 1;
      return { ok: true, json: async () => body };
    };
    const { bus, counters, sent } = makeBus({
      cfg: { ...loadConfig({ GARRISON_HOME: mkdtempSync(path.join(os.tmpdir(), "wake-conv-cfg-")) }), wakeEnabled: true, gatewayUrl: "http://gateway.test", wakeUnheardEnabled: false, wakeReplyDuties: ["discuss"], wakeReplyTimeoutMs: 10_000, wakeReplyPollMs: 1 },
      fetchImpl,
      conversationTurnFn: async () => ({ ok: true, inputId: "in-1", url: `http://app.test/talk/${THREAD}`, base: "http://app.test", fromIndex: 20 })
    });
    const outcome = await bus.handleCommand({ command: "what page is this", eventId: "ev7", sessionId: "rec-1", wakeHitAt: 1000 });
    expect(typeof outcome.after).toBe("function");
    outcome.after!();
    await bus.settleReplyWatches();
    expect(urls[0]).toBe(`http://app.test/api/conversation/${THREAD}/log?fromIndex=20&limit=500`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      template: "conversation_reply",
      params: { text: "That is the Vault page.", path: `/talk/${THREAD}`, eventId: "ev7", sessionId: "rec-1", conversationId: THREAD, duty: "discuss" }
    });
    expect(counters.read().wake_conversation_replies).toBe(1);
  });

  it("does not announce the same answer twice when two hits share a conversation", async () => {
    const page = {
      events: [
        { kind: "stretch-started", payload: { stretchId: "s-discuss" } },
        { kind: "session-event", payload: { role: "assistant", blocks: [{ type: "text", text: "One answer." }] } },
        { kind: "stretch-ended", payload: { stretchId: "s-discuss", duty: "discuss" } }
      ],
      nextIndex: 30
    };
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, json: async () => (calls === 1 ? page : { events: [], nextIndex: 30 }) };
    };
    const { bus, counters, sent } = makeBus({
      cfg: { ...loadConfig({ GARRISON_HOME: mkdtempSync(path.join(os.tmpdir(), "wake-conv-cfg-")) }), wakeEnabled: true, gatewayUrl: "http://gateway.test", wakeUnheardEnabled: false, wakeReplyTimeoutMs: 50, wakeReplyPollMs: 1 },
      fetchImpl
    });
    const first = await bus.watchConversationReply({ conversationId: THREAD, eventId: "e1", base: "http://app.test", fromIndex: 27 });
    expect(first).toMatchObject({ text: "One answer.", stretchId: "s-discuss" });
    const second = await bus.watchConversationReply({ conversationId: THREAD, eventId: "e2", base: "http://app.test", fromIndex: 27 });
    expect(second).toBeNull();
    expect(sent).toHaveLength(1);
    expect(counters.read().wake_conversation_reply_timeouts).toBe(1);
  });

  it("leaves a session with no conversation on the classifier lane", async () => {
    const { bus, runCalls, turns } = makeBus();
    await bus.handleCommand({ command: "note this down", eventId: "ev2", sessionId: "pendant-1" });
    expect(turns).toEqual([]);
    expect(runCalls).toHaveLength(1);
  });

  it("falls back to a note, saying so, when the conversation cannot be reached", async () => {
    const { bus, counters } = makeBus({
      conversationTurnFn: async () => ({ ok: false, reason: "HTTP 502" })
    });
    const outcome = await bus.handleCommand({ command: "look at this", eventId: "ev3", sessionId: "rec-1" });
    expect(counters.read().wake_conversation_turn_failed).toBe(1);
    expect(outcome.confirmation).toContain("Couldn't reach the conversation");
    expect(outcome.result.intent).toBe("note_fallback");
  });

  it("discards a wake hit with nothing said after it", async () => {
    const { bus, turns } = makeBus();
    const outcome = await bus.handleCommand({ command: "", eventId: "ev4", sessionId: "rec-1" });
    expect(turns).toEqual([]);
    expect(outcome.result.intent).toBe("discarded");
  });
});

describe("the posted turn", () => {
  it("attaches frames with the composer's own convention", () => {
    expect(conversationTurnMessage({ command: " fix it ", frames: [] })).toBe("fix it");
    expect(conversationTurnMessage({ command: "fix it", frames: [{ file: "/a/1.jpg" }] })).toBe("fix it\n\nAttached file:\n- /a/1.jpg");
    expect(conversationTurnMessage({ command: "fix it", frames: [{ file: "/a/1.jpg" }, { file: "/a/2.jpg" }] })).toBe(
      "fix it\n\nAttached files:\n- /a/1.jpg\n- /a/2.jpg"
    );
  });

  it("goes through the conversation door keyed by the wake event", async () => {
    const posts: Array<{ url: string; body: any }> = [];
    const server = createServer((req, res) => {
      if (req.method === "GET") {
        // The ledger baseline the reply watcher starts from: everything already
        // in the log before this turn is not the answer to it.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ conversationId: THREAD, total: 42, tail: [] }));
        return;
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        posts.push({ url: req.url ?? "", body: JSON.parse(raw) });
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true, seq: 9, recordedBy: "responder" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const counters = new Counters(mkdtempSync(path.join(os.tmpdir(), "wake-conv-c-")), "wake");
    const posted = await postConversationTurn({
      conversationId: THREAD,
      command: "what is on screen",
      eventId: "ev9",
      frames: [{ file: "/m/1.jpg" }],
      counters,
      env: { GARRISON_APP_URL: base },
      log: { log: () => {}, error: () => {} }
    });
    expect(posted).toMatchObject({ ok: true, seq: 9, recordedBy: "responder", url: `${base}/talk/${THREAD}`, base, fromIndex: 42 });
    expect(posts).toHaveLength(1);
    // The conversation door, not the thread's /inputs lane: a conversation-backed
    // thread renders only the ledger, so a turn posted to /inputs ran unseen.
    expect(posts[0].url).toBe(`/api/conversation/${THREAD}/message`);
    expect(posts[0].body).toEqual({ message: "what is on screen\n\nAttached file:\n- /m/1.jpg", origin: "capture", clientRequestId: "wake:ev9" });
    expect(counters.read().conversation_turn_posted).toBe(1);
  });

  it("reports the missing app host instead of throwing", async () => {
    const posted = await postConversationTurn({ conversationId: THREAD, command: "x", eventId: "e", env: {}, log: { log: () => {}, error: () => {} } });
    expect(posted.ok).toBe(false);
    expect(posted.reason).toContain("GARRISON_APP_URL");
  });
});

describe("recent frames", () => {
  it("hands back the newest frames first, spaced apart, newest-only when they are too close", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "wake-conv-media-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const media = new SessionMedia(root, "rec-1");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    for (let seq = 1; seq <= 5; seq++) media.acceptVideo(seq, seq * 667, jpeg);
    const spaced = media.recentFrames({ max: 3, spacingMs: 2000 });
    expect(spaced.map((f) => f.seq)).toEqual([5]);
    const dense = media.recentFrames({ max: 3, spacingMs: 0 });
    expect(dense.map((f) => f.seq)).toEqual([5, 4, 3]);
    expect(dense[0].file).toBe(path.join(root, "rec-1", "frames", "5.jpg"));
  });
});
