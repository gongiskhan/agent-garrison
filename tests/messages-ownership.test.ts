import { afterAll, beforeAll, expect, it } from "vitest";
import { StateClient } from "@garrison/state-client";
import { startStateService, type StateHarness } from "./state-service-harness";
import { openDb } from "../services/state/src/db.mjs";
import { baseAttachment, baseMessage, baseConversation } from "../packages/messages/providers/shared";
import { googleDescriptor } from "../packages/messages/providers/google-common";

let h: StateHarness & { tokens: Record<string, string> };
const timestamp = "2026-09-13T12:00:00.000Z", account = { id: "owner@example.test", label: "Fixture account" };
const descriptor = { ...googleDescriptor([account]), id: "ownership" };
const conversation = baseConversation("ownership", account.id, "thread-one", "mail-thread", "Ownership fixture", timestamp);
const attachment = { ...baseAttachment("audio-one", "voice.ogg", "audio/ogg", 100), path: "attachments/ownership/owner%40example%2Etest/2026-09/audio-one.ogg" };
const message = { ...baseMessage("ownership", account.id, "mail-one", conversation.id, timestamp, timestamp), bodyText: "Fixture original", attachments: [attachment] };
const request = (method: string, route: string, body?: unknown) => h.client.request(method, `/v1/messages/${route}`, { body });
beforeAll(async () => { h = await startStateService({ nodes: ["file-owner", "new-ingest"] }); await request("POST", "providers/register", { descriptor }); });
afterAll(async () => { await h?.stop(); });

it("preserves generated audio and its owner across changed provider resync on a new lease node", async () => {
  const lease: any = await request("POST", "lease/acquire", {});
  const first = new StateClient({ url: h.url, token: lease.token, node: "file-owner" });
  await first.request("POST", "/v1/messages/ingest", { body: { provider: descriptor.id, account: account.id, fence: lease.fence, messages: [message], conversations: [conversation], cursor: { page: 1 } } });
  const processed = { ...attachment, playbackPath: attachment.path.replace(".ogg", ".m4a"), durationMs: 12000, transcript: "clementine ownership fixture", transcriptStatus: "done", ownerNode: "file-owner" };
  await request("POST", `${message.id}/media`, { attachment: processed });
  const second = new StateClient({ url: h.url, token: h.tokens["new-ingest"], node: "new-ingest" });
  expect(await second.request("POST", "/v1/messages/work/effects/claim", { body: {} })).toMatchObject({ item: null });
  // This disposable state database belongs only to this test.
  const db = openDb(h.dbPath); db.prepare("UPDATE messages_ingest_lease SET expiresAt=?").run("2000-01-01T00:00:00.000Z"); db.close();
  const next: any = await second.request("POST", "/v1/messages/lease/acquire", { body: {} });
  const ingest = new StateClient({ url: h.url, token: next.token, node: "new-ingest" });
  await ingest.request("POST", "/v1/messages/ingest", { body: { provider: descriptor.id, account: account.id, fence: next.fence,
    messages: [{ ...message, bodyText: "Fixture changed body", read: true, attachments: [{ ...attachment, path: null }] }], conversations: [conversation], cursor: { page: 2 } } });
  const stored: any = await request("GET", message.id);
  expect(stored.message).toMatchObject({ bodyText: "Fixture changed body", read: true, attachments: [processed] });
  const found: any = await request("GET", `?filter=${encodeURIComponent(JSON.stringify({ text: "clemen" }))}`);
  expect(found.messages.map((row: any) => row.id)).toEqual([message.id]);
  await expect(second.request("POST", `/v1/messages/${message.id}/media`, { body: { attachment: processed } })).rejects.toMatchObject({ status: 403 });
  const owned: any = await request("POST", "work/effects/claim", {});
  expect(owned.item).toMatchObject({ kind: "processMedia", payload: { ownerNode: "file-owner", attachmentIds: ["audio-one"] } });
});
