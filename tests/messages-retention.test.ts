import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimWork, emitSystem, getMessage, listMessages, pruneMessages, registerProvider, upsertMessage, enqueueOutbox } from "../services/state/src/messages/store.mjs";
import { baseAttachment } from "../packages/messages/providers/shared";
import { googleDescriptor } from "../packages/messages/providers/google-common";
import { messagesDbFixture } from "./messages-db-fixture";

let fixture: ReturnType<typeof messagesDbFixture>;
beforeEach(() => { fixture = messagesDbFixture(); });
afterEach(() => { fixture.close(); });
const at = Date.parse("2026-09-13T12:00:00.000Z");
const age = (days: number) => new Date(at - days * 86400_000).toISOString();

describe("Messages retention", () => {
  it('prunes terminal uploads after native attachment replacement while preserving a starred send and active retry',()=>{
    const outbox=(id:string)=>{
      enqueueOutbox(fixture.db,fixture.node,{id,provider:'mail-fixture',account:fixture.account,to:{address:'self@example.invalid'},body:{markdown:'Fixture'},attachments:[{path:`attachments/mail-fixture/account/2026-01/${id}.png`,name:'image.png',mime:'image/png'}]});
      fixture.db.prepare("UPDATE messages_outbox SET createdAt=?,status='sent',externalId=? WHERE id=?").run(age(120),id,id);
    };
    outbox('expired');outbox('starred-send');outbox('retry-origin');
    fixture.ingest('starred-send',{externalId:'starred-send',ts:age(120),starred:true});
    enqueueOutbox(fixture.db,fixture.node,{id:'active-retry',provider:'mail-fixture',account:fixture.account,to:{address:'self@example.invalid'},body:{markdown:'Retry'},attachments:[]});
    fixture.db.prepare('UPDATE messages_outbox SET externalReceipt=? WHERE id=?').run(JSON.stringify({retryOutboxId:'active-retry'}),'retry-origin');
    pruneMessages(fixture.db,fixture.node,{at});
    expect(fixture.db.prepare('SELECT id FROM messages_outbox ORDER BY id').all().map((r:any)=>r.id)).toEqual(['active-retry','retry-origin','starred-send']);
    const jobs=fixture.db.prepare("SELECT payload FROM messages_effects WHERE kind='pruneFiles'").all().map((r:any)=>JSON.parse(r.payload));
    expect(jobs).toEqual([{id:'outbox:expired',ownerNode:fixture.node,paths:['attachments/mail-fixture/account/2026-01/expired.png']}]);
  });
  it('does not unlink a retained message file when an older message shares its path',()=>{
    const attachment={...baseAttachment('shared','image.png','image/png',50),path:'attachments/mail-fixture/account/2026-01/shared.png',ownerNode:fixture.node};
    fixture.ingest('old-shared',{ts:age(120),attachments:[attachment]});
    fixture.ingest('kept-shared',{ts:age(120),starred:true,attachments:[attachment]});
    expect(pruneMessages(fixture.db,fixture.node,{at}).removed).toBe(1);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM messages_effects WHERE kind='pruneFiles'").get().n).toBe(0);
  });
  it("prunes old provider records while retaining the boundary, starred and card-linked messages", () => {
    const old = fixture.ingest("old", { ts: age(91) });
    const boundary = fixture.ingest("boundary", { ts: age(90) });
    const starred = fixture.ingest("starred", { ts: age(120), starred: true });
    const card = fixture.ingest("card", { ts: age(120), cardId: "card-fixture" });
    expect(pruneMessages(fixture.db, fixture.node, { at })).toEqual({ removed: 1 });
    expect(getMessage(fixture.db, old.id)).toBeNull();
    expect([boundary, starred, card].every(message => getMessage(fixture.db, message.id))).toBe(true);
    expect(fixture.db.prepare("SELECT id FROM messages_conversations WHERE id=?").get(old.conversationId)).toBeUndefined();
    expect(listMessages(fixture.db, { text: "fixture" }).messages).toHaveLength(3);
  });
  it.each(["question", "approval", "revert"])("keeps an unanswered system %s beyond retention and prunes its answered counterpart", (kind) => {
    function system(id: string, answeredAt: string | null) {
      const result = emitSystem(fixture.db, fixture.node, { category: "card.needs-input", title: id, body: "Fixture system message", idempotencyKey: id,
        action: { kind, prompt: "Choose?", options: null, answer: answeredAt ? "Keep" : null, answeredAt, revertUntil: null } });
      return upsertMessage(fixture.db, fixture.node, { ...result.message, ts: age(120) }).message;
    }
    const unanswered = system("unanswered", null);
    const answered = system("answered", age(110));
    expect(pruneMessages(fixture.db, fixture.node, { at }).removed).toBe(1);
    expect(getMessage(fixture.db, unanswered.id)).not.toBeNull();
    expect(getMessage(fixture.db, answered.id)).toBeNull();
  });
  it("prunes ordinary system information after ninety days", () => {
    const result = emitSystem(fixture.db, fixture.node, { category: "card.done", title: "Done fixture", body: "Complete" });
    upsertMessage(fixture.db, fixture.node, { ...result.message, ts: age(91) });
    expect(pruneMessages(fixture.db, fixture.node, { at }).removed).toBe(1);
  });
  it("honors each provider retention setting", () => {
    registerProvider(fixture.db, "provider-owner", { descriptor: { ...googleDescriptor([{ id: fixture.account, label: "Fixture account" }]), id: "mail-fixture", retentionDays: 30 } });
    const short = fixture.ingest("short-retention", { ts: age(31) });
    const longer = fixture.ingest("default-retention", { provider: "chat-fixture", ts: age(31) });
    expect(pruneMessages(fixture.db, fixture.node, { at }).removed).toBe(1);
    expect(getMessage(fixture.db, short.id)).toBeNull();
    expect(getMessage(fixture.db, longer.id)).not.toBeNull();
  });
  it("routes original, HTML, thumbnail and playback cleanup to their actual file owners", () => {
    const audio = { ...baseAttachment("audio", "voice.ogg", "audio/ogg", 100), path: "attachments/mail-fixture/account/2026-01/audio.ogg", playbackPath: "attachments/mail-fixture/account/2026-01/audio.m4a", transcriptStatus: "done", transcript: "Fixture transcript", ownerNode: fixture.node };
    const image = { ...baseAttachment("image", "image.jpg", "image/jpeg", 100), path: "attachments/mail-fixture/account/2026-01/image.jpg", thumbPath: "attachments/mail-fixture/account/2026-01/image.thumb.webp", ownerNode: "provider-owner" };
    const message = fixture.ingest("file-owners", { ts: age(120), attachments: [audio, image], rawPath: "raw/mail-fixture/account/message.json", rawOwnerNode: "provider-owner", bodyHtmlPath: "html/message.html", htmlOwnerNode: "provider-owner" });
    expect(pruneMessages(fixture.db, fixture.node, { at }).removed).toBe(1);
    expect(claimWork(fixture.db, "other-node", "effects").item).toBeNull();
    const local = claimWork(fixture.db, fixture.node, "effects").item;
    expect(local.kind).toBe("pruneFiles");
    expect(local.payload).toEqual({ id: message.id, ownerNode: fixture.node, paths: [audio.path, audio.playbackPath] });
    const remote = claimWork(fixture.db, "provider-owner", "effects").item;
    expect(remote.payload.ownerNode).toBe("provider-owner");
    expect(remote.payload.paths.sort()).toEqual(["raw/mail-fixture/account/message.json", "html/message.html", `html/${message.id}.images.json`, image.path, image.thumbPath].sort());
    expect(pruneMessages(fixture.db, fixture.node, { at }).removed).toBe(0);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM messages_effects WHERE kind='pruneFiles'").get().n).toBe(2);
  });
});
