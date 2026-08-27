import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContactIndex } from "../fittings/seed/whatsapp-web/lib/contacts.mjs";
import { Outbox } from "../fittings/seed/whatsapp-web/lib/outbox.mjs";
import { MessageStore } from "../fittings/seed/whatsapp-web/lib/store.mjs";
import { createApp, createOutboxSender } from "../fittings/seed/whatsapp-web/scripts/server.mjs";
import { runAction as whatsappRunAction } from "../fittings/seed/whatsapp-web/scripts/connector.mjs";
import { runAction as slackRunAction } from "../fittings/seed/slack-channel/scripts/connector.mjs";
import slackOutbox from "../fittings/seed/slack-channel/lib/outbox.js";

// The buffer wired into the two Fittings that own a long-lived process (brief
// §8.4). google is deliberately absent: its Fitting is connector.mjs + setup.sh
// with no daemon, so there is nothing there that could hold a cancel window.

const JID = "351912345678@s.whatsapp.net";

function fakeConnectionManager(connected = true) {
  const calls: Array<{ method: string; args: any[] }> = [];
  return {
    calls,
    status: () => ({ paired: connected, connected, connecting: false, phone: null }),
    requestPairingCode: async () => "ABCD1234",
    sendText: async (jid: string, body: string) => {
      calls.push({ method: "sendText", args: [jid, body] });
      return { id: "wamid.fake" };
    }
  };
}

function statusFile(dir: string, name: string, url: string) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify({ fittingId: name.replace(/\.json$/, ""), port: 9999, url, pid: 1 }));
  return file;
}

// The connector CLIs take an injected fetchImpl; this records what they sent.
function mockFetch(calls: Array<{ url: string; opts?: any }>, respond: (url: string, opts?: any) => any) {
  return async (url: string, opts?: any) => {
    calls.push({ url, opts });
    const body = respond(url, opts);
    return {
      ok: body.status === undefined || body.status < 400,
      status: body.status ?? 200,
      json: async () => body.json ?? {},
      text: async () => JSON.stringify(body.json ?? {})
    };
  };
}

