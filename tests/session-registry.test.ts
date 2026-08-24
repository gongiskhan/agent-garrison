// Mesh session registry (plan §2.6) + web-channel thread metadata (§4.3).
//
// Two modules, one invariant each side:
//
//   fittings/seed/http-gateway/scripts/lib/session-registry.mjs
//     One row per Operative RUN — metadata only, written ONLY by the node the
//     run is homed on, and completely inert on a box that is not enrolled in a
//     mesh. Never throws, never blocks a turn.
//
//   fittings/seed/web-channel-default/lib/thread-registry.mjs
//     A compact, debounced, capped INDEX of this node's threads in a node-scoped
//     config doc. Messages stay on disk here; only the index travels.
//
// Both run against the real service on an ephemeral port (tests/state-service-harness).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StateClient } from "@garrison/state-client";

import { startStateService } from "./state-service-harness";

const ROOT = path.resolve(__dirname, "..");
const SESSION_LIB = pathToFileURL(
  path.join(ROOT, "fittings/seed/http-gateway/scripts/lib/session-registry.mjs")
).href;
const THREAD_LIB = pathToFileURL(
  path.join(ROOT, "fittings/seed/web-channel-default/lib/thread-registry.mjs")
).href;

const sessionLib = () => import(SESSION_LIB);
const threadLib = () => import(THREAD_LIB);

let home: string;
let h: Awaited<ReturnType<typeof startStateService>>;

const saved = {
  url: process.env.GARRISON_STATE_URL,
  token: process.env.GARRISON_STATE_TOKEN,
  node: process.env.GARRISON_NODE_NAME,
  home: process.env.GARRISON_HOME
};

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "session-registry-home-"));
  h = await startStateService({ nodes: ["alpha", "beta"] });
  process.env.GARRISON_HOME = home;
  process.env.GARRISON_STATE_URL = h.url;
  process.env.GARRISON_STATE_TOKEN = h.tokens.alpha;
  process.env.GARRISON_NODE_NAME = "alpha";
  (await sessionLib())._resetForTests();
  (await threadLib())._resetForTests();
}, 30_000);

