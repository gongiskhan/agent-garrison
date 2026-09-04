import { describe, expect, it } from "vitest";
import {
  CAPTURE_REPLY_IDLE_MS,
  cleanSpokenText,
  createFoldState,
  foldCaptureEvents,
  settleCaptureIdle,
  speakReply,
  watchCaptureFeedback,
  type CaptureHeard,
  type CaptureReply
} from "../packages/talk/ui/capture-feedback";
import { describePushStatus } from "../packages/talk/ui/record-button";

function started(stretchId: string) {
  return { kind: "stretch-started", payload: { stretchId } };
}
function said(text: string) {
  return { kind: "session-event", payload: { role: "assistant", blocks: [{ type: "text", text }] } };
}
function ended(stretchId: string, duty: string) {
  return { kind: "stretch-ended", payload: { stretchId, duty } };
}
const heardCapture = { kind: "user-message", payload: { origin: "capture", text: "what is this page\n\nAttached file:\n- /m/1.jpg" } };

describe("foldCaptureEvents", () => {
  it("reports what the broadcast heard and speaks only the answer to it", () => {
    const heard: CaptureHeard[] = [];
    const replies: CaptureReply[] = [];
    const state = createFoldState();
    const handlers = { onHeard: (h: CaptureHeard) => heard.push(h), onReply: (r: CaptureReply) => replies.push(r) };
    // A typed turn's answer is never spoken.
    foldCaptureEvents(state, [{ kind: "user-message", payload: { origin: "web", text: "typed" } }, started("s-0"), said("typed answer"), ended("s-0", "discuss")], handlers);
    expect(replies).toEqual([]);
    foldCaptureEvents(
      state,
      [heardCapture, started("s-t"), said("gate"), ended("s-t", "triage"), started("s-d"), said("It is the Vault page.\n[route: discuss]\n[orchestrator-active]"), ended("s-d", "discuss"), started("s-x"), said("no test"), ended("s-x", "test")],
      handlers,
      { now: 7 }
    );
    expect(heard).toEqual([{ text: "what is this page", at: 7 }]);
    expect(replies).toEqual([{ text: "It is the Vault page.", duty: "discuss", stretchId: "s-d", at: 7 }]);
    expect(state.awaiting).toBe(0);
  });

  it("speaks a triage-only answer once the conversation has sat idle, and not before (D57)", () => {
    const replies: CaptureReply[] = [];
    const awaiting: number[] = [];
    const state = createFoldState();
    const handlers = { onReply: (r: CaptureReply) => replies.push(r), onAwaiting: (n: number) => awaiting.push(n) };
    // The gateway's inference ran triage alone: it asked a question and ended "blocked".
    const plural = { kind: "user-message", payload: { origin: "capture", text: "look at this\n\nAttached files:\n- /m/1.jpg\n- /m/2.jpg" } };
    foldCaptureEvents(state, [plural, started("s-t"), said("Which page do you mean?"), ended("s-t", "triage")], handlers, { now: 1_000 });
    expect(replies).toEqual([]);
    expect(state.lastEnded?.text).toBe("Which page do you mean?");
    // Not yet idle long enough: still waiting for a discuss stretch.
    expect(settleCaptureIdle(state, handlers, { now: 1_000 + CAPTURE_REPLY_IDLE_MS - 1 })).toBeNull();
    expect(replies).toEqual([]);
    const reply = settleCaptureIdle(state, handlers, { now: 1_000 + CAPTURE_REPLY_IDLE_MS });
    expect(reply).toEqual({ text: "Which page do you mean?", duty: "triage", stretchId: "s-t", at: 1_000 + CAPTURE_REPLY_IDLE_MS });
    expect(replies).toEqual([reply]);
    expect(state.awaiting).toBe(0);
    expect(awaiting).toEqual([1, 0]);
    // Settled once: a second idle tick says nothing.
    expect(settleCaptureIdle(state, handlers, { now: 1_000_000 })).toBeNull();
  });

  it("drops the idle fallback when a follow-up stretch starts, and speaks nothing for typed turns", () => {
    const replies: CaptureReply[] = [];
    const state = createFoldState();
    const handlers = { onReply: (r: CaptureReply) => replies.push(r) };
    foldCaptureEvents(state, [heardCapture, started("s-t"), said("gate"), ended("s-t", "triage"), started("s-d")], handlers, { now: 5 });
    expect(state.lastEnded).toBeNull();
    // Running: the idle settle never speaks over a live stretch.
    expect(settleCaptureIdle(state, handlers, { now: 5 + CAPTURE_REPLY_IDLE_MS * 2 })).toBeNull();
    foldCaptureEvents(state, [said("The real answer."), ended("s-d", "discuss")], handlers, { now: 9 });
    expect(replies.map((r) => r.text)).toEqual(["The real answer."]);
    // A typed turn's triage-only answer stays silent too.
    const quiet = createFoldState();
    foldCaptureEvents(quiet, [{ kind: "user-message", payload: { origin: "web", text: "typed" } }, started("s-q"), said("?"), ended("s-q", "triage")], handlers, { now: 1 });
    expect(settleCaptureIdle(quiet, handlers, { now: 1 + CAPTURE_REPLY_IDLE_MS })).toBeNull();
    expect(replies).toHaveLength(1);
  });

  it("cleans fences and trailers and caps what is spoken", () => {
    expect(cleanSpokenText("Look:\n```\nx\n```\n[route: a]")).toBe("Look:");
    expect(cleanSpokenText("b".repeat(2000), 100)).toHaveLength(100);
  });
});

