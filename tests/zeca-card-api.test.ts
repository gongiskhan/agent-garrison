import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore JavaScript service boundary
import { createTalkRouter } from "../packages/talk/src/router.mjs";
// @ts-ignore JavaScript service boundary
import { ensureThread } from "../packages/talk/src/threads.mjs";
// @ts-ignore JavaScript service boundary
import { openConversation, ledgerToSessionEvents } from "@garrison/claude-pty";
// @ts-ignore JavaScript service boundary
import { cheapestAnthropicTarget, callCardInference } from "../fittings/seed/http-gateway/scripts/lib/card-inference.mjs";

const home = mkdtempSync(join(tmpdir(), "zeca-card-api-"));
const requests: Array<{ method: string; path: string; body: any }> = [];
const servers: http.Server[] = [];
let base: string, failure: string | null = null;
process.env.GARRISON_HOME = home;
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
async function requestBody(req: http.IncomingMessage) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
beforeAll(async () => {
  const board = await listen(async (req, res) => {
    const body = await requestBody(req); requests.push({ method: req.method!, path: req.url!, body });
    res.setHeader("content-type", "application/json");
    if (failure && req.url !== "/cards") { res.statusCode = 503; res.end(JSON.stringify({ error: failure })); return; }
    const card = { id: `created-card-${requests.length}`, rev: 1, title: body.title, ...body };
    res.end(JSON.stringify({ card, ok: true }));
  });
  mkdirSync(join(home, "ui-fittings"), { recursive: true });
  writeFileSync(join(home, "ui-fittings/kanban-loop.json"), JSON.stringify({ url: board }));
  const gateway = await listen(async (req, res) => {
    const body = await requestBody(req);
    expect(req.url).toBe("/conversation/card-inference");
    expect(body.maxTokens).toBe(800); expect(body.effort).toBe("low");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: JSON.stringify({ title: "Repair the calendar", description: "## Task\nFix dates\n## Decisions already made\nNone\n## Open questions\nNone\n## Context\nCalendar times are wrong", messageIds: ["1", "2"], confidence: 0.8 }) }));
  });
  const talk = createTalkRouter({ gatewayUrl: gateway });
  base = await listen((req, res) => { void talk(req, res); });
  for (const [id, source] of [["zeca-api-test", "zeca"], ["zeca-empty-api", "zeca"], ["ordinary-api", "chat"]]) await ensureThread({ id, source });
  const store = openConversation("zeca-api-test", { role: "test" }); store.init({});
  store.append({ kind: "user-message", payload: { text: "Fix dates" } });
  store.append({ kind: "session-event", payload: { id: "answer", role: "assistant", blocks: [{ type: "text", text: "Keep local times" }] } });
});
afterAll(async () => { for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } });
const body = { conversationId: "zeca-api-test", title: "Repair dates", description: "## Task\nFix dates", projectId: "garrison", messageIds: ["1", "2"], windowSize: 10, confidence: 0.8, fallbackUsed: false, titleEdited: true, descriptionEdited: false, action: "todo" };
async function post(path: string, value: any) {
  const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  return { status: response.status, data: await response.json() };
}
describe("Zeca card endpoints", () => {
  it("infers a validated task through the bounded gateway call", async () => {
    const result = await post("/api/cards/from-zeca/infer", { conversationId: body.conversationId, windowSize: 10 });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ title: "Repair the calendar", fallbackUsed: false, windowStartId: "1", windowEndId: "2" });
  });
  it.each(["todo", "start", "schedule"])("creates using the existing %s board path and records origin, timeline and learning metadata", async (action) => {
    const start = requests.length, scheduledAt = "2026-09-10T13:00:00+01:00";
    const result = await post("/api/cards/from-zeca", { ...body, action, ...(action === "schedule" ? { scheduledAt } : {}) });
    expect(result.status).toBe(201);
    expect(result.data.state).toBe(action === "start" ? "running" : action === "schedule" ? "scheduled" : "todo");
    const calls = requests.slice(start);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/cards", body: { project: "garrison", targetList: "todo", origin: { type: "zeca", conversationId: body.conversationId, messageIds: ["1", "2"] } } });
    expect(calls[0].body).not.toHaveProperty("routing");
    if (action === "start") expect(calls[1]).toMatchObject({ method: "POST", path: `/cards/${result.data.cardId}/start` });
    if (action === "schedule") expect(calls[1]).toMatchObject({ method: "PATCH", body: { rev: 1, schedule: { kind: "once", action: "run", at: scheduledAt } } });
    const store = openConversation(body.conversationId, { role: "test" });
    const event = store.tail(1, { kinds: ["card.created_from_zeca"] })[0];
    expect(event.payload).toMatchObject({ cardId: result.data.cardId, conversationId: body.conversationId, action, windowSize: 10, messageIds: ["1", "2"], confidence: 0.8, titleEdited: true, descriptionEdited: false, fallbackUsed: false });
    const rendered = ledgerToSessionEvents(store.tail(20), { conversationId: body.conversationId });
    expect(JSON.stringify(rendered)).toContain("Card created from this conversation: Repair dates");
    expect(JSON.stringify(rendered)).toContain("Open card");
  });
  it.each(["start", "schedule"])("returns a created To do card and warning when %s fails", async (action) => {
    failure = "The gateway is unavailable";
    try {
      const result = await post("/api/cards/from-zeca", { ...body, action, scheduledAt: "2026-09-10T13:00:00Z", fallbackUsed: true });
      expect(result.status).toBe(201);
      expect(result.data).toMatchObject({ state: "todo", warning: failure });
    } finally { failure = null; }
  });
  it("validates creation fields and conversation type without creating a card", async () => {
    const count = requests.length;
    for (const change of [{ title: " " }, { description: "" }, { projectId: "" }, { action: "schedule" }, { messageIds: ["foreign"] }]) expect((await post("/api/cards/from-zeca", { ...body, ...change })).status).toBe(400);
    expect((await post("/api/cards/from-zeca", { ...body, conversationId: "unknown-conversation" })).status).toBe(404);
    expect((await post("/api/cards/from-zeca", { ...body, conversationId: "ordinary-api" })).status).toBe(409);
    expect(requests).toHaveLength(count);
  });
  it("returns all specified inference errors", async () => {
    for (const [conversationId, windowSize, status] of [["zeca-empty-api", 10, 400], ["zeca-api-test", 15, 400], ["unknown-conversation", 10, 404], ["ordinary-api", 10, 409]]) expect((await post("/api/cards/from-zeca/infer", { conversationId, windowSize })).status).toBe(status);
  });
});

it("selects the cheapest configured Anthropic ladder model and performs exactly one logged proxy request", async () => {
  const model = { dutyLadder: { implement: { rungs: [{ provider: "anthropic", model: "claude-opus-5" }, { provider: "openai", model: "cheapest" }, { provider: "anthropic", model: "claude-haiku-4-5" }] } } };
  expect(cheapestAnthropicTarget(model).model).toBe("claude-haiku-4-5");
  const calls: any[] = [];
  const text = await callCardInference({ executionModel: async () => model, resolveSecrets: () => ({ ANTHROPIC_API_KEY: "test-only" }) }, { system: "system", prompt: "prompt", signal: AbortSignal.timeout(1000) }, { proxyUrl: "http://proxy.test", fetchImpl: async (url: URL, options: any) => { calls.push({ url: url.href, options }); return { ok: true, json: async () => ({ content: [{ type: "text", text: "{}" }] }) }; } });
  expect(text).toBe("{}"); expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("http://proxy.test/v1/messages");
  expect(JSON.parse(calls[0].options.body)).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 800, thinking: { type: "disabled" }, messages: [{ role: "user", content: "prompt" }] });
});
