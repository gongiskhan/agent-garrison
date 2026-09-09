import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import { setupKanbanState } from "./kanban-state-env";
// @ts-ignore existing JavaScript boundary
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore existing JavaScript boundary
import { saveBoard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore existing JavaScript boundary
import { buildBoard } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore existing JavaScript boundary
import { openConversation } from "@garrison/claude-pty";
// @ts-ignore existing JavaScript boundary
import { ensureThread, getThread, renameThread } from "../packages/talk/src/threads.mjs";
// @ts-ignore existing JavaScript boundary
import { createSessionCard, endSessionCard, resumeSessionCard, syncSessionCardTitle, provisionalTitle } from "../packages/talk/src/conversation-cards.mjs";
// @ts-ignore existing JavaScript boundary
import { saveSidebar } from "../packages/talk/src/sidebar-state.mjs";
// @ts-ignore JavaScript lifecycle boundary
import { recordUserMessage } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

const home = mkdtempSync(join(tmpdir(), "conversation-cards-"));
const root = join(home, "board");
process.env.GARRISON_HOME = home;
process.env.GARRISON_KANBAN_DIR = root;
process.env.GARRISON_POLICY_PATH = join(home, "no-policy.json");
let state: Awaited<ReturnType<typeof setupKanbanState>>;
let server: http.Server;
let base: string;
beforeAll(async () => {
  state = await setupKanbanState();
  await saveBoard(buildBoard(), root);
  server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl: "", cap: 10 }, resolve("fittings/seed/kanban-loop/dist")));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  mkdirSync(join(home, "ui-fittings"), { recursive: true });
  writeFileSync(join(home, "ui-fittings/kanban-loop.json"), JSON.stringify({ url: base }));
}, 30_000);
afterAll(async () => { await new Promise<void>((done) => server.close(() => done())); await state.stop(); });

async function work(id: string, message?: string, source = "chat") {
  await ensureThread({ id, source });
  const store = openConversation(id, { role: "test" });
  store.init({});
  if (message) store.append({ kind: "user-message", payload: { text: message, routing: { model: "chosen-model", account: "chosen-account" } } });
  return store;
}
describe("work conversation cards", () => {
  it("ignores empty, Zeca, and shell conversations", async () => {
    await work("empty-work");
    await work("zeca-work", "A message", "zeca");
    await work("shell-work", "A message", "shell");
    for (const id of ["empty-work", "zeca-work", "shell-work"]) expect(await createSessionCard(id)).toBeNull();
  });
  it("creates once on the first message, preserving markdown and route without project inference", async () => {
    const message = "Please **fix** the bug\n\n- Keep this markdown";
    const store = await work("first-work", message);
    expect(await Promise.all([createSessionCard("first-work"), createSessionCard("first-work")])).toEqual(["first-work", "first-work"]);
    const card = await loadCard(root, "first-work");
    expect(card).toMatchObject({ list: "running", project: null, machineId: "test-node", titleLocked: false, conversationId: "first-work", routing: { model: "chosen-model", account: "chosen-account" }, origin: { type: "workSession" } });
    expect(card.description).toMatch(/^Work session started .*\+00:00 on test-node\n\n/);
    expect(card.description.split("on test-node\n\n")[1]).toBe(message);
    expect(await getThread("first-work")).toMatchObject({ boardCardId: "first-work" });
    expect(store.tail(20, { kinds: ["card.created_for_session"] }).map((e: any) => e.payload)).toEqual([{ cardId: "first-work", conversationId: "first-work", machineId: "test-node", titleProvisional: true }]);
    expect(card.inferState).not.toBe("running");
  });
  it("syncs titles until a manual rename locks the card", async () => {
    await work("title-work", "A word ".repeat(20));
    await createSessionCard("title-work");
    expect((await loadCard(root, "title-work")).title).toBe(provisionalTitle("A word ".repeat(20)));
    await syncSessionCardTitle("title-work", "Inferred title");
    expect((await loadCard(root, "title-work")).title).toBe("Inferred title");
    const card = await loadCard(root, "title-work");
    const response = await fetch(`${base}/cards/title-work`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ rev: card.rev, title: "My name" }) });
    expect(response.status).toBe(200);
    await syncSessionCardTitle("title-work", "Later title");
    await renameThread("title-work", "Manual conversation name");
    expect(await loadCard(root, "title-work")).toMatchObject({ title: "My name", titleLocked: true });
  });
  it("keeps a long first message verbatim and refuses a changed retry", async () => {
    const store = await work("long-first-work");
    const text = "Keep this markdown.\n\n".repeat(2000) + "The final line.";
    expect(recordUserMessage(store, { text, clientRequestId: "long-first" }).ok).toBe(true);
    expect(recordUserMessage(store, { text, clientRequestId: "long-first" }).duplicate).toBe(true);
    expect(recordUserMessage(store, { text: text + "changed", clientRequestId: "long-first" }).conflict).toBe(true);
    await createSessionCard("long-first-work");
    expect((await loadCard(root, "long-first-work")).description.split("on test-node\n\n")[1]).toBe(text);
  });
  it("ends on runtime exit and archive, resumes, and emits existing state events", async () => {
    const store = await work("state-work", "Work here");
    await createSessionCard("state-work");
    await endSessionCard("state-work");
    expect((await loadCard(root, "state-work")).list).toBe("done");
    await resumeSessionCard("state-work");
    expect((await loadCard(root, "state-work")).list).toBe("running");
    await saveSidebar({ archived: ["local:state-work"] });
    expect((await loadCard(root, "state-work")).list).toBe("done");
    expect(store.tail(20, { kinds: ["card-state-changed"] })).toHaveLength(3);
  });
});
