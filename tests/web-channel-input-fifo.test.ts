import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wc-input-fifo-"));
process.env.GARRISON_HOME = TMP_HOME;

// @ts-ignore plain ESM modules
const { startServer } = await import("../fittings/seed/web-channel-default/scripts/server.mjs");
// @ts-ignore plain ESM modules
const threads = await import("../fittings/seed/web-channel-default/scripts/threads.mjs");

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

type GatewayTurn = { body: any; response: http.ServerResponse; generationId: string };
let gateway: http.Server;
let web: http.Server;
let port = 0;
const turns: GatewayTurn[] = [];
const interrupts: any[] = [];
let holdNextOpen = false;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => resolve(raw));
  });
}

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function frames(raw: string) {
  return raw.split(/\r?\n\r?\n/).flatMap((block) => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (event === "message" && !data.length) return [];
    try { return [{ event, data: JSON.parse(data.join("\n")) }]; } catch { return [{ event, data: data.join("\n") }]; }
  });
}

beforeAll(async () => {
  gateway = http.createServer(async (req, res) => {
    if (req.url === "/chat/stream" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const generationId = `generation-${turns.length + 1}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      turns.push({ body, response: res, generationId });
      if (!holdNextOpen) {
        res.write(sse("open", { generationId, ts: Date.now() }));
        res.write(sse("route", { runtime: "agent-sdk", session_id: `session-${turns.length}` }));
        res.write(sse("chunk", { text: `draft-${turns.length}` }));
      } else {
        holdNextOpen = false;
      }
      return;
    }
    if (req.url === "/chat/interrupt" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      interrupts.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, generationId: body.generationId }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const started = await startServer({
    port: 0,
    host: "127.0.0.1",
    gatewayUrl: `http://127.0.0.1:${(gateway.address() as any).port}`,
    gatewayOpenTimeoutMs: 300,
  });
  web = started.server;
  if (!web.listening) await new Promise<void>((resolve) => web.once("listening", resolve));
  port = (web.address() as any).port;
});

afterAll(async () => {
  for (const turn of turns) {
    try { turn.response.end(); } catch {}
  }
  await new Promise<void>((resolve) => web.close(() => resolve()));
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

const api = (pathname: string) => `http://127.0.0.1:${port}${pathname}`;

async function admit(threadId: string, clientRequestId: string, message: string) {
  const response = await fetch(api(`/api/threads/${threadId}/inputs`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, clientRequestId }),
  });
  return { status: response.status, body: await response.json() as any };
}

describe("durable Web input FIFO", () => {
  it("runs one input at a time, binds exact generations, and keeps queued work", async () => {
    const threadId = "fifo-thread";
    await fetch(api("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: threadId }),
    });

    const first = await admit(threadId, "client-1", "first question");
    const duplicate = await admit(threadId, "client-1", "changed retry text");
    const second = await admit(threadId, "client-2", "second question");
    expect(first.status).toBe(202);
    expect(duplicate.body).toMatchObject({ duplicate: true, input: { inputId: first.body.input.inputId } });
    expect(second.status).toBe(202);
    expect(second.body.input.inputId).not.toBe(first.body.input.inputId);

    await waitFor(() => turns.length, (count) => count === 1, "first gateway turn");
    const running: any = await waitFor(
      () => threads.getThread(threadId),
      (thread) => (thread as any)?.pendingInputs?.[0]?.generationId === "generation-1",
      "first generation binding",
    );
    expect(running.pendingInputs).toMatchObject([
      { inputId: first.body.input.inputId, state: "running", generationId: "generation-1" },
      { inputId: second.body.input.inputId, state: "queued", message: "second question" },
    ]);
    const snapshot: any = await threads.getThreadSnapshot(threadId);
    expect(snapshot.inputRevision).toBe(snapshot.thread.inputRevision);
    expect(snapshot.pendingInputs).toMatchObject([
      { inputId: first.body.input.inputId, state: "running" },
      { inputId: second.body.input.inputId, state: "queued", position: 1 },
    ]);
    expect(running.messages).toMatchObject([
      { role: "user", text: "first question", turnId: first.body.input.inputId },
    ]);
    expect(turns).toHaveLength(1);

    const firstLive = await fetch(api(`/api/threads/${threadId}/inputs/${first.body.input.inputId}/live`));
    const firstLiveBody = firstLive.text();
    expect((await fetch(api(`/api/threads/${threadId}/interrupt`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationId: "generation-stale" }),
    })).status).toBe(409);
    const stopped = await fetch(api(`/api/threads/${threadId}/interrupt`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationId: "generation-1" }),
    });
    expect(stopped.status).toBe(200);
    expect(interrupts).toEqual([{ threadId, generationId: "generation-1" }]);
    expect((await fetch(api(`/api/threads/${threadId}`), { method: "DELETE" })).status).toBe(409);

    turns[0].response.write(sse("done", { reply: "first answer", stopped_by_user: true }));
    turns[0].response.end();
    await waitFor(() => turns.length, (count) => count === 2, "second gateway turn");
    expect(turns[1].body.message).toBe("second question");
    expect(turns[1].body.context).toContain("user: first question");
    expect(turns[1].body.context).toContain("assistant: first answer");
    expect(turns[1].body.context).not.toContain("user: second question");

    const secondLive = await fetch(api(`/api/threads/${threadId}/inputs/${second.body.input.inputId}/live`));
    const secondLiveBody = secondLive.text();
    turns[1].response.write(sse("session_event", {
      id: "event-second",
      role: "assistant",
      ts: Date.now(),
      order: 0,
      revision: 0,
      blocks: [{ type: "text", text: "second answer" }],
    }));
    turns[1].response.write(sse("done", { reply: "second answer" }));
    turns[1].response.end();

    const [firstRaw, secondRaw] = await Promise.all([firstLiveBody, secondLiveBody]);
    expect(frames(firstRaw).find((frame) => frame.event === "done")?.data).toMatchObject({
      inputId: first.body.input.inputId,
      generationId: "generation-1",
      stopped_by_user: true,
    });
    expect(frames(secondRaw).find((frame) => frame.event === "session_event")?.data).toMatchObject({
      inputId: second.body.input.inputId,
      turnId: second.body.input.inputId,
      generationId: "generation-2",
    });

    const settled: any = await waitFor(
      () => threads.getThread(threadId),
      (thread) => thread?.messages?.length === 4 && (thread as any)?.pendingInputs?.length === 0,
      "both persisted replies",
    );
    expect(settled.messages.map((message: any) => [message.role, message.turnId])).toEqual([
      ["user", first.body.input.inputId],
      ["assistant", first.body.input.inputId],
      ["user", second.body.input.inputId],
      ["assistant", second.body.input.inputId],
    ]);
    expect(settled.sessionEvents[0]).toMatchObject({
      id: "event-second",
      turnId: second.body.input.inputId,
      generationId: "generation-2",
    });
  });

  it("closed-validates admission and refuses Stop during the pre-open starting state", async () => {
    const threadId = "fifo-starting";
    await fetch(api("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: threadId }),
    });
    const unknown = await admit("missing-thread", "client-missing", "no owner");
    expect(unknown.status).toBe(404);
    const unsupported = await fetch(api(`/api/threads/${threadId}/inputs`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "bad", clientRequestId: "client-extra", generationId: "browser-forged" }),
    });
    expect(unsupported.status).toBe(400);
    const missingClient = await fetch(api(`/api/threads/${threadId}/inputs`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "bad" }),
    });
    expect(missingClient.status).toBe(400);

    holdNextOpen = true;
    const admitted = await admit(threadId, "client-starting", "wait for open");
    expect(admitted.status).toBe(202);
    await waitFor(() => turns.length, (count) => count === 3, "pre-open gateway turn");
    const before = interrupts.length;
    const earlyStop = await fetch(api(`/api/threads/${threadId}/interrupt`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationId: "generation-3" }),
    });
    expect(earlyStop.status).toBe(409);
    expect(await earlyStop.json()).toMatchObject({ error: "input is still starting" });
    expect(interrupts).toHaveLength(before);

    turns[2].response.write(sse("open", { generationId: "generation-3", ts: Date.now() }));
    turns[2].response.write(sse("done", { reply: "opened and finished" }));
    turns[2].response.end();
    await waitFor(
      () => threads.getThread(threadId),
      (thread) => (thread as any)?.pendingInputs?.length === 0 && thread?.messages?.length === 2,
      "starting input cleanup",
    );
  });

  it("retains and retries an authoritative reply during a storage outage before advancing the FIFO", async () => {
    const threadId = "fifo-persistence-failure";
    await fetch(api("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: threadId }),
    });
    const before = turns.length;
    const admitted = await admit(threadId, "client-persistence", "must remain durable");
    const successor = await admit(threadId, "client-persistence-successor", "run only after recovery");
    await waitFor(() => turns.length, (count) => count === before + 1, "persistence test gateway turn");
    const turn = turns[before];
    await waitFor(
      () => threads.getThread(threadId),
      (thread) => (thread as any)?.pendingInputs?.[0]?.generationId === turn.generationId,
      "persistence test generation binding",
    );
    const live = await fetch(api(`/api/threads/${threadId}/inputs/${admitted.body.input.inputId}/live`));
    const liveBody = live.text();
    const storeDir = threads._threadsDirForTest();
    fs.chmodSync(storeDir, 0o500);
    try {
      turn.response.write(sse("done", { reply: "must not be acknowledged without disk" }));
      turn.response.end();
      await new Promise((resolve) => setTimeout(resolve, 180));
      const retained: any = await threads.getThread(threadId);
      expect(retained.messages).toMatchObject([
        { role: "user", text: "must remain durable", turnId: admitted.body.input.inputId },
      ]);
      expect(retained.messages).toHaveLength(1);
      expect(retained.pendingInputs).toMatchObject([
        { inputId: admitted.body.input.inputId, state: "running", generationId: turn.generationId },
        { inputId: successor.body.input.inputId, state: "queued" },
      ]);
      expect(retained.inputReceipts).toEqual([]);
      expect(turns).toHaveLength(before + 1);
    } finally {
      fs.chmodSync(storeDir, 0o700);
    }
    await liveBody;
    await waitFor(() => turns.length, (count) => count === before + 2, "successor after persistence recovery");
    const successorTurn = turns[before + 1];
    expect(successorTurn.body.message).toBe("run only after recovery");
    successorTurn.response.write(sse("done", { reply: "successor completed" }));
    successorTurn.response.end();
    const recovered: any = await waitFor(
      () => threads.getThread(threadId),
      (thread) => (thread as any)?.pendingInputs?.length === 0 && thread?.messages?.length === 4,
      "recovered FIFO settlement",
    );
    expect(recovered.messages).toMatchObject([
      { role: "user", turnId: admitted.body.input.inputId },
      { role: "assistant", text: "must not be acknowledged without disk", turnId: admitted.body.input.inputId },
      { role: "user", turnId: successor.body.input.inputId },
      { role: "assistant", text: "successor completed", turnId: successor.body.input.inputId },
    ]);
  });

  it("fails closed when a terminal frame arrives before the gateway open identity", async () => {
    const threadId = "fifo-done-before-open";
    await fetch(api("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: threadId }),
    });
    const before = turns.length;
    holdNextOpen = true;
    const admitted = await admit(threadId, "client-before-open", "do not trust early terminal data");
    await waitFor(() => turns.length, (count) => count === before + 1, "done-before-open gateway turn");
    turns[before].response.write(sse("done", { reply: "unbound reply" }));
    turns[before].response.end();

    const failed: any = await waitFor(
      () => threads.getThread(threadId),
      (thread) => (thread as any)?.pendingInputs?.length === 0,
      "done-before-open failure",
    );
    expect(failed.messages).toMatchObject([
      { role: "user", turnId: admitted.body.input.inputId },
      { role: "assistant", turnId: admitted.body.input.inputId },
    ]);
    expect(failed.messages[1].text).toContain("before its open frame");
    expect(failed.inputReceipts.at(-1)).toMatchObject({
      inputId: admitted.body.input.inputId,
      state: "failed",
    });
    expect(failed.inputReceipts.at(-1)).not.toHaveProperty("generationId");
  });

  it("locks the first gateway generation and rejects a conflicting second open", async () => {
    const threadId = "fifo-conflicting-open";
    await fetch(api("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: threadId }),
    });
    const before = turns.length;
    holdNextOpen = true;
    const admitted = await admit(threadId, "client-conflicting-open", "bind exactly once");
    await waitFor(() => turns.length, (count) => count === before + 1, "conflicting-open gateway turn");
    const turn = turns[before];
    turn.response.write(sse("open", { generationId: "generation-authoritative" }));
    turn.response.write(sse("open", { generationId: "generation-conflict" }));
    turn.response.write(sse("done", { reply: "must be ignored" }));
    turn.response.end();

    const failed: any = await waitFor(
      () => threads.getThread(threadId),
      (thread) => (thread as any)?.pendingInputs?.length === 0,
      "conflicting-open failure",
    );
    expect(failed.messages[1].text).toContain("conflicting generationId");
    expect(failed.inputReceipts.at(-1)).toMatchObject({
      inputId: admitted.body.input.inputId,
      generationId: "generation-authoritative",
      state: "failed",
    });
  });

  it("times out a pre-open gateway hang and advances the durable successor", async () => {
    const threadId = "fifo-open-timeout";
    await fetch(api("/api/threads"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: threadId }),
    });
    const before = turns.length;
    holdNextOpen = true;
    const stuck = await admit(threadId, "client-stuck-open", "gateway never opens");
    const successor = await admit(threadId, "client-after-timeout", "must run after timeout");
    await waitFor(() => turns.length, (count) => count === before + 1, "stuck gateway turn");
    await waitFor(() => turns.length, (count) => count === before + 2, "successor after open timeout");
    const successorTurn = turns[before + 1];
    expect(successorTurn.body.message).toBe("must run after timeout");
    successorTurn.response.write(sse("done", { reply: "ran after timeout" }));
    successorTurn.response.end();

    const settled: any = await waitFor(
      () => threads.getThread(threadId),
      (thread) => (thread as any)?.pendingInputs?.length === 0,
      "timeout successor settlement",
    );
    expect(settled.messages).toMatchObject([
      { role: "user", turnId: stuck.body.input.inputId },
      { role: "assistant", turnId: stuck.body.input.inputId },
      { role: "user", turnId: successor.body.input.inputId },
      { role: "assistant", text: "ran after timeout", turnId: successor.body.input.inputId },
    ]);
    expect(settled.messages[1].text).toContain("did not open");
  });
});
