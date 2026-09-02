// The feedback slice: a channel-originated card posts its outcome back to the
// originating thread when it lands terminal (done / needs-attention). These
// cover the PURE edge logic + message shape; the fetch side is fire-and-forget
// by design and exercised by the live run.
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


// @ts-ignore — pure .mjs
const lib = () => import("../fittings/seed/kanban-loop/lib/notify-origin.mjs");

const origin = { channel: "web", threadId: "chat-abc123-xyz" };
const base = {
  id: "01TESTCARD",
  title: "Add a CSV export button",
  originChannel: origin,
  lastReply: "Done - the button exports the visible rows.",
  videoUrl: null,
  attentionReason: null
};

describe("terminalTransition (edge detection)", () => {
  it("fires when the list CHANGES into done or needs-attention", async () => {
    const { terminalTransition } = await lib();
    expect(terminalTransition({ ...base, list: "test" }, { ...base, list: "done" })).toBe(true);
    expect(terminalTransition({ ...base, list: "plan" }, { ...base, list: "needs-attention" })).toBe(true);
  });

  it("does NOT fire on repeated saves in the same terminal list", async () => {
    const { terminalTransition } = await lib();
    expect(terminalTransition({ ...base, list: "done" }, { ...base, list: "done" })).toBe(false);
    expect(terminalTransition({ ...base, list: "needs-attention" }, { ...base, list: "needs-attention" })).toBe(false);
  });

  it("does NOT fire for non-terminal moves, quick cards, or cards without an origin", async () => {
    const { terminalTransition } = await lib();
    expect(terminalTransition({ ...base, list: "plan" }, { ...base, list: "implement" })).toBe(false);
    expect(terminalTransition({ ...base, list: "test" }, { ...base, list: "done", quick: true })).toBe(false);
    expect(terminalTransition({ ...base, list: "test", originChannel: null }, { ...base, list: "done", originChannel: null })).toBe(false);
    expect(terminalTransition({ ...base, list: "test" }, { ...base, list: "done", originChannel: { channel: "web" } })).toBe(false);
  });

  it("fires again on a NEW outcome after the card was revived", async () => {
    const { terminalTransition } = await lib();
    // parked -> retried (todo) -> done: both edges are real outcomes.
    expect(terminalTransition({ ...base, list: "needs-attention" }, { ...base, list: "todo" })).toBe(false);
    expect(terminalTransition({ ...base, list: "todo" }, { ...base, list: "done" })).toBe(true);
  });
});

describe("outcomeMessage (what the thread reads)", () => {
  it("a done card reads as a completion with the reply snippet", async () => {
    const { outcomeMessage } = await lib();
    const text = outcomeMessage({ ...base, list: "done" });
    expect(text).toContain("Run complete — Add a CSV export button.");
    expect(text).toContain("exports the visible rows");
  });

  it("uses the authoritative engine summary without the card-front truncation or verdict token", async () => {
    const { outcomeMessage } = await lib();
    const marker = "final recommendation after the old 280-character boundary";
    const summary = `${"context ".repeat(60)}${marker}\ndone`;
    const text = outcomeMessage({ ...base, list: "done", lastReply: "context …" }, { summary });
    expect(text).toContain(marker);
    expect(text).not.toMatch(/\ndone\s*$/i);
  });

  it("a parked card carries the attention reason", async () => {
    const { outcomeMessage } = await lib();
    const text = outcomeMessage({
      ...base,
      list: "needs-attention",
      attentionReason: "The Implement run produced no output."
    });
    expect(text).toContain("Run needs attention — Add a CSV export button.");
    expect(text).toContain("produced no output");
  });

  it("long snippets are truncated, evidence video linked when present", async () => {
    const { outcomeMessage } = await lib();
    const text = outcomeMessage({
      ...base,
      list: "done",
      lastReply: "x".repeat(1000),
      videoUrl: "http://gallery/final.mp4"
    });
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(500));
    expect(text).toContain("Evidence video: http://gallery/final.mp4");
  });
});

// The web channel is Conversations, a route of the Garrison shell. Every
// web-bound post resolves its base from GARRISON_APP_URL first (the runner
// projects it) and the legacy web-channel-default status file second, so a node
// without the own-port fitting still reaches the shared thread store.
describe("web channel base resolution (shell first, status file second)", () => {
  const priorHome = process.env.GARRISON_HOME;
  const priorApp = process.env.GARRISON_APP_URL;
  let home: string;

  beforeAll(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // A home with no ui-fittings dir: the status-file fallback yields nothing.
    home = mkdtempSync(join(tmpdir(), "notify-origin-home-"));
    process.env.GARRISON_HOME = home;
  });
  afterAll(() => {
    if (priorHome === undefined) delete process.env.GARRISON_HOME;
    else process.env.GARRISON_HOME = priorHome;
    if (priorApp === undefined) delete process.env.GARRISON_APP_URL;
    else process.env.GARRISON_APP_URL = priorApp;
  });

  function capture() {
    const sent: Array<{ url: string; body: any }> = [];
    const fetchImpl: any = async (url: string, init: any) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };
    return { sent, fetchImpl };
  }

  it("deliverBoardNotice ensures the thread and appends under the app's /api/* routes", async () => {
    process.env.GARRISON_APP_URL = "http://127.0.0.1:9333/";
    const { deliverBoardNotice } = (await lib()) as any;
    const { sent, fetchImpl } = capture();
    const ok = await deliverBoardNotice("Board review", "Two cards idle.", { fetchImpl, idempotencyKey: "k1" });
    expect(ok).toBe(true);
    expect(sent.map((s) => s.url)).toEqual([
      "http://127.0.0.1:9333/api/threads",
      "http://127.0.0.1:9333/api/threads/kanban-board-review/messages"
    ]);
    expect(sent[1].body.idempotencyKey).toBe("k1");
  });

  it("a web-origin reminder chains to the app thread once and skips the app in the fan-out", async () => {
    process.env.GARRISON_APP_URL = "http://127.0.0.1:9333";
    const { deliverScheduleReminder } = (await lib()) as any;
    const { sent, fetchImpl } = capture();
    const card = { id: "01JCARD", title: "ship the thing", list: "backlog", originChannel: { channel: "web", threadId: "t1" } };
    const result = await deliverScheduleReminder(home, card, { idempotencyKey: "card-01JCARD-due", fetchImpl });
    expect(result.ok).toBe(true);
    // The chain already reached the web surface through the shell; the fan-out
    // entry rides under the same id, so the skip list drops it and the reminder
    // lands on Conversations exactly once.
    expect(sent.map((s) => s.url)).toEqual(["http://127.0.0.1:9333/api/threads/t1/messages"]);
  });

  it("a web-origin reminder names both missing seams when neither host is known", async () => {
    delete process.env.GARRISON_APP_URL;
    const { deliverScheduleReminder } = (await lib()) as any;
    const { sent, fetchImpl } = capture();
    const card = { id: "01JCARD", title: "ship the thing", list: "backlog", originChannel: { channel: "web", threadId: "t1" } };
    const result = await deliverScheduleReminder(home, card, { fetchImpl });
    expect(sent).toHaveLength(0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("GARRISON_APP_URL unset");
    expect(result.error).toContain("web-channel-default");
  });

  it("deliverBoardNotice is false, not a throw, with no web channel base", async () => {
    delete process.env.GARRISON_APP_URL;
    const { deliverBoardNotice } = (await lib()) as any;
    const { sent, fetchImpl } = capture();
    expect(await deliverBoardNotice("Board review", "text", { fetchImpl })).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
