// The conversation SERVING layer (Conversations plan, C1): the one http router
// three surfaces mount, and the store -> SessionEvent adapter that feeds it.
//
// Two things here are load-bearing beyond the endpoints themselves:
//   - the adapter's events must survive the web channel's sanitizer UNCHANGED,
//     because that sanitizer drops a malformed event WHOLE and silently;
//   - `conversationEventId` must be spelled identically in the .mjs producer and
//     the .tsx consumer, or a search hit lands on an id nothing carries.
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore — pure .mjs
import { gatewayCancelForwarder, handleConversationRequest } from "../packages/claude-pty/src/conversation-http.mjs";
// @ts-ignore — pure .mjs
import { conversationEventId, ledgerToSessionEvents } from "../packages/claude-pty/src/conversation-adapt.mjs";
// @ts-ignore — pure .mjs (the SERVER half of the block-type whitelist)
import { sanitizeSessionEvent } from "../packages/talk/src/threads.mjs";
import { conversationEventId as conversationEventIdTsx } from "../packages/claude-chat/src/ConversationView";
import { groupSessionTurns, mergeSessionEvents, presentSessionTurn, stripHandoffFence } from "../packages/claude-chat/src/journal";

let tmp: string;
let env: Record<string, string>;
const servers: http.Server[] = [];

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "convread-"));
  env = { GARRISON_HOME: tmp };
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  rmSync(tmp, { recursive: true, force: true });
});

const TARGET = { id: "cc-sonnet", runtime: "agent-sdk", provider: "anthropic", model: "sonnet", effort: "medium" };

function seed(id: string) {
  const store = openConversation(id, { role: "gateway", env });
  store.init({ title: "Wire the search", objective: "Make conversation search land on the right row" });
  store.append({ kind: "user-message", payload: { text: "please wire the search backend", origin: "web" } });
  store.append({
    kind: "stretch-started",
    duty: "triage",
    stretch: "s1",
    payload: { stretchId: "s1", ordinal: 1, duty: "triage", target: TARGET, chosenBy: "duty-default" },
  });
  store.append({
    kind: "delegation-returned",
    stretch: "s1",
    payload: {
      delegationId: "d1",
      ok: true,
      summary: "codex reviewed the router",
      payloadRef: "payloads/delegation-d1.md",
      usedTokens: 1234,
      durationMs: 4000,
    },
  });
  store.writeHandoff(1, {
    v: 1,
    stretchId: "s1",
    duty: "triage",
    status: "complete",
    summary: "triaged: the router is the next piece",
    evidenceRefs: [],
    nextSteps: { next: "implement", why: "the shape is settled", items: [] },
    blocker: null,
    activeConstraints: [],
    failedApproaches: [],
    surprises: [],
    forceEscalation: false,
    synthesized: false,
  });
  store.append({
    kind: "handoff",
    duty: "triage",
    stretch: "s1",
    payload: {
      stretchId: "s1",
      duty: "triage",
      status: "complete",
      summary: "triaged: the router is the next piece",
      nextSteps: { next: "implement", why: "the shape is settled", items: [] },
      blocker: null,
    },
  });
  store.append({
    kind: "stretch-ended",
    duty: "triage",
    stretch: "s1",
    payload: { stretchId: "s1", outcome: "handoff", usedTokens: 900, durationMs: 12_000, model: "sonnet" },
  });
  store.append({
    kind: "card-state-changed",
    payload: { cardId: id, from: { list: "todo" }, to: { list: "running" }, by: "launcher" },
  });
  store.writeNamedPayload("delegation-d1.md", "# the codex review\n\nit looked fine.\n");
  return store;
}

/** A request with the path sent VERBATIM - node's http client does not resolve
 *  `.` / `..` / `%2E` the way fetch does, which is the only way to put a hostile
 *  ref in front of the server. */
