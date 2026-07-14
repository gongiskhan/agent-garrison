// S3a — origin records + the per-transport lifecycle event router (D8).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

// env sandbox BEFORE importing the server/board (server-boot describe uses it).
const KANBAN_DIR = mkdtempSync(join(tmpdir(), "s3a-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "s3a-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "s3a-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore — pure .mjs
import { safeOriginId, deriveOriginId, parseOriginId, ensureOriginRecord, appendOriginEvent, readOriginRecord, readOriginEvents } from "../fittings/seed/kanban-loop/lib/origins.mjs";
// @ts-ignore
import { routeOriginEvent, routeTerminalTransition, routeNeedsInput, createdMessage, dutySummaryMessage, needsInputMessage } from "../fittings/seed/kanban-loop/lib/notify-origin.mjs";
// @ts-ignore
import { parkFields, processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore
import { createCard, loadCard, saveBoard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard, phaseTemplatesFrom } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { buildBoard } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "s3a-root-"));

describe("origins store", () => {
  it("safeOriginId sanitizes into a filename with a hash when it changes materially", () => {
    expect(safeOriginId("board")).toBe("board");
    expect(safeOriginId("web:chat-abc")).toMatch(/^web-chat-abc-[0-9a-f]{8}$/);
    expect(safeOriginId("")).toBe("board");
  });

  it("deriveOriginId — web / board / skill / explicit matrix", () => {
    expect(deriveOriginId({ originChannel: { channel: "web", threadId: "T1" } })).toBe("web:T1");
    expect(deriveOriginId({ origin: "garrison-doorway" })).toBe("skill:unknown");
    expect(deriveOriginId({})).toBe("board");
    expect(deriveOriginId({ project: "x" })).toBe("board");
    expect(deriveOriginId({ origin_id: "terminal:tty7", originChannel: { channel: "web", threadId: "T1" } })).toBe("terminal:tty7"); // explicit wins
  });

  it("parseOriginId splits transport:address, board for the bare/unknown cases", () => {
    expect(parseOriginId("web:T1")).toEqual({ transport: "web", address: "T1" });
    expect(parseOriginId("skill:abc")).toEqual({ transport: "skill", address: "abc" });
    expect(parseOriginId("board")).toEqual({ transport: "board", address: null });
    expect(parseOriginId("bogus:x")).toEqual({ transport: "board", address: "x" });
    expect(parseOriginId("")).toEqual({ transport: "board", address: null });
  });

  it("ensureOriginRecord is idempotent; appendOriginEvent + readOriginEvents round-trip", () => {
    const root = tmp();
    expect(ensureOriginRecord(root, { origin_id: "web:T1", thread: "T1" })).toBe(true);
    expect(ensureOriginRecord(root, { origin_id: "web:T1" })).toBe(false); // already exists
    const rec = readOriginRecord(root, "web:T1");
    expect(rec).toMatchObject({ origin_id: "web:T1", transport: "web", address: "T1", thread: "T1" });
    appendOriginEvent(root, "web:T1", { at: "t1", kind: "created", cardId: "C1" });
    appendOriginEvent(root, "web:T1", { at: "t2", kind: "finished", cardId: "C1" });
    const evs = readOriginEvents(root, "web:T1");
    expect(evs.map((e: any) => e.kind)).toEqual(["created", "finished"]);
  });
});

describe("parkFields blocked/failed classification (S3a)", () => {
  it("defaults to blocked; 'failed' sets attentionKind failed", () => {
    expect(parkFields({}, "plan", "reason").attentionKind).toBe("blocked");
    expect(parkFields({}, "plan", "reason", "failed").attentionKind).toBe("failed");
    expect(parkFields({}, "plan", "reason", "blocked").attentionKind).toBe("blocked");
    // still carries the legacy fields
    expect(parkFields({}, "plan", "why").attentionReason).toBe("why");
    expect(parkFields({}, "plan", "why").status).toBe("needs-attention");
  });
});

describe("message builders", () => {
  it("createdMessage / dutySummaryMessage / needsInputMessage", () => {
    const card = { id: "C1", title: "Add login" };
    expect(createdMessage(card)).toContain("Registered as a run — Add login.");
    const ds = dutySummaryMessage(card, { phase: "implement", summary: "wired the handler" });
    expect(ds).toContain("Implement complete — wired the handler");
    const ni = needsInputMessage(card, { questions: ["Which DB?", "Confirm scope?"] });
    expect(ni).toContain("Needs input — Add login.");
    expect(ni).toContain("1. Which DB?");
    expect(ni).toContain("2. Confirm scope?");
  });
});

describe("routeOriginEvent — event-log append for all transports; web delivery", () => {
  it("board transport: appends to the event log only (no web)", () => {
    const root = tmp();
    routeOriginEvent(root, null, { id: "C1", title: "T", origin_id: "board" }, { kind: "created", message: "hi" });
    const evs = readOriginEvents(root, "board");
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ kind: "created", cardId: "C1", message: "hi" });
    expect(readOriginRecord(root, "board")).toMatchObject({ transport: "board" });
  });

  it("skill transport: event log only", () => {
    const root = tmp();
    routeOriginEvent(root, null, { id: "C2", origin: "garrison-doorway" }, { kind: "duty-summary", message: "done", detail: { phase: "plan" } });
    const evs = readOriginEvents(root, "skill:unknown");
    expect(evs[0]).toMatchObject({ kind: "duty-summary", detail: { phase: "plan" } });
  });
});

