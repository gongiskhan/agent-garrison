import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StateClient } from "@garrison/state-client";
import { startStateService, type StateHarness } from "./state-service-harness";
import { openDb } from "../services/state/src/db.mjs";
import { MessagesIngestWorker } from "../packages/messages/worker";
import { MessagesRuntime } from "../src/lib/messages-runtime";
import { slackDescriptor } from "../packages/messages/providers/slack-common";
import { baseMessage, baseConversation } from "../packages/messages/providers/shared";
import type { ProviderDescriptor } from "../packages/messages/types";

let state: StateHarness & { tokens: Record<string, string> }, fitting: http.Server, callback: string, home: string;
let fetches = 0, includeSecond = false;
const account = { id: "fixture", label: "Demo account" }, timestamp = "2026-09-13T12:00:00.000Z";
const conversation = baseConversation("demo", "fixture", "chat-demo", "dm", "Fixture conversation", timestamp);
const one = { ...baseMessage("demo", "fixture", "message-demo-one", conversation.id, timestamp, timestamp), bodyText: "First callback fixture" };
const two = { ...baseMessage("demo", "fixture", "message-demo-two", conversation.id, timestamp, timestamp), bodyText: "Second callback fixture" };
let descriptor: ProviderDescriptor;
const request = (method: string, suffix: string, body?: unknown) => state.client.request(method, `/v1/messages/${suffix}`, { body });
beforeAll(async () => {
  vi.stubEnv("GARRISON_MESSAGES_FIXTURES", "1");
  home = await fs.mkdtemp(path.join(os.tmpdir(), "messages-callback-"));
  state = await startStateService({ nodes: ["first-node", "second-node"] });
  fitting = http.createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    if (req.method !== "POST" || req.url !== "/messages-adapter/fetchMessages" || body.account !== "fixture") { res.writeHead(404); res.end(); return; }
    fetches++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: includeSecond ? [one, two] : [one], conversations: [conversation], cursor: { sequence: includeSecond ? 2 : 1 } }));
  });
  await new Promise<void>((resolve, reject) => { fitting.once("error", reject); fitting.listen(0, "127.0.0.1", resolve); });
  callback = `http://127.0.0.1:${(fitting.address() as { port: number }).port}/messages-adapter`;
  descriptor = { ...slackDescriptor([account]), id: "demo", label: "Demo", callbackBaseUrl: callback };
  await request("POST", "providers/register", { descriptor, callbackBaseUrl: callback });
});
afterAll(async () => {
  if (fitting) await new Promise<void>(resolve => fitting.close(() => resolve()));
  await state?.stop(); await fs.rm(home, { recursive: true, force: true }); vi.unstubAllEnvs();
});

describe("Messages callback discovery and lease handover", () => {
  it("discovers the fixtures-only demo through the same fitting registry path", async () => {
    const { providers }: any = await request("GET", "providers");
    const registered = providers.find((provider: ProviderDescriptor) => provider.id === "demo");
    expect(registered).toMatchObject({ callbackBaseUrl: callback, ownerNode: "first-node", accounts: [account] });
    const client = { node: "first-node", getNode: async () => ({ name: "first-node" }) };
    await fs.mkdir(path.join(home, "ui-fittings"));
    await fs.writeFile(path.join(home, "ui-fittings/demo.json"), JSON.stringify({ url: callback.replace("/messages-adapter", "") }));
    const enabled: any = new MessagesRuntime({ client: client as any, env: { NODE_ENV: "test", GARRISON_HOME: home, GARRISON_MESSAGES_FIXTURES: "1" } });
    enabled.providers = [registered];
    expect(await enabled.ingestAccounts()).toMatchObject([{ account, callbackBaseUrl: callback }]);
    const disabled: any = new MessagesRuntime({ client: client as any, env: { NODE_ENV: "test", GARRISON_HOME: home } });
    disabled.providers = [registered]; expect(await disabled.ingestAccounts()).toEqual([]);
  });
  it("ingests over real HTTP, rejects the stale node and replays without a lost or duplicate message", async () => {
    const lease: any = await request("POST", "lease/acquire", {});
    const first = new MessagesIngestWorker({ stateUrl: state.url, token: lease.token, fence: lease.fence, diskRoot: path.join(home, "first"),
      accounts: [{ provider: descriptor, account, callbackBaseUrl: callback }] });
    await first.tick();
    expect(fetches).toBe(1);
    expect((await request("GET", "") as any).messages.map((message: any) => message.externalId)).toEqual([one.externalId]);
    const secondClient = new StateClient({ url: state.url, node: "second-node", token: state.tokens["second-node"] });
    expect(await secondClient.request("POST", "/v1/messages/lease/acquire", { body: {} })).toMatchObject({ granted: false });
    // Only the disposable fixture database is opened to advance its lease clock.
    const db = openDb(state.dbPath);
    db.prepare("UPDATE messages_ingest_lease SET expiresAt=?").run("2000-01-01T00:00:00.000Z"); db.close();
    const next: any = await secondClient.request("POST", "/v1/messages/lease/acquire", { body: {} });
    expect(next.fence).toBe(lease.fence + 1);
    await expect(first.renew()).rejects.toThrow();
    await first.tick(); expect(fetches).toBe(1);
    includeSecond = true;
    const second = new MessagesIngestWorker({ stateUrl: state.url, token: next.token, fence: next.fence, diskRoot: path.join(home, "second"),
      accounts: [{ provider: descriptor, account, callbackBaseUrl: callback }] });
    await second.tick();
    const result: any = await request("GET", "");
    expect(result.messages.map((message: any) => message.externalId).sort()).toEqual([one.externalId, two.externalId].sort());
    expect((await request("GET", "sync") as any).sync.find((row: any) => row.provider === "demo").cursor).toEqual({ sequence: 2 });
    await request("POST", "sync", { providers: ["demo"] }); await second.tick();
    expect((await request("GET", "") as any).messages).toHaveLength(2);
    const firstMirror: any = await request("POST", "work/mirrors/claim", {});
    const secondMirror: any = await secondClient.request("POST", "/v1/messages/work/mirrors/claim", { body: {} });
    expect(new Set([firstMirror.item.messageId, secondMirror.item.messageId]).size).toBe(2);
    expect(await request("POST", "work/mirrors/claim", {})).toMatchObject({ item: null });
    first.stop(); second.stop();
  });
});
