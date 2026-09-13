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

// Notification producers require the shared store, independently of mirror health.
describe("board notices and scheduled reminders enter Messages", () => {
  async function readMessage(id: string) {
    return (await __kanbanState.client.request("GET", `/v1/messages/${id}`)).message;
  }
  it("stores a board notice exactly once before any delivery mirror runs", async () => {
    const { deliverBoardNotice } = (await lib()) as any;
    expect(await deliverBoardNotice("Board review", "Two cards idle.", { idempotencyKey: "board-review-fixture" })).toBe(true);
    expect(await deliverBoardNotice("Board review", "Two cards idle.", { idempotencyKey: "board-review-fixture" })).toBe(true);
    const result: any = await __kanbanState.client.request("GET", "/v1/messages");
    expect(result.messages.filter((message: any) => message.externalId === "board-review-fixture")).toHaveLength(1);
  });
  it("stores a web-origin reminder with its card link and one mirror receipt", async () => {
    const { deliverScheduleReminder } = (await lib()) as any;
    const card = { id: "01JCARD", title: "Ship fixture", list: "backlog", originChannel: { channel: "web", threadId: "t1" } };
    const result = await deliverScheduleReminder("", card, { idempotencyKey: "card-fixture-due" });
    expect(result).toMatchObject({ ok: true, receipts: [{ id: "messages", queued: true }] });
    expect(await readMessage(result.receipts[0].messageId)).toMatchObject({ cardId: card.id, category: "card.due" });
  });
  it("reports a failed store write without pretending a reminder was delivered", async () => {
    const { deliverScheduleReminder } = (await lib()) as any;
    const result = await deliverScheduleReminder("", { id: "fixture-fail", title: "Fixture" }, { fetchImpl: async () => { throw new Error("Fixture state unavailable"); } });
    expect(result).toMatchObject({ ok: false, receipts: [] });
    expect(result.error).toContain("Fixture state unavailable");
  });
  it("does not fall back to a direct channel send after a board notice store failure", async () => {
    const { deliverBoardNotice } = (await lib()) as any;
    const urls: string[] = [];
    await expect(deliverBoardNotice("Board review", "Fixture", { fetchImpl: async (url: string) => { urls.push(url); throw new Error("Fixture state unavailable"); } })).rejects.toThrow("Fixture state unavailable");
    expect(urls.length).toBeGreaterThan(0);
    expect([...new Set(urls)]).toEqual([`${__kanbanState.url}/v1/messages/system`]);
  });
});
