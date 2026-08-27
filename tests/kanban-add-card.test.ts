// S1a — the SERVER contract behind the Backlog / To Do inline quick-add UI. Boots the REAL
// own-port board server (makeRequestHandler over an ephemeral port) against a
// sandboxed, freshly-seeded board and exercises POST /cards exactly the way the
// board UI's ListAddCard does: { title, description?, project?, targetList? } → a card
// that lands directly in that manual list and shows up on GET /board without a
// create-then-move transition. Also pins
// the two contract edges the UI leans on: title inference from the description, and
// the empty-input rejection.
//
// Sandboxed like tests/coordination-server.test.ts: tmp GARRISON_KANBAN_DIR board,
// tmp GARRISON_HOME / GARRISON_RUNS_DIR, and a nonexistent GARRISON_POLICY_PATH so
// loadPolicy() is null (coordination + policy branches stay off — a hermetic create).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

// ── env sandbox (set BEFORE importing the server / board modules) ──
const KANBAN_DIR = mkdtempSync(join(tmpdir(), "addcard-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "addcard-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "addcard-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
// Policy-less: loadPolicy() → null, so the create path skips the coordination /
// flow branches and is a pure Backlog insert.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore — pure ESM .mjs, no .d.ts
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard, updateCardCAS, BOARD_VERSION } from "../fittings/seed/kanban-loop/lib/board.mjs";

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


let gateway: http.Server;
let gatewayUrl = "";
let server: http.Server;
let base = "";

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as any).port;
}

beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(seedBoard(), KANBAN_DIR);

  // A benign stub gateway so any fire-and-forget project inference (a no-project
  // card) resolves quietly. The UI-parity cases below all pass a project, so this
  // is only defence in depth.
  gateway = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/chat") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ reply: "inferred-repo" }));
    }
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "" })}\n\n`);
      return res.end();
    }
    res.writeHead(200); res.end("ok");
  });
  gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;

  const opts = { root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl, cap: 10 };
  server = http.createServer(makeRequestHandler(opts, join(FITTING, "dist")));
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => gateway.close(() => r()));
});

async function jget(path: string) {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json()) as any };
}
async function jsend(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, body: (await r.json()) as any };
}

async function waitForCard(id: string, predicate: (card: any) => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let detail: any = null;
  while (Date.now() < deadline) {
    detail = (await jget(`/cards/${id}`)).body;
    if (predicate(detail.card)) return detail;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`card ${id} did not reach the expected state: ${JSON.stringify(detail?.card)}`);
}

describe("POST /cards — the direct manual-list quick-add contract", () => {
  it("projects the fixed Scheduled system column first", async () => {
    const view = await jget("/board");
    expect(view.status).toBe(200);
    expect(view.body.version).toBe(BOARD_VERSION);
    expect(view.body.lists[0]).toMatchObject({ id: "scheduled", kind: "scheduled", system: true });
  });

  it("creates recurring templates in Scheduled and preserves their release target", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Weekday review",
      project: "garrison",
      schedule: {
        kind: "cron", action: "run", cron: "0 8 * * 1-5", timezone: "Europe/Lisbon",
        enabled: true, targetList: "todo"
      }
    });
    expect(create.status).toBe(201);
    expect(create.body.card).toMatchObject({
      list: "scheduled",
      schedule: {
        kind: "cron", action: "run", cron: "0 8 * * 1-5", timezone: "Europe/Lisbon",
        enabled: true, targetList: "todo"
      }
    });
    expect(Date.parse(create.body.card.schedule.nextAt)).toBeGreaterThan(Date.now());
    const view = await jget("/board");
    expect(view.body.lists[0].cards.map((card: any) => card.id)).toContain(create.body.card.id);
  });

  it("accepts legacy scheduledFor once, but stores the authoritative v5 shape", async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const create = await jsend("POST", "/cards", {
      title: "Legacy client", project: "garrison", targetList: "todo",
      scheduledFor: at, scheduleAction: "notify"
    });
    expect(create.status).toBe(201);
    expect(create.body.card).toMatchObject({
      list: "scheduled", scheduledFor: at,
      schedule: { kind: "once", action: "notify", at, targetList: "todo" }
    });
  });

  it("validates cron and timezone instead of storing a permanently broken template", async () => {
    const badCron = await jsend("POST", "/cards", {
      title: "Bad cron", project: "garrison",
      schedule: { kind: "cron", action: "run", cron: "tomorrow", timezone: "Europe/Lisbon", enabled: true, targetList: "backlog" }
    });
    expect(badCron.status).toBe(400);
    expect(String(badCron.body.error)).toMatch(/5 fields/);
    const badTimezone = await jsend("POST", "/cards", {
      title: "Bad timezone", project: "garrison",
      schedule: { kind: "cron", action: "run", cron: "0 8 * * *", timezone: "Moon/Base", enabled: true, targetList: "backlog" }
    });
    expect(badTimezone.status).toBe(400);
    expect(String(badTimezone.body.error)).toMatch(/IANA timezone/);
  });

  it("prevents raw moves into Scheduled and returns a cleared schedule to its target", async () => {
    const plain = await jsend("POST", "/cards", { title: "Not schedulable by move", project: "garrison" });
    const rawMove = await jsend("PATCH", `/cards/${plain.body.card.id}`, { list: "scheduled", rev: plain.body.card.rev });
    expect(rawMove.status).toBe(400);
    expect(String(rawMove.body.message ?? rawMove.body.error)).toMatch(/Schedule controls/i);

    const at = new Date(Date.now() + 86_400_000).toISOString();
    const held = await jsend("POST", "/cards", {
      title: "Clear me", project: "garrison",
      schedule: { kind: "once", action: "notify", at, timezone: "UTC", enabled: true, targetList: "todo" }
    });
    const cleared = await jsend("PATCH", `/cards/${held.body.card.id}`, { schedule: null, rev: held.body.card.rev });
    expect(cleared.status).toBe(200);
    expect(cleared.body.card).toMatchObject({ list: "todo", schedule: null, scheduledFor: null });
  });

  it("Run now materialises a linked occurrence without changing the regular clock", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Manual recurrence", project: "garrison",
      schedule: {
        kind: "cron", action: "notify", cron: "0 8 * * 1-5", timezone: "Europe/Lisbon",
        enabled: true, targetList: "todo"
      }
    });
    const regularNext = create.body.card.schedule.nextAt;
    const run = await jsend("POST", `/cards/${create.body.card.id}/run-now`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ occurrence: true, created: true });
    expect(run.body.card).toMatchObject({ scheduleTemplateId: create.body.card.id });
    expect(run.body.card.list).not.toBe("done");
    const template = await jget(`/cards/${create.body.card.id}`);
    expect(template.body.card.schedule.nextAt).toBe(regularNext);
    expect(template.body.card.list).toBe("scheduled");
  });

  it("does not let the generic editor resume a Morning template before legacy cutover", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Morning briefing", project: "garrison",
      schedule: {
        kind: "cron", action: "run", cron: "0 8 * * 1-5", timezone: "Europe/Lisbon",
        enabled: false, targetList: "todo", cutoverPending: true, desiredEnabled: true
      }
    });
    expect(create.status).toBe(201);
    const resumed = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      rev: create.body.card.rev,
      schedule: { ...create.body.card.schedule, enabled: true }
    });
    expect(resumed.status).toBe(409);
    expect(resumed.body.error).toBe("schedule-cutover-pending");
    expect(String(resumed.body.message)).toMatch(/Run now.*remove the legacy job/i);
  });

  it("stores personal as an independent scope and suppresses automatic project inference", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Book a dentist appointment",
      description: "Call the clinic tomorrow",
      scope: "personal"
    });
    expect(create.status).toBe(201);
    expect(create.body.card).toMatchObject({ scope: "personal", project: null, flow: null });

    // Give a mistakenly-started fire-and-forget inference enough time to expose
    // itself. Personal/no-project capture is deliberate, not an inference failure.
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    const detail = await jget(`/cards/${create.body.card.id}`);
    expect(detail.body.card).toMatchObject({ scope: "personal", project: null });
    expect(detail.body.events.some((event: any) => event.kind === "inference")).toBe(false);
  });

  it("allows a personal task to carry a real project", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Private cleanup in Garrison",
      project: "garrison",
      scope: "personal"
    });
    expect(create.status).toBe(201);
    expect(create.body.card).toMatchObject({ scope: "personal", project: "garrison" });
  });

  it("rejects contradictory or unknown scope values at the API boundary", async () => {
    const unknown = await jsend("POST", "/cards", { title: "Bad scope", scope: "private" });
    expect(unknown.status).toBe(400);
    expect(String(unknown.body.error)).toMatch(/personal, project, unscoped/);

    const projectless = await jsend("POST", "/cards", { title: "Missing project", scope: "project" });
    expect(projectless.status).toBe(400);

    const contradictory = await jsend("POST", "/cards", {
      title: "Contradictory scope",
      scope: "unscoped",
      project: "garrison"
    });
    expect(contradictory.status).toBe(400);
  });

  it("lets a human correct an inferred project before the first run and audits the override", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Infer then correct",
      description: "A project-shaped task"
    });
    expect(create.status).toBe(201);
    const inferred = await waitForCard(create.body.card.id, (card) => card.project === "inferred-repo");
    expect(inferred.card.scope).toBe("project");

    const corrected = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      project: "garrison",
      rev: inferred.card.rev
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body.card).toMatchObject({ project: "garrison", scope: "project", inferState: "manual" });
    const detail = await jget(`/cards/${create.body.card.id}`);
    expect(detail.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "inference", message: expect.stringContaining("inferred-repo → garrison") })
    ]));
  });

  it("a project correction clears a stale routing.project unless routing is explicitly replaced", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Correct the real cwd",
      project: "before",
      routing: { project: "stale-pin", model: "model-kept" }
    });
    const corrected = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      project: "after",
      rev: create.body.card.rev
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body.card.project).toBe("after");
    expect(corrected.body.card.routing).toEqual({ model: "model-kept" });

    const explicit = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      project: "label-only",
      routing: { project: "explicit-cwd", model: "model-kept" },
      rev: corrected.body.card.rev
    });
    expect(explicit.status).toBe(200);
    expect(explicit.body.card.routing.project).toBe("explicit-cwd");
  });

  it("manual inference is deliberate on personal/no-project and preserves the personal label", async () => {
    const create = await jsend("POST", "/cards", { title: "Personal but infer when asked", scope: "personal" });
    const start = await jsend("POST", `/cards/${create.body.card.id}/infer-project`);
    expect(start.status).toBe(200);
    const inferred = await waitForCard(create.body.card.id, (card) => card.project === "inferred-repo");
    expect(inferred.card).toMatchObject({ project: "inferred-repo", scope: "personal", inferState: "done" });
  });

  it("fixes project and personal scope after the first run starts", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Scope belongs to the run",
      project: "garrison",
      scope: "personal",
      routing: { project: "run-workspace", model: "model-before" }
    });
    const stamped = await updateCardCAS(KANBAN_DIR, create.body.card.id, (card: any) => ({
      ...card,
      runId: "01RUNSCOPELOCK00000000000",
      runDir: "runs/01RUNSCOPELOCK00000000000"
    }));
    expect(stamped?.runId).toBeTruthy();

    const project = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      project: "another-project",
      rev: stamped.rev
    });
    expect(project.status).toBe(409);
    expect(project.body.error).toBe("scope-already-ran");

    const scope = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      scope: "project",
      rev: stamped.rev
    });
    expect(scope.status).toBe(409);
    expect(scope.body.message).toMatch(/fresh card/i);

    const clearedRoutingProject = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      routing: { model: "model-after" },
      rev: stamped.rev
    });
    expect(clearedRoutingProject.status).toBe(409);
    expect(clearedRoutingProject.body.error).toBe("scope-already-ran");

    const changedRoutingProject = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      routing: { project: "other-workspace", model: "model-after" },
      rev: stamped.rev
    });
    expect(changedRoutingProject.status).toBe(409);

    // Runtime/model/effort corrections remain legal when the execution project
    // is preserved exactly.
    const modelOnly = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      routing: { project: "run-workspace", model: "model-after", effort: "high" },
      rev: stamped.rev
    });
    expect(modelOnly.status).toBe(200);
    expect(modelOnly.body.card.routing).toMatchObject({
      project: "run-workspace",
      model: "model-after",
      effort: "high"
    });
  });

  it("refuses manual project inference after the first run starts", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Personal run without a repository",
      scope: "personal"
    });
    const stamped = await updateCardCAS(KANBAN_DIR, create.body.card.id, (card: any) => ({
      ...card,
      runId: "01RUNINFERLOCK0000000000",
      runDir: "runs/personal/01RUNINFERLOCK0000000000"
    }));

    const infer = await jsend("POST", `/cards/${create.body.card.id}/infer-project`);
    expect(infer.status).toBe(409);
    expect(infer.body.error).toBe("scope-already-ran");
    const detail = await jget(`/cards/${create.body.card.id}`);
    expect(detail.body.card).toMatchObject({ project: null, scope: "personal", runId: stamped.runId });
  });

  it("creates a card in Backlog from title + description + project, and it shows on the board", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Wire the export button",
      description: "the toolbar export needs a real handler",
      project: "garrison"
    });
    expect(create.status).toBe(201);
    const card = create.body.card;
    expect(card.title).toBe("Wire the export button");
    expect(card.description).toBe("the toolbar export needs a real handler");
    expect(card.project).toBe("garrison");
    expect(card.list).toBe("backlog");

    // The UI refreshes via GET /board — the new card must be nested under Backlog
    // there (membership is derived from the card, never stored).
    const board = await jget("/board");
    expect(board.status).toBe(200);
    const backlog = board.body.lists.find((l: any) => l.id === "backlog");
    expect(backlog.cards.map((c: any) => c.id)).toContain(card.id);
    const onBoard = backlog.cards.find((c: any) => c.id === card.id);
    expect(onBoard.title).toBe("Wire the export button");
    expect(onBoard.project).toBe("garrison");
  });

  it("accepts a title-only card (description optional) into Backlog", async () => {
    const create = await jsend("POST", "/cards", { title: "Just a title", project: "garrison" });
    expect(create.status).toBe(201);
    expect(create.body.card.title).toBe("Just a title");
    expect(create.body.card.list).toBe("backlog");
  });

  it("creates directly at the TOP of To Do without a transient Backlog card", async () => {
    const older = await jsend("POST", "/cards", {
      title: "Older direct To Do card",
      project: "garrison",
      targetList: "todo"
    });
    const newer = await jsend("POST", "/cards", {
      title: "Newer direct To Do card",
      project: "garrison",
      targetList: "todo"
    });
    expect(older.status).toBe(201);
    expect(newer.status).toBe(201);
    expect(older.body.card.list).toBe("todo");
    expect(newer.body.card.list).toBe("todo");

    const board = await jget("/board");
    const backlog = board.body.lists.find((l: any) => l.id === "backlog");
    const todo = board.body.lists.find((l: any) => l.id === "todo");
    expect(backlog.cards.map((c: any) => c.id)).not.toContain(older.body.card.id);
    expect(backlog.cards.map((c: any) => c.id)).not.toContain(newer.body.card.id);
    expect(todo.cards[0].id).toBe(newer.body.card.id);
    expect(todo.cards.findIndex((c: any) => c.id === newer.body.card.id))
      .toBeLessThan(todo.cards.findIndex((c: any) => c.id === older.body.card.id));
    expect(newer.body.card.position).toBeLessThan(older.body.card.position);
    const detail = await jget(`/cards/${newer.body.card.id}`);
    expect(detail.body.events?.some((event: any) => event.kind === "moved")).toBe(false);
  });

  it("refuses unknown, autonomous, interactive, and terminal direct-create targets", async () => {
    for (const targetList of ["missing", "plan", "discuss", "done", "archived"]) {
      const create = await jsend("POST", "/cards", {
        title: `Unsafe target ${targetList}`,
        project: "garrison",
        targetList
      });
      expect(create.status).toBe(400);
    }
  });

  it("renames a human-held card through the revision-checked PATCH used by inline editing", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Title before inline edit",
      project: "garrison",
      targetList: "todo"
    });
    expect(create.status).toBe(201);
    const renamed = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      title: "Title after inline edit",
      rev: create.body.card.rev
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.card.title).toBe("Title after inline edit");

    const stale = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      title: "Stale title must not win",
      rev: create.body.card.rev
    });
    expect(stale.status).toBe(409);

    const board = await jget("/board");
    const todo = board.body.lists.find((l: any) => l.id === "todo");
    expect(todo.cards.find((c: any) => c.id === create.body.card.id)?.title)
      .toBe("Title after inline edit");
  });

  it("stamps an http(s) videoUrl at create (Drill Evidence) and rejects other schemes", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Drill fix: home",
      description: "Drill batch fix",
      project: "garrison",
      videoUrl: "http://127.0.0.1:27096/api/runs/01TEST/evidence-file/video.webm"
    });
    expect(create.status).toBe(201);
    expect(create.body.card.videoUrl).toBe("http://127.0.0.1:27096/api/runs/01TEST/evidence-file/video.webm");
    const detail = await jget(`/cards/${create.body.card.id}`);
    expect(detail.body.card.videoUrl).toBe("http://127.0.0.1:27096/api/runs/01TEST/evidence-file/video.webm");
    // The links block (a sibling of `card` in the detail response) renders it
    // as the card's video href.
    expect(detail.body.links?.video).toMatchObject({ kind: "href" });

    const bad = await jsend("POST", "/cards", {
      title: "No file links",
      project: "garrison",
      videoUrl: "file:///etc/passwd"
    });
    expect(bad.status).toBe(201);
    expect(bad.body.card.videoUrl).toBeNull();
  });

  it("synchronously scopes an auto-project card to its explicit absolute workspace", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Build an isolated cache",
      description: "Implement the package in /tmp/kanban-explicit-workspace-proof. Run its tests."
    });
    expect(create.status).toBe(201);
    expect(create.body.card.project).toBe("/tmp/kanban-explicit-workspace-proof");
    expect(create.body.card.inferState).toBe("done");
    const detail = await jget(`/cards/${create.body.card.id}`);
    expect(detail.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "inference", message: expect.stringContaining("Detected explicit workspace") })
    ]));
  });

  it("infers the title from the description when title is blank (the sheet path)", async () => {
    const create = await jsend("POST", "/cards", {
      title: "   ",
      description: "First line becomes the title\nsecond line ignored",
      project: "garrison"
    });
    expect(create.status).toBe(201);
    expect(create.body.card.title).toBe("First line becomes the title");
    expect(create.body.card.list).toBe("backlog");
  });

  it("rejects a card with neither a title nor a description (400)", async () => {
    const create = await jsend("POST", "/cards", { project: "garrison" });
    expect(create.status).toBe(400);
    expect(String(create.body.error)).toMatch(/title or a description/i);
  });

  // Item 1 — a new card lands at the TOP of the list, not the bottom. Create A
  // then B and prove B (the later create) sorts BEFORE A in Backlog, with a
  // strictly-lower effective position. Membership + order come from GET /board,
  // exactly as the UI renders it.
  it("adds a new card to the TOP of Backlog (later card sorts first)", async () => {
    const a = await jsend("POST", "/cards", { title: "Top test A", project: "garrison" });
    const b = await jsend("POST", "/cards", { title: "Top test B", project: "garrison" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const board = await jget("/board");
    const backlog = board.body.lists.find((l: any) => l.id === "backlog");
    const ids = backlog.cards.map((c: any) => c.id);
    const iA = ids.indexOf(a.body.card.id);
    const iB = ids.indexOf(b.body.card.id);
    // B was created after A, so B must appear ABOVE A (lower index) — top, not bottom.
    expect(iB).toBeLessThan(iA);
    // And B must be the very first card in Backlog.
    expect(iB).toBe(0);

    // The order is float-position driven: B's effective position is strictly below A's.
    const cardB = backlog.cards[iB];
    const cardA = backlog.cards[iA];
    expect(typeof cardB.position).toBe("number");
    expect(typeof cardA.position).toBe("number");
    expect(cardB.position).toBeLessThan(cardA.position);
  });

  // Item 2 — the Move button is the MANUAL gate: PATCH can move a card to ANY real
  // list, not just its validNext. This pins the server contract the UI's move sheet
  // now leans on (deriveMoveTargets offers every list; there is no validNext gate on
  // PATCH). backlog.validNext is ["todo"], so a move straight to "done" proves it.
  it("move: PATCH can move a card to an arbitrary list outside its validNext", async () => {
    const create = await jsend("POST", "/cards", { title: "Move me anywhere", project: "garrison" });
    expect(create.status).toBe(201);
    const { id, rev } = create.body.card;

    const moved = await jsend("PATCH", `/cards/${id}`, { list: "done", rev });
    expect(moved.status).toBe(200);
    expect(moved.body.card.list).toBe("done");

    const board = await jget("/board");
    const done = board.body.lists.find((l: any) => l.id === "done");
    expect(done.cards.map((c: any) => c.id)).toContain(id);
  });

  it("moves without an explicit drag position land at the TOP of the destination", async () => {
    const older = await jsend("POST", "/cards", { title: "Older destination card", project: "garrison" });
    const olderMove = await jsend("PATCH", `/cards/${older.body.card.id}`, { list: "done", rev: older.body.card.rev });
    expect(olderMove.status).toBe(200);

    const fresh = await jsend("POST", "/cards", { title: "Fresh destination card", project: "garrison" });
    const freshMove = await jsend("PATCH", `/cards/${fresh.body.card.id}`, { list: "done", rev: fresh.body.card.rev });
    expect(freshMove.status).toBe(200);

    const board = await jget("/board");
    const done = board.body.lists.find((l: any) => l.id === "done");
    expect(done.cards.findIndex((c: any) => c.id === fresh.body.card.id))
      .toBeLessThan(done.cards.findIndex((c: any) => c.id === older.body.card.id));
  });

  it("preserves an explicit drag position on a cross-list move", async () => {
    const create = await jsend("POST", "/cards", { title: "Precisely dropped", project: "garrison" });
    const moved = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      list: "todo",
      position: -987_654_321,
      rev: create.body.card.rev
    });
    expect(moved.status).toBe(200);
    expect(moved.body.card.position).toBe(-987_654_321);
  });

  it("serialises concurrent top-position allocation", async () => {
    const created = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      jsend("POST", "/cards", { title: `Concurrent top ${i}`, project: "garrison" })
    ));
    expect(created.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(created.map((r) => r.body.card.id));
    const board = await jget("/board");
    const backlog = board.body.lists.find((l: any) => l.id === "backlog");
    const positions = backlog.cards
      .filter((card: any) => ids.has(card.id))
      .map((card: any) => card.position);
    expect(positions).toHaveLength(8);
    expect(positions.every((position: unknown) => typeof position === "number" && Number.isFinite(position))).toBe(true);
    expect(new Set(positions).size).toBe(8);
  });

  it("serialises concurrent implicit moves into one destination", async () => {
    const created = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      jsend("POST", "/cards", { title: `Concurrent move ${i}`, project: "garrison" })
    ));
    const moved = await Promise.all(created.map((response) =>
      jsend("PATCH", `/cards/${response.body.card.id}`, { list: "archived", rev: response.body.card.rev })
    ));
    expect(moved.every((response) => response.status === 200)).toBe(true);
    const positions = moved.map((response) => response.body.card.position);
    expect(positions.every((position) => typeof position === "number" && Number.isFinite(position))).toBe(true);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("resolves a concurrent create versus explicit drag-to-top collision", async () => {
    const dragCard = await jsend("POST", "/cards", { title: "Concurrent dragged top", project: "garrison" });
    const before = await jget("/board");
    const backlog = before.body.lists.find((list: any) => list.id === "backlog");
    const oldMin = Math.min(...backlog.cards.map((card: any) => card.position));
    const requestedTop = oldMin - 60_000;

    const [created, moved] = await Promise.all([
      jsend("POST", "/cards", { title: "Concurrent created top", project: "garrison" }),
      jsend("PATCH", `/cards/${dragCard.body.card.id}`, {
        list: "backlog",
        position: requestedTop,
        rev: dragCard.body.card.rev
      })
    ]);
    expect(created.status).toBe(201);
    expect(moved.status).toBe(200);
    expect(created.body.card.position).toBeLessThan(oldMin);
    expect(moved.body.card.position).toBeLessThan(oldMin);
    expect(created.body.card.position).not.toBe(moved.body.card.position);
  });

  it("round-trips edited checklist items with five paragraphs and no 500-char truncation", async () => {
    const original = Array.from(
      { length: 5 },
      (_, i) => `Paragraph ${i + 1}: ${"detail ".repeat(30).trimEnd()}`
    ).join("\n\n");
    expect(original.length).toBeGreaterThan(500);
    const create = await jsend("POST", "/cards", {
      title: "Long checklist",
      project: "garrison",
      checklist: [{ text: original, done: false }]
    });
    expect(create.status).toBe(201);
    const detail = await jget(`/cards/${create.body.card.id}`);
    expect(detail.body.checklist[0].text).toBe(original);

    const edited = `${original}\n\nSixth paragraph added during editing.`;
    const patch = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      rev: detail.body.card.rev,
      checklist: [{ ...detail.body.checklist[0], text: edited }]
    });
    expect(patch.status).toBe(200);
    const after = await jget(`/cards/${create.body.card.id}`);
    expect(after.body.checklist[0].text).toBe(edited);
  });

  it("rejects oversized checklist input instead of silently truncating it", async () => {
    const tooLong = await jsend("POST", "/cards", {
      title: "Too long checklist",
      project: "garrison",
      checklist: [{ text: "x".repeat(64 * 1024 + 1) }]
    });
    expect(tooLong.status).toBe(400);
    expect(String(tooLong.body.error)).toMatch(/checklist item 1 exceeds/i);

    const tooMany = await jsend("POST", "/cards", {
      title: "Too many checklist items",
      project: "garrison",
      checklist: Array.from({ length: 101 }, (_, index) => ({ text: `item ${index}` }))
    });
    expect(tooMany.status).toBe(400);
    expect(String(tooMany.body.error)).toMatch(/maximum is 100/i);
  });
});
