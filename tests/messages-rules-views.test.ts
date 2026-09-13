import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRule, claimWork, counts, deleteView, emitSystem, finishWork, getConversation, getMessage, listMessages, listRules, listViews, saveRule, saveView, testRule } from "../services/state/src/messages/store.mjs";
import { baseAttachment } from "../packages/messages/providers/shared";
import { messagesDbFixture } from "./messages-db-fixture";
import { openDb } from "../services/state/src/db.mjs";
import path from "node:path";

let fixture: ReturnType<typeof messagesDbFixture>;
beforeEach(() => { fixture = messagesDbFixture(); });
afterEach(() => { fixture.close(); });
const rule = (input: Record<string, any> = {}) => saveRule(fixture.db, fixture.node, { name: "Fixture rule", match: {}, actions: [{ type: "label", label: "client" }], ...input }).rule;

describe("Messages deterministic rules", () => {
  it("applies every supported action before notification delivery", () => {
    const saved = rule({ actions: [{ type: "markRead" }, { type: "archive" }, { type: "star" }, { type: "mute" }, { type: "label", label: "client" }, { type: "suppressNotification" }, { type: "createCard", project: "fixture-project", flow: "delivery" }] });
    const input = fixture.ingest("all-actions");
    expect(getMessage(fixture.db, input.id)).toMatchObject({ read: true, archived: true, starred: true, labels: ["client"], suppressNotification: true });
    expect(getConversation(fixture.db, input.conversationId).conversation).toMatchObject({ muted: true, unreadCount: 0 });
    expect(claimWork(fixture.db, fixture.node, "mirrors").item).toBeNull();
    const effects = fixture.db.prepare("SELECT kind,payload FROM messages_effects ORDER BY kind").all();
    expect(effects.map((effect: any) => effect.kind)).toEqual(["createCard", "providerState"]);
    expect(JSON.parse(effects[0].payload)).toEqual({ type: "createCard", project: "fixture-project", flow: "delivery" });
    expect(listRules(fixture.db).find((entry: any) => entry.id === saved.id)).toMatchObject({ matchedCount: 1, lastMatchedAt: expect.any(String) });
  });
  it("preserves cumulative labels and lets later rules match earlier state changes", () => {
    rule({ name: "First", order: 1, actions: [{ type: "label", label: "first" }] });
    rule({ name: "Second", order: 2, match: { labels: ["first"] }, actions: [{ type: "label", label: "second" }, { type: "star" }] });
    const message = fixture.ingest("ordered");
    expect(getMessage(fixture.db, message.id)).toMatchObject({ labels: ["first", "second"], starred: true });
    expect(listRules(fixture.db).map((entry: any) => entry.matchedCount)).toEqual([1, 1]);
  });
  it("skips disabled rules and stops only when a matching enabled rule requests it", () => {
    rule({ name: "Disabled", enabled: false, order: 0, stopProcessing: true, actions: [{ type: "star" }] });
    rule({ name: "No match", order: 1, match: { senderIs: ["other@example.invalid"] }, stopProcessing: true, actions: [{ type: "archive" }] });
    rule({ name: "Stop", order: 2, stopProcessing: true, actions: [{ type: "label", label: "stopped" }] });
    rule({ name: "Too late", order: 3, actions: [{ type: "markRead" }] });
    const message = fixture.ingest("stop");
    expect(getMessage(fixture.db, message.id)).toMatchObject({ labels: ["stopped"], read: false, starred: false, archived: false });
    expect(listRules(fixture.db).map((entry: any) => entry.matchedCount)).toEqual([0, 0, 1, 0]);
  });
  it("runs once per rule revision despite changed resyncs and retries", () => {
    const saved = rule({ match: { providers: ["mail-fixture"] }, actions: [{ type: "label", label: "client" }, { type: "createCard" }] });
    const message = fixture.ingest("repeat");
    fixture.ingest("repeat", { bodyText: "Provider changed body" });
    applyRule(fixture.db, fixture.node, saved.id);
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM messages_effects WHERE kind='createCard'").get().n).toBe(1);
    expect(listRules(fixture.db)[0].matchedCount).toBe(1);
    const effect = claimWork(fixture.db, fixture.node, "effects");
    finishWork(fixture.db, fixture.node, "effects", effect.item.id, { claimToken: effect.claimToken, cardId: "created-card" });
    expect(getMessage(fixture.db, message.id).cardId).toBe("created-card");
    rule({ ...saved, actions: [{ type: "star" }] });
    applyRule(fixture.db, fixture.node, saved.id);
    expect(getMessage(fixture.db, message.id).starred).toBe(true);
    expect(listRules(fixture.db)[0].matchedCount).toBe(2);
  });
  it("matches deterministic text conditions case-insensitively and only inbound messages", () => {
    rule({ match: { senderIs: ["CLIENT@EXAMPLE.INVALID"], subjectContains: "SUBJECT", bodyContains: "BODY" }, actions: [{ type: "star" }] });
    const incoming = fixture.ingest("incoming");
    const outgoing = fixture.ingest("outgoing", { direction: "out" });
    const wrongBody = fixture.ingest("wrong-body", { bodyText: "Something else" });
    expect([incoming, outgoing, wrongBody].map(message => getMessage(fixture.db, message.id).starred)).toEqual([true, false, false]);
  });
  it("does not create recursive cards from system events that already reference a card", () => {
    rule({ actions: [{ type: "createCard" }] });
    emitSystem(fixture.db, fixture.node, { category: "card.created", title: "Card created", body: "Fixture", cardId: "existing-card" });
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM messages_effects WHERE kind='createCard'").get().n).toBe(0);
    emitSystem(fixture.db, fixture.node, { category: "system.error", title: "Error", body: "An actionable fixture error" });
    expect(fixture.db.prepare("SELECT COUNT(*) AS n FROM messages_effects WHERE kind='createCard'").get().n).toBe(1);
  });
  it("returns the exact Apply count with at most twenty test rows and one completion notice", () => {
    for (let index = 0; index < 24; index++) fixture.ingest(`existing-${index}`, { subject: "Existing fixture" });
    fixture.ingest("outbound-existing", { direction: "out", subject: "Existing fixture" });
    const saved = rule({ name: "Existing clients", match: { subjectContains: "Existing" } });
    const tested = testRule(fixture.db, saved);
    expect(tested.count).toBe(24);
    expect(tested.messages).toHaveLength(20);
    expect(applyRule(fixture.db, fixture.node, saved.id).count).toBe(tested.count);
    expect(applyRule(fixture.db, fixture.node, saved.id).count).toBe(tested.count);
    expect(listMessages(fixture.db, { labels: ["client"] }).messages).toHaveLength(24);
    const notices = listMessages(fixture.db, { categories: ["rules.applied"] }).messages;
    expect(notices).toHaveLength(1);
    expect(notices[0].bodyText).toBe("Rule Existing clients applied to 24 messages.");
    expect(listRules(fixture.db)[0].matchedCount).toBe(24);
  });
  it.each(["mute", "suppressNotification"])("%s prevents enqueueing a mirror while ordinary messages still notify", (action) => {
    rule({ match: { bodyContains: "quiet" }, actions: [{ type: action }] });
    fixture.ingest("quiet", { bodyText: "quiet fixture" });
    const ordinary = fixture.ingest("ordinary");
    expect(fixture.db.prepare("SELECT messageId FROM messages_mirrors").all()).toEqual([{ messageId: ordinary.id }]);
  });
  it.each([
    { actions: [null] }, { actions: [{ type: "send", body: "not supported" }] }, { actions: [{ type: "label", label: "" }] },
    { actions: [{ type: "createCard", project: { instruction: "not a project id" } }] }, { actions: [{ type: "createCard", flow: 4 }] },
    { enabled: "false" }, { stopProcessing: "false" }, { order: Number.NaN },
  ])("rejects malformed rule state or action fields %#", (input) => {
    expect(() => rule(input)).toThrow();
  });
});

