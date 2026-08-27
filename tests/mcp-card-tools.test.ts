// The mcp-gateway card scheduling tools (schedule_card / run_card /
// list_scheduled_cards) against the REAL booted board server - the executable
// form of the Omi reminder phrases ("run card 7Q2M", "snooze card 7Q2M for 2
// hours"). Mirrors the sandbox + server-boot harness of
// tests/ws2-kanban-tools.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

const KANBAN_DIR = mkdtempSync(join(tmpdir(), "cardtools-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "cardtools-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "cardtools-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore — pure .mjs
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard, createCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import {
  kanbanAvailable,
  callScheduleCard,
  callRunCard,
  callListScheduledCards
} from "../fittings/seed/mcp-gateway/scripts/lib/tools.mjs";

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
let server: http.Server;
let base = "";
const kicks: { path: string; body: Record<string, unknown> }[] = [];

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as any).port;
}

beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(seedBoard(), KANBAN_DIR);
  // Stub gateway. Start is the CONVERSATION LAUNCHER now: /cards/:id/start
  // POSTs /conversation/kick (fresh card) or /conversation/message (resume) and
  // accepts only 202 (accepted) / 409 (already live) — a 200 is a refusal.
  gateway = http.createServer((req, res) => {
    if (req.method === "POST" && String(req.url).startsWith("/conversation/")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      return req.on("end", () => {
        kicks.push({ path: String(req.url), body: JSON.parse(body || "{}") });
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    }
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "" })}\n\n`);
      return res.end();
    }
    res.writeHead(200);
    res.end("ok");
  });
  const gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;
  const opts = { root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl, cap: 10 };
  server = http.createServer(makeRequestHandler(opts, join(FITTING, "dist")));
  base = `http://127.0.0.1:${await listen(server)}`;
  // The tools discover the board from ~/.garrison/ui-fittings/kanban-loop.json.
  mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
  writeFileSync(join(GARRISON_HOME, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: base }));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => gateway.close(() => r()));
});

async function getCard(id: string) {
  const r = await fetch(`${base}/cards/${id}`);
  return ((await r.json()) as any).card;
}

describe("list_scheduled_cards - empty board", () => {
  it("says 'no scheduled cards' when nothing holds a schedule", async () => {
    expect(kanbanAvailable()).toBe(true);
    const out = await callListScheduledCards();
    expect(out.count).toBe(0);
    expect(out.result).toBe("no scheduled cards");
  });
});

describe("schedule_card", () => {
  it("resolves a 4-char ULID suffix (the reminder short ref) and snoozes", async () => {
    const card = await createCard(KANBAN_DIR, { list: "todo", title: "Suffix snooze target", project: "garrison" });
    const before = Date.now();
    const out = await callScheduleCard({ card: card.id.slice(-4), in_minutes: 120 });
    expect(out.ambiguous).toBeUndefined();
    expect(out.card_id).toBe(card.id);
    // one-line result carries the resolved title + id + the instant
    expect(out.result).toContain("Suffix snooze target");
    expect(out.result).toContain(card.id);
    expect(out.result).toContain(out.scheduled_for);
    expect(out.action).toBe("notify");
    const due = Date.parse(out.scheduled_for);
    expect(due).toBeGreaterThan(before + 110 * 60000);
    expect(due).toBeLessThan(before + 130 * 60000);
    const onDisk = await getCard(card.id);
    expect(onDisk.scheduledFor).toBe(out.scheduled_for);
    expect(onDisk.scheduleAction).toBe("notify");
  });

  it("reports an ambiguous ref as candidates instead of guessing", async () => {
    const a = await createCard(KANBAN_DIR, { list: "todo", title: "Twin A sharedfrag", project: "garrison" });
    const b = await createCard(KANBAN_DIR, { list: "todo", title: "Twin B sharedfrag", project: "garrison" });
    const out = await callScheduleCard({ card: "sharedfrag", in_minutes: 5 });
    expect(out.ambiguous).toBe(true);
    expect(out.candidates.length).toBe(2);
    expect(out.result).toContain(a.id);
    expect(out.result).toContain(b.id);
    expect(out.result).toContain("Twin A sharedfrag");
    // neither twin gained a schedule
    expect((await getCard(a.id)).scheduledFor).toBeNull();
    expect((await getCard(b.id)).scheduledFor).toBeNull();
  });

  it("rejects until + in_minutes together, and neither", async () => {
    const card = await createCard(KANBAN_DIR, { list: "todo", title: "Exactly one lane", project: "garrison" });
    await expect(callScheduleCard({ card: card.id })).rejects.toThrow(/exactly one/);
    await expect(
      callScheduleCard({ card: card.id, in_minutes: 5, until: new Date(Date.now() + 60000).toISOString() })
    ).rejects.toThrow(/exactly one/);
  });

  it("clear=true removes an until-based schedule (rev-carrying PATCH)", async () => {
    const card = await createCard(KANBAN_DIR, { list: "todo", title: "Clear me later", project: "garrison" });
    const until = new Date(Date.now() + 3 * 3600_000).toISOString();
    const set = await callScheduleCard({ card: card.id, until, action: "run" });
    expect(set.scheduled_for).toBe(until);
    expect(set.action).toBe("run");
    const out = await callScheduleCard({ card: card.id, clear: true });
    expect(out.cleared).toBe(true);
    expect(out.result).toContain("Clear me later");
    expect(out.result).toContain(card.id);
    const onDisk = await getCard(card.id);
    expect(onDisk.scheduledFor).toBeNull();
    expect(onDisk.scheduleAction).toBeNull();
  });
});

