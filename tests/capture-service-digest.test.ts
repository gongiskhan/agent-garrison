// Capture service - G5 recording digest.
//
// A recording started from a Conversations thread carries conversation_id in
// session_start; when it ends, ONE assistant message lands in that thread
// through the conversation router's /api/conversation/:id/note door, keyed by the session id,
// and the push (when any) deep-links to /talk/<id>. Drives the real ingress
// over ws against a sandboxed GARRISON_HOME with a fake Conversations host.

import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import {
  DIGEST_TRANSCRIPT_CAP,
  buildDigest,
  digestIdempotencyKey,
  digestPath,
  postConversationDigest
} from "../fittings/seed/capture-service/lib/digest.mjs";
import { Counters } from "../fittings/seed/capture-service/lib/store.mjs";

const TOKEN = "test-capture-token";
const SID = "01DIGESTSESSION01";
const THREAD = "chat-mf0abc-xyz123";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type Posted = { url: string; body: any };

// A stand-in for the shell's thread engine: records every POST and answers 200.
async function fakeConversations(status = 200): Promise<{ base: string; posts: Posted[] }> {
  const posts: Posted[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      // The Zeca resolver polls GET /api/zeca from boot (D60); this fake is
      // only the note door, so reads are answered empty and never counted.
      if (req.method === "GET") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      posts.push({ url: req.url ?? "", body: raw ? JSON.parse(raw) : null });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ thread: { id: THREAD } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => server.close());
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}`, posts };
}

async function boot(appUrl: string) {
  const home = mkdtempSync(path.join(os.tmpdir(), "capture-digest-"));
  const env = { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN, GARRISON_APP_URL: appUrl };
  const cfg = loadConfig(env);
  const handle = await startServer({ ...cfg, env, port: 0, enabled: true });
  cleanups.push(() => {
    handle.ingress.close();
    handle.server.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { handle, home, base: `http://127.0.0.1:${handle.cfg.port}` };
}

function connect(base: string) {
  const ws = new WebSocket(base.replace("http://", "ws://") + "/capture/stream", {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  const queue: any[] = [];
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const next = (pred: (m: any) => boolean): Promise<any> => {
    const i = queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve };
      waiters.push(waiter);
      setTimeout(() => reject(new Error(`timed out (have ${JSON.stringify(queue)})`)), 5000).unref();
    });
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const closed = new Promise<{ code: number }>((resolve) => ws.on("close", (code) => resolve({ code })));
  return { ws, next, opened, closed };
}

function startMsg(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "session_start",
    session_id: SID,
    mode: "screen_audio",
    device_name: "Test iPhone",
    consent: "shown",
    started_at: "2026-09-02T10:00:00.000Z",
    ...extra
  });
}

