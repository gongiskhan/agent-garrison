// The Slack channel's outbound half: the two contracts that make proactive
// messages (reminders, card outcomes, mirrored questions) visible on Slack.
//
// The adapter is plain CommonJS, so the pure half is loaded through
// createRequire (same pattern as tests/spotter-dhash.test.ts). The Slack Web API
// is never touched: createOutbound takes an injected postMessage, so these
// exercise the real delivery decisions rather than a mock of them.
import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore - pure ESM .mjs, no .d.ts
import { originIdFor } from "../fittings/seed/http-gateway/scripts/lib/discuss-intercept.mjs";
// @ts-ignore - pure ESM .mjs, no .d.ts
import { deriveOriginId, parseOriginId } from "../fittings/seed/kanban-loop/lib/origins.mjs";
// @ts-ignore - pure ESM .mjs, no .d.ts
import { deliverScheduleReminder } from "../fittings/seed/kanban-loop/lib/notify-origin.mjs";

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


const require_ = createRequire(__filename);
const {
  slackThreadId,
  parseSlackThreadId,
  renderNotification,
  NotifyDedupe,
  createOutbound
} = require_("../fittings/seed/slack-channel/lib/outbound.js");

interface PostedMessage {
  channel: string;
  threadTs: string | null;
  text: string;
}

function recorder(result: boolean | boolean[] = true) {
  const posted: PostedMessage[] = [];
  const results = Array.isArray(result) ? [...result] : null;
  const postMessage = async (message: PostedMessage) => {
    posted.push(message);
    if (results) return results.length ? results.shift()! : true;
    return result as boolean;
  };
  return { posted, postMessage };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "slack-outbound-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("slack thread id convention", () => {
  it("round-trips a Slack conversation through the origin id every transport uses", () => {
    // Inbound: the adapter builds this from the event it received.
    const threadId = slackThreadId("C0ABCDE12", "1712345678.000200");
    expect(threadId).toBe("C0ABCDE12:1712345678.000200");

    // The gateway stamps the card, kanban derives the origin id, and
    // discuss-intercept formats the SAME id for its board lookup.
    const card = { originChannel: { channel: "slack", threadId } };
    const originId = deriveOriginId(card);
    expect(originId).toBe("slack:C0ABCDE12:1712345678.000200");
    expect(originIdFor("slack", threadId)).toBe(originId);

    // Outbound: the address parses back into exactly the conversation + thread
    // chat.postMessage needs.
    const { transport, address } = parseOriginId(originId);
    expect(transport).toBe("slack");
    expect(parseSlackThreadId(address)).toEqual({
      channel: "C0ABCDE12",
      threadTs: "1712345678.000200"
    });
  });

  it("accepts the full origin id as well as the bare address", () => {
    expect(parseSlackThreadId("slack:D0999:1712345678.000200")).toEqual({
      channel: "D0999",
      threadTs: "1712345678.000200"
    });
  });

  it("accepts a conversation with no thread ts", () => {
    expect(parseSlackThreadId("C0ABCDE12")).toEqual({ channel: "C0ABCDE12", threadTs: null });
  });

  it("rejects ids that are not Slack conversations", () => {
    expect(parseSlackThreadId("kanban-board-review")).toBeNull();
    expect(parseSlackThreadId("web:2f9c-1234")).toBeNull();
    expect(parseSlackThreadId("C0ABCDE12:not-a-ts")).toBeNull();
    expect(parseSlackThreadId("")).toBeNull();
    expect(parseSlackThreadId(null)).toBeNull();
  });
});

