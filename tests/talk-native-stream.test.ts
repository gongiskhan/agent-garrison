import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-ignore — standalone fitting module
import { localSessionForStream } from "../packages/talk/src/mesh-sessions.mjs";

let home: string;
let database: string;
let router: any;
const servers: Server[] = [];
const clients: AbortController[] = [];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
}
function indexAt(base: string) {
  writeFileSync(path.join(home, "ui-fittings", "remote-shell-runtime.json"), JSON.stringify({ url: base }));
}
const selected = () => ({ id: "cursor-local", runtime: "cursor", kind: "desktop", status: "idle",
  transcript: { path: database, format: "cursor-desktop-db" } });
function sendIndex(res: http.ServerResponse, rows: unknown[]) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ rows }));
}
async function connect(base: string, id = "cursor-local") {
  const controller = new AbortController();
  clients.push(controller);
  return fetch(`${base}/api/sessions/${id}/stream?path=/unindexed/private-file`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
  });
}
async function firstData(reader: ReadableStreamDefaultReader<Uint8Array>, prefix = "") {
  let text = prefix;
  while (!/^data: (.+)$/m.test(text)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("stream ended before an initial data frame");
    text += new TextDecoder().decode(chunk.value);
  }
  return JSON.parse(text.match(/^data: (.+)$/m)![1]);
}