describe("whatsapp-web /outbox HTTP contract", () => {
  let dir: string;
  let server: http.Server;
  let base: string;
  let cm: ReturnType<typeof fakeConnectionManager>;
  let outbox: any;

  function boot(connected = true) {
    cm = fakeConnectionManager(connected);
    outbox = new Outbox({
      file: path.join(dir, "outbox.json"),
      send: createOutboxSender(cm),
      // Timers are inert here: these tests drive the drain explicitly through
      // fire(), so nothing ever waits on a real 60 seconds.
      setTimer: () => 0 as unknown as NodeJS.Timeout,
      clearTimer: () => {}
    });
    const handler = createApp({
      connectionManager: cm,
      store: new MessageStore(dir),
      contactIndex: new ContactIndex(),
      outbox,
      port: 0,
      host: "127.0.0.1"
    });
    server = http.createServer(handler);
    return new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      })
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-outbox-"));
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it("POST /outbox parks the send, sends nothing, and says until when", async () => {
    await boot();
    const res = await fetch(`${base}/outbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "send_text", payload: { jid: JID, body: "later" }, context: "agent" })
    });
    const json: any = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: "pending", delaySeconds: 60, to: JID });
    expect(json.cancelHint).toContain(`/outbox/${json.id}/cancel`);
    expect(cm.calls).toHaveLength(0);
  });

  it("GET /outbox lists what is pending, with a preview but never the raw record", async () => {
    await boot();
    await fetch(`${base}/outbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "send_text", payload: { jid: JID, body: "the body" }, context: "agent" })
    });
    const json: any = await (await fetch(`${base}/outbox`)).json();
    expect(json.pending).toHaveLength(1);
    expect(json.pending[0]).toMatchObject({ to: JID, preview: "the body", status: "pending" });
    expect(json.pending[0].payload).toBeUndefined();
  });

  it("POST /outbox/:id/cancel prevents the send and is idempotent", async () => {
    await boot();
    const queued: any = await (
      await fetch(`${base}/outbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "send_text", payload: { jid: JID, body: "oops" }, context: "agent" })
      })
    ).json();

    const first: any = await (await fetch(`${base}/outbox/${queued.id}/cancel`, { method: "POST" })).json();
    expect(first).toMatchObject({ ok: true, status: "cancelled" });
    const second = await fetch(`${base}/outbox/${queued.id}/cancel`, { method: "POST" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, status: "cancelled" });

    // The window elapsing on a cancelled entry must not resurrect it.
    await outbox.fire(queued.id);
    expect(cm.calls).toHaveLength(0);
  });

  it("cancel after the send answers already-sent, honestly, with 409", async () => {
    await boot();
    const queued: any = await (
      await fetch(`${base}/outbox`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "send_text", payload: { jid: JID, body: "gone" }, context: "agent" })
      })
    ).json();
    await outbox.fire(queued.id);
    expect(cm.calls).toEqual([{ method: "sendText", args: [JID, "gone"] }]);

    const res = await fetch(`${base}/outbox/${queued.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, status: "sent", error: "already sent" });
  });

  it("cancelling an unknown id is a 404, not a silent success", async () => {
    await boot();
    const res = await fetch(`${base}/outbox/ob_nothing/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("refuses to park a send the daemon could never make (not connected)", async () => {
    await boot(false);
    const res = await fetch(`${base}/outbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "send_text", payload: { jid: JID, body: "hi" }, context: "agent" })
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ awaiting_connector: true });
  });

  it("refuses a bare name, an empty body, and an action the buffer does not carry", async () => {
    await boot();
    const post = (body: unknown) =>
      fetch(`${base}/outbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ action: "send_text", payload: { jid: "Maria", body: "hi" }, context: "agent" })).status).toBe(400);
    expect((await post({ action: "send_text", payload: { jid: JID, body: "  " }, context: "agent" })).status).toBe(400);
    expect((await post({ action: "delete_everything", payload: { jid: JID, body: "hi" } })).status).toBe(400);
  });

  it("the real send callback refuses an automation-context entry AT SEND TIME", async () => {
    // Nothing about this process says "automation" — the discriminator has to
    // come off the parked record, or the deferral would launder the refusal.
    await boot();
    const send = createOutboxSender(cm);
    await expect(send({ context: "automation", payload: { jid: JID, body: "hi" } } as any)).rejects.toThrow(/Automations engine/);
    expect(cm.calls).toHaveLength(0);
    await expect(send({ context: "agent", payload: { jid: JID, body: "hi" } } as any)).resolves.toMatchObject({ id: "wamid.fake" });
  });
});

describe("whatsapp-web connector send_text routing", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-conn-outbox-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("an agent-context send goes to /outbox and reports that it has NOT been sent", async () => {
    const env = { WHATSAPP_WEB_STATUS_FILE: statusFile(dir, "whatsapp-web.json", "http://127.0.0.1:9999") };
    const calls: Array<{ url: string; opts?: any }> = [];
    const result: any = await whatsappRunAction({
      action: "send_text",
      args: { to: JID, body: "hi" },
      env,
      fetchImpl: mockFetch(calls, () => ({ json: { ok: true, id: "ob_1", executeAt: "2026-08-13T10:01:00.000Z", delaySeconds: 60, cancelHint: "curl -sX POST http://127.0.0.1:9999/outbox/ob_1/cancel" } }))
    });
    expect(calls[0].url).toBe("http://127.0.0.1:9999/outbox");
    expect(JSON.parse(calls[0].opts.body)).toMatchObject({ action: "send_text", payload: { jid: JID, body: "hi" }, context: "agent" });
    expect(result).toMatchObject({ sent: false, queued: true, id: "ob_1" });
    expect(result.message).toContain("NOT SENT YET");
    expect(result.message).toContain("2026-08-13T10:01:00.000Z");
    expect(result.cancelHint).toContain("/outbox/ob_1/cancel");
  });

  it("a human-context send bypasses the buffer and posts immediately", async () => {
    const env = {
      WHATSAPP_WEB_STATUS_FILE: statusFile(dir, "whatsapp-web.json", "http://127.0.0.1:9999"),
      GARRISON_SEND_CONTEXT: "human"
    };
    const calls: Array<{ url: string; opts?: any }> = [];
    const result = await whatsappRunAction({
      action: "send_text",
      args: { to: JID, body: "hi" },
      env,
      fetchImpl: mockFetch(calls, () => ({ json: { id: "wamid.1" } }))
    });
    expect(calls[0].url).toBe("http://127.0.0.1:9999/send");
    expect(result).toEqual({ id: "wamid.1" });
  });

  it("still refuses the Automations engine before anything is parked", async () => {
    const env = {
      WHATSAPP_WEB_STATUS_FILE: statusFile(dir, "whatsapp-web.json", "http://127.0.0.1:9999"),
      GARRISON_AUTOMATION_ENGINE: "1"
    };
    const calls: Array<{ url: string; opts?: any }> = [];
    await expect(
      whatsappRunAction({ action: "send_text", args: { to: JID, body: "hi" }, env, fetchImpl: mockFetch(calls, () => ({ json: {} })) })
    ).rejects.toThrow(/Automations engine/);
    expect(calls).toHaveLength(0);
  });
});

describe("slack outbox routes", () => {
  const { Outbox: SlackOutbox, createOutboxRoutes, renderQueuedNotice, slackDestination, renderBatch } = slackOutbox;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "slack-outbox-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // delaySeconds 0 is how the drain tests get an already-due entry without
  // waiting a real minute; the window itself is covered in outbox-buffer.
  function routes(opts: { announce?: (entry: any) => Promise<void>; delaySeconds?: number } = {}) {
    // The adapter's wiring, minus Slack itself: one message per drain, rendered
    // exactly as scripts/slack-adapter.js renders it.
    const posted: Array<{ channel: string; text: string }> = [];
    const outbox = new SlackOutbox({
      file: path.join(dir, "outbox.json"),
      delaySeconds: opts.delaySeconds ?? 60,
      groupKey: slackDestination,
      send: async (entry: any, batch: any[]) => {
        posted.push({ channel: entry.payload.channel, text: renderBatch(batch) });
        return { posted: true, messages: batch.length };
      },
      setTimer: () => 0,
      clearTimer: () => {}
    });
    return { posted, outbox, api: createOutboxRoutes({ outbox, baseUrl: "http://127.0.0.1:29512", announce: opts.announce ?? null }) };
  }

  it("enqueue parks the post and reports the window", async () => {
    const { api, posted } = routes();
    const out = await api.enqueue({ action: "send_message", payload: { channel: "C123", text: "ship it" }, context: "agent" });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, status: "pending", to: "C123", preview: "ship it", delaySeconds: 60 });
    expect(out.body.cancelHint).toBe(`curl -sX POST http://127.0.0.1:29512/outbox/${out.body.id}/cancel`);
    expect(posted).toHaveLength(0);
  });

  it("announces the parked post through the fitting's own notify path", async () => {
    const announced: any[] = [];
    const { api } = routes({ announce: async (entry) => void announced.push(renderQueuedNotice(entry)) });
    const out = await api.enqueue({ action: "send_message", payload: { channel: "C123", text: "ship it" }, context: "agent" });
    expect(announced).toHaveLength(1);
    expect(announced[0].title).toBe("Message queued, not sent yet");
    expect(announced[0].text).toContain(out.body.executeAt);
    expect(announced[0].idempotencyKey).toBe(`outbox-queued:${out.body.id}`);
  });

  it("a failing announcement never swallows the parked send", async () => {
    const { api, outbox } = routes({ announce: async () => { throw new Error("slack is down"); } });
    const out = await api.enqueue({ action: "send_message", payload: { channel: "C123", text: "hi" }, context: "agent" });
    expect(out.status).toBe(200);
    expect(outbox.pending()).toHaveLength(1);
  });

  it("list, cancel, and cancel-after-send behave like the whatsapp contract", async () => {
    const { api, outbox, posted } = routes();
    const out = await api.enqueue({ action: "send_message", payload: { channel: "C123", text: "hi" }, context: "agent" });
    expect(api.list().body.pending).toHaveLength(1);

    expect(api.cancel(out.body.id)).toMatchObject({ status: 200, body: { ok: true, status: "cancelled" } });
    expect(api.cancel(out.body.id)).toMatchObject({ status: 200, body: { ok: true, status: "cancelled" } });
    await outbox.fire(out.body.id);
    expect(posted).toHaveLength(0);

    const second = await api.enqueue({ action: "send_message", payload: { channel: "C123", text: "two" }, context: "agent" });
    await outbox.fire(second.body.id);
    expect(posted).toHaveLength(1);
    expect(api.cancel(second.body.id)).toMatchObject({ status: 409, body: { ok: false, status: "sent" } });
    expect(api.cancel("ob_nope").status).toBe(404);
  });

  it("drains everything due for one channel as ONE post, not a burst", async () => {
    // chat.postMessage is rate-limited near one message per second per channel.
    const { api, outbox, posted } = routes({ delaySeconds: 0 });
    const first = await api.enqueue({ action: "send_message", payload: { channel: "C1", text: "build green" }, context: "agent" });
    await api.enqueue({ action: "send_message", payload: { channel: "C1", text: "deployed" }, context: "agent" });
    await api.enqueue({ action: "send_message", payload: { channel: "C2", text: "elsewhere" }, context: "agent" });

    await outbox.fire(first.body.id);
    expect(posted).toEqual([{ channel: "C1", text: "build green\n\ndeployed" }]);
    expect(api.list().body.pending.map((e: any) => e.to)).toEqual(["C2"]);
  });

  it("a lone parked message arrives verbatim, with nothing added to it", async () => {
    const { api, outbox, posted } = routes({ delaySeconds: 0 });
    const only = await api.enqueue({ action: "send_message", payload: { channel: "C1", text: "just this" }, context: "agent" });
    await outbox.fire(only.body.id);
    expect(posted).toEqual([{ channel: "C1", text: "just this" }]);
  });

  it("refuses an empty channel, an empty text, and a foreign action", async () => {
    const { api } = routes();
    expect((await api.enqueue({ action: "send_message", payload: { channel: "", text: "hi" } })).status).toBe(400);
    expect((await api.enqueue({ action: "send_message", payload: { channel: "C1", text: "  " } })).status).toBe(400);
    expect((await api.enqueue({ action: "chat.delete", payload: { channel: "C1", text: "hi" } })).status).toBe(400);
  });
});

