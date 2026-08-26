// S3a — origin records + the per-transport lifecycle event router (D8).
//
// The Conversations cut removed the local dispatch engine, so the blocks that
// drove processCard to make the router emit are gone. The router itself is
// untouched and fully live: server.mjs routes `created`, `steering` and
// `needs-input` (server.mjs:1454/1981/1990) and board.mjs fires
// routeTerminalTransition from the saveCardCAS choke point (board.mjs:1286).
// That choke point is what the engine-driven blocks were really testing —
// reaching it through a card WRITE rather than through a card RUN is both what
// production does now and a shorter path to the same invariant.
//
// dutySummaryMessage is kept below with its callers noted: engine.mjs still
// imports it, but the duty-summary emission went with the dispatch engine, so
// the builder is currently unreached. See task "Re-wire routeAutonomyActed into
// the conversation launcher" — same lane, same pending re-wire.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import { safeOriginId, deriveOriginId, parseOriginId, ensureOriginRecord, appendOriginEvent, readOriginRecord, readOriginEvents, readOriginEventsSince, originEventsFile } from "../fittings/seed/kanban-loop/lib/origins.mjs";
// @ts-ignore
import { routeOriginEvent, routeTerminalTransition, routeNeedsInput, createdMessage, dutySummaryMessage, needsInputMessage } from "../fittings/seed/kanban-loop/lib/notify-origin.mjs";
// @ts-ignore
import { parkFields } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore
import { createCard, loadCard, saveBoard, saveCardCASWithHooks, updateCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
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
// The card store is shared by every test in this file now, where a fresh tmp root
// used to isolate them; wipe the cards between tests so one test's cards can never
// show up in another's sweep or board read. The board layout this file seeds once
// survives — reset() only clears cards.
beforeEach(async () => {
  await __kanbanState?.reset();
});

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

  // Delivery is fire-and-forget and its path includes a state service round
  // trip, so a fixed sleep is a race under a loaded suite. Poll for it instead;
  // the assertion that follows still owns the verdict.
  async function waitForDelivery(match: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = received.find((m) => m.url.includes(match));
      if (hit || Date.now() > deadline) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

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
    const hit = await waitForDelivery("chat-xyz");
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

  // The engine-driven version of this drove processCard and asserted the reply
  // reached the thread untruncated. The card WRITE is the live seam now: the
  // terminal edge fires from saveCardCAS (board.mjs:1286) and the authoritative
  // text rides the `terminalSummary` hook, so it must be written through
  // saveCardCASWithHooks — plain updateCardCAS carries no hooks and the thread
  // then gets only the generic completion line.
  it("delivers one untruncated terminal answer through the card-write choke point", async () => {
    const root = tmp();
    const threadId = "chat-terminal-full";
    const card = await createCard(root, {
      list: "todo",
      title: "Product opinion",
      project: "demo",
      originChannel: { channel: "web", threadId }
    });
    const marker = "recommendation beyond the former card snippet boundary";
    const summary = `${"Detailed product reasoning. ".repeat(20)}${marker}`;

    const disk = await loadCard(root, card.id);
    await saveCardCASWithHooks(
      root,
      { ...disk, id: card.id, list: "done", status: "ok" },
      disk.rev,
      new Date().toISOString(),
      { terminalSummary: summary }
    );

    await waitForDelivery(threadId);
    const hits = received.filter((m) => m.url.includes(threadId));
    expect(hits).toHaveLength(1);
    // The full summary reaches the thread — no card-front truncation, and not
    // the bare "Run complete" fallback.
    expect(hits[0].body.messages[0].text).toContain(marker);
    expect(readOriginEvents(root, `web:${threadId}`).map((e: any) => e.kind)).toContain("finished");
  });

  it("falls back to the generic completion line when the write carries no summary", async () => {
    const root = tmp();
    const threadId = "chat-terminal-bare";
    const card = await createCard(root, {
      list: "todo",
      title: "Bare finish",
      project: "demo",
      originChannel: { channel: "web", threadId }
    });

    await updateCardCAS(root, card.id, (c: any) => ({ ...c, list: "done", status: "ok" }));

    await waitForDelivery(threadId);
    const hits = received.filter((m) => m.url.includes(threadId));
    expect(hits).toHaveLength(1);
    expect(hits[0].body.messages[0].text).toContain("Bare finish");
  });
});