afterEach(async () => {
  (await sessionLib())._resetForTests();
  (await threadLib())._resetForTests();
  await h?.stop();
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of [
    ["GARRISON_STATE_URL", saved.url],
    ["GARRISON_STATE_TOKEN", saved.token],
    ["GARRISON_NODE_NAME", saved.node],
    ["GARRISON_HOME", saved.home]
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("session-registry — the run lifecycle", () => {
  it("announce → generation open/close → end is visible to a peer, metadata only", async () => {
    const reg = await sessionLib();
    const RUN = "default@2026-08-24T10-00-00.000Z";

    await reg.announceSession({
      id: RUN,
      compositionId: "default",
      runtime: "claude-code",
      model: "opus",
      cwd: "/home/ggomes/dev/garrison",
      status: "starting"
    });

    const peer = new StateClient({ url: h.url, token: h.tokens.beta, node: "beta" });
    let [row] = await peer.listSessions({ node: "alpha" });
    expect(row.id).toBe(RUN);
    expect(row.homeNode).toBe("alpha");
    expect(row.status).toBe("starting");
    expect(row.compositionId).toBe("default");
    expect(row.runtime).toBe("claude-code");
    expect(row.cwd).toBe("/home/ggomes/dev/garrison");

    await reg.touchSession(RUN, "idle", { runtime: "agent-sdk" });
    await reg.openGeneration(RUN);
    row = (await peer.getSession(RUN))!;
    expect(row.status).toBe("running");
    expect(row.runtime).toBe("agent-sdk");

    await reg.closeGeneration(RUN);
    expect((await peer.getSession(RUN))!.status).toBe("idle");

    await reg.endSession(RUN);
    row = (await peer.getSession(RUN))!;
    expect(row.status).toBe("ended");
    expect(row.endedAt).toBeTruthy();

    // Metadata only: no transcript, no message text, no permission decision.
    expect(Object.keys(row.body)).toEqual(expect.arrayContaining(["pid"]));
    expect(JSON.stringify(row)).not.toMatch(/transcript|permission|decision/i);
  });

  it("overlapping turns only return to idle when the LAST one closes", async () => {
    const reg = await sessionLib();
    const RUN = "overlap-run";
    await reg.announceSession({ id: RUN, compositionId: "default" });

    await reg.openGeneration(RUN);
    await reg.openGeneration(RUN);
    expect((await h.client.getSession(RUN))!.status).toBe("running");

    await reg.closeGeneration(RUN);
    // One turn is still in flight — a flip to idle here would tell the nightly
    // convergence check this repo is free while a turn is still writing to it.
    expect((await h.client.getSession(RUN))!.status).toBe("running");

    await reg.closeGeneration(RUN);
    expect((await h.client.getSession(RUN))!.status).toBe("idle");
  });

  it("only the home node writes its sessions; a peer's write is a 403 the module swallows", async () => {
    const reg = await sessionLib();
    const RUN = "homed-on-alpha";
    await reg.announceSession({ id: RUN, compositionId: "default", status: "running" });

    // At the wire level the service refuses outright.
    const peer = new StateClient({ url: h.url, token: h.tokens.beta, node: "beta" });
    await expect(peer.upsertSession(RUN, { status: "ended" })).rejects.toMatchObject({ status: 403 });

    // The module, pointed at beta's token, must neither throw nor change the row.
    process.env.GARRISON_STATE_TOKEN = h.tokens.beta;
    process.env.GARRISON_NODE_NAME = "beta";
    reg._resetForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(reg.touchSession(RUN, "ended")).resolves.toBeNull();
    warn.mockRestore();
    expect((await h.client.getSession(RUN))!.status).toBe("running");
  });

  it("an unenrolled box is a silent no-op after ONE warning", async () => {
    delete process.env.GARRISON_STATE_URL;
    delete process.env.GARRISON_STATE_TOKEN;
    const reg = await sessionLib();
    reg._resetForTests();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(reg.lazyClient()).toBeNull();
    await expect(reg.announceSession({ id: "nowhere", compositionId: "default" })).resolves.toBeNull();
    await expect(reg.touchSession("nowhere", "running")).resolves.toBeNull();
    await expect(reg.openGeneration("nowhere")).resolves.toBeNull();
    await expect(reg.closeGeneration("nowhere")).resolves.toBeNull();
    await expect(reg.endSession("nowhere")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    // Nothing reached the service.
    expect(await h.client.listSessions()).toEqual([]);
  });

  it("controlUrl comes from the web-channel status file, and is omitted when it is absent", async () => {
    const reg = await sessionLib();
    await reg.announceSession({ id: "no-surface", compositionId: "default" });
    expect((await h.client.getSession("no-surface"))!.controlUrl).toBeNull();

    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    writeFileSync(
      path.join(home, "ui-fittings", "web-channel-default.json"),
      JSON.stringify({ fittingId: "web-channel-default", port: 8083, url: "http://127.0.0.1:8083" })
    );
    reg._resetForTests();

    await reg.announceSession({ id: "with-surface", compositionId: "default" });
    const row = (await h.client.getSession("with-surface"))!;
    expect(row.controlUrl).toBe("http://127.0.0.1:8083");
    // The port rides in the body so the peer proxy can rehost it on the node's
    // tailnet address — a loopback URL alone is not dialable from another node.
    expect(row.body.controlPort).toBe(8083);
  });
});

describe("thread-registry — a debounced, capped, node-scoped index", () => {
  const thread = (id: string, ts: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `thread ${id}`,
    createdAt: ts,
    updatedAt: ts,
    messages: [{ role: "user", text: "hi", ts }],
    ...over
  });
  const meta = (t: { id: string; title: string; messages: unknown[] }) => ({
    id: t.id,
    title: t.title,
    messageCount: t.messages.length
  });

  async function doc() {
    return h.client.getConfig("web-channel.threads", "node:alpha");
  }

  it("mirrors id / title / lastMessageAt / messageCount / cardId — and no message text", async () => {
    const reg = await threadLib();
    const t = thread("chat-1", "2026-08-24T10:00:00.000Z", {
      context: { cardId: "01CARD" },
      messages: [
        { role: "user", text: "secret payload", ts: "2026-08-24T10:00:00.000Z" },
        { role: "assistant", text: "also secret", ts: "2026-08-24T10:05:00.000Z" }
      ]
    });
    await reg.noteThread(t, meta(t as never));
    await reg.flushThreadRegistry();

    const stored = await doc();
    expect(stored!.body.threads).toEqual([
      {
        id: "chat-1",
        title: "thread chat-1",
        lastMessageAt: "2026-08-24T10:05:00.000Z",
        messageCount: 2,
        cardId: "01CARD"
      }
    ]);
    expect(JSON.stringify(stored!.body)).not.toContain("secret");
  });

  it("a burst of 5 updates writes the doc ONCE, no sooner than the debounce", async () => {
    const reg = await threadLib();
    // Land a first write so the debounce floor is armed (a cold module writes
    // immediately — that is the leading edge, not the property under test).
    const first = thread("chat-0", "2026-08-24T09:00:00.000Z");
    await reg.noteThread(first, meta(first as never));
    await reg.flushThreadRegistry();
    const before = (await doc())!.rev;

    const t0 = Date.now();
    let last: Promise<unknown> = Promise.resolve();
    for (let i = 1; i <= 5; i += 1) {
      const t = thread(`chat-${i}`, `2026-08-24T10:0${i}:00.000Z`);
      last = reg.noteThread(t, meta(t as never));
      await new Promise((r) => setTimeout(r, 20));
    }
    await last;
    const elapsed = Date.now() - t0;

    const after = await doc();
    expect(after!.rev - before).toBe(1); // ONE doc update for five upserts
    expect(after!.body.threads).toHaveLength(6);
    expect(elapsed).toBeGreaterThan(1000); // the 2s floor was honoured, not raced
  }, 15_000);

  it("caps at the 200 most recent threads", async () => {
    const reg = await threadLib();
    for (let i = 0; i < 250; i += 1) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      const t = thread(`chat-${String(i).padStart(3, "0")}`, ts);
      void reg.noteThread(t, meta(t as never));
    }
    await reg.flushThreadRegistry();

    const threads = (await doc())!.body.threads as { id: string }[];
    expect(threads).toHaveLength(200);
    expect(threads[0].id).toBe("chat-249"); // newest first
    expect(threads.at(-1)!.id).toBe("chat-050"); // the oldest 50 fell off
  });

  it("a deleted thread leaves the index and does not come back on the next seed", async () => {
    const reg = await threadLib();
    for (const id of ["chat-a", "chat-b"]) {
      const t = thread(id, "2026-08-24T10:00:00.000Z");
      void reg.noteThread(t, meta(t as never));
    }
    await reg.flushThreadRegistry();
    expect((await doc())!.body.threads).toHaveLength(2);

    // A fresh process (reset = no in-memory index) deleting a thread must not
    // have the stored doc's copy re-seeded over the deletion.
    reg._resetForTests();
    await reg.forgetThread("chat-a");
    await reg.flushThreadRegistry();

    const threads = (await doc())!.body.threads as { id: string }[];
    expect(threads.map((t) => t.id)).toEqual(["chat-b"]);
  });

  it("an unenrolled box is a silent no-op after ONE warning", async () => {
    delete process.env.GARRISON_STATE_URL;
    delete process.env.GARRISON_STATE_TOKEN;
    const reg = await threadLib();
    reg._resetForTests();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = thread("chat-x", "2026-08-24T10:00:00.000Z");
    await reg.noteThread(t, meta(t as never));
    await reg.flushThreadRegistry();
    await reg.noteThread(t, meta(t as never));
    await reg.flushThreadRegistry();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    expect(await h.client.getConfig("web-channel.threads", "node:alpha")).toBeNull();
  });
});
