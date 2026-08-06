import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageStore } from "../fittings/seed/whatsapp-web/lib/store.mjs";

describe("whatsapp-web MessageStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("append() persists a message and it's readable back via lastForChat", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-store-"));
    const store = new MessageStore(dir);
    store.append({ id: "1", chatJid: "a@s.whatsapp.net", body: "hi", timestamp: 1000, fromMe: false });
    expect(store.lastForChat("a@s.whatsapp.net")).toMatchObject({ id: "1", body: "hi" });
  });

  it("lastForChat() returns null for a chat with no messages", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-store-"));
    const store = new MessageStore(dir);
    expect(store.lastForChat("nope@s.whatsapp.net")).toBeNull();
  });

  it("lastForChat() tracks the most recent message per chat by timestamp", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-store-"));
    const store = new MessageStore(dir);
    store.append({ id: "1", chatJid: "a@s.whatsapp.net", body: "first", timestamp: 1000 });
    store.append({ id: "2", chatJid: "a@s.whatsapp.net", body: "second", timestamp: 2000 });
    expect(store.lastForChat("a@s.whatsapp.net")).toMatchObject({ id: "2", body: "second" });
  });

  it("recentMessages() returns newest first, capped at n", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-store-"));
    const store = new MessageStore(dir);
    for (let i = 0; i < 5; i++) {
      store.append({ id: String(i), chatJid: "a@s.whatsapp.net", body: `m${i}`, timestamp: i });
    }
    const recent = store.recentMessages(3);
    expect(recent.map((m: any) => m.id)).toEqual(["4", "3", "2"]);
  });

  it("recentMessages() defaults to 20", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-store-"));
    const store = new MessageStore(dir);
    for (let i = 0; i < 25; i++) {
      store.append({ id: String(i), chatJid: "a@s.whatsapp.net", body: `m${i}`, timestamp: i });
    }
    expect(store.recentMessages()).toHaveLength(20);
  });

  it("reloads its index from an existing messages.jsonl on construction", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-store-"));
    const first = new MessageStore(dir);
    first.append({ id: "1", chatJid: "a@s.whatsapp.net", body: "hi", timestamp: 1000 });

    const second = new MessageStore(dir);
    expect(second.lastForChat("a@s.whatsapp.net")).toMatchObject({ id: "1", body: "hi" });
    expect(second.recentMessages()).toHaveLength(1);
  });

  it("skips a corrupt trailing line instead of failing to load", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-store-"));
    const good = JSON.stringify({ id: "1", chatJid: "a@s.whatsapp.net", body: "hi", timestamp: 1000 });
    writeFileSync(path.join(dir, "messages.jsonl"), `${good}\nnot json\n`, { mode: 0o600 });
    const store = new MessageStore(dir);
    expect(store.recentMessages()).toHaveLength(1);
  });

  it("caps the in-memory recent list at maxRecent", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wweb-store-"));
    const store = new MessageStore(dir, { maxRecent: 3 });
    for (let i = 0; i < 10; i++) {
      store.append({ id: String(i), chatJid: "a@s.whatsapp.net", body: `m${i}`, timestamp: i });
    }
    expect(store.recent).toHaveLength(3);
    expect(store.recentMessages(10).map((m: any) => m.id)).toEqual(["9", "8", "7"]);
  });
});
