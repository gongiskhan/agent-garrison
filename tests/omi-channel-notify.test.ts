// Omi channel M3 — outbound notifications acceptance (build spec): unit tests
// against a mocked Omi API (401 no-retry, 429/5xx backoff retries), toggle-off
// routes to the web-channel PWA fallback (I9 degrade), failures retried and
// logged, per-day cap enforced, templates are plain text + one deep link with
// no action buttons, and the kanban notify-origin omi transport delivers to
// this fitting's thread-append contract.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OmiApi } from "../fittings/seed/omi-channel/lib/omi-api.mjs";
import { Notifier, RelayNotifier, renderTemplate } from "../fittings/seed/omi-channel/lib/notify.mjs";
import { makeRequestHandler } from "../fittings/seed/omi-channel/scripts/server.mjs";
import { OmiStore, Counters, atomicWriteJSON } from "../fittings/seed/omi-channel/lib/store.mjs";
import { loadConfig } from "../fittings/seed/omi-channel/lib/config.mjs";

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


const UID = "omi_test_user_1";

type MockCall = { url: string; init: RequestInit };

function mockFetch(script: Array<number | Error>) {
  const calls: MockCall[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script.shift() ?? 200;
    if (next instanceof Error) throw next;
    return new Response("{}", { status: next as number });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function makeApi(script: Array<number | Error>) {
  const { calls, impl } = mockFetch(script);
  const sleeps: number[] = [];
  const api = new OmiApi({
    appId: "app_123",
    appSecret: "secret_abc",
    fetchImpl: impl,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    log: { error: () => {} }
  });
  return { api, calls, sleeps };
}

describe("OmiApi direct notifications (mocked)", () => {
  it("sends uid + message as query params with the Bearer app secret", async () => {
    const { api, calls } = makeApi([200]);
    const result = await api.sendNotification({ uid: UID, message: "Hello from Garrison" });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v2/integrations/app_123/notification");
    expect(url.searchParams.get("uid")).toBe(UID);
    expect(url.searchParams.get("message")).toBe("Hello from Garrison");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret_abc");
    expect(calls[0].init.body).toBeUndefined();
  });

  it("does NOT retry a 401 (credential problem)", async () => {
    const { api, calls } = makeApi([401, 200]);
    const result = await api.sendNotification({ uid: UID, message: "x" });
    expect(result).toMatchObject({ ok: false, status: 401, retriable: false });
    expect(calls).toHaveLength(1);
  });

  // A rate limit is a WAIT instruction, not a transient blip. The old
  // doubling-from-1s schedule covered 3 seconds in total, so a notification that
  // hit Omi's window burned all three attempts against a limit that had not
  // moved and degraded to the web fallback every time.
  it("waits wide enough on 429 for the rate-limit window to actually clear", async () => {
    const { api, calls, sleeps } = makeApi([429, 200]);
    const result = await api.sendNotification({ uid: UID, message: "x" });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([5000]);
  });

  it("honours Retry-After when Omi sends one, capped so a caller is not held forever", async () => {
    const calls: MockCall[] = [];
    const sleeps: number[] = [];
    const script = [
      new Response("{}", { status: 429, headers: { "retry-after": "12" } }),
      new Response("{}", { status: 429, headers: { "retry-after": "9999" } }),
      new Response("{}", { status: 200 })
    ];
    const api = new OmiApi({
      appId: "app_123",
      appSecret: "secret_abc",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return script.shift()!;
      }) as unknown as typeof fetch,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      log: { error: () => {} }
    });
    const result = await api.sendNotification({ uid: UID, message: "x" });
    expect(result).toMatchObject({ ok: true, attempts: 3 });
    expect(sleeps).toEqual([12_000, 25_000]);
  });

  it("gives up after 3 attempts on persistent 5xx (retriable)", async () => {
    const { api, calls, sleeps } = makeApi([500, 503, 500]);
    const result = await api.sendNotification({ uid: UID, message: "x" });
    expect(result).toMatchObject({ ok: false, retriable: true, attempts: 3 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("skips cleanly when credentials are not sealed", async () => {
    const api = new OmiApi({ appId: "", appSecret: "" });
    const result = await api.sendNotification({ uid: UID, message: "x" });
    expect(result.ok).toBe(false);
    expect(result.retriable).toBe(false);
  });
});

describe("notification templates", () => {
  it("render to plain text plus one bare deep link - no buttons, no markup", () => {
    const msg = renderTemplate("card_created", { title: "Email the beta list", cardUrl: "https://x/#/cards/C1" });
    expect(msg).toBe("New card from Omi: Email the beta list\nCard: https://x/#/cards/C1");
    expect(renderTemplate("tip", { text: "Do it Tuesday" })).toBe("Tip: Do it Tuesday");
    expect(renderTemplate("wake_confirmation", { text: "Card created.", cardUrl: "https://x/#/cards/C2" })).toContain(
      "Card: https://x/#/cards/C2"
    );
    expect(renderTemplate("relay", { text: "Run complete" })).toBe("Run complete");
    expect(() => renderTemplate("buttons_thing", {})).toThrow();
  });
});

// A tiny web-channel stand-in implementing the thread-append contract.
function makeWebChannelStub() {
  const received: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
    res.statusCode = 200;
    res.end("{}");
  });
  return { server, received };
}


// Receipts are keyed by means, not position: a send now yields the push, the
// readable omi-chat copy, and the web fallback only when the push failed. Looking
// them up by name keeps these tests from breaking every time a means is added.
const by = (receipts: any[], means: string) => receipts.find((r: any) => r.means === means);

describe("Notifier routing and degrade path", () => {
  let home: string;
  let webStub: ReturnType<typeof makeWebChannelStub>;
  let webPort = 0;

  beforeAll(async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "omi-notify-"));
    webStub = makeWebChannelStub();
    await new Promise<void>((r) => webStub.server.listen(0, "127.0.0.1", r));
    const addr = webStub.server.address();
    webPort = typeof addr === "object" && addr ? addr.port : 0;
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    writeFileSync(
      path.join(home, "ui-fittings", "web-channel-default.json"),
      JSON.stringify({ fittingId: "web-channel-default", port: webPort, url: `http://127.0.0.1:${webPort}` })
    );
  });

  afterAll(async () => {
    await new Promise<void>((r) => webStub.server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  });

  function makeNotifier(overrides: Record<string, unknown> = {}, apiScript: Array<number | Error> = [200]) {
    const store = new OmiStore(path.join(home, `omi-${Math.random().toString(36).slice(2, 8)}`));
    store.pinUid(UID);
    const counters = new Counters(store.root, "test");
    const { api, calls } = makeApi(apiScript);
    const cfg = { ...loadConfig({}), notifyEnabled: true, notifyMaxPerDay: 50, ...overrides };
    const notifier = new Notifier({
      cfg,
      store,
      counters,
      omiApi: api,
      env: { GARRISON_HOME: home },
      log: { log: () => {}, error: () => {} }
    });
    return { notifier, store, counters, apiCalls: calls };
  }

  it("delivers via Omi push when enabled and configured (no fallback)", async () => {
    const before = webStub.received.length;
    const { notifier, apiCalls } = makeNotifier();
    const receipts = await notifier.send({ template: "tip", params: { text: "hi" } });
    expect(by(receipts, "omi-push")).toMatchObject({ means: "omi-push", ok: true });
    expect(by(receipts, "web-channel")).toBeUndefined(); // push worked, no degrade
    expect(apiCalls).toHaveLength(1);
    expect(webStub.received.length).toBe(before);
  });

  it("toggle off routes to the web-channel PWA thread with a skip reason", async () => {
    const { notifier, apiCalls } = makeNotifier({ notifyEnabled: false });
    const receipts = await notifier.send({ template: "tip", params: { text: "fallback please" } });
    expect(by(receipts, "omi-push")).toMatchObject({ means: "omi-push", ok: false, skipped: "notify disabled" });
    expect(by(receipts, "web-channel")).toMatchObject({ means: "web-channel", ok: true });
    expect(apiCalls).toHaveLength(0);
    const posted = webStub.received.find(
      (r) => r.path.includes("/api/threads/omi-reports/messages") &&
        JSON.stringify(r.body).includes("fallback please")
    );
    expect(posted).toBeTruthy();
  });

  it("can suppress Web fallback when the caller delivers Web independently", async () => {
    const before = webStub.received.length;
    const { notifier } = makeNotifier({ notifyEnabled: false });
    const receipts = await notifier.send({
      template: "relay",
      params: { text: "independent web delivery" },
      suppressWebFallback: true
    });
    expect(by(receipts, "omi-push")).toMatchObject({ means: "omi-push", ok: false, skipped: "notify disabled" });
    expect(by(receipts, "web-channel")).toMatchObject({ means: "web-channel", ok: false });
    expect(String(by(receipts, "web-channel").skipped)).toMatch(/suppressed/);
    expect(webStub.received.length).toBe(before);
  });

  it("falls back when the Omi API keeps failing, with the failure in the receipt", async () => {
    const { notifier } = makeNotifier({}, [500, 500, 500]);
    const receipts = await notifier.send({ template: "tip", params: { text: "x" } });
    expect(by(receipts, "omi-push").ok).toBe(false);
    expect(String(by(receipts, "omi-push").error)).toContain("after 3 attempts");
    expect(by(receipts, "web-channel")).toMatchObject({ means: "web-channel", ok: true });
  });

  it("enforces the per-day cap and degrades past it", async () => {
    const { notifier, counters } = makeNotifier({ notifyMaxPerDay: 1 }, [200, 200]);
    const first = await notifier.send({ template: "tip", params: { text: "one" } });
    expect(first[0].ok).toBe(true);
    const second = await notifier.send({ template: "tip", params: { text: "two" } });
    expect(second[0].ok).toBe(false);
    expect(String(second[0].skipped)).toContain("daily cap");
    expect(by(second, "web-channel")).toMatchObject({ means: "web-channel", ok: true });
    expect(counters.read().notify_capped).toBe(1);
  });

  it("skips with a reason when no uid is pinned yet", async () => {
    const store = new OmiStore(path.join(home, "omi-nouid"));
    const counters = new Counters(store.root, "test");
    const { api } = makeApi([200]);
    const notifier = new Notifier({
      cfg: { ...loadConfig({}), notifyEnabled: true },
      store,
      counters,
      omiApi: api,
      env: { GARRISON_HOME: home },
      log: { log: () => {}, error: () => {} }
    });
    const receipts = await notifier.send({ template: "tip", params: { text: "x" } });
    expect(receipts[0]).toMatchObject({ means: "omi-push", ok: false, skipped: "no pinned uid yet" });
  });

  it("drains the tips queue attempt-once with receipts recorded", async () => {
    const { notifier, store, apiCalls } = makeNotifier({}, [200, 200]);
    for (const text of ["tip A", "tip B"]) {
      atomicWriteJSON(path.join(store.root, "tips-queue", `${text.replace(" ", "-")}.json`), {
        id: text.replace(" ", "-"),
        text,
        created: new Date().toISOString()
      });
    }
    const delivered = await notifier.drainTips();
    expect(delivered).toHaveLength(2);
    expect(apiCalls).toHaveLength(2);
    expect(readdirSync(path.join(store.root, "tips-queue"))).toHaveLength(0);
    expect(readdirSync(path.join(store.root, "tips-sent"))).toHaveLength(2);
  });
});