function rawGet(base: string, requestPath: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: Number(port), path: requestPath, method: "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

interface Mounted {
  base: string;
  forwardMessage: ReturnType<typeof vi.fn>;
  digs: Array<Record<string, unknown>>;
}

async function mount(opts: Record<string, unknown> = {}): Promise<Mounted> {
  const digs: Array<Record<string, unknown>> = [];
  const forwardMessage = vi.fn(async () => ({ ok: true }));
  const server = http.createServer((req, res) => {
    void handleConversationRequest(req, res, {
      env,
      pollMs: 25,
      forwardMessage,
      onDig: (dig: Record<string, unknown>) => digs.push(dig),
      ...opts,
    }).then((handled: boolean) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("unmounted");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}/api/conversation`, forwardMessage, digs };
}

describe("conversation router - reads", () => {
  it("serves meta, the raw log, L1 and one handoff", async () => {
    seed("c-read");
    const { base } = await mount();

    const meta = await (await fetch(`${base}/c-read`)).json();
    expect(meta.conversationId).toBe("c-read");
    expect(meta.summary).toContain("Wire the search");
    expect(meta.handoffs).toHaveLength(1);
    expect(meta.handoffs[0].handoff.nextSteps.next).toBe("implement");
    expect(meta.total).toBe(7);
    expect(meta.tail.map((event: { kind: string }) => event.kind)).toContain("stretch-ended");
    expect(meta.currentStretch).toBeNull();

    const log = await (await fetch(`${base}/c-read/log?fromIndex=1&limit=2`)).json();
    expect(log.events.map((event: { index: number }) => event.index)).toEqual([1, 2]);
    expect(log.nextIndex).toBe(3);
    expect(log.total).toBe(7);

    const summary = await fetch(`${base}/c-read/summary`);
    expect(summary.headers.get("content-type")).toContain("text/markdown");
    expect(await summary.text()).toContain("## Escalation floor");

    const handoff = await (await fetch(`${base}/c-read/handoff/1`)).json();
    expect(handoff.status).toBe("complete");
    expect((await fetch(`${base}/c-read/handoff/9`)).status).toBe(404);
    expect((await fetch(`${base}/c-read/handoff/notanordinal`)).status).toBe(400);
    expect((await fetch(`${base}/c-read/nonsense`)).status).toBe(404);
    expect((await fetch(`${base}/..%2Fescape`)).status).toBe(400);
  });

  it("serves a payload raw, sandboxed, and refuses every ref that is not one of ours", async () => {
    seed("c-pay");
    const { base } = await mount();

    const ok = await fetch(`${base}/c-pay/payload/delegation-d1.md`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/markdown");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    // Raw bytes, not a JSON envelope the viewer would have to unwrap.
    expect(await ok.text()).toBe("# the codex review\n\nit looked fine.\n");

    // `..`, an absolute path, a traversal, and a double-encoded traversal. These
    // go out over a RAW request: `fetch` resolves `%2E%2E` into path navigation
    // before the bytes leave the client, so a hostile ref sent that way would
    // never reach the server being tested.
    for (const ref of ["%2E%2E", "%2Fetc%2Fpasswd", "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd", "%252E%252E%252Fsummary.md", "..", "/etc/passwd"]) {
      const response = await rawGet(base, `/api/conversation/c-pay/payload/${ref}`);
      expect(response.status, ref).toBeGreaterThanOrEqual(400);
      expect(response.status, ref).toBeLessThan(500);
      expect(response.body, ref).not.toContain("root:");
      expect(response.body, ref).not.toContain("Escalation floor");
    }
    expect((await fetch(`${base}/c-pay/payload/never-written.json`)).status).toBe(404);
  });

  it("writes a dig per read and debounces repeats of the same ref", async () => {
    seed("c-dig");
    const { base, digs } = await mount();
    await fetch(`${base}/c-dig/payload/delegation-d1.md`);
    await fetch(`${base}/c-dig/payload/delegation-d1.md`);
    await fetch(`${base}/c-dig/handoff/1`);
    expect(digs).toEqual([
      { conversationId: "c-dig", target: "payload", ref: "delegation-d1.md", by: "human" },
      { conversationId: "c-dig", target: "handoff", ref: "1", by: "human" },
    ]);
  });

  it("the default dig recorder writes into the conversation it read", async () => {
    const store = seed("c-dig-default");
    const { base } = await mount({ onDig: undefined });
    await fetch(`${base}/c-dig-default/payload/delegation-d1.md`);
    const digRows = store.tail(50, { kinds: ["dig"] });
    expect(digRows).toHaveLength(1);
    expect(digRows[0].payload).toMatchObject({ target: "payload", ref: "delegation-d1.md", by: "human" });
  });
});

describe("conversation router - stream", () => {
  const answer = "1. Concurrent requests both pass the check. Use atomic unique admission.\n\n2. A crash after model execution can cause replay; provider cooperation is required.";
  const savedReply = `${answer}\n\n\`\`\`handoff\n{"summary":"Bookkeeping only"}\n\`\`\``;

  async function firstFrame(base: string, id: string, from = 0) {
    const response = await fetch(`${base}/${id}/stream?from=${from}`, { signal: AbortSignal.timeout(3000) });
    const reader = response.body!.getReader();
    let text = "";
    try {
      while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
      return JSON.parse(text.slice(6, text.indexOf("\n\n")));
    } finally {
      await reader.cancel();
    }
  }

  function replyStore(id: string, replyRef = "payloads/stretch-0001-reply.md") {
    const store = openConversation(id, { role: "gateway", env });
    store.append({ kind: "user-message", payload: { text: "Review the synthetic code" } });
    store.append({ kind: "stretch-started", stretch: "reply-s1", payload: { target: TARGET } });
    store.writeNamedPayload("stretch-0001-reply.md", savedReply);
    const finish = () => {
      store.append({ kind: "handoff", stretch: "reply-s1", payload: { summary: "Bookkeeping only", nextSteps: { next: "done" } } });
      store.append({ kind: "stretch-ended", stretch: "reply-s1", payload: { replyRef, next: "done", model: "gpt-6-astra" } });
    };
    return { store, finish };
  }

  it.each([0, 3])("replays the complete saved answer through the real stream and renderer (from=%s)", async (from) => {
    const { finish } = replyStore("c-answer-history");
    finish();
    const { base } = await mount();
    const frame = await firstFrame(base, "c-answer-history", from);
    const events = mergeSessionEvents([], frame.events.map(sanitizeSessionEvent));
    const turns = groupSessionTurns(events);
    const turn = turns.find((item) => item.assistantEvents.some((event) => event.turnId === "reply-s1"))!;
    expect(stripHandoffFence(presentSessionTurn(turn, false).primaryText)).toBe(answer);
    expect(frame.events.filter((event: any) => event.blocks.some((block: any) => block.text === savedReply))).toHaveLength(1);
    // A reconnect recreates the same identities, rather than appending a second answer.
    expect(mergeSessionEvents(events, (await firstFrame(base, "c-answer-history", from)).events)).toEqual(events);
  });

  it.each([false, true])("delivers a live answer after progress and avoids a complete streamed duplicate (%s)", async (alreadyStreamed) => {
    const { store, finish } = replyStore(`c-answer-live-${alreadyStreamed}`);
    store.append({ kind: "session-event", stretch: "reply-s1", payload: { id: "text-1", role: "assistant", blocks: [{ type: "text", text: "I am checking the two schedules." }] } });
    const { base } = await mount();
    const response = await fetch(`${base}/c-answer-live-${alreadyStreamed}/stream`, { signal: AbortSignal.timeout(3000) });
    const reader = response.body!.getReader();
    let buffered = "";
    let events: any[] = [];
    let stage = 0;
    try {
      while (!events.some((event) => event.blocks.some((block: any) => block.phase === "ended"))) {
        buffered += new TextDecoder().decode((await reader.read()).value);
        let at: number;
        while ((at = buffered.indexOf("\n\n")) !== -1) {
          const raw = buffered.slice(0, at); buffered = buffered.slice(at + 2);
          if (!raw.startsWith("data: ")) continue;
          const frame = JSON.parse(raw.slice(6));
          events = mergeSessionEvents(events, frame.events ?? []);
          if (stage === 0) {
            stage = 1;
            if (alreadyStreamed) store.append({ kind: "session-event", stretch: "reply-s1", payload: { id: "text-1", role: "assistant", blocks: [{ type: "text", text: savedReply }] } });
            else finish();
          } else if (stage === 1 && alreadyStreamed) {
            // Final tee and settlement arrive in separate SSE batches.
            stage = 2; finish();
          }
        }
      }
      const turn = groupSessionTurns(events).find((item) => item.assistantEvents.some((event) => event.turnId === "reply-s1"))!;
      expect(stripHandoffFence(presentSessionTurn(turn, false).primaryText)).toBe(answer);
      expect(events.filter((event) => event.blocks.some((block: any) => block.text === savedReply))).toHaveLength(1);
      for (const event of events) expect(sanitizeSessionEvent(event)).not.toBeNull();
    } finally {
      await reader.cancel();
    }
  });

  it.each(["../outside.md", "/etc/passwd", "payloads/../outside.md", "payloads/%2e%2e/outside.md", "payloads/missing.md", "symlink", "directory-symlink", "oversize"])("does not hydrate unsafe or unavailable reply %s", async (mode) => {
    const validRef = "payloads/stretch-0001-reply.md";
    const id = `c-answer-unsafe-${mode.replace(/[^a-z]+/g, "-")}`;
    const special = ["symlink", "directory-symlink", "oversize"].includes(mode);
    const { store, finish } = replyStore(id, special ? validRef : mode);
    const file = path.join(store.dir, validRef);
    const outside = path.join(tmp, "outside.md");
    writeFileSync(outside, "PRIVATE_OUTSIDE_SENTINEL");
    if (mode === "symlink") { rmSync(file); symlinkSync(outside, file); }
    if (mode === "directory-symlink") {
      const elsewhere = path.join(tmp, "elsewhere"); mkdirSync(elsewhere);
      writeFileSync(path.join(elsewhere, "stretch-0001-reply.md"), "PRIVATE_OUTSIDE_SENTINEL");
      rmSync(path.dirname(file), { recursive: true }); symlinkSync(elsewhere, path.dirname(file));
    }
    if (mode === "oversize") writeFileSync(file, "X".repeat(1024 * 1024 + 1));
    finish();
    const { base } = await mount();
    const frame = await firstFrame(base, id);
    expect(frame.events.some((event: any) => event.id.includes("#reply:"))).toBe(false);
    expect(JSON.stringify(frame)).not.toContain("PRIVATE_OUTSIDE_SENTINEL");
    expect(frame.events.some((event: any) => event.blocks.some((block: any) => block.phase === "ended"))).toBe(true);
  });

  it.each([
    { name: "an existing history beyond the initial page", initial: 2105, burst: 0 },
    { name: "a live burst beyond two delta pages", initial: 1, burst: 1205 },
  ])("drains $name without requiring another write", async ({ initial, burst }) => {
    const id = `c-backlog-${initial}`;
    const store = openConversation(id, { role: "gateway", env });
    const append = (index: number) => {
      expect(store.append({ kind: "user-message", payload: { text: `message ${index}`, origin: "web" } }).ok).toBe(true);
    };
    for (let index = 0; index < initial; index += 1) append(index);
    const { base } = await mount();
    const response = await fetch(`${base}/${id}/stream`, { signal: AbortSignal.timeout(3000) });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const ids: string[] = [];
    let buffered = "";
    let appended = false;
    try {
      while (ids.length < initial + burst) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffered.indexOf("\n\n")) !== -1) {
          const raw = buffered.slice(0, at);
          buffered = buffered.slice(at + 2);
          if (!raw.startsWith("data: ")) continue;
          const frame = JSON.parse(raw.slice(6));
          ids.push(...(frame.events ?? []).map((event: { id: string }) => event.id));
          if (frame.type === "init" && !appended) {
            appended = true;
            for (let index = initial; index < initial + burst; index += 1) append(index);
          }
        }
      }
      expect(ids).toEqual(Array.from({ length: initial + burst }, (_, index) => conversationEventId(id, index)));
    } finally {
      await reader.cancel().catch(() => {});
    }
  });

  it("emits init from the requested index, then a delta when the ledger grows", async () => {
    const store = seed("c-stream");
    const { base } = await mount();
    const response = await fetch(`${base}/c-stream/stream?from=0`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const frames: Array<Record<string, any>> = [];
    const pump = async (until: (f: Array<Record<string, any>>) => boolean) => {
      const deadline = Date.now() + 8000;
      while (!until(frames) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffered.indexOf("\n\n")) !== -1) {
          const raw = buffered.slice(0, at);
          buffered = buffered.slice(at + 2);
          if (raw.startsWith("data: ")) frames.push(JSON.parse(raw.slice(6)));
        }
      }
    };

    await pump((f) => f.length >= 1);
    expect(frames[0].type).toBe("init");
    expect(frames[0].live).toBe(true);
    // conversation-opened + user message + stretch + delegation + handoff +
    // stretch-ended (a revision of the started row) + card move.
    expect(frames[0].events.length).toBe(7);
    expect(frames[0].events[1]).toMatchObject({ role: "user" });

    store.append({ kind: "user-message", payload: { text: "one more thing", origin: "web" } });
    await pump((f) => f.length >= 2);
    expect(frames[1].type).toBe("events");
    expect(frames[1].events).toHaveLength(1);
    expect(frames[1].events[0].id).toBe(conversationEventId("c-stream", 7));
    await reader.cancel();
  });
});

