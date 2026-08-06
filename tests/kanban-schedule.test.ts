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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GARRISON_HOME = mkdtempSync(join(tmpdir(), "garrison-home-sched-"));
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
process.env.GARRISON_RUNS_DIR = mkdtempSync(join(tmpdir(), "runs-home-sched-"));

// @ts-ignore — pure .mjs
import { ensureMorningBriefTemplate, seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, loadAllCards, migrateBoard, scheduleHolds, normaliseChecklist, cardPosition, normaliseScheduleAction, updateCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { processCard, runScheduleNow, sweepDueSchedules } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { nextCronOccurrence, latestCronOccurrence, scheduleValidationError } from "../fittings/seed/kanban-loop/lib/schedules.mjs";
// @ts-ignore — pure .mjs
import { parseCron as parseSchedulerCron, cronMatches as schedulerCronMatches } from "../fittings/seed/scheduler/scripts/scheduler.mjs";
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

describe("board v5 Scheduled migration", () => {
  it("adds one fixed system column at the far left and is idempotent", () => {
    const old = { version: 4, lists: [{ id: "backlog", title: "Backlog", order: 0, kind: "manual" }] };
    const migrated = migrateBoard(old as any);
    expect(migrated.version).toBe(5);
    expect(migrated.lists[0]).toMatchObject({
      id: "scheduled", order: -1, userOrder: -1, kind: "scheduled", system: true
    });
    expect(migrateBoard(migrated)).toBe(migrated);
    expect(migrated.lists.filter((list: any) => list.id === "scheduled")).toHaveLength(1);
  });
});

describe("timezone-aware cron schedules", () => {
  it("validates five-field cron and IANA timezone input", () => {
    expect(scheduleValidationError({
      kind: "cron", action: "run", cron: "0 8 * * 1-5", timezone: "Europe/Lisbon",
      enabled: true, targetList: "backlog"
    })).toBeNull();
    expect(scheduleValidationError({
      kind: "cron", action: "run", cron: "tomorrow", timezone: "Europe/Lisbon",
      enabled: true, targetList: "backlog"
    })).toMatch(/5 fields/);
    expect(scheduleValidationError({
      kind: "cron", action: "run", cron: "0 8 * * *", timezone: "Mars/Olympus",
      enabled: true, targetList: "backlog"
    })).toMatch(/IANA timezone/);
  });

  it("skips a nonexistent DST wall time", () => {
    // Europe/Lisbon jumps from 00:59Z / 00:59 local to 01:00Z / 02:00
    // local on 2026-03-29, so local 01:30 never exists that day.
    const skipped: any[] = [];
    const next = nextCronOccurrence("30 1 29 3 *", "Europe/Lisbon", "2026-03-28T00:00:00.000Z", {
      maxMinutes: 60 * 48,
      onSkip: (entry: any) => skipped.push(entry)
    });
    expect(next).toBeNull();
    expect(skipped).toEqual([{
      wallTime: "2026-03-29T01:30",
      timezone: "Europe/Lisbon",
      reason: "nonexistent-dst-wall-time"
    }]);
  });

  it("runs a repeated DST wall minute once", () => {
    const first = nextCronOccurrence("30 1 25 10 *", "Europe/Lisbon", "2026-10-24T00:00:00.000Z", {
      maxMinutes: 60 * 48
    });
    expect(first?.at).toBe("2026-10-25T00:30:00.000Z");
    const duplicateSuppressed = nextCronOccurrence("30 1 25 10 *", "Europe/Lisbon", first!.at, {
      excludeWallKey: first!.wallKey,
      maxMinutes: 120
    });
    expect(duplicateSuppressed).toBeNull();
  });

  it("suppresses the whole repeated DST interval for multi-minute cron rules", () => {
    const occurrences: string[] = [];
    let after = "2026-10-24T23:59:00.000Z";
    for (let index = 0; index < 5; index += 1) {
      const next = nextCronOccurrence("*/15 1 * * *", "Europe/Lisbon", after);
      expect(next).not.toBeNull();
      occurrences.push(next!.wallKey);
      after = next!.at;
    }
    expect(occurrences).toEqual([
      "2026-10-25T01:00",
      "2026-10-25T01:15",
      "2026-10-25T01:30",
      "2026-10-25T01:45",
      "2026-10-26T01:00"
    ]);
  });

  it("finds only the latest missed instant after downtime", () => {
    expect(latestCronOccurrence("0 * * * *", "UTC", "2026-08-05T12:41:00.000Z")?.at)
      .toBe("2026-08-05T12:00:00.000Z");
  });

  it("uses standard DOM-or-DOW semantics when both fields are restricted", () => {
    // Monday the 3rd matches DOW even though it is not the 5th. The scheduler
    // daemon uses the same rule, so migration preserves cadence.
    expect(nextCronOccurrence("0 8 5 * 1", "UTC", "2026-08-01T00:00:00.000Z", {
      maxMinutes: 60 * 24 * 10
    })?.at).toBe("2026-08-03T08:00:00.000Z");
    const daemonCron = parseSchedulerCron("0 8 5 * 1");
    expect(schedulerCronMatches(daemonCron, new Date(2026, 7, 3, 8, 0))).toBe(true);
    expect(schedulerCronMatches(daemonCron, new Date(2026, 7, 4, 8, 0))).toBe(false);
  });
});

describe("Morning briefing cutover", () => {
  it("seeds paused beside the legacy job, supports Run now, then enables after removal", async () => {
    const root = tmp();
    const jobs = join(root, "scheduler-jobs.json");
    process.env.GARRISON_SCHEDULER_JOBS = jobs;
    writeFileSync(jobs, JSON.stringify([{ id: "morning-briefing", cron: "15 9 * * 1-5", enabled: true }]));
    const first = await ensureMorningBriefTemplate(root, board, { now: "2026-08-05T07:00:00.000Z" });
    expect(first).toMatchObject({ created: true, cutoverPending: true });
    expect(first.card.schedule).toMatchObject({
      kind: "cron", cron: "15 9 * * 1-5", enabled: false, cutoverPending: true, desiredEnabled: true
    });
    const trial = await runScheduleNow(root, board, first.card.id, { now: () => "2026-08-05T07:05:00.000Z" });
    expect(trial.card.scheduleTemplateId).toBe(first.card.id);

    writeFileSync(jobs, "[]");
    const cutover = await ensureMorningBriefTemplate(root, board, { now: "2026-08-05T07:10:00.000Z" });
    expect(cutover.cutover).toBe(true);
    expect(cutover.card.schedule).toMatchObject({ enabled: true, cron: "15 9 * * 1-5" });
    expect(cutover.card.schedule.cutoverPending).toBeUndefined();
    expect(Date.parse(cutover.card.schedule.nextAt)).toBeGreaterThan(Date.parse("2026-08-05T07:10:00.000Z"));
    delete process.env.GARRISON_SCHEDULER_JOBS;
  });

  it("preserves a disabled legacy job as a paused template after cutover", async () => {
    const root = tmp();
    const jobs = join(root, "scheduler-jobs.json");
    process.env.GARRISON_SCHEDULER_JOBS = jobs;
    writeFileSync(jobs, JSON.stringify([{ id: "morning-briefing", cron: "0 8 * * 1-5", enabled: false }]));
    const first = await ensureMorningBriefTemplate(root, board, { now: "2026-08-05T07:00:00.000Z" });
    expect(first.card.schedule).toMatchObject({ enabled: false, cutoverPending: true, desiredEnabled: false });
    writeFileSync(jobs, "[]");
    const cutover = await ensureMorningBriefTemplate(root, board, { now: "2026-08-05T07:10:00.000Z" });
    expect(cutover.card.schedule.enabled).toBe(false);
    delete process.env.GARRISON_SCHEDULER_JOBS;
  });

  it("does not activate after legacy deletion without a durable Run-now verification", async () => {
    const root = tmp();
    const jobs = join(root, "scheduler-jobs.json");
    process.env.GARRISON_SCHEDULER_JOBS = jobs;
    writeFileSync(jobs, JSON.stringify([{ id: "morning-briefing", cron: "0 8 * * 1-5", enabled: true }]));
    const seeded = await ensureMorningBriefTemplate(root, board, { now: "2026-08-05T07:00:00.000Z" });
    expect(seeded.card.schedule).toMatchObject({ enabled: false, cutoverPending: true });

    writeFileSync(jobs, "[]");
    const blocked = await ensureMorningBriefTemplate(root, board, { now: "2026-08-05T07:10:00.000Z" });
    expect(blocked).toMatchObject({ cutoverBlocked: true, cutoverPending: true });
    expect(blocked.error).toMatch(/Run now/);
    expect((await loadCard(root, seeded.card.id)).schedule).toMatchObject({ enabled: false, cutoverPending: true });
    delete process.env.GARRISON_SCHEDULER_JOBS;
  });

  it("never treats an unreadable legacy scheduler registry as a completed cutover", async () => {
    const dir = tmp();
    const testBoard = seedBoard();
    const jobs = join(dir, "scheduler-jobs.json");
    writeFileSync(jobs, "{not-json");
    process.env.GARRISON_SCHEDULER_JOBS = jobs;

    await expect(ensureMorningBriefTemplate(dir, testBoard, {
      now: "2026-08-05T07:00:00.000Z"
    })).rejects.toThrow(/Cannot safely seed Morning briefing/);

    writeFileSync(jobs, JSON.stringify([{ id: "morning-briefing", cron: "0 8 * * 1-5", enabled: true }]));
    const seeded = await ensureMorningBriefTemplate(dir, testBoard, { now: "2026-08-05T07:01:00.000Z" });
    expect(seeded.card.schedule).toMatchObject({ enabled: false, cutoverPending: true });

    writeFileSync(jobs, "{still-not-json");
    const blocked = await ensureMorningBriefTemplate(dir, testBoard, { now: "2026-08-05T07:02:00.000Z" });
    expect(blocked).toMatchObject({ cutoverPending: true, cutoverBlocked: true });
    expect(blocked.card.schedule).toMatchObject({ enabled: false, cutoverPending: true });
    delete process.env.GARRISON_SCHEDULER_JOBS;
  });
});

describe("sweepDueSchedules", () => {
  it("leaves future schedules alone and drops malformed legacy input at construction", async () => {
    const root = tmp();
    const held = await createCard(root, { title: "future", list: "todo", scheduledFor: future() });
    const broken = await createCard(root, { title: "typo", list: "todo", scheduledFor: "not-a-time" });
    const swept = await sweepDueSchedules(root, board);
    expect(swept).toEqual([]);
    expect((await loadCard(root, held.id)).scheduleNotifiedAt).toBeNull();
    expect((await loadCard(root, broken.id)).scheduledFor).toBeNull();
  });

  it("one-time notify moves to its target, sends once, and completes the schedule", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "remind me", list: "todo", scheduledFor: past() });
    const deliveries: string[] = [];
    const swept = await sweepDueSchedules(root, board, {
      deliverReminder: async (_root: string, _card: any, options: any) => {
        deliveries.push(options.idempotencyKey);
        return { ok: true, receipts: [{ channel: "fixture", ok: true }] };
      }
    });
    expect(swept).toEqual([{ id: card.id, action: "notify" }]);
    const after = await loadCard(root, card.id);
    expect(after.list).toBe("todo");
    expect(after.scheduledFor).toBeNull();
    expect(after.schedule).toMatchObject({ kind: "once", enabled: false, nextAt: null });
    expect(after.scheduleNotifiedAt).toBeTruthy();
    expect(after.scheduleDelivery).toMatchObject({ status: "delivered", attempts: 1 });
    expect(deliveries).toHaveLength(1);
    // Second sweep: already notified, nothing to do.
    expect(await sweepDueSchedules(root, board)).toEqual([]);
  });

  it("retries a one-shot reminder from its durable outbox with one stable key", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "retry reminder", list: "todo", scheduledFor: past() });
    const keys: string[] = [];
    let available = false;
    const deliverReminder = async (_root: string, _card: any, options: any) => {
      keys.push(options.idempotencyKey);
      return available
        ? { ok: true, receipts: [{ channel: "fixture", ok: true }] }
        : { ok: false, error: "fixture unavailable", receipts: [] };
    };
    await sweepDueSchedules(root, board, { deliverReminder });
    let stored = await loadCard(root, card.id);
    expect(stored.scheduleDelivery).toMatchObject({ status: "pending", attempts: 1, lastError: "fixture unavailable" });
    expect(stored.scheduleNotifiedAt).toBeNull();

    available = true;
    expect(await sweepDueSchedules(root, board, { deliverReminder })).toEqual([]);
    stored = await loadCard(root, card.id);
    expect(stored.scheduleDelivery).toMatchObject({ status: "delivered", attempts: 2 });
    expect(stored.scheduleNotifiedAt).toBeTruthy();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
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

  it("creates one recurring occurrence under concurrent ticks", async () => {
    const root = tmp();
    const due = "2026-08-05T08:00:00.000Z";
    const template = await createCard(root, {
      title: "daily", list: "scheduled",
      schedule: {
        kind: "cron", action: "run", cron: "0 8 * * *", timezone: "UTC",
        enabled: true, targetList: "todo", nextAt: due
      },
      sequence: ["implement"]
    });
    const clock = { now: () => "2026-08-05T08:00:05.000Z", at: () => Date.parse("2026-08-05T08:00:05.000Z") };
    const results = await Promise.all([
      sweepDueSchedules(root, board, clock),
      sweepDueSchedules(root, board, clock)
    ]);
    expect(results.flat()).toHaveLength(1);
    const all = await loadAllCards(root);
    const occurrences = all.filter((card: any) => card.scheduleTemplateId === template.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ list: "implement", occurrenceAt: due });
    const after = await loadCard(root, template.id);
    expect(after.schedule.lastAt).toBe(due);
    expect(after.schedule.nextAt).toBe("2026-08-06T08:00:00.000Z");
  });

  it("does not materialise when the recurring intent loses to a pause", async () => {
    const root = tmp();
    const due = "2026-08-05T08:00:00.000Z";
    const template = await createCard(root, {
      title: "pause race", list: "scheduled",
      schedule: {
        kind: "cron", action: "run", cron: "0 8 * * *", timezone: "UTC",
        enabled: true, targetList: "todo", nextAt: due
      },
      sequence: ["implement"]
    });
    const swept = await sweepDueSchedules(root, board, {
      now: () => "2026-08-05T08:00:05.000Z",
      at: () => Date.parse("2026-08-05T08:00:05.000Z"),
      afterScheduleIntent: async () => {
        await updateCardCAS(root, template.id, (current: any) => ({
          ...current,
          schedule: { ...current.schedule, enabled: false, pending: null }
        }));
      }
    });
    expect(swept).toEqual([]);
    expect((await loadAllCards(root)).filter((card: any) => card.scheduleTemplateId === template.id)).toHaveLength(0);
    expect((await loadCard(root, template.id)).schedule.enabled).toBe(false);
  });

  it("retries a recurring reminder occurrence after a delivery crash", async () => {
    const root = tmp();
    const due = "2026-08-05T08:00:00.000Z";
    const template = await createCard(root, {
      title: "daily reminder", list: "scheduled",
      schedule: {
        kind: "cron", action: "notify", cron: "0 8 * * *", timezone: "UTC",
        enabled: true, targetList: "backlog", nextAt: due
      }
    });
    const keys: string[] = [];
    let available = false;
    const deliverReminder = async (_root: string, _card: any, options: any) => {
      keys.push(options.idempotencyKey);
      return available ? { ok: true, receipts: [] } : { ok: false, error: "crashed", receipts: [] };
    };
    const clock = { now: () => "2026-08-05T08:00:05.000Z", at: () => Date.parse("2026-08-05T08:00:05.000Z"), deliverReminder };
    await sweepDueSchedules(root, board, clock);
    const occurrence = (await loadAllCards(root)).find((row: any) => row.scheduleTemplateId === template.id);
    expect(occurrence.scheduleDelivery).toMatchObject({ status: "pending", attempts: 1 });
    available = true;
    await sweepDueSchedules(root, board, clock);
    expect((await loadCard(root, occurrence.id)).scheduleDelivery).toMatchObject({ status: "delivered", attempts: 2 });
    expect(new Set(keys).size).toBe(1);
  });

  it("coalesces downtime into the most recent missed occurrence", async () => {
    const root = tmp();
    const template = await createCard(root, {
      title: "hourly", list: "scheduled",
      schedule: {
        kind: "cron", action: "notify", cron: "0 * * * *", timezone: "UTC",
        enabled: true, targetList: "backlog", nextAt: "2026-08-05T05:00:00.000Z"
      }
    });
    await sweepDueSchedules(root, board, {
      now: () => "2026-08-05T12:41:00.000Z",
      at: () => Date.parse("2026-08-05T12:41:00.000Z")
    });
    const occurrences = (await loadAllCards(root)).filter((card: any) => card.scheduleTemplateId === template.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].occurrenceAt).toBe("2026-08-05T12:00:00.000Z");
    expect((await loadCard(root, template.id)).schedule.nextAt).toBe("2026-08-05T13:00:00.000Z");
  });

  it("records a skipped DST wall time on the recurring template", async () => {
    const root = tmp();
    const template = await createCard(root, {
      title: "Lisbon 01:30", list: "scheduled",
      schedule: {
        kind: "cron", action: "run", cron: "30 1 * * *", timezone: "Europe/Lisbon",
        enabled: true, targetList: "todo", nextAt: "2026-03-28T01:30:00.000Z"
      },
      sequence: ["implement"]
    });
    await sweepDueSchedules(root, board, {
      now: () => "2026-03-28T01:30:05.000Z",
      at: () => Date.parse("2026-03-28T01:30:05.000Z")
    });
    const stored = await loadCard(root, template.id);
    expect(stored.schedule.skippedWallTimes).toContainEqual(expect.objectContaining({
      wallTime: "2026-03-29T01:30",
      timezone: "Europe/Lisbon",
      reason: "nonexistent-dst-wall-time"
    }));
    expect(stored.events).toContainEqual(expect.objectContaining({ kind: "schedule-dst-skip" }));
  });

  it("leaves paused recurring templates untouched", async () => {
    const root = tmp();
    const template = await createCard(root, {
      title: "paused", list: "scheduled",
      schedule: {
        kind: "cron", action: "run", cron: "0 8 * * *", timezone: "UTC",
        enabled: false, targetList: "todo", nextAt: "2026-08-05T08:00:00.000Z"
      }
    });
    expect(await sweepDueSchedules(root, board, {
      now: () => "2026-08-06T08:00:00.000Z", at: () => Date.parse("2026-08-06T08:00:00.000Z")
    })).toEqual([]);
    expect((await loadCard(root, template.id)).schedule.lastAt).toBeNull();
  });

  it("Run now creates an extra occurrence without advancing the regular clock", async () => {
    const root = tmp();
    const template = await createCard(root, {
      title: "weekdays", list: "scheduled",
      schedule: {
        kind: "cron", action: "notify", cron: "0 8 * * 1-5", timezone: "Europe/Lisbon",
        enabled: true, targetList: "todo", nextAt: "2026-08-06T07:00:00.000Z"
      },
      sequence: ["implement"]
    });
    const result = await runScheduleNow(root, board, template.id, { now: () => "2026-08-05T13:00:00.000Z" });
    expect(result.created).toBe(true);
    expect(result.card).toMatchObject({ scheduleTemplateId: template.id, list: "implement" });
    expect((await loadCard(root, template.id)).schedule.nextAt).toBe("2026-08-06T07:00:00.000Z");
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
    scope: "unscoped",
    rev: 0,
    placement: { target: "mac-mini" },
    dispatch: null,
    command: null,
    description: null,
    acceptance: null,
    duty: null,
    level: 2,
    sequence: null,
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
