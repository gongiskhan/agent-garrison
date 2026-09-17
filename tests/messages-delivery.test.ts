import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimWork, finishWork, renewWork, emitSystem, enqueueOutbox, cancelOutbox, retryOutbox, getMessage, listMessages } from "../services/state/src/messages/store.mjs";
import { messagesDbFixture } from "./messages-db-fixture";

let fixture: ReturnType<typeof messagesDbFixture>;
beforeEach(() => { fixture = messagesDbFixture(); });
afterEach(() => { fixture.close(); });
const emit = () => emitSystem(fixture.db, fixture.node, { title: "Fixture notice", body: "Stored fixture notification" }).message;
const nextRetry = (id: string) => fixture.db.prepare("UPDATE messages_mirrors SET claimUntil=? WHERE messageId=?").run("2000-01-01T00:00:00.000Z", id);
const send = (id: string) => enqueueOutbox(fixture.db, fixture.node, { id, provider: "mail-fixture", account: fixture.account,
  to: { address: "self@example.invalid" }, body: { markdown: "Fixture only" }, attachments: [], origin: "agent" });
const heldNotice = (id: string) => listMessages(fixture.db, { kinds: ["system"] }).messages.find((message: any) => message.action?.target?.outboxId === id);

describe("Messages durable delivery workers", () => {
  it("backs off failed mirrors and carries successful targets into the next claim", () => {
    const message = emit(), first = claimWork(fixture.db, fixture.node, "mirrors");
    finishWork(fixture.db, fixture.node, "mirrors", message.id, { claimToken: first.claimToken, error: "Slack unavailable",
      receipt: [{ id: "web", ok: true }, { id: "slack", ok: false }] });
    expect(claimWork(fixture.db, "peer", "mirrors").item).toBeNull();
    nextRetry(message.id); expect(claimWork(fixture.db, "peer", "mirrors").item).toBeNull();
    const second = claimWork(fixture.db, fixture.node, "mirrors");
    expect(JSON.parse(second.item.receipt)).toEqual([{ id: "web", ok: true }, { id: "slack", ok: false }]);
    finishWork(fixture.db, fixture.node, "mirrors", message.id, { claimToken: second.claimToken, receipt: [{ id: "slack", ok: true }] });
    const stored = fixture.db.prepare("SELECT * FROM messages_mirrors WHERE messageId=?").get(message.id);
    expect(stored.status).toBe("done"); expect(JSON.parse(stored.receipt)).toEqual([{ id: "web", ok: true }, { id: "slack", ok: true }]);
    expect(claimWork(fixture.db, fixture.node, "mirrors").item).toBeNull();
  });
  it("ends repeated mirror failures with one visible, unmirrored system warning", () => {
    const message = emit();
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) nextRetry(message.id);
      const claim = claimWork(fixture.db, fixture.node, "mirrors");
      finishWork(fixture.db, fixture.node, "mirrors", message.id, { claimToken: claim.claimToken, error: "Fixture delivery failed", receipt: [{ id: "slack", ok: false }] });
    }
    expect(fixture.db.prepare("SELECT status,attempts FROM messages_mirrors WHERE messageId=?").get(message.id)).toEqual({ status: "failed", attempts: 5 });
    const warnings = listMessages(fixture.db, { categories: ["system.warning"] }).messages;
    expect(warnings).toHaveLength(1); expect(warnings[0]).toMatchObject({ subject: "Notification delivery failed", suppressNotification: true });
    expect(claimWork(fixture.db, fixture.node, "mirrors").item).toBeNull();
  });
  it("renews the current work claim and rejects a guessed or expired token", () => {
    const message = emit(), claim = claimWork(fixture.db, fixture.node, "mirrors");
    expect(renewWork(fixture.db, fixture.node, "mirrors", message.id, { claimToken: claim.claimToken })).toMatchObject({ renewed: true });
    expect(() => renewWork(fixture.db, fixture.node, "mirrors", message.id, { claimToken: "wrong" })).toThrow("expired or changed");
    nextRetry(message.id);
    expect(() => renewWork(fixture.db, fixture.node, "mirrors", message.id, { claimToken: claim.claimToken })).toThrow("expired or changed");
  });
  it("closes the held notice after cancellation", () => {
    send("cancelled-send"); const notice = heldNotice("cancelled-send"); expect(notice.action.answeredAt).toBeNull();
    cancelOutbox(fixture.db, fixture.node, "cancelled-send");
    expect(getMessage(fixture.db, notice.id)).toMatchObject({ read: true, action: { answeredAt: expect.any(String), answer: "Cancelled" } });
  });
  it("keeps the held notice open for a delegated receipt and closes it only on sent confirmation", () => {
    send("delegated-send"); const notice = heldNotice("delegated-send");
    fixture.db.prepare("UPDATE messages_outbox SET holdUntil=? WHERE id=?").run("2000-01-01T00:00:00.000Z", "delegated-send");
    const claim = claimWork(fixture.db, fixture.node, "outbox");
    finishWork(fixture.db, fixture.node, "outbox", "delegated-send", { claimToken: claim.claimToken, pending: true, externalReceipt: { id: "external-send" }, nextAttemptAt: "2000-01-01T00:00:00.000Z" });
    expect(getMessage(fixture.db, notice.id).action.answeredAt).toBeNull();
    const confirmed = claimWork(fixture.db, fixture.node, "outbox");
    finishWork(fixture.db, fixture.node, "outbox", "delegated-send", { claimToken: confirmed.claimToken, externalId: "sent-message" });
    expect(getMessage(fixture.db, notice.id)).toMatchObject({ action: { answer: "Sent", answeredAt: expect.any(String) } });
  });
  it("creates one explicitly requested retry with a fresh hold and the original attachment owner", () => {
    send("failed-send"); fixture.db.prepare("UPDATE messages_outbox SET status='failed',externalReceipt=? WHERE id=?").run(JSON.stringify({ id: "external-failed" }), "failed-send");
    const first = retryOutbox(fixture.db, "viewing-peer", "failed-send"), repeated = retryOutbox(fixture.db, "viewing-peer", "failed-send");
    expect(first.item.id).not.toBe("failed-send"); expect(repeated.item.id).toBe(first.item.id);
    expect(Date.parse(first.item.holdUntil) - Date.now()).toBeGreaterThan(58_000);
    const newRow = fixture.db.prepare("SELECT * FROM messages_outbox WHERE id=?").get(first.item.id);
    expect(newRow).toMatchObject({ ownerNode: fixture.node, status: "held", externalReceipt: null, origin: "agent" });
    expect(fixture.db.prepare("SELECT status FROM messages_outbox WHERE id='failed-send'").get().status).toBe("failed");
    expect(() => retryOutbox(fixture.db, fixture.node, first.item.id)).toThrow("Only a failed send");
  });
});