describe("conversation router - message", () => {
  it("stops the addressed conversation through the real gateway cancel door", async () => {
    const cancellations: unknown[] = [];
    const gateway = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      cancellations.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ cancelled: true }));
    });
    servers.push(gateway);
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const port = (gateway.address() as { port: number }).port;
    const { base } = await mount({ forwardCancel: gatewayCancelForwarder(`http://127.0.0.1:${port}`) });
    const response = await fetch(`${base}/c-stop/cancel`, { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ cancelled: true, conversationId: "c-stop" });
    expect(cancellations).toEqual([{ path: "/conversation/cancel", body: { conversationId: "c-stop" } }]);
  });

  it("reports an unavailable stop and a conversation already settled without claiming cancellation", async () => {
    const unavailable = await mount();
    expect((await fetch(`${unavailable.base}/c-stop/cancel`, { method: "POST" })).status).toBe(503);
    const settled = await mount({ forwardCancel: async () => ({ ok: false, status: 404, error: "no advancing conversation" }) });
    const response = await fetch(`${settled.base}/c-stop/cancel`, { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no advancing conversation" });
  });

  it("refuses unknown fields, forwards, and records what the responder did not", async () => {
    const store = seed("c-msg");
    const { base, forwardMessage } = await mount();

    const rejected = await fetch(`${base}/c-msg/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi", cwd: "/etc" }),
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain("cwd");
    expect(forwardMessage).not.toHaveBeenCalled();

    const empty = await fetch(`${base}/c-msg/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    expect(empty.status).toBe(400);

    const accepted = await fetch(`${base}/c-msg/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "carry on", clientRequestId: "req-1", origin: "web" }),
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ accepted: true, recordedBy: "router" });
    expect(forwardMessage).toHaveBeenCalledWith({
      conversationId: "c-msg",
      message: "carry on",
      clientRequestId: "req-1",
      origin: "web",
      context: null,
      routing: null,
    });
    const messages = store.tail(50, { kinds: ["user-message"] });
    expect(messages.at(-1).payload.text).toBe("carry on");
  });

  it("forwards host context and a Turn Rail routing pin with the message", async () => {
    seed("c-msg-ctx");
    const { base, forwardMessage } = await mount();
    const accepted = await fetch(`${base}/c-msg-ctx/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "go", context: "card brief: the settings tab", routing: { rung: "top" } }),
    });
    expect(accepted.status).toBe(202);
    expect(forwardMessage).toHaveBeenCalledWith(
      expect.objectContaining({ context: "card brief: the settings tab", routing: { rung: "top" } })
    );
  });

  it("refuses a non-object routing and a non-string context", async () => {
    seed("c-msg-bad");
    const { base, forwardMessage } = await mount();
    const badRouting = await fetch(`${base}/c-msg-bad/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "go", routing: ["top"] }),
    });
    expect(badRouting.status).toBe(400);
    const badContext = await fetch(`${base}/c-msg-bad/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "go", context: 42 }),
    });
    expect(badContext.status).toBe(400);
    expect(forwardMessage).not.toHaveBeenCalled();
  });

  it("does not double-write when the responder already recorded the message", async () => {
    const store = seed("c-msg2");
    const { base } = await mount({ forwardMessage: async () => ({ ok: true, recorded: true }) });
    const response = await fetch(`${base}/c-msg2/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "the gateway logs this one" }),
    });
    expect(await response.json()).toMatchObject({ recordedBy: "responder" });
    expect(store.tail(50, { kinds: ["user-message"] })).toHaveLength(1);
  });

  it("records nothing when the responder is unreachable", async () => {
    const store = seed("c-msg3");
    const { base } = await mount({ forwardMessage: async () => ({ ok: false, error: "ECONNREFUSED" }) });
    const response = await fetch(`${base}/c-msg3/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "nobody is home" }),
    });
    expect(response.status).toBe(502);
    expect(store.tail(50, { kinds: ["user-message"] })).toHaveLength(1); // only the seeded one
  });

  it("refuses to accept a message on a mount with no forwarder", async () => {
    seed("c-msg4");
    const { base } = await mount({ forwardMessage: null });
    const response = await fetch(`${base}/c-msg4/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "into the void" }),
    });
    expect(response.status).toBe(500);
  });
});

describe("conversation router - note", () => {
  it("appends a note nobody answers, dedupes on the client id, and renders it as assistant text", async () => {
    const store = seed("c-note");
    const { base, forwardMessage } = await mount();

    const rejected = await fetch(`${base}/c-note/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", message: "no" }),
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain("message");

    const empty = await fetch(`${base}/c-note/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    expect(empty.status).toBe(400);

    const post = () => fetch(`${base}/c-note/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Recording ended: screen audio", origin: "capture", clientRequestId: "capture-digest:s1" }),
    });
    const first = await post();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, conversationId: "c-note", duplicate: false });
    const second = await post();
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ accepted: true, duplicate: true });

    // A note never opens a responder stretch and never becomes a user message.
    expect(forwardMessage).not.toHaveBeenCalled();
    const notes = store.tail(50, { kinds: ["note"] });
    expect(notes).toHaveLength(1);
    expect(notes[0].payload).toMatchObject({ text: "Recording ended: screen audio", origin: "capture", clientRequestId: "capture-digest:s1" });
    expect(store.tail(50, { kinds: ["user-message"] })).toHaveLength(1); // only the seeded one

    const events = ledgerToSessionEvents(store.range({ fromIndex: 0, limit: 100 }).events, { conversationId: "c-note" });
    const rendered = events.find((event: any) => event.blocks?.some((block: any) => block.text === "Recording ended: screen audio"));
    expect(rendered).toBeTruthy();
    expect(rendered.role).toBe("assistant");
    expect(sanitizeSessionEvent(rendered)).not.toBeNull();
  });
});