describe("run_card", () => {
  it("starts a To do card by kicking its conversation — no list advance", async () => {
    const card = await createCard(KANBAN_DIR, { list: "todo", title: "Run me now", project: "garrison" });
    kicks.length = 0;
    const out = await callRunCard({ card: card.id.slice(-4) });
    expect(out.card_id).toBe(card.id);
    // Conversations: Start does not walk the card down a pipeline — there is no
    // pipeline. It hands the card's work to the gateway launcher; the card stays
    // where it is until the launcher itself moves it.
    expect(out.advanced).toBeNull();
    expect(out.result).toContain("Run me now");
    expect(out.result).toContain("started");
    expect((await getCard(card.id)).list).toBe("todo");
    // The kick carries the card's identity and its work as the opening task.
    expect(kicks).toEqual([
      {
        path: "/conversation/kick",
        body: expect.objectContaining({ conversationId: card.id, cardId: card.id, task: "Run me now" })
      }
    ]);
  });

  it("a start clears the card's schedule itself", async () => {
    const card = await createCard(KANBAN_DIR, { list: "todo", title: "Scheduled then started", project: "garrison" });
    await callScheduleCard({ card: card.id, in_minutes: 60 });
    const out = await callRunCard({ card: card.id });
    expect(out.result).toContain("its schedule was cleared");
    const onDisk = await getCard(card.id);
    expect(onDisk.list).toBe("todo");
    expect(onDisk.scheduledFor).toBeNull();
  });

  it("reports an ambiguous ref as candidates instead of starting anything", async () => {
    const out = await callRunCard({ card: "sharedfrag" });
    expect(out.ambiguous).toBe(true);
    expect(out.candidates.length).toBe(2);
    // the twins never left To do
    for (const c of out.candidates) expect(c.list).toBe("todo");
  });
});

describe("list_scheduled_cards - filtering", () => {
  it("lists only cards holding a schedule, as short-ref rows", async () => {
    const scheduled = await createCard(KANBAN_DIR, { list: "todo", title: "Listed schedule", project: "garrison" });
    const unscheduled = await createCard(KANBAN_DIR, { list: "todo", title: "Never scheduled", project: "garrison" });
    await callScheduleCard({ card: scheduled.id, in_minutes: 30 });
    const out = await callListScheduledCards();
    // exactly the cards the board reports with an authoritative v5 schedule
    // (paused recurring templates intentionally have no scheduledFor alias).
    const all = ((await (await fetch(`${base}/cards`)).json()) as any).cards;
    const expected = all.filter((c: any) => c.schedule != null || c.scheduledFor != null);
    expect(out.count).toBe(expected.length);
    expect(out.count).toBeGreaterThanOrEqual(1);
    expect(out.result).toContain(scheduled.id.slice(-4));
    expect(out.result).toContain("Listed schedule");
    expect(out.result).toContain("notify");
    expect(out.result).not.toContain("Never scheduled");
    // no ROW is the unscheduled card's (raw substring would flake: a 4-char
    // suffix can coincide with digits inside an ISO timestamp)
    const rows = out.result.split("\n").slice(1);
    expect(rows.some((r: string) => r.startsWith(`${unscheduled.id.slice(-4)}  `))).toBe(false);
  });
});

describe("gateway wiring", () => {
  it("declarations + dispatch live inside the kanbanAvailable() block", () => {
    const src = readFileSync(resolve(HERE, "..", "fittings", "seed", "mcp-gateway", "scripts", "gateway.mjs"), "utf8");
    for (const tool of ["schedule_card", "run_card", "list_scheduled_cards"]) {
      expect(src).toContain(`name: "${tool}"`);
    }
    expect(src).toContain('if (name === "schedule_card") return callScheduleCard(input)');
    expect(src).toContain('if (name === "run_card") return callRunCard(input)');
    expect(src).toContain('if (name === "list_scheduled_cards") return callListScheduledCards(input)');
    // declared inside the kanbanAvailable() block (present only when the board is live)
    const kanbanBlock = src.slice(src.indexOf("if (kanbanAvailable())"), src.indexOf("record_improver_feedback"));
    for (const tool of ["schedule_card", "run_card", "list_scheduled_cards"]) {
      expect(kanbanBlock).toContain(`name: "${tool}"`);
    }
  });
});