async function waitFor(pred: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("recording digest text", () => {
  const record = {
    id: SID,
    mode: "screen_audio",
    device_name: "Test iPhone",
    started_at: "2026-09-02T10:00:00.000Z",
    conversation_id: THREAD
  };
  const now = new Date("2026-09-02T10:02:13.000Z");

  it("names mode, duration, device and the transcript", () => {
    const transcript = { words: 5, segments: [{ text: "hello there" }, { text: "general kenobi" }] };
    const text = buildDigest({ record, transcript, cfg: { transcribeEnabled: true }, now });
    expect(text).toContain("Recording ended: screen audio, 2m 13s, from Test iPhone.");
    expect(text).toContain("Transcript (5 words):");
    expect(text).toContain("hello there");
    expect(text).toContain("general kenobi");
    expect(text).toContain(`Recording id ${SID}.`);
  });

  it("says why there is no transcript", () => {
    expect(buildDigest({ record, transcript: null, cfg: { transcribeEnabled: false }, now })).toContain(
      "transcription is off on this node"
    );
    expect(buildDigest({ record: { ...record, mode: "audio", conversation_id: null }, transcript: { segments: [] }, cfg: { transcribeEnabled: true }, now })).toContain(
      "Recording ended: microphone, 2m 13s, from Test iPhone.\n\nNo transcript: no speech was recognised"
    );
  });

  it("describes a screen-only broadcast without pretending a microphone was open", () => {
    const text = buildDigest({ record, transcript: null, cfg: { transcribeEnabled: true, screenAudioTranscribe: false }, now });
    expect(text).toBe(`Broadcast ended: screen, 2m 13s, from Test iPhone.\n\nRecording id ${SID}.`);
    expect(text).not.toContain("No transcript");
  });

  it("keeps a Listen session's transcript out of the conversation", () => {
    const listening = { ...record, mode: "audio" };
    const heard = { words: 42, segments: [{ text: "zeca send him a message" }, { text: "unrelated chatter" }] };
    const text = buildDigest({ record: listening, transcript: heard, cfg: { transcribeEnabled: true }, now });
    expect(text).toContain("Listening ended: 2m 13s, from Test iPhone.");
    expect(text).toContain('Heard 42 words; only what followed "Zeca" was sent here.');
    expect(text).not.toContain("unrelated chatter");
    expect(buildDigest({ record: listening, transcript: null, cfg: {}, now })).toBe(
      `Listening ended: 2m 13s, from Test iPhone.\n\nRecording id ${SID}.`
    );
  });

  it("clips a long transcript keeping head and tail", () => {
    const segments = Array.from({ length: 400 }, (_, i) => ({ text: `segment number ${i} with some words in it` }));
    const text = buildDigest({ record, transcript: { words: 4000, segments }, cfg: {}, now });
    expect(text.length).toBeLessThan(DIGEST_TRANSCRIPT_CAP + 400);
    expect(text).toContain("segment number 0 ");
    expect(text).toContain("[...]");
    expect(text).toContain("segment number 399 ");
  });

  it("derives the key and the deep link from the record", () => {
    expect(digestIdempotencyKey(SID)).toBe(`capture-digest:${SID}`);
    expect(digestPath(record)).toBe(`/talk/${THREAD}`);
    expect(digestPath({ id: SID })).toBeNull();
  });
});

describe("recording digest delivery", () => {
  it("posts one assistant message into the conversation when the session ends, keyed by session id", async () => {
    const app = await fakeConversations();
    const { handle, home, base } = await boot(app.base);
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg({ conversation_id: THREAD }));
    await c.next((m) => m.type === "session_started");
    c.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await c.next((m) => m.type === "session_ended");
    await c.closed;

    const record = JSON.parse(readFileSync(path.join(home, "capture", "sessions", `${SID}.json`), "utf8"));
    expect(record.conversation_id).toBe(THREAD);

    await waitFor(() => app.posts.length >= 1);
    expect(app.posts).toHaveLength(1);
    const [post] = app.posts;
    expect(post.url).toBe(`/api/conversation/${THREAD}/note`);
    expect(post.body.clientRequestId).toBe(`capture-digest:${SID}`);
    expect(post.body.origin).toBe("capture");
    // Default config is a screen-only broadcast (D60), so the note says so.
    expect(post.body.text).toContain("Broadcast ended: screen");
    expect(post.body.text).toContain(`Recording id ${SID}.`);
    expect(handle.counters.read().digest_posted).toBe(1);
  });

  it("posts nothing for a session that named no conversation", async () => {
    const app = await fakeConversations();
    const { handle, base } = await boot(app.base);
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg());
    await c.next((m) => m.type === "session_started");
    c.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
    await c.next((m) => m.type === "session_ended");
    await c.closed;
    await new Promise((r) => setTimeout(r, 150));
    expect(app.posts).toHaveLength(0);
    expect(handle.counters.read().digest_posted ?? 0).toBe(0);
  });

  it("refuses a conversation_id the thread store would rewrite", async () => {
    const app = await fakeConversations();
    const { base } = await boot(app.base);
    const c = connect(base);
    await c.opened;
    c.ws.send(startMsg({ conversation_id: "not a/thread:id" }));
    const err = await c.next((m) => m.type === "error");
    expect(err.error).toContain("conversation_id");
    expect((await c.closed).code).toBe(1008);
  });

  it("records a failed post without throwing and skips when no app host is named", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "capture-digest-unit-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const counters = new Counters(home, "test");
    const record = { id: SID, mode: "audio", started_at: "2026-09-02T10:00:00.000Z", conversation_id: THREAD };
    const quiet = { log() {}, error() {} };

    const failing = await postConversationDigest({
      record,
      store: null,
      cfg: {},
      counters,
      env: { GARRISON_APP_URL: "http://app.test" },
      fetchImpl: (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch,
      log: quiet
    });
    expect(failing).toMatchObject({ ok: false, status: 500 });
    expect(counters.read().digest_post_failed).toBe(1);

    const skipped = await postConversationDigest({ record, store: null, cfg: {}, counters, env: { GARRISON_HOME: home }, log: quiet });
    expect(skipped.ok).toBe(false);
    expect(skipped.skipped).toContain("GARRISON_APP_URL");

    const pushes: any[] = [];
    const ok = await postConversationDigest({
      record,
      store: null,
      cfg: {},
      counters,
      env: { GARRISON_APP_URL: "http://app.test" },
      fetchImpl: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
      notifier: { sendPush: async (args: unknown) => { pushes.push(args); return { ok: true }; } },
      log: quiet
    });
    expect(ok.ok).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ path: `/talk/${THREAD}`, tag: "recording_digest", link: null });
  });
});
