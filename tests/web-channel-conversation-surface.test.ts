// The web channel's conversation surface (Conversations plan, C4).
//
// A thread IS a conversation's channel surface, so two seams changed and this
// file pins both:
//
//   1. the SEND DOOR - a typed message no longer opens a turn on the chat lane,
//      it is admitted through the conversation router, whose allowed-fields gate
//      is exact and whose refusal means the message was NOT recorded;
//   2. the SURFACE - main.tsx mounts ConversationView on the conversation lane
//      (no seeded history: the record replays itself) and keeps ClaudeChat for
//      the remote-shell lane, whose turns are delegated to an agent on another
//      machine rather than run as a stretch here.
//
// The transport is exercised for real against a stubbed `fetch`; main.tsx mounts
// itself at import (top-level createRoot), so its seam is read from source, the
// same way tests/web-channel-context.test.ts pins the console labels.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTransportError } from "@garrison/claude-chat/transport";
import type { ChatTransport } from "@garrison/claude-chat";
import {
  CONVERSATION_BASE,
  conversationMessageUrl,
  createConversationTransport,
  postConversationMessage,
} from "../fittings/seed/web-channel-default/ui/conversation-transport";

const ROOT = path.resolve(__dirname, "..");
const MAIN = readFileSync(path.join(ROOT, "fittings/seed/web-channel-default/ui/main.tsx"), "utf8");

type Call = { url: string; body: Record<string, unknown> };

function stubFetch(reply: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    calls.push(call);
    return reply(call);
  });
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The one field the wrapper is allowed to re-point. Everything else must be the
 *  SAME reference as the transport it wrapped - that is what "the FIFO lane is
 *  untouched" means in code rather than in a comment. */
const inner: ChatTransport = {
  base: "/api",
  inputLifecycle: true,
  connect: () => () => {},
  sendMessage: async () => {},
  sendKey: async () => {},
  setMode: async (mode) => ({ mode, reached: false }),
  interrupt: async () => {},
  fetchCommands: async () => [],
  uploadFile: async () => ({ path: "/tmp/x" }),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web channel — the conversation send door", () => {
  it("posts to a RELATIVE per-conversation door", () => {
    expect(CONVERSATION_BASE).toBe("/api/conversation");
    expect(conversationMessageUrl("01CONV")).toBe("/api/conversation/01CONV/message");
    // The browser is almost never on this box: an absolute machine-local URL
    // would be unreachable AND mixed content over the tailnet's HTTPS.
    expect(conversationMessageUrl("01CONV").startsWith("/")).toBe(true);
    expect(conversationMessageUrl("a b/../c")).toBe("/api/conversation/a%20b%2F..%2Fc/message");
  });

  it("sends exactly the three fields the router's gate allows", async () => {
    const calls = stubFetch(() => json(202, { accepted: true, recordedBy: "responder", seq: null }));
    const transport = createConversationTransport(inner, { conversationId: "01CONV" });
    await transport.sendMessage("ship the ladder", {
      clientRequestId: "req-1",
      // Deliberately offered and deliberately NOT forwarded: the door refuses
      // unknown fields with a 400, so carrying these would break every send.
      context: { card: "01CARD" },
      routing: { duty: "implement" },
    } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/conversation/01CONV/message");
    expect(Object.keys(calls[0].body).sort()).toEqual(["clientRequestId", "message", "origin"]);
    expect(calls[0].body).toMatchObject({ message: "ship the ladder", clientRequestId: "req-1", origin: "web" });
  });

  it("receipts the ADMISSION and settles it, because no generation follows a message", async () => {
    stubFetch(() => json(202, { accepted: true, recordedBy: "responder", seq: null }));
    const transport = createConversationTransport(inner, { conversationId: "01CONV" });
    const receipt = await transport.sendMessage("hello", { clientRequestId: "req-2" } as never);
    // `settled` is terminal: the record is in the ledger and the conversation
    // owns the work. A `running` receipt would be a spinner nothing settles -
    // a responder stretch is a conversation fact, streamed into the body.
    expect(receipt).toMatchObject({ clientRequestId: "req-2", state: "settled" });
    expect(typeof (receipt as { acceptedAt?: string }).acceptedAt).toBe("string");
  });

  it("never dresses a client coordinate up as a ledger one", async () => {
    stubFetch((call) => json(202, call.body.message === "routed" ? { seq: 7, recordedBy: "router" } : { seq: null, recordedBy: "responder" }));
    const transport = createConversationTransport(inner, { conversationId: "01CONV" });
    const routed = await transport.sendMessage("routed", { clientRequestId: "req-3" } as never);
    const forwarded = await transport.sendMessage("forwarded", { clientRequestId: "req-4" } as never);
    expect((routed as { inputId: string }).inputId).toBe("conv:01CONV#7");
    expect((forwarded as { inputId: string }).inputId).toBe("conv:req-4");
  });

  it("mints its own request id when the host has none", async () => {
    const calls = stubFetch(() => json(202, { accepted: true }));
    const transport = createConversationTransport(inner, { conversationId: "01CONV" });
    const receipt = await transport.sendMessage("no id here");
    const minted = (receipt as { clientRequestId: string }).clientRequestId;
    expect(minted).toMatch(/^conv-/);
    expect(calls[0].body.clientRequestId).toBe(minted);
  });

  it("says the message was NOT recorded when the responder is unreachable", async () => {
    stubFetch(() => json(502, { error: "the conversation responder is unreachable; the message was NOT recorded" }));
    await expect(postConversationMessage("01CONV", "hi")).rejects.toBeInstanceOf(ChatTransportError);
    try {
      await postConversationMessage("01CONV", "hi");
    } catch (err) {
      const failure = (err as ChatTransportError).failure;
      expect(failure.source).toBe("gateway");
      expect(failure.retryable).toBe(true);
      expect(failure.text).toContain("NOT recorded");
      expect(failure.httpStatus).toBe(502);
    }
  });

  it("turns a dead network into a typed transport failure, not a bare throw", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    try {
      await postConversationMessage("01CONV", "hi");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(ChatTransportError);
      expect((err as ChatTransportError).failure.code).toBe("conversation_message_unreachable");
    }
  });

  it("re-points ONE door and leaves the rest of the transport alone", () => {
    const transport = createConversationTransport(inner, { conversationId: "01CONV" });
    expect(transport.sendMessage).not.toBe(inner.sendMessage);
    expect(transport.interrupt).toBe(inner.interrupt);
    expect(transport.uploadFile).toBe(inner.uploadFile);
    expect(transport.setMode).toBe(inner.setMode);
    expect(transport.base).toBe("/api");
    expect(transport.inputLifecycle).toBe(true);
  });
});

