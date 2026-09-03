import { describe, expect, it } from "vitest";
import {
  cleanSpokenText,
  createFoldState,
  foldCaptureEvents,
  speakReply,
  watchCaptureFeedback,
  type CaptureHeard,
  type CaptureReply
} from "../packages/talk/ui/capture-feedback";

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
