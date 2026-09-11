import { afterAll, beforeAll, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
const fittingRequire = createRequire(path.resolve("fittings/seed/mcp-gateway/package.json"));
const { Client } = fittingRequire("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = fittingRequire("@modelcontextprotocol/sdk/client/stdio.js");
// @ts-ignore — fitting's public ESM helper
import { callListCards, callGetCard, callListConnectors, callConnectorRead } from "../fittings/seed/mcp-gateway/scripts/lib/assistant-tools.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-tools-"));
const before = { ...process.env };
let server: http.Server;
let base: string;
let authRequests = 0;
const cards = [
  { id: "CARD-A", title: "Prepare report", list: "todo", project: "garrison", scheduledFor: "2026-09-11T15:00:00Z", description: "Use the real board", checklist: [{ text: "check sources", done: false }] },
  { id: "CARD-B", title: "Review report", list: "running", project: "garrison" },
  { id: "CARD-C", title: "Old report", list: "done", project: "garrison" },
];
const actions = [
  { name: "calendar.list_events", args: ["time_min", "time_max"], mutates: false },
  { name: "gmail.send", mutates: true },
  { name: "unknown-safety" },
];

beforeAll(async () => {
  fs.mkdirSync(path.join(root, "ui-fittings"), { recursive: true });
  fs.writeFileSync(path.join(root, "internal-token"), "internal-fixture");
  const scripts = path.join(root, "apm_modules/_local/google/scripts");
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "connector.mjs"), `process.stdout.write(JSON.stringify({ok:true,result:{action:process.argv[3],args:JSON.parse(process.argv[4]),credential:process.env.GOOGLE_ACCESS_TOKEN}}));`);
  server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname === "/cards") return res.end(JSON.stringify({ cards }));
    if (url.pathname === "/cards/resolve") {
      if (url.searchParams.get("ref") === "report") { res.statusCode = 409; return res.end(JSON.stringify({ candidates: cards.slice(0, 2) })); }
      return res.end(JSON.stringify({ card: cards[0] }));
    }
    if (url.pathname === "/cards/CARD-A") return res.end(JSON.stringify({ card: cards[0] }));
    if (url.pathname === "/api/connectors") return res.end(JSON.stringify({ connectors: [
      { id: "google", fittingId: "google", name: "Google", equipped: true, sealed: true, statusKnown: true },
      { id: "parked", fittingId: "parked", equipped: false },
    ] }));
    if (url.pathname === "/api/library") return res.end(JSON.stringify({ fittings: [
      { id: "google", metadata: { provides: [{ kind: "connector", name: "google" }], connector: { actions } } },
    ] }));
    if (url.pathname === "/api/connectors/google/auth-env" && req.method === "POST") {
      authRequests++;
      if (req.headers["x-garrison-internal"] !== "internal-fixture") { res.statusCode = 403; return res.end("{}"); }
      return res.end(JSON.stringify({ env: { GOOGLE_ACCESS_TOKEN: "fixture-private-token" } }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, { GARRISON_HOME: root, GARRISON_COMPOSITION_DIR: root, GARRISON_BASE_URL: base, GARRISON_APP_URL: base, GARRISON_INTERNAL_TOKEN_PATH: path.join(root, "internal-token") });
  fs.writeFileSync(path.join(root, "ui-fittings/kanban-loop.json"), JSON.stringify({ url: base }));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
  Object.assign(process.env, before);
  fs.rmSync(root, { recursive: true, force: true });
});

it("reads open cards with pagination and preserves schedules and relative links", async () => {
  const first = await callListCards({ limit: 1, query: "report" });
  expect(first).toMatchObject({ total: 2, next_offset: 1, cards: [{ id: "CARD-A", scheduledFor: cards[0].scheduledFor }] });
  expect(first.cards[0].url).toBe("/embed/kanban-loop?card=CARD-A");
  expect(await callListCards({ offset: first.next_offset })).toMatchObject({ cards: [{ id: "CARD-B" }], next_offset: null });
  expect(await callListCards({ list: "done" })).toMatchObject({ cards: [{ id: "CARD-C" }] });
});

it("fetches card details and relays ambiguity without choosing a candidate", async () => {
  expect(await callGetCard({ card: "CARD-A" })).toMatchObject({ card: { description: "Use the real board", checklist: cards[0].checklist } });
  expect(await callGetCard({ card: "report" })).toMatchObject({ ambiguous: true, candidates: cards.slice(0, 2) });
});

it("discovers equipped connectors and uses the real scoped-auth and CLI call path", async () => {
  expect(await callListConnectors()).toMatchObject({ connectors: [{ id: "google", connected: true, callable: true, actions }] });
  const args = { time_min: "2026-09-10T23:00:00Z", time_max: "2026-09-11T23:00:00Z" };
  const result = await callConnectorRead({ connector: "google", action: "calendar.list_events", args });
  expect(authRequests).toBe(1);
  expect(result).toEqual({ ok: true, result: { action: "calendar.list_events", args, credential: "[REDACTED]" } });
});

it.each(["gmail.send", "unknown-safety", "invented"])("refuses unsafe or unknown action %s before requesting any credentials", async (action) => {
  const count = authRequests;
  await expect(callConnectorRead({ connector: "google", action })).rejects.toThrow(/read-only|Unknown action/);
  expect(authRequests).toBe(count);
});

it("reports a disconnected service without spawning a connector", async () => {
  const result = await callConnectorRead({ connector: "google", action: "calendar.list_events" }, {
    authEnv: async () => ({ __awaiting_connector: true }), runConnector: async () => { throw new Error("must not execute"); },
  });
  expect(result).toEqual({ ok: false, awaiting_connector: true, connector: "google", url: "/connectors" });
});

it("exposes reads through the real stdio MCP server and rejects tools omitted by the profile", async () => {
  const client = new Client({ name: "assistant-tool-test", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve("fittings/seed/mcp-gateway/scripts/gateway.mjs"), "stdio"],
    env: { ...process.env, GARRISON_MCP_TOOLS: "garrison_list_cards,garrison_get_card,garrison_list_connectors,garrison_connector_read" } as Record<string, string>,
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((t: { name: string }) => t.name).sort()).toEqual(["garrison_connector_read", "garrison_get_card", "garrison_list_cards", "garrison_list_connectors"]);
    const read = await client.callTool({ name: "garrison_list_cards", arguments: {} });
    expect(JSON.parse((read.content as any)[0].text)).toMatchObject({ total: 2 });
    const denied = await client.callTool({ name: "garrison_create_card", arguments: { title: "must not create" } });
    expect(denied.isError).toBe(true);
    const write = await client.callTool({ name: "garrison_connector_read", arguments: { connector: "google", action: "gmail.send" } });
    expect(write.isError).toBe(true);
  } finally { await client.close(); }
}, 20_000);