describe("kanban notify-origin omi transport", () => {
  it("routes an omi-origin terminal event to the omi-channel thread-append route", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-kanban-notify-"));
    const prevHome = process.env.GARRISON_HOME;
    process.env.GARRISON_HOME = home;
    const stub = makeWebChannelStub();
    try {
      await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", r));
      const addr = stub.server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
      writeFileSync(
        path.join(home, "ui-fittings", "omi-channel.json"),
        JSON.stringify({ fittingId: "omi-channel", port, url: `http://127.0.0.1:${port}` })
      );
      const boardRoot = path.join(home, "kanban-loop");
      mkdirSync(boardRoot, { recursive: true });

      // @ts-ignore - pure .mjs
      const { routeOriginEvent } = await import("../fittings/seed/kanban-loop/lib/notify-origin.mjs");
      const card = {
        id: "01OMICARD",
        title: "Email the beta list",
        list: "done",
        origin_id: "omi:conv_omi_0001:1",
        originChannel: { channel: "omi", threadId: "omi-reports" }
      };
      routeOriginEvent(boardRoot, null, card, { kind: "finished", message: "Run complete - Email the beta list." });

      // The ack rides ALONGSIDE the delivery (routeOriginEvent fires both,
      // fire-and-forget), and being the shorter code path it usually lands
      // first. Wait for the delivery itself rather than for "the first
      // request" - the two are different classes and neither replaces the
      // other, so ordering between them is not a property worth pinning.
      const deadline = Date.now() + 3000;
      const delivery = () =>
        stub.received.find((r) => r.path === "/api/threads/omi-reports/messages");
      while (Date.now() < deadline && !delivery()) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const delivered = delivery();
      expect(delivered).toBeDefined();
      expect(JSON.stringify(delivered!.body)).toContain("Run complete");
      // ...and the ack is an addition, never a substitution: a terminal
      // outcome that only acked would leave the origin thread silent.
      expect(stub.received.some((r) => r.path === "/ack")).toBe(true);
    } finally {
      await new Promise<void>((r) => stub.server.close(() => r()));
      if (prevHome === undefined) delete process.env.GARRISON_HOME;
      else process.env.GARRISON_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// The triage process runs from a scheduler job that carries NO Omi secrets
// (baking them into the job command would print them in scheduler-jobs.json
// and ps output), so RelayNotifier hands pushes to the fitting server via
// POST /internal/omi-push and the server answers with the real receipt.
describe("RelayNotifier (secretless triage process -> server push relay)", () => {
  function makeRelayHarness(relayReceipt: Record<string, unknown> | null) {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-relay-"));
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    const relayed: Array<{ path: string; body: unknown }> = [];
    const relayStub = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      relayed.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(relayReceipt ?? {}));
    });
    const webStub = makeWebChannelStub();
    return { home, relayed, relayStub, webStub };
  }

  async function listenOn(server: Server): Promise<number> {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  function relayNotifier(home: string) {
    const store = new OmiStore(path.join(home, "omi"));
    store.pinUid(UID);
    const counters = new Counters(store.root, "test");
    const cfg = { ...loadConfig({}), notifyEnabled: true, notifyMaxPerDay: 50 };
    return new RelayNotifier({
      cfg,
      store,
      counters,
      omiApi: null,
      env: { GARRISON_HOME: home },
      log: { log: () => {}, error: () => {} }
    });
  }

  it("relays the rendered message through /internal/omi-push and returns the server receipt", async () => {
    const receipt = { means: "omi-push", ok: true, target: "omi uid kM7w..." };
    const { home, relayed, relayStub, webStub } = makeRelayHarness(receipt);
    try {
      const relayPort = await listenOn(relayStub);
      writeFileSync(
        path.join(home, "ui-fittings", "omi-channel.json"),
        JSON.stringify({ fittingId: "omi-channel", port: relayPort, url: `http://127.0.0.1:${relayPort}` })
      );
      const receipts = await relayNotifier(home).send({
        template: "card_created",
        params: { title: "Email the beta list" }
      });
      expect(relayed).toHaveLength(1);
      expect(relayed[0].path).toBe("/internal/omi-push");
      expect(relayed[0].body).toEqual({ message: "New card from Omi: Email the beta list" });
      // Push receipt from the server, plus the relay's own note that the
      // chat copy is the server's job (it holds no credentials to do it).
      expect(by(receipts, "omi-push")).toEqual(receipt);
      expect(by(receipts, "omi-chat")).toMatchObject({ ok: false, skipped: expect.stringContaining("server") });
    } finally {
      await new Promise<void>((r) => relayStub.close(() => r()));
      await new Promise<void>((r) => webStub.server.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("degrades to the web-channel thread when the fitting server is down", async () => {
    const { home, relayStub, webStub } = makeRelayHarness(null);
    try {
      const webPort = await listenOn(webStub.server);
      writeFileSync(
        path.join(home, "ui-fittings", "web-channel-default.json"),
        JSON.stringify({ fittingId: "web-channel-default", port: webPort, url: `http://127.0.0.1:${webPort}` })
      );
      // No omi-channel.json: the relay target is not running.
      const receipts = await relayNotifier(home).send({
        template: "card_created",
        params: { title: "Email the beta list" }
      });
      expect(by(receipts, "omi-push")).toMatchObject({ means: "omi-push", ok: false });
      expect(by(receipts, "web-channel")).toMatchObject({ means: "web-channel", ok: true });
      expect(webStub.received.some((r) => r.path === "/api/threads/omi-reports/messages")).toBe(true);
    } finally {
      await new Promise<void>((r) => relayStub.close(() => r()));
      await new Promise<void>((r) => webStub.server.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("server route /internal/omi-push answers the notifier receipt and 400s an empty message", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "omi-relay-route-"));
    const store = new OmiStore(path.join(home, "omi"));
    const counters = new Counters(store.root, "test");
    const sent: string[] = [];
    const notifierStub = {
      sendOmi: async (message: string) => {
        sent.push(message);
        return { means: "omi-push", ok: true, target: "omi uid kM7w..." };
      }
    };
    const cfg = { ...loadConfig({ GARRISON_HOME: home }), secrets: {} };
    const server = createServer(
      makeRequestHandler({ cfg, store, counters, ingress: null, notifier: notifierStub, chatTool: null })
    );
    try {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address();
      const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      const ok = await fetch(`${base}/internal/omi-push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "ping from triage" })
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ means: "omi-push", ok: true });
      expect(sent).toEqual(["ping from triage"]);
      const missing = await fetch(`${base}/internal/omi-push`, { method: "POST", body: "{}" });
      expect(missing.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
