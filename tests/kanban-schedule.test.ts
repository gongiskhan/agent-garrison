// Card scheduling: the hold predicate, the engine guard, the tick due-sweep
// (notify + auto-run modes), the checklist/position normalisers, the
// attachment artifact ref, and the outpost claimability hold.
//
// GARRISON_HOME is pinned to a throwaway dir BEFORE any import: the reminder
// path resolves channel fittings from $GARRISON_HOME/ui-fittings, and a test
// run on the prod box must never discover the LIVE omi/web channels and push
// a real notification (the fitting-env lesson: tests once deleted a live
// status file the same way).

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GARRISON_HOME = mkdtempSync(join(tmpdir(), "garrison-home-sched-"));
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
process.env.GARRISON_RUNS_DIR = mkdtempSync(join(tmpdir(), "runs-home-sched-"));

// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, scheduleHolds, normaliseChecklist, cardPosition, normaliseScheduleAction } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { processCard, sweepDueSchedules } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { resolveArtifactRef } from "../fittings/seed/kanban-loop/lib/links.mjs";
import { claimability, type ClaimableCard } from "../src/lib/dispatch";

const board = seedBoard();
const tmp = () => mkdtempSync(join(tmpdir(), "kanban-sched-"));
const future = () => new Date(Date.now() + 3600_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

const forbiddenRunFn = async () => {
  throw new Error("RUN ATTEMPTED for a schedule-held card");
};

describe("scheduleHolds", () => {
  it("does not hold without a schedule or with a past one", () => {
    expect(scheduleHolds({ scheduledFor: null })).toBe(false);
    expect(scheduleHolds({})).toBe(false);
    expect(scheduleHolds({ scheduledFor: past() })).toBe(false);
  });
  it("holds a future schedule", () => {
    expect(scheduleHolds({ scheduledFor: future() })).toBe(true);
  });
  it("holds an unparseable schedule (fail closed - never runs early)", () => {
    expect(scheduleHolds({ scheduledFor: "next tuesday-ish" })).toBe(true);
  });
});

describe("engine schedule guard", () => {
  it("skips a schedule-held card on an immediate agent list", async () => {
    const root = tmp();
    const card = await createCard(root, {
      title: "later",
      list: "implement",
      scheduledFor: future()
    });
    const { outcome } = await processCard({ root, board, card, runFn: forbiddenRunFn });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("scheduled");
  });
});

describe("createCard schedule fields", () => {
  it("defaults scheduleAction to notify only when scheduled", async () => {
    const root = tmp();
    const a = await createCard(root, { title: "a", list: "backlog", scheduledFor: future() });
    expect(a.scheduleAction).toBe("notify");
    const b = await createCard(root, { title: "b", list: "backlog" });
    expect(b.scheduledFor).toBeNull();
    expect(b.scheduleAction).toBeNull();
  });
  it("normaliseScheduleAction only admits the two actions", () => {
    expect(normaliseScheduleAction("run")).toBe("run");
    expect(normaliseScheduleAction("notify")).toBe("notify");
    expect(normaliseScheduleAction("explode")).toBe("notify");
  });
});

describe("sweepDueSchedules", () => {
  it("leaves future and unparseable schedules alone", async () => {
    const root = tmp();
    const held = await createCard(root, { title: "future", list: "todo", scheduledFor: future() });
    const broken = await createCard(root, { title: "typo", list: "todo", scheduledFor: "not-a-time" });
    const swept = await sweepDueSchedules(root, board);
    expect(swept).toEqual([]);
    expect((await loadCard(root, held.id)).scheduleNotifiedAt).toBeNull();
    expect((await loadCard(root, broken.id)).scheduledFor).toBe("not-a-time");
  });

  it("notify mode stamps the reminder exactly once and keeps the card in place", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "remind me", list: "todo", scheduledFor: past() });
    const swept = await sweepDueSchedules(root, board);
    expect(swept).toEqual([{ id: card.id, action: "notify" }]);
    const after = await loadCard(root, card.id);
    expect(after.list).toBe("todo");
    expect(after.scheduledFor).toBe(card.scheduledFor); // kept for display
    expect(after.scheduleNotifiedAt).toBeTruthy();
    // Second sweep: already notified, nothing to do.
    expect(await sweepDueSchedules(root, board)).toEqual([]);
  });

  it("run mode advances a manual-list card into its sequence head", async () => {
    const root = tmp();
    const card = await createCard(root, {
      title: "run me",
      list: "todo",
      scheduledFor: past(),
      scheduleAction: "run",
      sequence: ["implement", "review"]
    });
    const swept = await sweepDueSchedules(root, board);
    expect(swept).toEqual([{ id: card.id, action: "run" }]);
    const after = await loadCard(root, card.id);
    expect(after.list).toBe("implement");
    expect(after.scheduledFor).toBeNull();
    expect(after.scheduleNotifiedAt).toBeNull();
  });

  it("run mode without a sequence targets the first non-interactive agent exit", async () => {
    const root = tmp();
    // todo's validNext is [discuss, plan]; discuss is agent-interactive, so the
    // auto-run must land on plan.
    const card = await createCard(root, { title: "auto", list: "todo", scheduledFor: past(), scheduleAction: "run" });
    await sweepDueSchedules(root, board);
    expect((await loadCard(root, card.id)).list).toBe("plan");
  });

  it("run mode on an agent list just releases the hold in place", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "held run", list: "implement", scheduledFor: past(), scheduleAction: "run" });
    const swept = await sweepDueSchedules(root, board);
    expect(swept).toEqual([{ id: card.id, action: "run" }]);
    const after = await loadCard(root, card.id);
    expect(after.list).toBe("implement");
    expect(after.scheduledFor).toBeNull();
  });

  it("never touches a running card", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "busy", list: "implement", scheduledFor: past(), scheduleAction: "run" });
    const disk = await loadCard(root, card.id);
    disk.status = "running";
    const { saveCard } = await import("../fittings/seed/kanban-loop/lib/board.mjs" as string);
    await saveCard(root, disk);
    expect(await sweepDueSchedules(root, board)).toEqual([]);
  });
});

