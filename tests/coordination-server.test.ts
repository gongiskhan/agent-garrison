// GARRISON-FLOW-V2 S1 — the SERVER half of coordination ordering in the kanban-loop
// fitting. Boots the REAL own-port board server (makeRequestHandler over an ephemeral
// port) against a sandboxed board + a policy that turns coordination ON, and asserts the
// four server behaviours the design (plan-coord-engine Q2/Q4/Q8) specifies:
//   (a) the cardSummary projection carries waitingOn / stabilityAt / blocking,
//   (b) creating a second live card on a project records the honest provisional overlap
//       event (the real scoring waits for Plan completion — Q2 point 1),
//   (c) a manual Start on a WAITING card is the deliberate override — it clears waitingOn
//       (recording it) and dispatches (Q4),
//   (d) the auto-dispatch path SKIPS a waitingOn card (the same skip the tick applies).
//
// Sandboxed exactly like tests/kanban-dispatch.test.ts: a tmp GARRISON_KANBAN_DIR board,
// a tmp GARRISON_HOME for the coord substrate, a tmp GARRISON_RUNS_DIR, and a written
// GARRISON_POLICY_PATH with { coordination: { enabled: true } } so loadPolicy sees the
// section AND policyLoadState() is "ok" (coordination is AVAILABLE, not degraded).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

// ── env sandbox (set BEFORE importing the server / board / coordination modules) ──
const KANBAN_DIR = mkdtempSync(join(tmpdir(), "coord-srv-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "coord-srv-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "coord-srv-runs-"));
const POLICY_PATH = join(mkdtempSync(join(tmpdir(), "coord-srv-policy-")), "policy.json");
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = POLICY_PATH;
// A minimal but VALID policy with the coordination section on. policyLoadState() reads
// this as "ok", so coordinationAvailability() is ok:true (available, not degraded).
writeFileSync(POLICY_PATH, JSON.stringify({ coordination: { enabled: true } }));

// @ts-ignore — pure ESM .mjs, no .d.ts
import { makeRequestHandler, cardSummary } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard, createCard, loadCard, updateCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";

