import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContactIndex } from "../fittings/seed/whatsapp-web/lib/contacts.mjs";
import { MessageStore } from "../fittings/seed/whatsapp-web/lib/store.mjs";
import {
  buildConnectionManager,
  createAvatarResolver,
  createMessageBus,
  createOutboundAckTracker,
  WA_SENT_ACK_STATUS,
} from "../fittings/seed/whatsapp-web/scripts/server.mjs";

// Drives the REAL buildConnectionManager through its injectable seams — a FAKE
// Baileys module (baileysModuleLoader) and a FAKE fetch — so the outbound-ack
// gating and the avatar resolution are exercised end to end without ever
// importing @whiskeysockets/baileys or opening a socket, exactly like the
// sibling HTTP-layer tests fake the whole connection manager.

const flush = () => new Promise((r) => setTimeout(r, 40));

// Minimal stand-in for a Baileys socket: an emitter wireEvents() can subscribe
// to, plus the handful of methods the manager reads. emit() is our test hook to
// fire the events Baileys would fire on the wire.
function makeFakeSock(profilePictureUrl: (jid: string, kind?: string) => Promise<string | undefined>) {
  const handlers = new Map<string, Set<(payload: any) => void>>();
  return {
    ev: {
      on(event: string, fn: (payload: any) => void) {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(fn);
      },
      emit(event: string, payload: unknown) {
        for (const fn of handlers.get(event) ?? []) fn(payload);
      },
    },
    user: { id: "999@s.whatsapp.net" },
    profilePictureUrl,
    requestPairingCode: async () => "PAIRCODE",
    sendMessage: async () => ({ key: { id: "wamid.sent" } }),
    resyncAppState: async () => {},
    end() {},
  };
}

function makeBaileysMock() {
  const socks: any[] = [];
  const profileCalls: Array<[string, string | undefined]> = [];
  let profileImpl: (jid: string, kind?: string) => Promise<string | undefined> = async () => undefined;
  const mod = {
    default: (_opts: any) => {
      const sock = makeFakeSock(async (jid: string, kind?: string) => {
        profileCalls.push([jid, kind]);
        return profileImpl(jid, kind);
      });
      socks.push(sock);
      return sock;
    },
    useMultiFileAuthState: async () => ({
      state: { creds: { registered: true }, keys: {} },
      saveCreds: async () => {},
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
  };
  return { mod, socks, profileCalls, setProfileImpl: (f: typeof profileImpl) => { profileImpl = f; } };
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function bootManager() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wweb-ack-"));
  tmpDirs.push(dir);
  // A saved session on disk is what makes init() connect() rather than idle.
  mkdirSync(path.join(dir, "auth"), { recursive: true });
  writeFileSync(path.join(dir, "auth", "creds.json"), JSON.stringify({ registered: true }));

  const bus = createMessageBus();
  const events: any[] = [];
  bus.subscribe((e) => events.push(e));
  const store = new MessageStore(dir);
  const contactIndex = new ContactIndex();
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const baileys = makeBaileysMock();

  const cm = buildConnectionManager({
    sessionDir: dir,
    gatewayUrl: "http://127.0.0.1:1/gw",
    store,
    contactIndex,
    sendQueue: { enqueue: (task: () => Promise<unknown>) => task() },
    messageBus: bus,
    fetchImpl: async (url: string, init: any) => { fetchCalls.push({ url, init }); return { ok: true }; },
    baileysModuleLoader: async () => baileys.mod,
    log: () => {},
  });
  await cm.init();
  return { dir, cm, sock: baileys.socks[0], bus, events, store, contactIndex, baileys, fetchCalls };
}

function outMsg(id: string, jid: string, body: string) {
  return { messages: [{ key: { id, remoteJid: jid, fromMe: true }, message: { conversation: body }, messageTimestamp: 1_700_000_000 }] };
}
function inMsg(id: string, jid: string, body: string, pushName?: string) {
  return { messages: [{ key: { id, remoteJid: jid, fromMe: false }, message: { conversation: body }, pushName, messageTimestamp: 1_700_000_001 }] };
}
function ack(id: string, jid: string, status: number) {
  return [{ key: { id, remoteJid: jid, fromMe: true }, update: { status } }];
}

describe("whatsapp-web outbound ack gating (real connection manager)", () => {
  it("a stored outbound message does NOT pulse until its ack arrives, but is still stored", async () => {
    const { sock, events, store } = await bootManager();
    sock.ev.emit("messages.upsert", outMsg("m1", "111@s.whatsapp.net", "hello out"));
    await flush();
    expect(events).toHaveLength(0); // nothing on the bus yet — send unconfirmed
    expect(store.recentMessages(5).map((m: any) => m.id)).toContain("m1"); // persisted regardless
  });

  it("SERVER_ACK publishes exactly one 'sent' pulse; later DELIVERY/READ acks don't republish", async () => {
    const { sock, events, contactIndex } = await bootManager();
    contactIndex.upsert("111@s.whatsapp.net", "Bruno");
    sock.ev.emit("messages.upsert", outMsg("m1", "111@s.whatsapp.net", "oi"));
    await flush();
    expect(events).toHaveLength(0);

    sock.ev.emit("messages.update", ack("m1", "111@s.whatsapp.net", WA_SENT_ACK_STATUS));
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message",
      direction: "out",
      chatName: "Bruno",
      preview: "oi",
      ackStatus: WA_SENT_ACK_STATUS,
    });

    // DELIVERY_ACK (3) then READ (4) for the same id — takeAcked already
    // consumed the entry, so neither republishes.
    sock.ev.emit("messages.update", ack("m1", "111@s.whatsapp.net", 3));
    sock.ev.emit("messages.update", ack("m1", "111@s.whatsapp.net", 4));
    await flush();
    expect(events).toHaveLength(1);
  });

  it("an ack for an unknown message id publishes nothing", async () => {
    const { sock, events } = await bootManager();
    sock.ev.emit("messages.update", ack("never-tracked", "111@s.whatsapp.net", WA_SENT_ACK_STATUS));
    await flush();
    expect(events).toHaveLength(0);
  });

  it("an inbound message pulses immediately (with avatar) and forwards to the gateway", async () => {
    const { sock, events, fetchCalls, baileys } = await bootManager();
    baileys.setProfileImpl(async () => "https://pps.whatsapp.net/rita.jpg");
    sock.ev.emit("messages.upsert", inMsg("in1", "222@s.whatsapp.net", "ola", "Rita"));
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "message",
      direction: "in",
      chatName: "Rita",
      preview: "ola",
      avatarUrl: "https://pps.whatsapp.net/rita.jpg",
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/chat");
  });

  it("a rejecting profilePictureUrl yields avatarUrl null, and repeat jids hit the cache once", async () => {
    const { sock, events, baileys } = await bootManager();
    baileys.setProfileImpl(async () => { throw new Error("photo blocked"); });
    sock.ev.emit("messages.upsert", inMsg("in1", "333@s.whatsapp.net", "a"));
    await flush();
    sock.ev.emit("messages.upsert", inMsg("in2", "333@s.whatsapp.net", "b"));
    await flush();
    expect(events).toHaveLength(2);
    expect(events[0].avatarUrl).toBeNull();
    expect(events[1].avatarUrl).toBeNull();
    // Second lookup served from the negative cache — the socket is hit once.
    expect(baileys.profileCalls.filter((c) => c[0] === "333@s.whatsapp.net")).toHaveLength(1);
  });
});

