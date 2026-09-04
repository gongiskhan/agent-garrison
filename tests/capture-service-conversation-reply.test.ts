import { describe, expect, it } from "vitest";
import {
  awaitConversationReply,
  cleanReplyText,
  foldReplyEvents,
  REPLY_TEXT_CAP
} from "../fittings/seed/capture-service/lib/conversation-reply.mjs";

function started(stretchId: string) {
  return { kind: "stretch-started", payload: { stretchId } };
}
function said(text: string) {
  return { kind: "session-event", payload: { role: "assistant", blocks: [{ type: "text", text }] } };
}
function ended(stretchId: string, duty: string) {
  return { kind: "stretch-ended", payload: { stretchId, duty } };
}
function freshState() {
  return { running: null as string | null, texts: new Map<string, string>(), lastEnded: null as unknown };
}

describe("cleanReplyText", () => {
  it("drops the routing trailer, code fences and caps the length", () => {
    const raw = "The screen shows a login form.\n\n```js\nconsole.log(1)\n```\n\n[route: discuss | rule: x | profile: y]\n[orchestrator-active]\n";
    expect(cleanReplyText(raw)).toBe("The screen shows a login form.");
    const long = "a".repeat(REPLY_TEXT_CAP + 50);
    expect(cleanReplyText(long)).toHaveLength(REPLY_TEXT_CAP);
    expect(cleanReplyText(long).endsWith("...")).toBe(true);
  });
});

describe("foldReplyEvents", () => {
  it("answers with the first user-facing stretch and ignores the loop's own stretches", () => {
    const state = freshState();
    const events = [
      started("s-triage"), said("Done. Handoff written.\n[route: triage]"), ended("s-triage", "triage"),
      started("s-discuss"), said("You are looking at the Vault page.\n[orchestrator-active]"), ended("s-discuss", "discuss"),
      started("s-test"), said("No test action applies."), ended("s-test", "test")
    ];
    expect(foldReplyEvents(state, events)).toEqual({ text: "You are looking at the Vault page.", duty: "discuss", stretchId: "s-discuss" });
  });

  it("skips a stretch another watcher already announced", () => {
    const state = freshState();
    const events = [started("s-1"), said("first answer"), ended("s-1", "discuss"), started("s-2"), said("second answer"), ended("s-2", "discuss")];
    expect(foldReplyEvents(state, events, { isFresh: (id) => id !== "s-1" })).toEqual({ text: "second answer", duty: "discuss", stretchId: "s-2" });
  });

  it("remembers the last stretch that ended when none was user-facing", () => {
    const state = freshState();
    expect(foldReplyEvents(state, [started("s-t"), said("Triage answered directly."), ended("s-t", "triage")], { now: 500 })).toBeNull();
    expect(state.lastEnded).toEqual({ text: "Triage answered directly.", duty: "triage", stretchId: "s-t", at: 500 });
  });
});

describe("awaitConversationReply", () => {
  it("polls the log from the baseline and returns the discuss answer", async () => {
    const urls: string[] = [];
    const pages = [
      { events: [started("s-triage"), said("gate"), ended("s-triage", "triage")], nextIndex: 13 },
      { events: [], nextIndex: 13 },
      { events: [started("s-discuss"), said("Here is what I see.\n[route: discuss]"), ended("s-discuss", "discuss")], nextIndex: 16 }
    ];
    let page = 0;
    const fetchImpl = async (url: string) => {
      urls.push(url);
      const body = pages[Math.min(page, pages.length - 1)];
      page += 1;
      return { ok: true, json: async () => body };
    };
    const reply = await awaitConversationReply({
      base: "http://app.test",
      conversationId: "conv-1",
      fromIndex: 10,
      fetchImpl,
      pollMs: 1,
      sleep: async () => {}
    });
    expect(reply).toEqual({ text: "Here is what I see.", duty: "discuss", stretchId: "s-discuss", timedOut: false });
    expect(urls[0]).toBe("http://app.test/api/conversation/conv-1/log?fromIndex=10&limit=500");
    expect(urls[1]).toBe("http://app.test/api/conversation/conv-1/log?fromIndex=13&limit=500");
  });

  it("falls back to the last stretch once the loop has been idle, and gives up at the deadline", async () => {
    let clock = 0;
    const events = [started("s-t"), said("Direct answer from triage."), ended("s-t", "triage")];
    let served = false;
    const fetchImpl = async () => ({ ok: true, json: async () => (served ? { events: [], nextIndex: 4 } : ((served = true), { events, nextIndex: 4 })) });
    const reply = await awaitConversationReply({
      base: "http://app.test",
      conversationId: "conv-2",
      fetchImpl,
      pollMs: 1000,
      idleGraceMs: 5000,
      timeoutMs: 60_000,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; }
    });
    expect(reply).toEqual({ text: "Direct answer from triage.", duty: "triage", stretchId: "s-t", timedOut: false });

    clock = 0;
    const silent = await awaitConversationReply({
      base: "http://app.test",
      conversationId: "conv-3",
      fetchImpl: async () => ({ ok: true, json: async () => ({ events: [], nextIndex: 0 }) }),
      pollMs: 1000,
      timeoutMs: 5000,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; }
    });
    expect(silent).toBeNull();
  });
});
