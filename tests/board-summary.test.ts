// The dashboard Board panel's summary lib (src/lib/board-summary.ts): pure
// classification over card.json shapes plus the disk-reading readBoardSummary.
// Hermetic: GARRISON_KANBAN_DIR points at a tmp board and GARRISON_HOME at a
// tmp home so neither the real board nor the real ui-fittings dir is touched.
// Both env vars are read at call time by the lib, so setting them per-case
// (not before import) is the contract under test for case 8.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kanbanBoardDir, readBoardSummary, summarizeBoardCards } from "../src/lib/board-summary";

const ORIGINAL_KANBAN_DIR = process.env.GARRISON_KANBAN_DIR;
const ORIGINAL_HOME = process.env.GARRISON_HOME;

function makeBoard(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-summary-"));
  mkdirSync(join(dir, "cards"), { recursive: true });
  return dir;
}

function writeCard(boardDir: string, id: string, card: unknown): void {
  const dir = join(boardDir, "cards", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "card.json"), typeof card === "string" ? card : JSON.stringify(card));
}

beforeEach(() => {
  process.env.GARRISON_HOME = mkdtempSync(join(tmpdir(), "board-summary-home-"));
});

afterAll(() => {
  if (ORIGINAL_KANBAN_DIR === undefined) delete process.env.GARRISON_KANBAN_DIR;
  else process.env.GARRISON_KANBAN_DIR = ORIGINAL_KANBAN_DIR;
  if (ORIGINAL_HOME === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = ORIGINAL_HOME;
});

describe("kanbanBoardDir", () => {
  it("honors GARRISON_KANBAN_DIR, falling back to <garrison home>/kanban-loop", () => {
    process.env.GARRISON_KANBAN_DIR = "/tmp/some-board";
    expect(kanbanBoardDir()).toBe("/tmp/some-board");
    delete process.env.GARRISON_KANBAN_DIR;
    expect(kanbanBoardDir()).toBe(join(process.env.GARRISON_HOME!, "kanban-loop"));
  });
});

describe("summarizeBoardCards", () => {
  it("classifies a mixed board: pipeline lists run, terminals count, entry lists wait", () => {
    const summary = summarizeBoardCards([
      { id: "a", title: "Planning card", list: "plan", updated: "2026-07-14T10:00:00Z" },
      { id: "b", title: "Implementing card", list: "implement", updated: "2026-07-14T11:00:00Z" },
      { id: "c", title: "Parked card", list: "needs-attention", attentionReason: "no valid verdict", updated: "2026-07-14T12:00:00Z" },
      { id: "d", title: "Done card", list: "done", updated: "2026-07-13T09:00:00Z" },
      { id: "e", title: "Another done", list: "done", updated: "2026-07-13T10:00:00Z" },
      { id: "f", title: "Waiting card", list: "backlog", updated: "2026-07-14T08:00:00Z" }
    ]);
    expect(summary.running).toBe(2);
    expect(summary.needsAttention).toBe(1);
    expect(summary.done).toBe(2);
    expect(summary.idle).toBe(false);
    expect(summary.needsAttentionCards).toEqual([
      { id: "c", title: "Parked card", reason: "no valid verdict" }
    ]);
  });

  it("treats an absent attentionReason key as a valid card with a null reason", () => {
    // 7 of 13 live cards predate the field entirely; absence is not malformed.
    const summary = summarizeBoardCards([
      { id: "old", title: "Pre-field card", list: "needs-attention", updated: "2026-07-14T12:00:00Z" }
    ]);
    expect(summary.needsAttention).toBe(1);
    expect(summary.needsAttentionCards).toEqual([{ id: "old", title: "Pre-field card", reason: null }]);
  });

  it("returns every needs-attention card, most recently updated first", () => {
    const summary = summarizeBoardCards([
      { id: "older", title: "Older", list: "needs-attention", updated: "2026-07-12T10:00:00Z" },
      { id: "newest", title: "Newest", list: "needs-attention", updated: "2026-07-14T10:00:00Z" },
      { id: "middle", title: "Middle", list: "needs-attention", updated: "2026-07-13T10:00:00Z" }
    ]);
    expect(summary.needsAttentionCards.map((c) => c.id)).toEqual(["newest", "middle", "older"]);
  });

  it("is idle when only entry-list and done cards exist", () => {
    const summary = summarizeBoardCards([
      { id: "a", title: "Backlog card", list: "backlog" },
      { id: "b", title: "Todo card", list: "todo" },
      { id: "c", title: "Done card", list: "done" }
    ]);
    expect(summary.running).toBe(0);
    expect(summary.needsAttention).toBe(0);
    expect(summary.done).toBe(1);
    expect(summary.idle).toBe(true);
  });

  it("counts an entry-list card with runningSince set as running (dispatch edge)", () => {
    const summary = summarizeBoardCards([
      { id: "a", title: "Inferring card", list: "todo", runningSince: "2026-07-14T10:00:00Z" }
    ]);
    expect(summary.running).toBe(1);
    expect(summary.idle).toBe(false);
  });

  it("skips cards missing required fields without throwing", () => {
    const summary = summarizeBoardCards([
      { id: "a", list: "plan" }, // no title
      { title: "No id", list: "implement" },
      null,
      "not an object",
      { id: "ok", title: "Valid card", list: "review" }
    ]);
    expect(summary.running).toBe(1);
  });
});

describe("readBoardSummary", () => {
  it("reads cards off disk, skipping malformed card.json files", async () => {
    const board = makeBoard();
    process.env.GARRISON_KANBAN_DIR = board;
    writeCard(board, "01A", { id: "01A", title: "Running card", list: "implement", updated: "2026-07-14T10:00:00Z" });
    writeCard(board, "01B", { id: "01B", title: "Parked card", list: "needs-attention", attentionReason: "stuck", updated: "2026-07-14T11:00:00Z" });
    writeCard(board, "01C", "{ not json at all");
    writeCard(board, "01D", { id: "01D", title: "Done card", list: "done" });

    const summary = await readBoardSummary();
    expect(summary.running).toBe(1);
    expect(summary.needsAttention).toBe(1);
    expect(summary.done).toBe(1);
    expect(summary.idle).toBe(false);
    expect(summary.needsAttentionCards).toEqual([{ id: "01B", title: "Parked card", reason: "stuck" }]);
  });

  it("returns zeros and idle when the cards dir does not exist", async () => {
    process.env.GARRISON_KANBAN_DIR = join(mkdtempSync(join(tmpdir(), "board-summary-")), "nowhere");
    const summary = await readBoardSummary();
    expect(summary).toEqual({
      running: 0,
      needsAttention: 0,
      done: 0,
      needsAttentionCards: [],
      boardUrl: null,
      idle: true
    });
  });

  it("resolves boardUrl from the kanban-loop ui-fittings status file when present", async () => {
    const board = makeBoard();
    process.env.GARRISON_KANBAN_DIR = board;

    expect((await readBoardSummary()).boardUrl).toBeNull();

    const fittingsDir = join(process.env.GARRISON_HOME!, "ui-fittings");
    mkdirSync(fittingsDir, { recursive: true });
    writeFileSync(
      join(fittingsDir, "kanban-loop.json"),
      JSON.stringify({ fittingId: "kanban-loop", port: 7089, url: "http://127.0.0.1:7089", route: "/board" })
    );
    expect((await readBoardSummary()).boardUrl).toBe("http://127.0.0.1:7089/board");
  });

  it("honors a GARRISON_KANBAN_DIR repoint to a different board", async () => {
    const first = makeBoard();
    process.env.GARRISON_KANBAN_DIR = first;
    writeCard(first, "01A", { id: "01A", title: "First board card", list: "plan" });
    expect((await readBoardSummary()).running).toBe(1);

    const second = makeBoard();
    process.env.GARRISON_KANBAN_DIR = second;
    writeCard(second, "01B", { id: "01B", title: "Second board card", list: "done" });
    const summary = await readBoardSummary();
    expect(summary.running).toBe(0);
    expect(summary.done).toBe(1);
    expect(summary.idle).toBe(true);
  });
});