describe("conversation router - search", () => {
  it("returns conversation coordinates and never a file path", async () => {
    seed("c-search");
    const { base } = await mount();
    const body = await (await fetch(`${base}/search?q=${encodeURIComponent("wire the search backend")}&id=c-search`)).json();
    expect(body.hits.length).toBeGreaterThan(0);
    const hit = body.hits.find((h: { kind: string }) => h.kind === "user-message");
    expect(hit).toBeTruthy();
    expect(hit.conversationId).toBe("c-search");
    expect(hit.seq).toBe(1);
    expect(hit.snippet).toContain("wire the search backend");
    for (const each of body.hits) {
      expect(JSON.stringify(each)).not.toContain(tmp);
      expect(JSON.stringify(each)).not.toContain("log.jsonl");
    }
  });

  it("finds L1 and L2 too, and maps a handoff file to its ledger row", async () => {
    seed("c-search2");
    const { base } = await mount();
    const l1 = await (await fetch(`${base}/search?q=${encodeURIComponent("Wire the search")}&id=c-search2`)).json();
    expect(l1.hits.some((h: { kind: string }) => h.kind === "summary")).toBe(true);
    const l2 = await (await fetch(`${base}/search?q=${encodeURIComponent("the shape is settled")}&id=c-search2`)).json();
    const handoffHit = l2.hits.find((h: { kind: string }) => h.kind === "handoff");
    expect(handoffHit).toBeTruthy();
    // handoffs/0001.json is the first `handoff` ledger row, at index 4.
    expect(handoffHit.seq).toBe(4);
  });

  it("caps results and says so", async () => {
    const store = openConversation("c-many", { role: "gateway", env });
    store.init({ title: "many" });
    for (let i = 0; i < 60; i += 1) {
      store.append({ kind: "user-message", payload: { text: `needle-${i} recurring-token`, origin: "web" } });
    }
    const { base } = await mount();
    const body = await (await fetch(`${base}/search?q=recurring-token&id=c-many&limit=10`)).json();
    expect(body.hits).toHaveLength(10);
    expect(body.truncated).toBe(true);
  });

  it("treats a flag-shaped query as a needle, not as options", async () => {
    seed("c-hostile");
    const { base } = await mount();
    const response = await fetch(`${base}/search?q=${encodeURIComponent("-r /etc")}&id=c-hostile`);
    expect(response.status).toBe(200);
    expect((await response.json()).hits).toEqual([]);
    expect((await fetch(`${base}/search?id=c-hostile`)).status).toBe(400);
  });

  it("searches every conversation when no id is given", async () => {
    seed("c-all-a");
    seed("c-all-b");
    const { base } = await mount();
    const body = await (await fetch(`${base}/search?q=${encodeURIComponent("wire the search backend")}`)).json();
    expect(new Set(body.hits.map((h: { conversationId: string }) => h.conversationId))).toEqual(
      new Set(["c-all-a", "c-all-b"])
    );
  });
});