describe("watchCaptureFeedback", () => {
  it("starts from the conversation's current size and polls the log after it", async () => {
    const urls: string[] = [];
    const bodies = [
      { total: 40 },
      { events: [heardCapture], nextIndex: 41 },
      { events: [started("s-d"), said("Answer."), ended("s-d", "discuss")], nextIndex: 44 }
    ];
    let i = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const heard: string[] = [];
    const replies: string[] = [];
    const stop = watchCaptureFeedback("conv-1", { onHeard: (h) => heard.push(h.text), onReply: (r) => replies.push(r.text) }, { pollMs: 1, fetchImpl });
    const deadline = Date.now() + 2000;
    while (replies.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(urls.slice(0, 3)).toEqual(["/api/conversation/conv-1", "/api/conversation/conv-1/log?fromIndex=40&limit=500", "/api/conversation/conv-1/log?fromIndex=41&limit=500"]);
    expect(heard).toEqual(["what is this page"]);
    expect(replies).toEqual(["Answer."]);
  });
});

describe("speakReply", () => {
  it("registers the text with the voice layer before the phone says it, and honours the master switch", async () => {
    const posts: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(`${String(url)} ${String(init?.body ?? "")}`);
      return new Response("{}", { status: 202 });
    }) as typeof fetch;
    const spoken: string[] = [];
    const speech = {
      speak: async ({ text }: { text: string }) => { spoken.push(text); return { completed: true }; },
      settings: async () => ({ master: true })
    };
    expect(await speakReply(speech, "Answer.", { fetchImpl })).toBe(true);
    expect(posts).toEqual(['/api/voice/spoken {"text":"Answer."}']);
    expect(spoken).toEqual(["Answer."]);

    const muted = { ...speech, settings: async () => ({ master: false }) };
    expect(await speakReply(muted, "Quiet.", { fetchImpl })).toBe(false);
    expect(spoken).toEqual(["Answer."]);
  });
});

describe("describePushStatus", () => {
  it("says what stands between the phone and Zeca's pushed answers", () => {
    expect(describePushStatus(null)).toBeNull();
    expect(describePushStatus({ authorization: "authorized", registered: true, detail: "registered" })).toBeNull();
    expect(describePushStatus({ authorization: "notDetermined", registered: false, detail: "not registered" })?.action).toBe("enable");
    const denied = describePushStatus({ authorization: "denied", registered: false, detail: "not registered" });
    expect(denied?.action).toBeNull();
    expect(denied?.text).toMatch(/Settings > Garrison > Notifications/);
    expect(describePushStatus({ authorization: "authorized", registered: false, detail: "requesting token" })?.action).toBeNull();
    const failed = describePushStatus({ authorization: "authorized", registered: false, detail: "upload failed: 503" });
    expect(failed?.action).toBe("retry");
    expect(failed?.text).toContain("upload failed: 503");
  });
});