describe("slack connector send_message routing", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "slack-conn-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("an agent-context send goes to the adapter's /outbox and reports it is not sent", async () => {
    const env = {
      SLACK_BOT_TOKEN: "xoxb-1",
      SLACK_CHANNEL_STATUS_FILE: statusFile(dir, "slack-channel.json", "http://127.0.0.1:29512")
    };
    const calls: Array<{ url: string; opts?: any }> = [];
    const result: any = await slackRunAction({
      action: "send_message",
      args: { channel: "C123", text: "ship it" },
      env,
      fetchImpl: mockFetch(calls, () => ({ json: { ok: true, id: "ob_9", executeAt: "2026-08-13T10:01:00.000Z", delaySeconds: 60, cancelHint: "curl -sX POST http://127.0.0.1:29512/outbox/ob_9/cancel" } }))
    });
    expect(calls[0].url).toBe("http://127.0.0.1:29512/outbox");
    expect(JSON.parse(calls[0].opts.body)).toMatchObject({ action: "send_message", payload: { channel: "C123", text: "ship it" }, context: "agent" });
    expect(result).toMatchObject({ sent: false, queued: true, id: "ob_9" });
    expect(result.message).toContain("NOT SENT YET");
  });

  it("a human-context send posts straight to chat.postMessage", async () => {
    const env = {
      SLACK_BOT_TOKEN: "xoxb-1",
      GARRISON_SEND_CONTEXT: "human",
      SLACK_CHANNEL_STATUS_FILE: statusFile(dir, "slack-channel.json", "http://127.0.0.1:29512")
    };
    const calls: Array<{ url: string; opts?: any }> = [];
    await slackRunAction({
      action: "send_message",
      args: { channel: "C123", text: "hi" },
      env,
      fetchImpl: mockFetch(calls, () => ({ json: { ok: true, ts: "1" } }))
    });
    expect(calls[0].url).toContain("chat.postMessage");
  });

  it("fails closed when no adapter is running: there is nothing to hold the window", async () => {
    const env = { SLACK_BOT_TOKEN: "xoxb-1", SLACK_CHANNEL_STATUS_FILE: path.join(dir, "absent.json") };
    const calls: Array<{ url: string; opts?: any }> = [];
    await expect(
      slackRunAction({ action: "send_message", args: { channel: "C123", text: "hi" }, env, fetchImpl: mockFetch(calls, () => ({ json: {} })) })
    ).rejects.toThrow(/adapter .* is not running/);
    expect(calls).toHaveLength(0);
  });

  it("says so plainly when the running adapter predates the /outbox route", async () => {
    const env = {
      SLACK_BOT_TOKEN: "xoxb-1",
      SLACK_CHANNEL_STATUS_FILE: statusFile(dir, "slack-channel.json", "http://127.0.0.1:29512")
    };
    await expect(
      slackRunAction({
        action: "send_message",
        args: { channel: "C123", text: "hi" },
        env,
        fetchImpl: mockFetch([], () => ({ status: 404, json: {} }))
      })
    ).rejects.toThrow(/no \/outbox route/);
  });

  it("list_channels is untouched by the buffer", async () => {
    const env = { SLACK_BOT_TOKEN: "xoxb-1" };
    const calls: Array<{ url: string; opts?: any }> = [];
    await slackRunAction({ action: "list_channels", args: { limit: 5 }, env, fetchImpl: mockFetch(calls, () => ({ json: { ok: true, channels: [] } })) });
    expect(calls[0].url).toContain("conversations.list");
  });
});
