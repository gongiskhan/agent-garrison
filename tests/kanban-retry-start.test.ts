// POST /cards/:id/start — the Start button, after the Conversations cut.
//
// Start used to be "Advance": it moved a parked card back onto the phase list
// recorded in card.parkedFrom and dispatched that phase through the engine.
// There are no phase lists left. Start now KICKS A CONVERSATION through the
// gateway launcher — a fresh card gets /conversation/kick carrying its title +
// description as the opening task, a card that already has one gets a resume
// user message on /conversation/message — and the board never runs a model turn
// itself. These pin that seam plus its refusals (already running, a scheduled
// template, no gateway, a gateway that says no).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
const RUNS_DIR = mkdtempSync(path.join(tmpdir(), "kanban-retry-runs-"));
process.env.GARRISON_RUNS_DIR = RUNS_DIR;

// @ts-expect-error — plain ESM .mjs sibling, no .d.ts
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-expect-error — plain ESM .mjs sibling, no .d.ts
import { createCard, loadCard, saveBoard, saveCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-expect-error — plain ESM .mjs sibling, no .d.ts
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});


type LauncherCall = { path: string; body: any };

let gateway: http.Server;
let launcherCalls: LauncherCall[] = [];
// Per-path status the stub gateway answers the launcher with. 202 is the
// launcher's real "accepted, the conversation is running" answer.
let launcherStatus: Record<string, number> = {};
let server: http.Server;
let base = "";
let root = "";

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return (s.address() as { port: number }).port;
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "kanban-retry-root-"));
  await saveBoard({ ...seedBoard(), projects: { demo: { path: root } } }, root);

  // Stand in for the gateway's stretch launcher. A bare GET answers
  // gatewayReachable(); the two conversation routes record what Start sent.
  gateway = http.createServer((req, res) => {
    if (req.method === "POST" && typeof req.url === "string" && req.url.startsWith("/conversation/")) {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        launcherCalls.push({ path: req.url as string, body: raw ? JSON.parse(raw) : null });
        res.writeHead(launcherStatus[req.url as string] ?? 202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  const gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;
  server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl, cap: 10 }, root));
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterEach(() => {
  launcherCalls = [];
  launcherStatus = {};
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  rmSync(RUNS_DIR, { recursive: true, force: true });
});

describe("POST /cards/:id/start — the conversation kick", () => {
  it("kicks a fresh conversation carrying the card's title and description as the task", async () => {
    const card = await createCard(root, {
      title: "retry the same planning work",
      description: "the turn cap hit last time",
      project: "demo",
      list: "todo"
    });

    const response = await fetch(`${base}/cards/${card.id}/start`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ started: true, card: { id: card.id, status: "running" } });

    expect(launcherCalls).toHaveLength(1);
    expect(launcherCalls[0].path).toBe("/conversation/kick");
    // The conversation is keyed on the card id, and the opening task is the card
    // itself — the board hands over the work, not a phase instruction.
    expect(launcherCalls[0].body).toMatchObject({
      conversationId: card.id,
      cardId: card.id,
      title: "retry the same planning work"
    });
    expect(launcherCalls[0].body.task).toContain("retry the same planning work");
    expect(launcherCalls[0].body.task).toContain("the turn cap hit last time");
  });

  it("resumes an existing conversation with a user message instead of a second kick", async () => {
    const created = await createCard(root, { title: "already talking", project: "demo", list: "needs-attention" });
    const card = await saveCard(root, { ...created, conversationId: "01CONVERSATION000000000000" });
    expect(card.conversationId).toBe("01CONVERSATION000000000000");

    const response = await fetch(`${base}/cards/${card.id}/start`, { method: "POST" });
    expect(response.status).toBe(200);

    expect(launcherCalls).toHaveLength(1);
    expect(launcherCalls[0].path).toBe("/conversation/message");
    expect(launcherCalls[0].body).toMatchObject({
      conversationId: "01CONVERSATION000000000000",
      origin: "board"
    });
    expect(String(launcherCalls[0].body.message)).toMatch(/resume/i);
  });

  it("refuses a card that is already running, and never double-kicks it", async () => {
    const created = await createCard(root, { title: "in flight", project: "demo", list: "todo" });
    const running = await saveCard(root, { ...created, list: "running", status: "running" });
    expect(running.status).toBe("running");

    const response = await fetch(`${base}/cards/${running.id}/start`, { method: "POST" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already running/i);
    expect(launcherCalls).toHaveLength(0);
  });

  it("refuses a scheduled template — Run now owns that verb", async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const card = await createCard(root, {
      title: "weekday review",
      project: "demo",
      // The POST /cards route parks a scheduled card in `scheduled`; createCard
      // takes the list it is given, so name it directly here.
      list: "scheduled",
      schedule: { kind: "once", action: "notify", at, timezone: "UTC", enabled: true, targetList: "todo" }
    });
    expect(card.list).toBe("scheduled");

    const response = await fetch(`${base}/cards/${card.id}/start`, { method: "POST" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Run now/i);
    expect(launcherCalls).toHaveLength(0);
  });

  it("reports 502 when the launcher refuses the kick, and leaves the card alone", async () => {
    launcherStatus["/conversation/kick"] = 500;
    const card = await createCard(root, { title: "launcher says no", project: "demo", list: "todo" });

    const response = await fetch(`${base}/cards/${card.id}/start`, { method: "POST" });
    expect(response.status).toBe(502);
    expect(String((await response.json()).error)).toMatch(/refused the kick/i);
    // Start is a signal, not a write: the board never marks the card running on
    // its own — the launcher does that when the conversation actually opens.
    expect(await loadCard(root, card.id)).toMatchObject({ list: "todo", status: "ok" });
  });
});

describe("POST /cards/:id/start — with no gateway", () => {
  let soloServer: http.Server;
  let soloBase = "";

  beforeAll(async () => {
    soloServer = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl: null, cap: 10 }, root));
    soloBase = `http://127.0.0.1:${await listen(soloServer)}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => soloServer.close(() => resolve()));
  });

  it("503s instead of pretending work started", async () => {
    const card = await createCard(root, { title: "no operative", project: "demo", list: "todo" });
    const response = await fetch(`${soloBase}/cards/${card.id}/start`, { method: "POST" });
    expect(response.status).toBe(503);
    expect(String((await response.json()).error)).toMatch(/gateway not reachable/i);
  });
});