describe("web channel — the conversation surface", () => {
  it("mounts ConversationView on the conversation lane, with no seeded history", () => {
    const start = MAIN.indexOf("<ConversationView");
    expect(start).toBeGreaterThan(-1);
    const mount = MAIN.slice(start, MAIN.indexOf("/>", start));
    expect(mount).toContain("conversationId={conversationId}");
    expect(mount).toContain("base={CONVERSATION_BASE}");
    expect(mount).toContain("transport={conversationTransport}");
    // The append-only record replays itself; seeding it from a reduced thread
    // transcript would paint the same turns twice.
    expect(mount).not.toContain("initialHistory");
    expect(mount).not.toContain("transcriptUrl");
  });

  it("keeps the Turn Rail working on the conversation lane", () => {
    const start = MAIN.indexOf("<ConversationView");
    const mount = MAIN.slice(start, MAIN.indexOf("/>", start));
    for (const prop of ["routing={pins}", "routeOptions={routeOptions}", "onPinChange={savePins}"]) {
      expect(mount).toContain(prop);
    }
  });

  it("polls the record faster than the router's default, because this is the typed-into mount", () => {
    const server = readFileSync(path.join(ROOT, "fittings/seed/web-channel-default/scripts/server.mjs"), "utf8");
    const mount = server.slice(server.indexOf("handleConversationRequest(req, res, {"));
    expect(mount.slice(0, mount.indexOf("});"))).toContain("pollMs: 300");
    // Measured on the real server: 293ms from POST to the sender seeing their own
    // message. The composer's receipt is terminal on admission, so that echo is
    // the only confirmation the message landed.
  });

  it("exempts remote-shell threads, whose turns are delegated off this machine", () => {
    expect(MAIN).toContain("const conversationId = activeRshTransport ? null : (activeThread?.conversationId ?? null);");
    // The chat lane survives for exactly that case - including the exchange
    // reduction that seeds it.
    expect(MAIN).toContain("initialHistory={history}");
    expect(MAIN).toContain("if (!activeThread || conversationId) return [] as HistoryExchange[];");
  });
});
