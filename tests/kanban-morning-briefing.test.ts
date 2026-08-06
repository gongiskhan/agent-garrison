import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore — pure .mjs
import { createCard, loadCard, updateCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import {
  MORNING_BRIEF_SYSTEM_KEY,
  MORNING_BRIEF_WEB_THREAD,
  calendarResultFromEvidence,
  calendarResultFromSummary,
  deliverMorningBriefCompletion,
  readMorningBriefConnectorEvidence,
  reconcileMorningBriefDeliveries
} from "../fittings/seed/kanban-loop/lib/morning-briefing.mjs";

function root() {
  return mkdtempSync(join(tmpdir(), "kanban-morning-"));
}

async function occurrence(dir: string, summary: string) {
  return createCard(dir, {
    title: "Morning briefing",
    list: "done",
    scheduleTemplateId: "01MORNINGTEMPLATE000000000",
    scheduleSystemKey: MORNING_BRIEF_SYSTEM_KEY,
    occurrenceKey: "01MORNINGTEMPLATE000000000:2026-08-05T08:00",
    occurrenceAt: "2026-08-05T07:00:00.000Z",
    at: "2026-08-05T07:00:00.000Z",
    description: "Calendar + board focus",
    origin: "scheduler",
    acceptance: null
  }).then((card: any) => updateCardCAS(dir, card.id, (current: any) => ({ ...current, lastReply: summary })));
}

const calendarEvidence = {
  calendar: {
    connector: "google",
    action: "calendar.list_events",
    ok: true,
    checkedAt: "2026-08-05T07:04:00.000Z",
    eventCount: 0
  }
};

function successfulChannels(calls: Array<{ url: string; body: any }>, logicalKeys?: Set<string>) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith("/messages") && body?.idempotencyKey) logicalKeys?.add(body.idempotencyKey);
    if (url.startsWith("http://omi/") && url.endsWith("/messages")) {
      return new Response(JSON.stringify({
        ok: true,
        deliveryReceipts: [{ means: "omi-push", ok: true, target: "omi uid 1234..." }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

function deliveryOptions(calls: Array<{ url: string; body: any }>, extras: Record<string, unknown> = {}) {
  return {
    summary: "Calendar: no events today. Active work: two cards. Focus: finish routing.",
    connectorEvidence: calendarEvidence,
    fetchImpl: successfulChannels(calls) as any,
    fittingUrlFn: (id: string) => id === "omi-channel" ? "http://omi" : "http://web",
    now: () => "2026-08-05T07:05:00.000Z",
    at: () => Date.parse("2026-08-05T07:05:00.000Z"),
    ...extras
  };
}

describe("Morning briefing delivery", () => {
  it("posts Web and Omi once, suppresses Omi's Web fallback, and records keyed receipts", async () => {
    const dir = root();
    const card = await occurrence(dir, "Calendar: no events today. Active work: two cards. Focus: finish routing.");
    const calls: Array<{ url: string; body: any }> = [];
    const options = deliveryOptions(calls);
    const first = await deliverMorningBriefCompletion(dir, card.id, options);
    expect(first).toMatchObject({
      calendar: { status: "reported", eventCount: 0 },
      web: { status: "delivered", threadId: MORNING_BRIEF_WEB_THREAD },
      omi: { status: "delivered" }
    });
    await deliverMorningBriefCompletion(dir, card.id, options);

    const webPosts = calls.filter((call) => call.url === `http://web/api/threads/${MORNING_BRIEF_WEB_THREAD}/messages`);
    const omiPosts = calls.filter((call) => call.url === "http://omi/api/threads/morning-briefing/messages");
    expect(webPosts).toHaveLength(1);
    expect(omiPosts).toHaveLength(1);
    expect(omiPosts[0].body.suppressWebFallback).toBe(true);
    expect(omiPosts[0].body.idempotencyKey).toMatch(/^morning:.*:omi$/);
    expect(webPosts[0].body.idempotencyKey).toMatch(/^morning:.*:web$/);
    const stored = await loadCard(dir, card.id);
    expect(stored.morningBriefDelivery).toMatchObject({
      completedAt: "2026-08-05T07:05:00.000Z",
      web: { status: "delivered", idempotencyKey: webPosts[0].body.idempotencyKey },
      omi: { status: "delivered", idempotencyKey: omiPosts[0].body.idempotencyKey },
      calendar: { status: "reported", eventCount: 0 }
    });
    expect(stored.events.filter((event: any) => event.kind === "morning-brief-delivery")).toHaveLength(1);
  });

  it("makes missing Calendar and Omi visible without failing or publishing fabricated Calendar prose", async () => {
    const dir = root();
    const card = await occurrence(dir, "Calendário: 4 eventos.\nActive cards: three. Recommended focus: the release.");
    const calls: Array<{ url: string; body: any }> = [];
    const result = await deliverMorningBriefCompletion(dir, card.id, {
      summary: "Calendário: 4 eventos.\nActive cards: three. Recommended focus: the release.",
      fittingUrlFn: (id: string) => id === "web-channel-default" ? "http://web" : null,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }) as any,
      now: () => "2026-08-05T07:06:00.000Z",
      at: () => Date.parse("2026-08-05T07:06:00.000Z")
    });
    expect(result).toMatchObject({ calendar: { status: "degraded" }, omi: { status: "degraded" }, web: { status: "delivered" } });
    const webPost = calls.find((call) => call.url.endsWith("/messages"));
    expect(webPost?.body.messages[0].text).toMatch(/Calendar: degraded/);
    expect(webPost?.body.messages[0].text).toMatch(/Omi: degraded/);
    expect(webPost?.body.messages[0].text).not.toContain("4 eventos");
    expect(calls.some((call) => call.url.startsWith("http://omi"))).toBe(false);
  });

  for (const crashChannel of ["omi", "web"] as const) {
    it(`replays safely after a crash immediately after the ${crashChannel} append`, async () => {
      const dir = root();
      const card = await occurrence(dir, "Active work: two cards. Focus: finish routing.");
      const calls: Array<{ url: string; body: any }> = [];
      const logicalKeys = new Set<string>();
      let crashed = false;
      const options = deliveryOptions(calls, {
        fetchImpl: successfulChannels(calls, logicalKeys) as any,
        claimStaleMs: 0,
        afterChannelDelivered: ({ channel }: { channel: string }) => {
          if (!crashed && channel === crashChannel) {
            crashed = true;
            throw new Error(`simulated crash after ${channel}`);
          }
        }
      });
      await expect(deliverMorningBriefCompletion(dir, card.id, options)).rejects.toThrow(`simulated crash after ${crashChannel}`);
      const recovered = await deliverMorningBriefCompletion(dir, card.id, options);
      expect(recovered.card.morningBriefDelivery.completedAt).toBeTruthy();

      const messageAttempts = calls.filter((call) => call.url.endsWith("/messages"));
      const crashAttempts = messageAttempts.filter((call) => call.body.idempotencyKey.endsWith(`:${crashChannel}`));
      expect(crashAttempts).toHaveLength(2);
      expect(new Set(crashAttempts.map((call) => call.body.idempotencyKey)).size).toBe(1);
      // The destination contract de-duplicates the repeated append key, so only
      // the two logical channel messages exist despite the retried HTTP call.
      expect(logicalKeys.size).toBe(2);
    });
  }

  it("reconciles an unfinished occurrence on the scheduler/startup recovery path", async () => {
    const dir = root();
    const card = await occurrence(dir, "Active work: one card. Focus: ship it.");
    const calls: Array<{ url: string; body: any }> = [];
    const result = await reconcileMorningBriefDeliveries(dir, deliveryOptions(calls));
    expect(result).toEqual({ checked: 1, completed: 1, skipped: 0, errors: [] });
    expect((await loadCard(dir, card.id)).morningBriefDelivery.completedAt).toBeTruthy();
    const second = await reconcileMorningBriefDeliveries(dir, deliveryOptions(calls));
    expect(second).toEqual({ checked: 0, completed: 0, skipped: 0, errors: [] });
  });

  it("accepts only structured connector evidence, including the confined run artifact", async () => {
    expect(calendarResultFromSummary("Calendário: 2 eventos hoje.")).toMatchObject({ status: "degraded" });
    expect(calendarResultFromEvidence(calendarEvidence)).toMatchObject({ status: "reported", eventCount: 0 });
    expect(calendarResultFromEvidence({ calendar: { connector: "google", ok: true, eventCount: 2 } })).toMatchObject({ status: "degraded" });

    const dir = root();
    const runs = join(dir, "runs");
    const runDir = join(runs, "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "morning-briefing-evidence.json"), JSON.stringify(calendarEvidence));
    expect(readMorningBriefConnectorEvidence({ runDir }, { GARRISON_RUNS_DIR: runs })).toEqual(calendarEvidence);
    expect(readMorningBriefConnectorEvidence({ runDir: join(dir, "outside") }, { GARRISON_RUNS_DIR: runs })).toBeNull();
  });
});
