// The materialization door (Conversations B3): POST /cards accepts a
// conversation identity; the card TAKES the conversation's id; Running is
// launcher-only; card-materialized + card-state-changed land in the ledger
// with door-attributed actors.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

const KANBAN_DIR = mkdtempSync(join(tmpdir(), "mat-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "mat-home-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore — pure .mjs
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import { saveBoard, loadCard, saveCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { buildBoard } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore — pure .mjs
import { openConversation, newConversationId } from "../packages/claude-pty/src/conversation-store.mjs";

import { setupKanbanState } from "./kanban-state-env";
let state: Awaited<ReturnType<typeof setupKanbanState>>;

let server: http.Server;
let base = "";
beforeAll(async () => {
  state = await setupKanbanState();
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(buildBoard(), KANBAN_DIR);
  server = http.createServer(makeRequestHandler({ root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 }, join(FITTING, "dist")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
}, 30_000);
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await state?.stop();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

describe("materialization door", () => {
  it("default create lands on To do (backlog is gone)", async () => {
    const res = await post("/cards", { title: "plain card" });
    expect(res.status).toBe(201);
    expect(res.body.card.list).toBe("todo");
    // a plain card creates NO conversation store dir
    expect(res.body.card.conversationId ?? null).toBeNull();
  });

  it("a human cannot create a card directly in Running", async () => {
    const res = await post("/cards", { title: "sneaky", targetList: "running" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/launcher/);
  });

  it("the launcher creates a Running card that TAKES its conversation id, and materialization lands in the ledger", async () => {
    const conversationId = newConversationId();
    const store = openConversation(conversationId, { role: "gateway" });
    store.init({ title: "born from chat" });
    const res = await post(
      "/cards",
      {
        title: "born from chat",
        conversationId,
        targetList: "running",
        materialization: { decidedBy: "triage", reason: "user said implement it" },
      },
      { "x-garrison-engine": "gateway" }
    );
    expect(res.status).toBe(201);
    expect(res.body.card.id).toBe(conversationId); // one identity
    expect(res.body.card.conversationId).toBe(conversationId);
    expect(res.body.card.list).toBe("running");
    expect(res.body.card.status).toBe("running"); // coherentCardState mirrors the list
    const evts = store.tail(20, { kinds: ["card-materialized"] });
    expect(evts).toHaveLength(1);
    expect(evts[0].payload).toMatchObject({ cardId: conversationId, list: "running", decidedBy: "triage", reason: "user said implement it" });
  });

  it("an engine Running create REQUIRES a conversation id", async () => {
    const res = await post("/cards", { title: "no conv", targetList: "running" }, { "x-garrison-engine": "gateway" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/conversation/);
  });

  it("card-state-changed is written at the choke point with door-attributed actor", async () => {
    const conversationId = newConversationId();
    openConversation(conversationId, { role: "gateway" }).init({});
    const created = await post(
      "/cards",
      { title: "walks states", conversationId, targetList: "todo" },
      { "x-garrison-engine": "gateway" }
    );
    expect(created.status).toBe(201);
    const id = created.body.card.id;
    // Creation side-effects (project inference, provisional coordination) bump
    // rev asynchronously — retry the human PATCH with a fresh rev like a real
    // client would.
    let patched: Response | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const fresh = await loadCard(KANBAN_DIR, id);
      patched = await fetch(base + `/cards/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ list: "needs-attention", rev: fresh.rev }),
      });
      if (patched.status === 200) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(patched!.status).toBe(200);
    const store = openConversation(conversationId, { role: "test" });
    const changes = store.tail(20, { kinds: ["card-state-changed"] });
    expect(changes.length).toBeGreaterThanOrEqual(1);
    const last = changes[changes.length - 1];
    expect(last.payload).toMatchObject({
      from: { list: "todo" },
      to: { list: "needs-attention", status: "needs-attention" },
      by: "human",
    });
  });
});