describe("createOutboundAckTracker", () => {
  it("takeAcked returns the payload once, then null (dedupe)", () => {
    const tr = createOutboundAckTracker();
    tr.trackPending({ id: "a", chatJid: "x@s", chatName: "X", preview: "hi", timestamp: 1 });
    expect(tr.takeAcked("a")).toMatchObject({ chatJid: "x@s", chatName: "X", preview: "hi" });
    expect(tr.takeAcked("a")).toBeNull();
  });

  it("prunes entries older than maxAgeMs on the next insert", () => {
    let t = 0;
    const tr = createOutboundAckTracker({ maxAgeMs: 1000, now: () => t });
    tr.trackPending({ id: "old", chatJid: "x@s", chatName: null, preview: "a", timestamp: 0 });
    expect(tr.size).toBe(1);
    t = 2000; // past maxAgeMs
    tr.trackPending({ id: "new", chatJid: "y@s", chatName: null, preview: "b", timestamp: 0 });
    expect(tr.takeAcked("old")).toBeNull(); // aged out
    expect(tr.takeAcked("new")).toMatchObject({ chatJid: "y@s" });
  });

  it("caps at maxEntries, evicting the oldest first", () => {
    const tr = createOutboundAckTracker({ maxEntries: 2 });
    for (const id of ["a", "b", "c"]) tr.trackPending({ id, chatJid: `${id}@s`, chatName: null, preview: id, timestamp: 0 });
    expect(tr.size).toBe(2);
    expect(tr.takeAcked("a")).toBeNull(); // oldest evicted
    expect(tr.takeAcked("c")).toBeTruthy();
  });

  it("ignores entries without an id", () => {
    const tr = createOutboundAckTracker();
    tr.trackPending({ id: "", chatJid: "x@s", chatName: null, preview: "x", timestamp: 0 } as any);
    expect(tr.size).toBe(0);
    expect(tr.takeAcked("")).toBeNull();
  });
});

describe("createAvatarResolver", () => {
  it("resolves a URL and caches it — the socket is hit once per jid", async () => {
    let calls = 0;
    const r = createAvatarResolver({
      getProfilePictureUrl: async () => { calls++; return "https://pps.whatsapp.net/p.jpg"; },
    });
    expect(await r.lookup("1@s")).toBe("https://pps.whatsapp.net/p.jpg");
    expect(await r.lookup("1@s")).toBe("https://pps.whatsapp.net/p.jpg");
    expect(calls).toBe(1);
  });

  it("times out to null without hanging", async () => {
    const r = createAvatarResolver({
      getProfilePictureUrl: () => new Promise<string>(() => {}), // never resolves
      timeoutMs: 20,
    });
    expect(await r.lookup("1@s")).toBeNull();
  });

  it("caches a miss under a short negative TTL, then retries after it lapses", async () => {
    let t = 0;
    let calls = 0;
    const r = createAvatarResolver({
      getProfilePictureUrl: async () => { calls++; return undefined; }, // no photo
      negativeTtlMs: 1000,
      now: () => t,
    });
    expect(await r.lookup("1@s")).toBeNull();
    expect(await r.lookup("1@s")).toBeNull();
    expect(calls).toBe(1); // negative cache hit
    t = 2000; // negative TTL lapsed
    expect(await r.lookup("1@s")).toBeNull();
    expect(calls).toBe(2); // retried
  });

  it("never throws when the getter throws — returns null", async () => {
    const r = createAvatarResolver({ getProfilePictureUrl: () => { throw new Error("boom"); } });
    expect(await r.lookup("1@s")).toBeNull();
  });
});
