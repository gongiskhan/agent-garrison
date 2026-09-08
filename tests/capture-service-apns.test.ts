// Capture service — M5 APNs transport, no network anywhere.
//
// JWT: generated with a throwaway P-256 key and verified cryptographically
// (ES256 header/kid/iss/iat, signature EXACTLY 64 bytes proving P1363 not
// DER) — the ios-thing test-apns.js pattern. Send path: an injected fake
// http2 session scripts per-token outcomes, covering success, dead-token
// pruning, Retry-After-honoured retries, persistent-failure degrade to the
// web-channel thread, the per-day cap, loopback-link stripping, /notify sink
// idempotency, and the I5 no-content-in-logs rule.

import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
import { ApnsSender, decodeP8 } from "../fittings/seed/capture-service/lib/apns.mjs";
import { CompanionNotifier, appPathFor, isLoopbackUrl, renderTemplate } from "../fittings/seed/capture-service/lib/notify.mjs";
import { CaptureStore, Counters, atomicWriteJSON } from "../fittings/seed/capture-service/lib/store.mjs";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const P8_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const TEAM = "N3AN3Z32JN";
const KEY_ID = "TESTKEY123";

function testCfg(home: string, overrides: Record<string, unknown> = {}) {
  const cfg = loadConfig({
    GARRISON_HOME: home,
    APNS_TEAM_ID: TEAM,
    APNS_KEY_ID: KEY_ID,
    APNS_P8: P8_PEM
  });
  return { ...cfg, notifyEnabled: true, ...overrides };
}

// A fake http2 session: each request's outcome is scripted per token.
// script: token -> {status, reason?, retryAfter?} (missing token -> 200).
function fakeHttp2(script: Record<string, { status: number; reason?: string; retryAfter?: number }>, calls: any[] = []) {
  return () => {
    const session = new EventEmitter() as any;
    session.request = (headers: Record<string, string>) => {
      const token = headers[":path"].replace("/3/device/", "");
      calls.push({ token, headers, body: "" });
      const req = new EventEmitter() as any;
      req.setEncoding = () => {};
      req.write = (chunk: string) => {
        calls[calls.length - 1].body += chunk;
      };
      req.end = () => {
        const outcome = script[token] ?? { status: 200 };
        setImmediate(() => {
          const headersOut: Record<string, unknown> = { ":status": outcome.status };
          if (outcome.retryAfter) headersOut["retry-after"] = String(outcome.retryAfter);
          req.emit("response", headersOut);
          if (outcome.reason) req.emit("data", JSON.stringify({ reason: outcome.reason }));
          req.emit("end");
        });
      };
      return req;
    };
    session.destroy = () => {};
    return session;
  };
}

function makeStore(home: string) {
  const store = new CaptureStore(path.join(home, "capture"));
  return store;
}

function registerDevices(store: CaptureStore, tokens: string[]) {
  atomicWriteJSON(store.devicesFile, {
    tokens: tokens.map((t) => ({ token: t, device_name: "test", registered_at: "2026-08-13T00:00:00Z" }))
  });
}

