import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../services/state/src/db.mjs";
import { acquireIngestLease, ingestBatch, registerProvider } from "../services/state/src/messages/store.mjs";
import { baseConversation, baseMessage } from "../packages/messages/providers/shared";
import { googleDescriptor } from "../packages/messages/providers/google-common";
import { slackDescriptor } from "../packages/messages/providers/slack-common";

export function messagesDbFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "messages-functional-"));
  const db = openDb(path.join(root, "state.db"));
  const node = "ingest-owner", account = "fixture-account", ts = "2026-09-13T12:00:00.000Z";
  const accounts = [{ id: account, label: "Fixture account" }];
  registerProvider(db, "provider-owner", { descriptor: { ...googleDescriptor(accounts), id: "mail-fixture" } });
  registerProvider(db, "provider-owner", { descriptor: { ...slackDescriptor(accounts), id: "chat-fixture" } });
  const lease = acquireIngestLease(db, node);
  function ingest(id: string, overrides: Record<string, any> = {}) {
    const provider = overrides.provider ?? "mail-fixture";
    const selectedAccount = overrides.account ?? account;
    const conversation = { ...baseConversation(provider, selectedAccount, `conversation-${id}`, provider === "mail-fixture" ? "mail-thread" : "dm", "Fixture conversation", overrides.ts ?? ts), ...overrides.conversation };
    const { conversation: _conversation, ...patch } = overrides;
    const message = { ...baseMessage(provider, selectedAccount, id, conversation.id, ts, ts),
      sender: { id: "fixture-sender", name: "Example Client", address: "client@example.invalid", isMe: false },
      bodyText: "Fixture body", subject: "Fixture subject", ...patch };
    ingestBatch(db, { name: node }, { provider, account: selectedAccount, fence: lease.fence, messages: [message], conversations: [conversation], cursor: { last: id } });
    return message;
  }
  return { root, db, node, account, ts, ingest, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