describe("ledger -> SessionEvent adapter", () => {
  it("round-trips through the web channel sanitizer with nothing dropped", () => {
    seed("c-adapt");
    const store = openConversation("c-adapt", { role: "reader", env });
    const events = ledgerToSessionEvents(store.range({ fromIndex: 0, limit: 100 }).events, {
      conversationId: "c-adapt",
    });
    expect(events).toHaveLength(7);
    for (const event of events) {
      // The sanitizer refuses a malformed event WHOLE - a null here means the
      // conversation would silently vanish from a persisted transcript.
      expect(sanitizeSessionEvent(event), JSON.stringify(event)).not.toBeNull();
    }
    const types = events.flatMap((event: { blocks: Array<{ type: string }> }) => event.blocks.map((b) => b.type));
    expect(new Set(types)).toEqual(new Set(["text", "stretch", "ledger"]));
  });

  it("settles a stretch in place: ended REVISES started under one stable id", () => {
    seed("c-rev");
    const store = openConversation("c-rev", { role: "reader", env });
    const events = ledgerToSessionEvents(store.range({ fromIndex: 0, limit: 100 }).events, {
      conversationId: "c-rev",
    });
    const stretchEvents = events.filter((event: { blocks: Array<{ type: string }> }) =>
      event.blocks.some((block) => block.type === "stretch")
    );
    expect(stretchEvents).toHaveLength(2);
    expect(stretchEvents[0].id).toBe(stretchEvents[1].id);
    expect(stretchEvents[0].revision).toBe(0);
    expect(stretchEvents[1].revision).toBe(1);
    expect(stretchEvents[1].order).toBe(stretchEvents[0].order);
    expect(stretchEvents[0].blocks[0]).toMatchObject({
      phase: "started",
      stretchId: "s1",
      duty: "triage",
      chosenBy: "duty-default",
      attribution: { runtime: "agent-sdk", model: "sonnet", effort: "medium" },
    });
    expect(stretchEvents[1].blocks[0]).toMatchObject({ phase: "ended", outcome: "handoff", usedTokens: 900 });
  });

  it("emits a standalone ended boundary when its started row is outside the window", () => {
    seed("c-window");
    const store = openConversation("c-window", { role: "reader", env });
    // Start AFTER the stretch-started record (index 2).
    const events = ledgerToSessionEvents(store.range({ fromIndex: 3, limit: 100 }).events, {
      conversationId: "c-window",
    });
    const ended = events.find((event: { blocks: Array<{ phase?: string }> }) => event.blocks[0]?.phase === "ended");
    expect(ended.revision).toBe(0);
    expect(ended.id).toBe(conversationEventId("c-window", 5));
    expect(sanitizeSessionEvent(ended)).not.toBeNull();
  });

  it.each([true, false])("settled runtime attribution survives separate SSE batches and sanitizer (effortApplied=%s)", (effortApplied) => {
    const stretchStarts = new Map();
    const record = (index: number, kind: string, payload: object) => ({ index, kind, stretch: "codex-proof", payload });
    const opts = { conversationId: "c-attribution", stretchStarts };
    const started = ledgerToSessionEvents([record(0, "stretch-started", {
      target: { id: "requested", runtime: "codex", model: "requested-model", effort: "max" }
    })], opts)[0];
    expect(started.blocks[0].attribution).not.toHaveProperty("account");
    expect(started.blocks[0].attribution).not.toHaveProperty("effortApplied");
    ledgerToSessionEvents([record(1, "stretch-routing", {
      runtime: "codex", model: "gpt-6-astra", provider: "chatgpt-subscription", account: "chatgpt", target: "astra-sub"
    })], opts);
    const [ended] = ledgerToSessionEvents([record(2, "stretch-ended", {
      runtime: "codex", provider: "chatgpt-subscription", model: "gpt-6-astra", target: "astra-sub", effort: "high", effortApplied
    })], opts);
    expect(ended.id).toBe(started.id);
    expect(ended.revision).toBe(1);
    expect(sanitizeSessionEvent(ended)?.blocks[0].attribution).toEqual({
      route: "astra-sub", runtime: "codex", provider: "chatgpt-subscription", model: "gpt-6-astra",
      effort: "high", effortApplied, account: "chatgpt"
    });
    const [standalone] = ledgerToSessionEvents([record(2, "stretch-ended", {
      runtime: "codex", model: "gpt-6-astra", effort: "high", effortApplied
    })], { conversationId: "c-windowed" });
    expect(sanitizeSessionEvent(standalone)?.blocks[0].attribution).toEqual({
      runtime: "codex", model: "gpt-6-astra", effort: "high", effortApplied
    });
  });

  it("maps the store's open vocabulary onto the renderer's closed one", () => {
    const store = openConversation("c-kinds", { role: "gateway", env });
    store.init({ title: "kinds" });
    store.append({ kind: "escalation", duty: "implement", payload: { from: "middle", to: "top", reason: "tripwire" } });
    store.append({ kind: "policy-rewrite", payload: { from: "done", to: "review", reason: "reviewBeforeDone" } });
    store.append({ kind: "summary-trimmed", payload: { dropped: ["decision: a"], preTrimRef: "payloads/abc.json" } });
    store.append({ kind: "card-materialized", payload: { cardId: "c-kinds", list: "todo", title: "A card" } });
    store.append({ kind: "delegation-failed", payload: { delegationId: "d9", code: "empty-output", message: "nothing came back" } });
    // Not rendered: a read trace is not a fact about the work, and an unknown
    // kind must never be invented into a row.
    store.append({ kind: "dig", payload: { target: "payload", ref: "x" } });
    store.append({ kind: "some-future-kind", payload: { hello: "world" } });

    const events = ledgerToSessionEvents(store.range({ fromIndex: 0, limit: 100 }).events, {
      conversationId: "c-kinds",
    });
    const rows = events.map((event: { blocks: Array<Record<string, unknown>> }) => event.blocks[0]);
    expect(rows.map((row: Record<string, unknown>) => row.kind)).toEqual([
      "card-state-changed", // conversation-opened
      "escalation",
      "policy-rewrite",
      "policy-rewrite", // summary-trimmed
      "card-state-changed", // card-materialized
      "delegation-failed",
    ]);
    expect(rows[0].title).toContain("Conversation opened");
    expect(rows[3].title).toContain("Summary trimmed");
    expect(rows[3].payloadRef).toBe("abc.json"); // bare, as the payload route wants it
    expect(rows[4].title).toContain("Card materialized");
    for (const event of events) expect(sanitizeSessionEvent(event)).not.toBeNull();
  });

  it("conversationEventId is spelled the same in the producer and the consumer", () => {
    // Producer: packages/claude-pty/src/conversation-adapt.mjs
    // Consumer: packages/claude-chat/src/ConversationView.tsx
    expect(conversationEventId("01J", 42)).toBe("01J#42");
    expect(conversationEventIdTsx("01J", 42)).toBe(conversationEventId("01J", 42));
  });
});