describe("apns sender", () => {
  it("builds a verifiable ES256 JWT with a P1363 signature, cached under 40 minutes", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "apns-jwt-"));
    try {
      let clock = 1_755_000_000_000;
      const sender = new ApnsSender({ cfg: testCfg(home), now: () => clock });
      const jwt = sender.providerToken();
      const [h, p, s] = jwt.split(".");
      expect(jwt.split(".").length).toBe(3);
      const header = JSON.parse(Buffer.from(h, "base64url").toString());
      const payload = JSON.parse(Buffer.from(p, "base64url").toString());
      expect(header).toEqual({ alg: "ES256", kid: KEY_ID });
      expect(payload.iss).toBe(TEAM);
      expect(payload.iat).toBe(Math.floor(clock / 1000));
      const sig = Buffer.from(s, "base64url");
      expect(sig.length).toBe(64); // P1363 r||s — DER would vary and be rejected
      expect(
        crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)
      ).toBe(true);

      // Cached inside the window, refreshed past it.
      clock += 39 * 60 * 1000;
      expect(sender.providerToken()).toBe(jwt);
      clock += 2 * 60 * 1000;
      expect(sender.providerToken()).not.toBe(jwt);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts the p8 as raw PEM or base64 and reports unconfigured otherwise", () => {
    expect(decodeP8(P8_PEM)).toContain("BEGIN PRIVATE KEY");
    expect(decodeP8(Buffer.from(P8_PEM).toString("base64"))).toContain("BEGIN PRIVATE KEY");
    expect(decodeP8("not-a-key")).toBeNull();
    const home = mkdtempSync(path.join(os.tmpdir(), "apns-nokey-"));
    try {
      const sender = new ApnsSender({ cfg: { ...testCfg(home), secrets: { apnsTeamId: TEAM, apnsKeyId: KEY_ID, apnsP8: "" } } });
      expect(sender.enabled()).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("sends the verified headers and payload shape, with per-token outcomes", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "apns-send-"));
    try {
      const calls: any[] = [];
      const sender = new ApnsSender({
        cfg: testCfg(home),
        connectFn: fakeHttp2({ tokendead1: { status: 410, reason: "Unregistered" } }, calls)
      });
      const outcome = await sender.notify(["tokenok01", "tokendead1"], { title: "T", body: "B", data: { link: "x" } });
      expect(calls[0].headers["apns-topic"]).toBe("com.gomes.garrison");
      expect(calls[0].headers["apns-push-type"]).toBe("alert");
      expect(calls[0].headers["apns-priority"]).toBe("10");
      expect(calls[0].headers.authorization).toMatch(/^bearer /);
      const payload = JSON.parse(calls[0].body);
      expect(payload.aps.alert).toEqual({ title: "T", body: "B" });
      expect(payload.aps["interruption-level"]).toBe("time-sensitive");
      expect(payload.link).toBe("x");
      const byToken = Object.fromEntries(outcome.results.map((r: any) => [r.token, r]));
      expect(byToken.tokenok01).toMatchObject({ ok: true, status: 200, dead: false });
      expect(byToken.tokendead1).toMatchObject({ ok: false, status: 410, dead: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("companion notifier", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function makeNotifier(
    script: Record<string, any>,
    overrides: Record<string, unknown> = {},
    tokens = ["tokenok01"],
    { env = {}, fetchImpl }: { env?: Record<string, string>; fetchImpl?: typeof fetch } = {}
  ) {
    const home = mkdtempSync(path.join(os.tmpdir(), "apns-notify-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const cfg = testCfg(home, overrides);
    const store = makeStore(home);
    registerDevices(store, tokens);
    const counters = new Counters(store.root, "test");
    const sleeps: number[] = [];
    const calls: any[] = [];
    const notifier = new CompanionNotifier({
      cfg,
      store,
      counters,
      env: { GARRISON_HOME: home, ...env },
      apns: new ApnsSender({ cfg, counters, connectFn: fakeHttp2(script, calls) }),
      ...(fetchImpl ? { fetchImpl } : {}),
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      }
    });
    return { notifier, store, counters, sleeps, calls, home, cfg };
  }

  it("carries the in-app route as `path`: explicit, or derived from a link on this node's app", async () => {
    const env = { GARRISON_APP_URL: "https://node.tail.ts.net" };
    expect(appPathFor({ path: "/talk/abc" }, env)).toBe("/talk/abc");
    expect(appPathFor({ link: "https://node.tail.ts.net/talk/abc?x=1" }, env)).toBe("/talk/abc?x=1");
    // A link anywhere else never steers the app, and nothing that is not a
    // rooted single-slash path gets through.
    expect(appPathFor({ link: "https://github.com/gongiskhan/garrison/pull/1" }, env)).toBeNull();
    expect(appPathFor({ link: "https://node.tail.ts.net/talk/abc" }, {})).toBeNull();
    expect(appPathFor({ path: "//evil.example/x" }, env)).toBeNull();
    expect(appPathFor({ path: "https://evil.example/x" }, env)).toBeNull();
    expect(appPathFor({ path: "talk/abc" }, env)).toBeNull();

    const { notifier, calls } = makeNotifier({}, {}, ["tokenok01"], { env });
    await notifier.send({
      template: "wake_confirmation",
      params: { text: "Card created.", cardUrl: "https://node.tail.ts.net/fitting/kanban-loop/card/42" }
    });
    const payload = JSON.parse(calls[0].body);
    expect(payload.link).toBe("https://node.tail.ts.net/fitting/kanban-loop/card/42");
    expect(payload.path).toBe("/fitting/kanban-loop/card/42");
    expect(payload.tag).toBe("wake_confirmation");
  });

  it("delivers a template push and counts it against the daily ledger", async () => {
    const { notifier, counters } = makeNotifier({});
    const receipts = await notifier.send({ template: "wake_confirmation", params: { text: "Created a task, test." } });
    expect(receipts).toEqual([{ means: "companion-push", ok: true, target: "1/1 devices" }]);
    expect(counters.read().notifications_sent).toBe(1);
    // wake_confirmation answers a spoken command: it draws on the interactive
    // budget, leaving the routine one untouched.
    expect(notifier.sentToday("interactive")).toBe(1);
    expect(notifier.sentToday()).toBe(0);
    await notifier.send({ template: "tip", params: { text: "Routine one." } });
    expect(notifier.sentToday()).toBe(1);
  });

  it("prunes dead tokens and still succeeds on the live one", async () => {
    const { notifier, store, counters } = makeNotifier(
      { },
      {},
      ["tokendead1", "tokenok01"]
    );
    // Script the dead token via the sender's fake.
    (notifier as any).apns = new ApnsSender({
      cfg: (notifier as any).cfg,
      counters,
      connectFn: fakeHttp2({ tokendead1: { status: 410, reason: "Unregistered" } })
    });
    const receipts = await notifier.send({ template: "tip", params: { text: "hidrata-te" } });
    expect(receipts[0]).toMatchObject({ means: "companion-push", ok: true, target: "1/2 devices" });
    const registry = JSON.parse(readFileSync(store.devicesFile, "utf8"));
    expect(registry.tokens.map((t: any) => t.token)).toEqual(["tokenok01"]);
    expect(counters.read().apns_tokens_pruned).toBe(1);
  });

  it("honours Retry-After on 429 with a capped delay, then succeeds", async () => {
    const { notifier, sleeps } = makeNotifier({});
    let attempt = 0;
    (notifier as any).apns = {
      enabled: () => true,
      notify: async () => {
        attempt += 1;
        if (attempt === 1) {
          return { results: [{ token: "tokenok01", status: 429, reason: "TooManyRequests", ok: false, dead: false, retryAfter: 7 }] };
        }
        return { results: [{ token: "tokenok01", status: 200, reason: "", ok: true, dead: false, retryAfter: null }] };
      }
    };
    const receipts = await notifier.send({ template: "ask", params: { text: "Qual dos dois ficheiros?" } });
    expect(receipts[0].ok).toBe(true);
    expect(sleeps).toEqual([7000]); // Retry-After honoured, not the 5s floor
    expect(attempt).toBe(2);
  });

  it("degrades to the web-channel thread after persistent 5xx, without content in logs", async () => {
    const logSpy = vi.spyOn(console, "log");
    // A real loopback web-channel stub receives the fallback.
    const posts: any[] = [];
    const web = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posts.push({ url: req.url, body: JSON.parse(body || "{}") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
    cleanups.push(() => web.close());
    const webPort = (web.address() as { port: number }).port;

    const { notifier, counters, sleeps, home } = makeNotifier({ tokenok01: { status: 503, reason: "ServiceUnavailable" } });
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    writeFileSync(
      path.join(home, "ui-fittings", "web-channel-default.json"),
      JSON.stringify({ fittingId: "web-channel-default", port: webPort, url: `http://127.0.0.1:${webPort}`, pid: process.pid })
    );

    const SECRET_TEXT = "Finished the tax filing task.";
    const receipts = await notifier.send({ template: "relay", params: { text: SECRET_TEXT } });
    expect(receipts.length).toBe(2);
    expect(receipts[0]).toMatchObject({ means: "companion-push", ok: false });
    expect(receipts[0].error).toContain("ServiceUnavailable");
    expect(receipts[1]).toMatchObject({ means: "web-channel", ok: true });
    expect(sleeps).toEqual([5000, 25000]); // floors wider than a burst window
    expect(counters.read().notify_failed).toBe(1);
    expect(counters.read().notify_fallback_web).toBe(1);
    expect(posts.at(-1).body.messages[0].text).toBe(SECRET_TEXT);
    // I5: outcome lines only, never the message text.
    const logged = logSpy.mock.calls.flat().join("\n");
    expect(logged).not.toContain(SECRET_TEXT);
    logSpy.mockRestore();
  });

  it("never degrades a conversation_reply to the web thread: the answer already lives in its conversation", async () => {
    const posts: string[] = [];
    const fetchImpl = (async (url: string) => {
      posts.push(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const { notifier, counters } = makeNotifier({}, { notifyEnabled: false }, ["tokenok01"], {
      env: { GARRISON_APP_URL: "http://app.test/" },
      fetchImpl
    });
    const receipts = await notifier.send({
      template: "conversation_reply",
      params: { text: "You are looking at the Vault page.", path: "/talk/companion-reports" }
    });
    expect(receipts[0]).toMatchObject({ means: "companion-push", ok: false, skipped: "notify disabled" });
    expect(receipts[1]).toMatchObject({ means: "web-channel", ok: false, skipped: "answer already in the conversation" });
    expect(posts).toEqual([]);
    expect(counters.read().notify_fallback_web ?? 0).toBe(0);
  });

  it("pushes a conversation_reply as Zeca, opening the conversation, on the interactive budget", async () => {
    const { notifier, calls } = makeNotifier({}, {}, ["tokenok01"], { env: { GARRISON_APP_URL: "https://node.tail.ts.net" } });
    const receipts = await notifier.send({
      template: "conversation_reply",
      params: { text: "You are looking at the Vault page.", path: "/talk/companion-reports" }
    });
    expect(receipts).toEqual([{ means: "companion-push", ok: true, target: "1/1 devices" }]);
    const payload = JSON.parse(calls[0].body);
    expect(payload.aps.alert).toEqual({ title: "Zeca", body: "You are looking at the Vault page." });
    expect(payload.path).toBe("/talk/companion-reports");
    expect(payload.tag).toBe("conversation_reply");
    expect(notifier.sentToday("interactive")).toBe(1);
  });

  it("posts the fallback to the Garrison app when GARRISON_APP_URL names it, ignoring the legacy status file", async () => {
    const posts: string[] = [];
    const fetchImpl = (async (url: string) => {
      posts.push(url);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const { notifier, counters, home } = makeNotifier({}, { notifyEnabled: false }, ["tokenok01"], {
      env: { GARRISON_APP_URL: "http://app.test/" },
      fetchImpl
    });
    // A legacy host is ALSO advertised; both share one thread store, so only
    // the app may be posted to or the thread gets the message twice.
    mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
    writeFileSync(
      path.join(home, "ui-fittings", "web-channel-default.json"),
      JSON.stringify({ fittingId: "web-channel-default", port: 1, url: "http://legacy.test" })
    );

    const receipts = await notifier.send({ template: "relay", params: { text: "Finished." } });
    expect(receipts[0]).toMatchObject({ means: "companion-push", ok: false, skipped: "notify disabled" });
    expect(receipts[1]).toMatchObject({ means: "web-channel", ok: true, target: "thread companion-reports" });
    expect(posts).toEqual([
      "http://app.test/api/threads",
      "http://app.test/api/threads/companion-reports/messages"
    ]);
    expect(counters.read().notify_fallback_web).toBe(1);
  });

  it("names both hosts in the skip reason when neither the app nor the legacy fitting is reachable", async () => {
    const { notifier } = makeNotifier({}, { notifyEnabled: false });
    const receipts = await notifier.send({ template: "relay", params: { text: "Finished." } });
    expect(receipts[1]).toMatchObject({
      means: "web-channel",
      ok: false,
      skipped: "no Conversations host: GARRISON_APP_URL unset and web channel fitting not running"
    });
  });

  it("enforces the per-day cap and strips loopback links", async () => {
    const { notifier, counters, calls, home } = makeNotifier({}, { notifyMaxPerDay: 1, notifyInteractiveMaxPerDay: 2 });
    await notifier.send({ template: "tip", params: { text: "one" } });
    const capped = await notifier.send({ template: "tip", params: { text: "two" } });
    expect(capped[0]).toMatchObject({ means: "companion-push", ok: false, skipped: "daily routine cap 1 reached" });
    expect(counters.read().notify_capped).toBe(1);

    // The budgets are SEPARATE (2026-08-15): routine fan-out exhausting its
    // cap must never silence the confirmations answering a spoken command.
    const answer = await notifier.send({ template: "wake_confirmation", params: { text: "Criei a tarefa." } });
    expect(answer[0]).toMatchObject({ means: "companion-push", ok: true });
    const answer2 = await notifier.send({ template: "wake_confirmation", params: { text: "Outra." } });
    expect(answer2[0]).toMatchObject({ means: "companion-push", ok: true });
    const answer3 = await notifier.send({ template: "wake_confirmation", params: { text: "Terceira." } });
    expect(answer3[0]).toMatchObject({ ok: false, skipped: "daily interactive cap 2 reached" });

    // Loopback deep links never reach a phone (unreachable + mixed content).
    expect(isLoopbackUrl("http://127.0.0.1:8089/#/cards/x")).toBe(true);
    expect(isLoopbackUrl("https://host.tail31efa.ts.net:8443/#/cards/x")).toBe(false);
    rmSync(path.join(home, "capture", "notify-ledger.json"), { force: true });
    await notifier.send({ template: "card_created", params: { title: "T", cardUrl: "http://127.0.0.1:8089/#/cards/x" } });
    const lastPayload = JSON.parse(calls.at(-1).body);
    expect(lastPayload.aps.alert.body).not.toContain("127.0.0.1");
    expect(lastPayload.link).toBeUndefined();
    expect(counters.read().notify_loopback_link_stripped).toBe(1);

    const tailnet = renderTemplate("card_created", { title: "T", cardUrl: "https://host.ts.net:8443/#/cards/x" });
    expect(tailnet).toContain("https://host.ts.net:8443/#/cards/x");
  });
});

describe("the /notify sink", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it("delivers the fan-out shape once per idempotency key, honouring the toggle", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "notify-sink-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const cfg = loadConfig({
      GARRISON_HOME: home,
      APNS_TEAM_ID: TEAM,
      APNS_KEY_ID: KEY_ID,
      APNS_P8: P8_PEM
    });
    const handle = await startServer({ ...cfg, port: 0, notifyEnabled: true });
    cleanups.push(() => {
      handle.ingress.close();
      handle.server.close();
    });
    registerDevices(handle.store as any, ["tokenok01"]);
    (handle as any).notifier.apns = new ApnsSender({ cfg: (handle as any).cfg, connectFn: fakeHttp2({}) });
    const base = `http://127.0.0.1:${handle.cfg.port}`;

    const post = (body: unknown) =>
      fetch(`${base}/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

    const first = await (await post({ title: "Card done", text: "Finished X", link: "https://h.ts.net/#/cards/1", idempotencyKey: "k1" })).json();
    expect(first[0]).toMatchObject({ means: "companion-push", ok: true });
    const dup = await (await post({ title: "Card done", text: "Finished X", idempotencyKey: "k1" })).json();
    expect(dup[0]).toMatchObject({ means: "companion-push", ok: true, deduplicated: true });
    expect((handle as any).counters.read().notifications_sent).toBe(1);

    expect((await post({ title: "x" })).status).toBe(400); // text required

    // A relayed wake_confirmation must survive an exhausted ROUTINE budget:
    // the 2026-08-15 silence was exactly this path being capped by chatter.
    (handle.cfg as any).notifyMaxPerDay = 0;
    const relayedAnswer = await (await post({ title: "Zeca", text: "Criei a tarefa.", tag: "wake_confirmation" })).json();
    expect(relayedAnswer[0]).toMatchObject({ means: "companion-push", ok: true });
    const relayedChatter = await (await post({ title: "Garrison", text: "Rotina.", tag: "relay" })).json();
    expect(relayedChatter[0]).toMatchObject({ ok: false, skipped: "daily routine cap 0 reached" });
    (handle.cfg as any).notifyMaxPerDay = 50;

    // Toggle honoured live: flip off, receipts say so, nothing sends.
    (handle.cfg as any).notifyEnabled = false;
    const off = await (await post({ title: "T", text: "y" })).json();
    expect(off[0]).toMatchObject({ means: "companion-push", ok: false, skipped: "notify disabled" });
  });
});