beforeAll(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "talk-native-stream-"));
  mkdirSync(path.join(home, "ui-fittings"));
  database = path.join(home, "cursor.vscdb");
  execFileSync("sqlite3", [database, `create table cursorDiskKV(key text primary key,value text);
    insert into cursorDiskKV values ('composerData:cursor-local','{"fullConversationHeadersOnly":[{"bubbleId":"a1"}]}');
    insert into cursorDiskKV values ('bubbleId:cursor-local:a1','{"bubbleId":"a1","type":2,"text":"Synthetic Cursor output."}');`]);
  // Import does not boot a runtime; fixtures supply only the standalone router.
  // @ts-ignore — standalone fitting module
  const { createTalkRouter } = await import("../packages/talk/src/router.mjs");
  router = createTalkRouter({});
});
beforeEach(() => {
  vi.stubEnv("GARRISON_HOME", home);
  vi.stubEnv("GARRISON_NODE_NAME", "owner");
});
afterEach(async () => {
  for (const controller of clients.splice(0)) controller.abort();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("owner-local native stream lookup", () => {
  it("flushes immediately and reads indexed Cursor output without contacting a stalled authority", async () => {
    let authorityRequests = 0;
    const authority = await serve(() => { authorityRequests += 1; });
    vi.stubEnv("GARRISON_STATE_URL", authority);
    vi.stubEnv("GARRISON_STATE_TOKEN", "fixture-only");
    const entered = gate(), release = gate();
    indexAt(await serve((_req, res) => {
      entered.release();
      void release.promise.then(() => sendIndex(res, [selected()]));
    }));
    const base = await serve((req, res) => { void router(req, res); });
    const response = await connect(base);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain(": opening session output");
    expect(initial).not.toContain("data:");
    await entered.promise;
    expect(authorityRequests).toBe(0);
    release.release();
    expect(await firstData(reader)).toMatchObject({ type: "init", available: true,
      events: [{ blocks: [{ text: "Synthetic Cursor output." }] }] });
    expect(authorityRequests).toBe(0);
  });

  it("retries a temporary index failure and does not cache an empty result", async () => {
    let reads = 0;
    indexAt(await serve((_req, res) => {
      if (++reads === 1) { res.writeHead(503); res.end(); }
      else sendIndex(res, [selected()]);
    }));
    const result = await localSessionForStream("cursor-local");
    expect(reads).toBe(2);
    expect(result).toMatchObject({ available: true, row: { id: "cursor-local", node: "owner" } });
  });

  it("keeps a temporary outage retryable, then recovers on the next EventSource connection", async () => {
    let unavailable = true, reads = 0;
    indexAt(await serve((_req, res) => {
      reads += 1;
      if (unavailable) { res.writeHead(503); res.end(); }
      else sendIndex(res, [selected()]);
    }));
    const base = await serve((req, res) => { void router(req, res); });
    const text = await (await connect(base)).text();
    expect(reads).toBe(2);
    expect(text).toContain("retry: 2000");
    expect(text).toContain('"code":"session-index-unavailable","retryable":true');
    expect(text).not.toContain('"type":"end"');
    expect(text).not.toContain('"available":false');
    unavailable = false;
    const reader = (await connect(base)).body!.getReader();
    expect(await firstData(reader)).toMatchObject({ type: "init", available: true });
  });

  it("ends only after a successful owner index proves the id absent", async () => {
    indexAt(await serve((_req, res) => sendIndex(res, [selected()])));
    const base = await serve((req, res) => { void router(req, res); });
    const text = await (await connect(base, "unknown-id")).text();
    expect(text).toContain('"type":"init","available":false');
    expect(text).toContain('"type":"end"');
    expect(text).not.toContain("Synthetic Cursor output");
  });

  it("treats malformed indexes as unavailable and bounds each stalled attempt", async () => {
    indexAt("http://127.0.0.1:1");
    const malformed = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    expect(await localSessionForStream("cursor-local", { fetchImpl: malformed })).toEqual({ available: false, row: null });
    expect(malformed).toHaveBeenCalledTimes(2);
    const stalled = vi.fn((_url: string, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    expect(await localSessionForStream("cursor-local", { fetchImpl: stalled, timeoutMs: 20 })).toEqual({ available: false, row: null });
    expect(stalled).toHaveBeenCalledTimes(2);
  });

  it("aborts the pending owner lookup when its viewer closes without starting a retry", async () => {
    const entered = gate(), disconnected = gate();
    let reads = 0;
    indexAt(await serve((_req, res) => {
      reads += 1; entered.release(); res.once("close", disconnected.release);
    }));
    const base = await serve((req, res) => { void router(req, res); });
    await connect(base);
    await entered.promise;
    clients.at(-1)!.abort();
    await disconnected.promise;
    expect(reads).toBe(1);
  });

  it.each(["cursor-agent-jsonl", "cursor-desktop-db"])("replays recent %s output in complete small frames without dropping latest text", async (format) => {
    const file = path.join(home, `large-${format}`);
    const allText = Array.from({ length: 1514 }, (_, i) => `Event ${i}: ${"é".repeat(1000)}`);
    if (format === "cursor-agent-jsonl") {
      writeFileSync(file, allText.map((text) => JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } })).join("\n") + "\n");
    } else {
      const headers = allText.map((_, i) => ({ bubbleId: `a${i}` }));
      const statements = allText.map((text, i) => `insert into cursorDiskKV values ('bubbleId:cursor-large:a${i}','${JSON.stringify({ bubbleId: `a${i}`, type: 2, text })}');`);
      execFileSync("sqlite3", [file], { input: `create table cursorDiskKV(key text primary key,value text);
        insert into cursorDiskKV values ('composerData:cursor-large','${JSON.stringify({ fullConversationHeadersOnly: headers })}');
        ${statements.join("\n")}` });
    }
    indexAt(await serve((_req, res) => sendIndex(res, [{ ...selected(), id: "cursor-large", transcript: { path: file, format } }])));
    const base = await serve((req, res) => { void router(req, res); });
    const reader = (await connect(base, "cursor-large")).body!.getReader();
    const expected = allText.slice(format === "cursor-desktop-db" ? -100 : -500);
    const frames: any[] = [];
    const events: any[] = [];
    const decoder = new TextDecoder();
    let pending = "";
    while (events.length < expected.length) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      pending += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const wire = pending.slice(0, boundary + 2);
        pending = pending.slice(boundary + 2);
        if (!wire.startsWith("data: ")) continue;
        expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(32 * 1024);
        const frame = JSON.parse(wire.slice(6).trim());
        expect(frame.events.length).toBeLessThanOrEqual(25);
        frames.push(frame);
        events.push(...frame.events);
      }
    }
    expect(frames[0]).toMatchObject({ type: "init", available: true, live: true });
    expect(frames[0].events.length).toBeGreaterThan(0);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.slice(1).every((frame) => frame.type === "events")).toBe(true);
    expect(events.map((event) => event.blocks[0].text)).toEqual(expected);
    expect(new Set(events.map((event) => event.id)).size).toBe(expected.length);
    clients.at(-1)!.abort();
  });
});