describe("routeTerminalTransition — finished / blocked / failed", () => {
  it("maps the terminal edge to the right event kind", () => {
    const root = tmp();
    const done = { id: "CD", title: "d", list: "done", origin_id: "board" };
    routeTerminalTransition(root, { list: "todo" }, done);
    expect(readOriginEvents(root, "board").at(-1)).toMatchObject({ kind: "finished" });

    const blocked = { id: "CB", title: "b", list: "needs-attention", attentionKind: "blocked", origin_id: "board" };
    routeTerminalTransition(root, { list: "running" }, blocked);
    expect(readOriginEvents(root, "board").at(-1)).toMatchObject({ kind: "blocked" });

    const failed = { id: "CF", title: "f", list: "needs-attention", attentionKind: "failed", origin_id: "board" };
    routeTerminalTransition(root, { list: "running" }, failed);
    expect(readOriginEvents(root, "board").at(-1)).toMatchObject({ kind: "failed" });

    // no-op on a non-terminal move / repeated terminal save
    const before = readOriginEvents(root, "board").length;
    routeTerminalTransition(root, { list: "todo" }, { id: "CX", list: "running", origin_id: "board" });
    routeTerminalTransition(root, { list: "done" }, { id: "CY", list: "done", origin_id: "board" });
    expect(readOriginEvents(root, "board").length).toBe(before);
  });

  // The one caller is board.mjs:1286, inside saveCardCAS. Driving a real card
  // write is what proves the edge fires exactly once per outcome — the property
  // the choke point exists for.
  it("fires exactly once per outcome from the saveCardCAS choke point", async () => {
    const root = tmp();
    const card = await createCard(root, { list: "todo", title: "real write", project: "demo" });

    await updateCardCAS(root, card.id, (c: any) => ({ ...c, list: "done", status: "ok" }));
    const afterFirst = readOriginEvents(root, "board").filter((e: any) => e.cardId === card.id);
    expect(afterFirst.map((e: any) => e.kind)).toContain("finished");
    const finishedCount = afterFirst.filter((e: any) => e.kind === "finished").length;
    expect(finishedCount).toBe(1);

    // A second write that does NOT change the terminal state must not re-fire.
    await updateCardCAS(root, card.id, (c: any) => ({ ...c, title: "real write (edited)" }));
    expect(
      readOriginEvents(root, "board").filter((e: any) => e.cardId === card.id && e.kind === "finished")
    ).toHaveLength(1);
  });
});

describe("routeNeedsInput helper", () => {
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

// S3e — skill/terminal origin PARITY: a skill-origin card gets the same durable
// lifecycle log a web thread does, PULLABLE via the board's /origins endpoints.
// The advance that used to produce the middle event came from the engine; the
// created + finished edges are the two the live code still emits, and the pull
// surface is unchanged.
describe("S3e — skill-origin parity + /origins endpoints (booted board)", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    await saveBoard(seedBoard(), KANBAN_DIR);
    server = http.createServer(makeRequestHandler({ root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 }, join(FITTING, "dist")));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("a skill-origin card carried to done yields created + finished, pollable via GET /origins/:id/events", async () => {
    // 1. POST /cards with an explicit skill origin_id → the `created` event.
    const created = await fetch(`${base}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "parity run", project: "p", origin: "garrison-doorway", origin_id: "skill:parity-test" })
    });
    const { card } = (await created.json()) as any;
    expect(card.id).toBeTruthy();
    expect(card.origin_id).toBe("skill:parity-test");

    // 2. carry it to done through the live write path → the `finished` event.
    await updateCardCAS(KANBAN_DIR, card.id, (c: any) => ({ ...c, list: "done", status: "ok" }));
    expect((await loadCard(KANBAN_DIR, card.id)).list).toBe("done");

    // 3. the durable log carries the same lifecycle kinds a web thread gets.
    const kinds = readOriginEvents(KANBAN_DIR, "skill:parity-test").filter((e: any) => e.cardId === card.id).map((e: any) => e.kind);
    expect(kinds).toContain("created");
    expect(kinds).toContain("finished");

    // 4. the on-disk events file exists (the pull-delivery record).
    expect(existsSync(originEventsFile(KANBAN_DIR, "skill:parity-test"))).toBe(true);

    // 5. readable via GET /origins/:id/events (the PULL delivery a skill polls).
    const polled = await fetch(`${base}/origins/${encodeURIComponent("skill:parity-test")}/events`);
    expect(polled.status).toBe(200);
    const doc = (await polled.json()) as any;
    expect(doc.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["created", "finished"]));
    expect(doc.nextSince).toBe(String(doc.total));

    // 6. GET /origins/:id returns the record with the skill transport.
    const rec = await fetch(`${base}/origins/${encodeURIComponent("skill:parity-test")}`);
    expect(rec.status).toBe(200);
    expect((await rec.json()).origin).toMatchObject({ transport: "skill", address: "parity-test" });

    // 7. since=<total> (line offset) returns only newer events (none) — incremental poll.
    const since = await fetch(`${base}/origins/${encodeURIComponent("skill:parity-test")}/events?since=${doc.total}`);
    expect(((await since.json()) as any).events).toHaveLength(0);
    // and readOriginEventsSince honours a line offset directly.
    expect(readOriginEventsSince(KANBAN_DIR, "skill:parity-test", doc.total).events).toHaveLength(0);
  });

  it("GET /origins/:id 404s for an unknown origin", async () => {
    const r = await fetch(`${base}/origins/${encodeURIComponent("skill:nope")}`);
    expect(r.status).toBe(404);
  });
});