describe("notification rendering", () => {
  it("renders title, body, link and url-bearing actions as Slack links", () => {
    const text = renderNotification({
      title: "Card due",
      text: 'Scheduled: "ship the thing" is due (card AB12).',
      link: "http://127.0.0.1:8081/#/cards/01J",
      actions: [{ label: "Snooze 2h" }, { label: "Open board", url: "http://127.0.0.1:8081/" }]
    });
    expect(text).toContain("*Card due*");
    expect(text).toContain('Scheduled: "ship the thing" is due (card AB12).');
    expect(text).toContain("http://127.0.0.1:8081/#/cards/01J");
    expect(text).toContain("<http://127.0.0.1:8081/|Open board>");
    // No interactivity endpoint exists, so a label-only action degrades to text
    // rather than becoming a button that does nothing.
    expect(text).toContain("Snooze 2h");
  });

  it("does not repeat the link when an action points at the same place", () => {
    const url = "http://127.0.0.1:8081/#/cards/01J";
    const text = renderNotification({ title: "Card due", text: "due", link: url, actions: [{ label: "Open card", url }] });
    expect(text.split(url)).toHaveLength(2);
  });

  it("escapes the three characters Slack mrkdwn reserves", () => {
    const text = renderNotification({ text: "compare a < b && c > d" });
    expect(text).toBe("compare a &lt; b &amp;&amp; c &gt; d");
  });

  it("clamps a very long body below Slack's ceiling", () => {
    const text = renderNotification({ text: "x".repeat(50_000) });
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("POST /notify", () => {
  it("posts to the configured conversation", async () => {
    const { posted, postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: "D0OPERATOR", dedupe: new NotifyDedupe() });

    const out = await outbound.notify({ title: "Card due", text: "the thing is due" });

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, delivered: 1, channel: "D0OPERATOR" });
    expect(posted).toHaveLength(1);
    expect(posted[0].channel).toBe("D0OPERATOR");
    expect(posted[0].threadTs).toBeNull();
    expect(posted[0].text).toContain("the thing is due");
  });

  it("delivers a repeated idempotencyKey exactly once", async () => {
    const { posted, postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: "C0TEAM", dedupe: new NotifyDedupe() });

    const first = await outbound.notify({ text: "card AB12 is due", idempotencyKey: "card-01J-due" });
    const second = await outbound.notify({ text: "card AB12 is due", idempotencyKey: "card-01J-due" });

    expect(first.body).toMatchObject({ ok: true, delivered: 1 });
    expect(second.body).toMatchObject({ ok: true, delivered: 0, deduplicated: true });
    expect(posted).toHaveLength(1);
  });

  it("dedupes concurrent fan-outs of the same key", async () => {
    const { posted, postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: "C0TEAM", dedupe: new NotifyDedupe() });

    const [a, b] = await Promise.all([
      outbound.notify({ text: "due", idempotencyKey: "same" }),
      outbound.notify({ text: "due", idempotencyKey: "same" })
    ]);

    expect(posted).toHaveLength(1);
    expect([a.body.deduplicated, b.body.deduplicated].filter(Boolean)).toHaveLength(1);
  });

  it("does not remember a delivery that failed, so the retry still posts", async () => {
    const { posted, postMessage } = recorder([false, true]);
    const outbound = createOutbound({ postMessage, notifyChannel: "C0TEAM", dedupe: new NotifyDedupe() });

    const failed = await outbound.notify({ text: "due", idempotencyKey: "k" });
    const retried = await outbound.notify({ text: "due", idempotencyKey: "k" });

    expect(failed.status).toBe(502);
    expect(failed.body.ok).toBe(false);
    expect(retried.body).toMatchObject({ ok: true, delivered: 1 });
    expect(posted).toHaveLength(2);
  });

  it("survives an adapter restart through the on-disk record", async () => {
    const file = path.join(tmp, "notify-dedupe.json");
    const first = recorder();
    await createOutbound({
      postMessage: first.postMessage,
      notifyChannel: "C0TEAM",
      dedupe: new NotifyDedupe({ file })
    }).notify({ text: "due", idempotencyKey: "card-01J-due" });
    expect(first.posted).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveProperty("notify:card-01J-due");

    // A brand new process, reading the same file.
    const second = recorder();
    const out = await createOutbound({
      postMessage: second.postMessage,
      notifyChannel: "C0TEAM",
      dedupe: new NotifyDedupe({ file })
    }).notify({ text: "due", idempotencyKey: "card-01J-due" });

    expect(out.body).toMatchObject({ deduplicated: true });
    expect(second.posted).toHaveLength(0);
  });

  it("forgets a key once it ages past the ttl", async () => {
    let now = 1_000_000;
    const { posted, postMessage } = recorder();
    const dedupe = new NotifyDedupe({ ttlMs: 1_000, now: () => now });
    const outbound = createOutbound({ postMessage, notifyChannel: "C0TEAM", dedupe });

    await outbound.notify({ text: "due", idempotencyKey: "k" });
    now += 5_000;
    await outbound.notify({ text: "due", idempotencyKey: "k" });

    expect(posted).toHaveLength(2);
  });

  it("reports honestly when no notify channel is configured", async () => {
    const { posted, postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: null, dedupe: new NotifyDedupe() });

    const out = await outbound.notify({ text: "due" });

    // NOT a 404: 404 means "not a notify-capable channel" to the fan-out, and
    // this fitting is one - it just has nowhere to put the message yet.
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, delivered: 0, reason: "no notify_channel configured" });
    expect(posted).toHaveLength(0);
  });

  it("rejects an empty payload", async () => {
    const { postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: "C0TEAM", dedupe: new NotifyDedupe() });
    expect((await outbound.notify({ text: "   " })).status).toBe(400);
  });
});