// Web delivery: a fake web-channel thread server + a status file so statusFileUrl resolves.
describe("routeOriginEvent — web transport delivers to the thread", () => {
  let threadServer: http.Server;
  const received: any[] = [];

  beforeAll(async () => {
    threadServer = http.createServer((req, res) => {
      if (req.method === "POST" && /\/api\/threads\/.+\/messages/.test(req.url || "")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            received.push({ url: req.url, body: JSON.parse(body) });
          } catch {
            received.push({ url: req.url, body: null });
          }
          res.writeHead(200);
          res.end("{}");
        });
        return;
      }
      res.writeHead(200);
      res.end("{}");
    });
    await new Promise<void>((r) => threadServer.listen(0, "127.0.0.1", r));
    const port = (threadServer.address() as any).port;
    mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
    writeFileSync(join(GARRISON_HOME, "ui-fittings", "web-channel-default.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
  });
  afterAll(async () => {
    await new Promise<void>((r) => threadServer.close(() => r()));
  });

  it("posts the message to the origin thread AND logs the event", async () => {
    const root = tmp();
    const card = { id: "CW", title: "web card", origin_id: "web:chat-xyz", originChannel: { channel: "web", threadId: "chat-xyz" } };
    routeOriginEvent(root, null, card, { kind: "finished", message: "Run complete — web card." });
    // event log always written (synchronously)
    expect(readOriginEvents(root, "web:chat-xyz").map((e: any) => e.kind)).toEqual(["finished"]);
    // web delivery is fire-and-forget — give it a tick
    await new Promise((r) => setTimeout(r, 120));
    const hit = received.find((m) => m.url.includes("chat-xyz"));
    expect(hit).toBeTruthy();
    expect(hit.body.messages[0].text).toContain("Run complete — web card.");
  });

  it("a quick card is NOT delivered to web (event log only)", async () => {
    const root = tmp();
    routeOriginEvent(root, null, { id: "CQ", title: "quick", quick: true, origin_id: "web:chat-quick", originChannel: { channel: "web", threadId: "chat-quick" } }, { kind: "finished", message: "x" });
    expect(readOriginEvents(root, "web:chat-quick")).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(received.find((m) => m.url.includes("chat-quick"))).toBeUndefined();
  });
});

describe("routeTerminalTransition — finished / blocked / failed", () => {
  it("maps the terminal edge to the right event kind", () => {
    const root = tmp();
    const done = { id: "CD", title: "d", list: "done", origin_id: "board" };
    routeTerminalTransition(root, { list: "test" }, done);
    expect(readOriginEvents(root, "board").at(-1)).toMatchObject({ kind: "finished" });

    const blocked = { id: "CB", title: "b", list: "needs-attention", attentionKind: "blocked", origin_id: "board" };
    routeTerminalTransition(root, { list: "review" }, blocked);
    expect(readOriginEvents(root, "board").at(-1)).toMatchObject({ kind: "blocked" });

    const failed = { id: "CF", title: "f", list: "needs-attention", attentionKind: "failed", origin_id: "board" };
    routeTerminalTransition(root, { list: "implement" }, failed);
    expect(readOriginEvents(root, "board").at(-1)).toMatchObject({ kind: "failed" });

    // no-op on a non-terminal move / repeated terminal save
    const before = readOriginEvents(root, "board").length;
    routeTerminalTransition(root, { list: "plan" }, { id: "CX", list: "implement", origin_id: "board" });
    routeTerminalTransition(root, { list: "done" }, { id: "CY", list: "done", origin_id: "board" });
    expect(readOriginEvents(root, "board").length).toBe(before);
  });
});