describe("Messages saved filters and views", () => {
  it("combines provider unions with the remaining filter fields and computes unread view counts", () => {
    const file = baseAttachment("file", "fixture.txt", "text/plain", 10);
    const mail = fixture.ingest("mail-with-file", { attachments: [file] });
    const chat = fixture.ingest("chat-with-file", { provider: "chat-fixture", attachments: [file] });
    fixture.ingest("read-mail", { read: true, attachments: [file] });
    fixture.ingest("mail-without-file");
    fixture.ingest("another-sender", { sender: { id: "different", name: "Someone else", isMe: false }, attachments: [file] });
    const filter = { providers: ["mail-fixture", "chat-fixture"], unread: true, hasAttachments: true, from: "CLIENT" };
    expect(listMessages(fixture.db, filter).messages.map((entry: any) => entry.id).sort()).toEqual([mail.id, chat.id].sort());
    const saved = saveView(fixture.db, fixture.node, { name: "Clients", icon: "Users", filter, order: 100 }).view;
    expect(counts(fixture.db).counts[saved.id]).toBe(2);
    expect(counts(fixture.db).counts.mail).toBe(3);
    expect(counts(fixture.db).counts.chat).toBe(1);
  });
  it("persists names, icons, filters, ordering and deletion while keeping built-ins locked", () => {
    const first = saveView(fixture.db, fixture.node, { name: "First", icon: "Mail", filter: { unread: true }, order: 100 }).view;
    const second = saveView(fixture.db, fixture.node, { name: "Second", icon: "Star", filter: { starred: true }, order: 101 }).view;
    saveView(fixture.db, fixture.node, { ...second, name: "Priority", order: 99 });
    const persisted = openDb(path.join(fixture.root, "state.db"));
    try { expect(listViews(persisted).find((view: any) => view.id === second.id)).toMatchObject({ name: "Priority", order: 99, filter: { starred: true } }); }
    finally { persisted.close(); }
    expect(listViews(fixture.db).filter((view: any) => !view.builtIn).map((view: any) => [view.id, view.name])).toEqual([[second.id, "Priority"], [first.id, "First"]]);
    expect(listViews(fixture.db).find((view: any) => view.id === second.id)).toMatchObject({ filter: { starred: true }, icon: "Star" });
    expect(() => saveView(fixture.db, fixture.node, { id: "all", name: "Changed", filter: {} })).toThrow("Built-in");
    expect(() => deleteView(fixture.db, fixture.node, "agents")).toThrow("Built-in");
    deleteView(fixture.db, fixture.node, first.id);
    expect(listViews(fixture.db).filter((view: any) => !view.builtIn)).toHaveLength(1);
  });
  it("includes ordinary system messages when explicitly filtering for non-actionable messages", () => {
    const chat = fixture.ingest("ordinary-chat", { provider: "chat-fixture" });
    const info = emitSystem(fixture.db, fixture.node, { category: "card.done", title: "Done", body: "Fixture completion" }).message;
    emitSystem(fixture.db, fixture.node, { category: "card.needs-input", title: "Choose", body: "Fixture question", action: { kind: "question", prompt: "Choose?", options: null, answeredAt: null, answer: null, revertUntil: null } });
    expect(listMessages(fixture.db, { actionable: false }).messages.map((message: any) => message.id).sort()).toEqual([chat.id, info.id].sort());
  });
});