describe("ledger -> SessionEvent adapter: teed session events", () => {
  it.each(["split", "later-progress", "terminal"])("keeps complete reply as final prose after %s tee envelopes", (mode) => {
    const answer = "First finding.\n\nSecond finding.";
    const replyTexts = new Map();
    const eventSlots = new Map();
    const opts = { conversationId: "c-final-position", replyTexts, eventSlots, readReply: () => answer };
    const texts = mode === "split" ? ["First finding.", "Second finding."] : mode === "later-progress" ? [answer, "Saving results."] : [answer];
    const records = texts.map((text, index) => ({
      index, kind: "session-event", stretch: "s1", payload: { id: `message-${index}`, role: "assistant", blocks: [mode === "terminal" ? { type: "turn_end", result: text } : { type: "text", text }] }
    }));
    const initial = ledgerToSessionEvents(records, opts);
    const settled = ledgerToSessionEvents([{ index: texts.length, kind: "stretch-ended", stretch: "s1", payload: { replyRef: "payloads/reply.md", next: "done" } }], opts);
    const turn = groupSessionTurns(mergeSessionEvents(initial, settled))[0];
    expect(presentSessionTurn(turn, false).primaryText).toBe(answer);
    expect(settled.filter((event: any) => event.id.includes("#reply:"))).toHaveLength(mode === "terminal" ? 0 : 1);
  });

  it("passes the stretch transcript through verbatim, stamped with the stretch turnId", () => {
    const store = openConversation("c-tee", { role: "gateway", env });
    store.init({ title: "tee" });
    store.append({ kind: "user-message", payload: { text: "go" } });
    store.append({
      kind: "session-event",
      stretch: "st_9",
      duty: "implement",
      payload: { id: "blk-1", ts: "2026-08-27T00:00:01Z", role: "assistant", blocks: [{ type: "text", text: "working on it" }] },
    });
    store.append({
      kind: "session-event",
      stretch: "st_9",
      duty: "implement",
      payload: { id: "blk-1", ts: "2026-08-27T00:00:02Z", role: "assistant", blocks: [{ type: "text", text: "working on it — done" }] },
    });
    const events = ledgerToSessionEvents(store.range({ fromIndex: 0, limit: 100 }).events, { conversationId: "c-tee" });
    const teed = events.filter((e: any) => e.turnId === "st_9" && e.blocks[0]?.type === "text");
    expect(teed).toHaveLength(2);
    // One event, revised in place: same id, same slot, bumped revision — or the
    // stream would paint a new bubble per throttle tick.
    expect(teed[1].id).toBe(teed[0].id);
    expect(teed[1].order).toBe(teed[0].order);
    expect(teed[0].revision).toBe(0);
    expect(teed[1].revision).toBe(1);
    expect(teed[1].blocks[0].text).toBe("working on it — done");
    // The channel sanitizer must keep it whole, or the prose vanishes again.
    expect(sanitizeSessionEvent(teed[1])).not.toBeNull();
  });

  it("skips a spilled tee record and a malformed one, never inventing an event", () => {
    const store = openConversation("c-tee-bad", { role: "gateway", env });
    store.init({ title: "tee" });
    store.append({ kind: "session-event", stretch: "st_9", payload: { spilled: true, bytes: 70000, sha256: "ab" } });
    store.append({ kind: "session-event", stretch: "st_9", payload: { id: "", blocks: "nope" } });
    const events = ledgerToSessionEvents(store.range({ fromIndex: 0, limit: 100 }).events, { conversationId: "c-tee-bad" });
    expect(events.filter((e: any) => e.turnId === "st_9")).toHaveLength(0);
  });
});

describe("conversation router - mounting", () => {
  it("declines a path outside its base and answers everything inside it", async () => {
    const { base } = await mount();
    const outside = await fetch(`${base.replace("/api/conversation", "")}/api/other`);
    expect(await outside.text()).toBe("unmounted");
    // Inside the base, an unknown route is this router's 404, not the mount's.
    const inside = await fetch(`${base}/c-none/who-knows`);
    expect(inside.status).toBe(404);
    expect((await inside.json()).error).toContain("no such conversation route");
  });

  it("streams a conversation that has no directory yet as live, not unavailable", async () => {
    mkdirSync(path.join(tmp, "conversations"), { recursive: true });
    writeFileSync(path.join(tmp, "conversations", ".keep"), "");
    const { base } = await mount();
    const response = await fetch(`${base}/c-brand-new/stream`);
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const frame = JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "").trim());
    expect(frame).toMatchObject({ type: "init", available: true, live: true, events: [] });
    await reader.cancel();
  });
});