describe("routeNeedsInput helper (defined, not yet emitted)", () => {
  it("renders numbered questions + logs a needs-input event", () => {
    const root = tmp();
    routeNeedsInput(root, null, { id: "CN", title: "n", origin_id: "board" }, { questions: ["A?", { question: "B?" }] });
    const ev = readOriginEvents(root, "board").at(-1);
    expect(ev.kind).toBe("needs-input");
    expect(ev.detail.questions).toEqual(["A?", "B?"]);
    expect(ev.message).toContain("1. A?");
    expect(ev.message).toContain("2. B?");
  });
});

// Server-boot: the created event fires on POST /cards, with a derived origin_id.
describe("created event on POST /cards (booted board server)", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
    await saveBoard(seedBoard(), KANBAN_DIR);
    // Point the web channel status at nothing so a web-origin created event logs the
    // event without attempting (a now-dead) thread delivery — this describe asserts
    // the durable event log, not web delivery (covered above).
    mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
    writeFileSync(join(GARRISON_HOME, "ui-fittings", "web-channel-default.json"), JSON.stringify({}));
    server = http.createServer(makeRequestHandler({ root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 }, join(FITTING, "dist")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("a web-origin card gets a created event in its origin log", async () => {
    const res = await fetch(`${base}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "From a thread", project: "garrison", originChannel: { channel: "web", threadId: "thread-777" } })
    });
    expect(res.status).toBe(201);
    const { card } = await res.json();
    expect(card.origin_id).toBe("web:thread-777");
    const evs = readOriginEvents(KANBAN_DIR, "web:thread-777");
    expect(evs.some((e: any) => e.kind === "created" && e.cardId === card.id)).toBe(true);
  });

  it("a board card derives origin_id 'board' and logs created there", async () => {
    const res = await fetch(`${base}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Board card", project: "garrison" })
    });
    const { card } = await res.json();
    expect(card.origin_id).toBe("board");
    expect(readOriginEvents(KANBAN_DIR, "board").some((e: any) => e.cardId === card.id && e.kind === "created")).toBe(true);
  });
});

// Engine-driven: a genuine advance emits a duty-summary event; a park emits blocked/failed.
describe("engine emission — duty-summary on advance, blocked/failed on park", () => {
  const model: any = {
    version: 2,
    compositionId: "t",
    kanbanLists: ["implement", "review"],
    sequences: { develop: { "2": ["implement", "review"] } },
    cells: {},
    holds: {}
  };
  const board = buildBoard(model, { templates: phaseTemplatesFrom(seedBoard()) });

  it("advancing a card writes a duty-summary event to its (board) origin", async () => {
    const root = tmp();
    const card = await createCard(root, { list: "implement", title: "adv", project: "demo", duty: "develop", level: 2, sequence: ["implement", "review"] });
    const runFn = async () => ({ reply: "review" });
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10, model, cwd: root });
    expect(outcome.status).toBe("moved");
    const evs = readOriginEvents(root, "board");
    const ds = evs.find((e: any) => e.kind === "duty-summary");
    expect(ds).toBeTruthy();
    expect(ds.detail).toMatchObject({ phase: "implement", listTo: "review" });
  });

  it("a no-valid-next park routes a BLOCKED event and stamps attentionKind blocked", async () => {
    const root = tmp();
    const card = await createCard(root, { list: "implement", title: "stuck", project: "demo", duty: "develop", level: 2, sequence: ["implement", "review"] });
    const runFn = async () => ({ reply: "this chooses nothing valid" });
    await processCard({ root, board, card, runFn, cap: 10, model, cwd: root });
    const parked = await loadCard(root, card.id);
    expect(parked.list).toBe("needs-attention");
    expect(parked.attentionKind).toBe("blocked");
    expect(readOriginEvents(root, "board").some((e: any) => e.kind === "blocked")).toBe(true);
  });

  it("a dispatch error park routes a FAILED event and stamps attentionKind failed", async () => {
    const root = tmp();
    const card = await createCard(root, { list: "implement", title: "boom", project: "demo", duty: "develop", level: 2, sequence: ["implement", "review"] });
    const runFn = async () => {
      throw new Error("gateway blew up");
    };
    await processCard({ root, board, card, runFn, cap: 10, model, cwd: root });
    const parked = await loadCard(root, card.id);
    expect(parked.list).toBe("needs-attention");
    expect(parked.attentionKind).toBe("failed");
    expect(readOriginEvents(root, "board").some((e: any) => e.kind === "failed")).toBe(true);
  });
});