describe("POST /api/threads/:id/messages", () => {
  it("appends into the Slack thread the card came from", async () => {
    const { posted, postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: "C0TEAM", dedupe: new NotifyDedupe() });

    const out = await outbound.threadAppend("C0ABCDE12:1712345678.000200", {
      messages: [{ role: "assistant", text: "Run complete - ship the thing." }]
    });

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, appended: 1 });
    expect(posted).toEqual([
      {
        channel: "C0ABCDE12",
        threadTs: "1712345678.000200",
        text: "Run complete - ship the thing."
      }
    ]);
  });

  it("delivers a repeated idempotencyKey once per thread", async () => {
    const { posted, postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: "C0TEAM", dedupe: new NotifyDedupe() });
    const body = { messages: [{ role: "assistant", text: "due" }], idempotencyKey: "card-01J-due" };

    const first = await outbound.threadAppend("C0ABCDE12:1712345678.000200", body);
    const second = await outbound.threadAppend("C0ABCDE12:1712345678.000200", body);
    // A different thread with the same key is a different delivery.
    const other = await outbound.threadAppend("C0ZZZZZ:1712345678.000300", body);

    expect(first.body).toMatchObject({ ok: true, appended: 1 });
    expect(second.body).toMatchObject({ ok: true, appended: 0, deduplicated: true });
    expect(other.body).toMatchObject({ ok: true, appended: 1 });
    expect(posted).toHaveLength(2);
  });

  it("falls back to the notify channel rather than dropping an unroutable thread", async () => {
    const { posted, postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: "D0OPERATOR", dedupe: new NotifyDedupe() });

    const out = await outbound.threadAppend("kanban-board-review", {
      messages: [{ role: "assistant", text: "Weekly review" }]
    });

    expect(out.status).toBe(200);
    expect(posted).toEqual([{ channel: "D0OPERATOR", threadTs: null, text: "Weekly review" }]);
  });

  it("refuses when the thread is unroutable and there is no fallback", async () => {
    const { posted, postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: null, dedupe: new NotifyDedupe() });

    const out = await outbound.threadAppend("kanban-board-review", {
      messages: [{ role: "assistant", text: "Weekly review" }]
    });

    expect(out.status).toBe(400);
    expect(out.body.ok).toBe(false);
    expect(posted).toHaveLength(0);
  });

  it("reports a Slack failure instead of claiming delivery", async () => {
    const { postMessage } = recorder(false);
    const outbound = createOutbound({ postMessage, notifyChannel: "C0TEAM", dedupe: new NotifyDedupe() });

    const out = await outbound.threadAppend("C0ABCDE12:1712345678.000200", {
      messages: [{ role: "assistant", text: "Run complete" }],
      idempotencyKey: "k"
    });

    expect(out.status).toBe(502);
    expect(out.body).toMatchObject({ ok: false, appended: 0 });
  });

  it("rejects a body with no message text", async () => {
    const { postMessage } = recorder();
    const outbound = createOutbound({ postMessage, notifyChannel: "C0TEAM", dedupe: new NotifyDedupe() });
    expect((await outbound.threadAppend("C0ABCDE12", { messages: [] })).status).toBe(400);
    expect((await outbound.threadAppend("C0ABCDE12", { messages: [{ role: "assistant" }] })).status).toBe(400);
  });
});

describe("kanban-loop reaches the Slack fitting", () => {
  // The registration in CHANNEL_FITTINGS is one line, and until it existed a
  // Slack-originated card's outcome went nowhere. This drives the real
  // notify-origin delivery path against a fake status file and asserts the URL
  // it produces is the route the adapter now serves.
  it("posts a slack-origin card's reminder to the adapter's thread-append route", async () => {
    const home = path.join(tmp, "garrison-home");
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    // A port no instance family claims: the ack fan-out this path also triggers
    // uses the real fetch, and it must never reach a live service on this box.
    writeFileSync(
      path.join(home, "ui-fittings", "slack-channel.json"),
      JSON.stringify({ fittingId: "slack-channel", port: 45512, url: "http://127.0.0.1:45512", pid: 1 })
    );
    const previous = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = home;

    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
    });

    try {
      const card = {
        id: "01JCARD",
        title: "ship the thing",
        list: "backlog",
        originChannel: { channel: "slack", threadId: "C0ABCDE12:1712345678.000200" }
      };
      const result = await deliverScheduleReminder(path.join(tmp, "board"), card, {
        idempotencyKey: "card-01JCARD-due",
        fetchImpl
      });

      expect(result.ok).toBe(true);
      expect(calls).toContain(
        "http://127.0.0.1:45512/api/threads/C0ABCDE12%3A1712345678.000200/messages"
      );
      // The chain already reached Slack, so the fan-out must not send the same
      // reminder to the same fitting a second time.
      expect(calls.filter((url) => url.endsWith("/notify"))).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.GARRISON_HOME;
      else process.env.GARRISON_HOME = previous;
    }
  });
});