// A stub gateway: GET anything → 200 (so gatewayReachable() is true); POST /chat/stream →
// one SSE `done` with a benign verdict (so a background dispatch completes without noise).
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

  gateway = http.createServer((req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "implement" })}\n\n`);
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
  return { status: r.status, body: await r.json() as any };
}
async function jsend(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, body: await r.json() as any };
}

describe("(a) cardSummary carries the coordination fields", () => {
  it("waitingOn / stabilityAt / planCompletedAt / blocking survive the projection", () => {
    const waitingOn = { cardId: "01BLOCKER00000000000000000", cardTitle: "earlier run", grade: "medium", reason: "medium overlap on files [src/a.ts]", until: "stability", thenTo: "implement", rerun: false, since: "2026-07-10T00:00:00.000Z" };
    const cs = cardSummary({ id: "x", title: "t", list: "plan", waitingOn, stabilityAt: "2026-07-10T01:00:00.000Z", planCompletedAt: "2026-07-10T00:30:00.000Z", blocking: ["01A", "01B"] });
    expect(cs.waitingOn).toEqual(waitingOn);
    expect(cs.stabilityAt).toBe("2026-07-10T01:00:00.000Z");
    expect(cs.planCompletedAt).toBe("2026-07-10T00:30:00.000Z");
    expect(cs.blocking).toEqual(["01A", "01B"]);
  });

  it("defaults are honest (null / empty) for a card with no coordination state", () => {
    const cs = cardSummary({ id: "y", title: "t", list: "todo" });
    expect(cs.waitingOn).toBeNull();
    expect(cs.stabilityAt).toBeNull();
    expect(cs.planCompletedAt).toBeNull();
    expect(cs.blocking).toEqual([]);
  });
});

describe("(b) create-time provisional overlap event", () => {
  it("a second live card on the same project gets an honest provisional coordination event", async () => {
    // First card, made LIVE: on an agent list with a minted runDir (isCardLive).
    const first = await createCard(KANBAN_DIR, { title: "first", project: "demo", list: "backlog" });
    await updateCardCAS(KANBAN_DIR, first.id, (c: any) => ({ ...c, list: "plan", runId: "01RUNFIRST0000000000000000", runDir: join(RUNS_DIR, "01RUNFIRST0000000000000000") }));

    // Second card on the SAME project via the real create endpoint.
    const created = await jsend("POST", "/cards", { title: "second", project: "demo", description: "overlapping work" });
    expect(created.status).toBe(201);
    const id = created.body.card.id;

    const detail = await jget(`/cards/${id}`);
    const events = detail.body.events as Array<{ kind: string; message: string }>;
    const provisional = events.find((e) => e.kind === "coordination" && /provisional/i.test(e.message));
    expect(provisional, "a provisional coordination event should be recorded").toBeTruthy();
    expect(provisional!.message).toMatch(/demo/);
  });

  it("a card on a project with NO other live cards gets no provisional event", async () => {
    const created = await jsend("POST", "/cards", { title: "lonely", project: "solo-project", description: "no peers" });
    const id = created.body.card.id;
    const detail = await jget(`/cards/${id}`);
    const events = detail.body.events as Array<{ kind: string }>;
    expect(events.find((e) => e.kind === "coordination")).toBeUndefined();
  });
});

describe("(c) manual Start on a waiting card overrides the wait and dispatches", () => {
  it("clears waitingOn with a recorded override event, then dispatches", async () => {
    const card = await createCard(KANBAN_DIR, { title: "waiter", project: "demo", list: "backlog" });
    await updateCardCAS(KANBAN_DIR, card.id, (c: any) => ({
      ...c,
      list: "plan",
      runId: "01RUNWAITER000000000000000",
      runDir: join(RUNS_DIR, "01RUNWAITER000000000000000"),
      planCompletedAt: "2026-07-10T00:00:00.000Z",
      waitingOn: { cardId: "01RUNFIRST0000000000000000", cardTitle: "first", grade: "medium", reason: "medium overlap", until: "stability", thenTo: "implement", rerun: false, since: "2026-07-10T00:00:00.000Z" }
    }));

    const res = await jsend("POST", `/cards/${card.id}/start`);
    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(true);
    // The response reflects the pre-dispatch state: the wait is cleared and the override
    // is the last recorded event.
    expect(res.body.card.waitingOn).toBeNull();
    expect(res.body.card.lastEvent.kind).toBe("coordination");
    expect(res.body.card.lastEvent.message).toMatch(/overridden manually/i);

    // On disk the wait stays cleared (the override write landed before dispatch).
    const disk = await loadCard(KANBAN_DIR, card.id);
    expect(disk.waitingOn ?? null).toBeNull();
  });
});

describe("(d) auto-dispatch skips a waitingOn card", () => {
  it("a PATCH move onto an immediate agent list does NOT dispatch a waiting card", async () => {
    // A card on a MANUAL list (todo) carrying a wait — a move out of it is a human PATCH
    // (todo is not engine-owned), and the auto-dispatch onto plan must skip the wait.
    const card = await createCard(KANBAN_DIR, { title: "still-waiting", project: "demo", list: "todo" });
    const set = await updateCardCAS(KANBAN_DIR, card.id, (c: any) => ({
      ...c,
      waitingOn: { cardId: "01RUNFIRST0000000000000000", cardTitle: "first", grade: "heavy", reason: "heavy overlap", until: "terminal", thenTo: "implement", rerun: false, since: "2026-07-10T00:00:00.000Z" }
    }));

    const res = await jsend("PATCH", `/cards/${card.id}`, { list: "plan", rev: set.rev });
    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(false);
    expect(res.body.note).toMatch(/waiting/i);
    // The card DID move (the wait defers dispatch, not the move) and keeps its wait.
    expect(res.body.card.list).toBe("plan");
    expect(res.body.card.waitingOn).not.toBeNull();
    const disk = await loadCard(KANBAN_DIR, card.id);
    expect(disk.list).toBe("plan");
    expect(disk.waitingOn).toBeTruthy();
  });
});