describe("checklist + position normalisers", () => {
  it("normaliseChecklist keeps well-formed items and drops junk", () => {
    const items = normaliseChecklist([
      { text: "  buy milk  ", done: false },
      { id: "abc", text: "call bank", done: true },
      { text: "" },
      "not-an-object",
      { done: true }
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("buy milk");
    expect(items[0].done).toBe(false);
    expect(items[0].id).toMatch(/^[0-9A-Za-z_-]+$/);
    expect(items[1].id).toBe("abc");
    expect(items[1].doneAt).toBeTruthy();
  });
  it("non-arrays normalise to null (no checklist)", () => {
    expect(normaliseChecklist(null)).toBeNull();
    expect(normaliseChecklist("x")).toBeNull();
  });
  it("cardPosition prefers the explicit position and falls back to created", () => {
    expect(cardPosition({ position: 42, created: "2026-01-01T00:00:00Z" })).toBe(42);
    expect(cardPosition({ created: "2026-01-01T00:00:00.000Z" })).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });
});

describe("attachment artifact ref", () => {
  it("maps attachment:<name> into the card's attachments dir", () => {
    const root = "/tmp/kb";
    const card = { id: "01HXXXXXXXXXXXXXXXXXXXXXXX" };
    const p = resolveArtifactRef(card, "attachment:notes.pdf", { root, cwd: "/tmp" });
    expect(p).toBe(join(root, "cards", card.id, "attachments", "notes.pdf"));
  });
  it("refuses traversal-shaped names", () => {
    const card = { id: "01HXXXXXXXXXXXXXXXXXXXXXXX" };
    expect(resolveArtifactRef(card, "attachment:../card.json", { root: "/tmp/kb", cwd: "/tmp" })).toBeNull();
    expect(resolveArtifactRef(card, "attachment:.hidden", { root: "/tmp/kb", cwd: "/tmp" })).toBeNull();
  });
});

describe("claimability schedule hold (outpost path)", () => {
  const base: ClaimableCard = {
    id: "01HXXXXXXXXXXXXXXXXXXXXXXX",
    title: "t",
    list: "implement",
    project: null,
    rev: 0,
    placement: { target: "mac-mini" },
    dispatch: null,
    command: null,
    description: null,
    acceptance: null,
    duty: null,
    goalMode: false
  };
  it("holds a future scheduledFor and releases a past one", () => {
    const now = Date.now();
    expect(claimability({ ...base, scheduledFor: new Date(now + 60_000).toISOString() }, "mac-mini", now).claimable).toBe(false);
    expect(claimability({ ...base, scheduledFor: new Date(now - 60_000).toISOString() }, "mac-mini", now).claimable).toBe(true);
  });
  it("holds an unparseable scheduledFor (fail closed)", () => {
    const verdict = claimability({ ...base, scheduledFor: "someday" }, "mac-mini", Date.now());
    expect(verdict.claimable).toBe(false);
    expect(verdict.reason).toMatch(/unparseable/);
  });
});
