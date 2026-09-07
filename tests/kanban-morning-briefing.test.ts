import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
// @ts-ignore — pure .mjs
import { ensureMorningBriefTemplate, seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

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
// used to isolate them; wipe it between tests so one test's cards can never show
// up in another's sweep, batch, or board read.
beforeEach(async () => {
  await __kanbanState?.reset();
});
// The web channel base is GARRISON_APP_URL first (Conversations in the shell),
// the legacy web-channel-default status file second. A vitest process can
// inherit the runner's GARRISON_APP_URL; the tests that inject fittingUrlFn
// without an env are exercising the fallback seam, so the inherited value is
// cleared for the file and restored after.
const INHERITED_APP_URL = process.env.GARRISON_APP_URL;
beforeAll(() => {
  delete process.env.GARRISON_APP_URL;
});
afterAll(() => {
  if (INHERITED_APP_URL === undefined) delete process.env.GARRISON_APP_URL;
  else process.env.GARRISON_APP_URL = INHERITED_APP_URL;
});


function root() {
  return mkdtempSync(join(tmpdir(), "kanban-morning-"));
}

async function occurrence(dir: string, summary: string, occurrenceSuffix = "2026-08-05T08:00") {
  return createCard(dir, {
    title: "Morning briefing",
    list: "done",
    scheduleTemplateId: "01MORNINGTEMPLATE000000000",
    scheduleSystemKey: MORNING_BRIEF_SYSTEM_KEY,
    occurrenceKey: `01MORNINGTEMPLATE000000000:${occurrenceSuffix}`,
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

// Slack (and, by default, email) are left unrunning/unconfigured for the
// pre-existing Web/Omi tests: they must degrade quietly rather than sharing
// Web's fixture URL (both would otherwise resolve to the same
// "morning-briefing" thread id and double-count Web's post assertions).
function deliveryOptions(calls: Array<{ url: string; body: any }>, extras: Record<string, unknown> = {}) {
  return {
    summary: "Calendar: no events today. Active work: two cards. Focus: finish routing.",
    connectorEvidence: calendarEvidence,
    fetchImpl: successfulChannels(calls) as any,
    fittingUrlFn: (id: string) => id === "omi-channel" ? "http://omi" : id === "web-channel-default" ? "http://web" : null,
    now: () => "2026-08-05T07:05:00.000Z",
    at: () => Date.parse("2026-08-05T07:05:00.000Z"),
    ...extras
  };
}


function emailFixture(output = JSON.stringify({ ok: true, result: { id: "fixture-message" } })) {
  const home = mkdtempSync(join(tmpdir(), "kanban-mail-fixture-"));
  writeFileSync(join(home, "internal-token"), "test-token");
  const spawnCalls: string[][] = [];
  const options = {
    env: {
      GARRISON_HOME: home,
      GARRISON_COMPOSITION_DIR: home,
      GARRISON_APP_URL: "http://app",
      GARRISON_KANBANLOOP_MORNING_BRIEF_EMAIL: "reader@example.invalid"
    },
    fittingUrlFn: () => null,
    fetchImpl: async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).endsWith("/auth-env") ? { env: { GOOGLE_ACCESS_TOKEN: "fixture-token" } } : { ok: true }
    ), { status: 200 }),
    spawnImpl: (_cmd: string, args: string[]) => {
      spawnCalls.push(args);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true
      });
      setImmediate(() => { child.stdout.write(output); child.emit("close", 0); });
      return child;
    }
  };
  return { options, spawnCalls };
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

  it("posts Web to the shell's talk API when GARRISON_APP_URL is set, never asking for the legacy fitting", async () => {
    const dir = root();
    const card = await occurrence(dir, "Calendar: no events today. Active work: two cards. Focus: finish routing.");
    const calls: Array<{ url: string; body: any }> = [];
    const asked: string[] = [];
    const result = await deliverMorningBriefCompletion(dir, card.id, deliveryOptions(calls, {
      env: { GARRISON_APP_URL: "http://app/" },
      fittingUrlFn: (id: string) => {
        asked.push(id);
        return id === "omi-channel" ? "http://omi" : null;
      }
    }));
    expect(result).toMatchObject({
      web: { status: "delivered", threadId: MORNING_BRIEF_WEB_THREAD },
      omi: { status: "delivered" }
    });
    // The talk API is mounted under /api/* on the app; the trailing slash on the
    // projected URL must not double up.
    const webPosts = calls.filter((call) => call.url === `http://app/api/threads/${MORNING_BRIEF_WEB_THREAD}/messages`);
    expect(webPosts).toHaveLength(1);
    expect(asked).not.toContain("web-channel-default");
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

  it("delivers Slack when the fitting is running, and degrades honestly otherwise", async () => {
    const dir = root();
    const card = await occurrence(dir, "Active work: two cards. Focus: finish routing.");
    const calls: Array<{ url: string; body: any }> = [];
    const result = await deliverMorningBriefCompletion(dir, card.id, deliveryOptions(calls, {
      fittingUrlFn: (id: string) =>
        id === "omi-channel" ? "http://omi" : id === "web-channel-default" ? "http://web" : id === "slack-channel" ? "http://slack" : null
    }));
    expect(result).toMatchObject({
      slack: { status: "delivered", threadId: "morning-briefing" },
      email: { status: "degraded", detail: expect.stringContaining("No morning_brief_email configured") }
    });
    const slackPosts = calls.filter((call) => call.url === "http://slack/api/threads/morning-briefing/messages");
    expect(slackPosts).toHaveLength(1);
    expect(slackPosts[0].body.idempotencyKey).toMatch(/^morning:.*:slack$/);
  });

  it("degrades Slack honestly when the relay reports no routable destination", async () => {
    const dir = root();
    const card = await occurrence(dir, "Active work: one card.");
    const result = await deliverMorningBriefCompletion(dir, card.id, deliveryOptions([], {
      fittingUrlFn: (id: string) => id === "slack-channel" ? "http://slack" : null,
      fetchImpl: (async (input: string | URL | Request) => {
        if (String(input).includes("slack")) {
          return new Response(JSON.stringify({ ok: false, error: "unroutable thread id and no notify_channel configured" }), {
            status: 400,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }) as any
    }));
    expect(result.slack).toMatchObject({ status: "degraded", detail: expect.stringContaining("no notify_channel configured") });
  });

  it("delivers email via the google connector once configured and connected, and degrades when Google is not connected", async () => {
    const dir = root();
    const home = mkdtempSync(join(tmpdir(), "kanban-morning-home-"));
    writeFileSync(join(home, "internal-token"), "test-token");
    const compositionDir = mkdtempSync(join(tmpdir(), "kanban-morning-comp-"));
    const scriptDir = join(compositionDir, "apm_modules", "_local", "google", "scripts");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "connector.mjs"), "");
    const env = {
      GARRISON_HOME: home,
      GARRISON_COMPOSITION_DIR: compositionDir,
      GARRISON_APP_URL: "http://app",
      GARRISON_KANBANLOOP_MORNING_BRIEF_EMAIL: "reader@example.invalid"
    };

    const connectedCard = await occurrence(dir, "Active work: one card.");
    const connectedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth-env")) {
        expect((init?.headers as any)?.["x-garrison-internal"]).toBe("test-token");
        return new Response(JSON.stringify({ env: { GOOGLE_ACCESS_TOKEN: "tok" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    const spawnCalls: any[] = [];
    const spawnImpl = (_cmd: string, args: string[], opts: any) => {
      spawnCalls.push({ args, env: opts.env });
      const handlers: Record<string, Function> = {};
      return {
        stdout: { on: (_e: string, cb: Function) => { if (_e === "data") cb(JSON.stringify({ ok: true, result: { id: "fixture-confirmed-message" } })); } },
        stderr: { on: () => {} },
        on: (event: string, cb: Function) => { handlers[event] = cb; if (event === "close") setImmediate(() => cb(0)); },
        kill: () => {}
      };
    };
    const connected = await deliverMorningBriefCompletion(dir, connectedCard.id, deliveryOptions([], {
      env,
      fetchImpl: connectedFetch,
      spawnImpl: spawnImpl as any,
      fittingUrlFn: () => null
    }));
    expect(connected.email).toMatchObject({ status: "delivered", detail: expect.stringContaining("reader@example.invalid") });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].args).toContain("gmail.send");
    expect(spawnCalls[0].env.GOOGLE_ACCESS_TOKEN).toBe("tok");

    const disconnectedCard = await occurrence(dir, "Active work: one card.", "2026-08-05T09:00");
    const disconnectedFetch = (async (input: string | URL | Request) => {
      if (String(input).includes("/auth-env")) {
        return new Response(JSON.stringify({ awaiting_connector: true }), { status: 409, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    const disconnected = await deliverMorningBriefCompletion(dir, disconnectedCard.id, deliveryOptions([], {
      env,
      fetchImpl: disconnectedFetch,
      fittingUrlFn: () => null
    }));
    expect(disconnected.email).toMatchObject({ status: "degraded", detail: expect.stringContaining("not connected") });
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

  it("fences Gmail before sending and never repeats an uncertain successful send after recovery", async () => {
    const dir = root();
    const card = await occurrence(dir, "Synthetic briefing.");
    const fixture = emailFixture();
    let crashed = false;
    const options = deliveryOptions([], {
      ...fixture.options,
      claimStaleMs: 0,
      afterChannelDelivered: async ({ channel }: { channel: string }) => {
        if (channel !== "email" || crashed) return;
        crashed = true;
        const stored = await loadCard(dir, card.id);
        expect(stored.morningBriefDelivery.email).toMatchObject({
          status: "sending", attemptedAt: expect.any(String)
        });
        throw new Error("crash after email send");
      }
    });
    await expect(deliverMorningBriefCompletion(dir, card.id, options)).rejects.toThrow();
    const recovered = await deliverMorningBriefCompletion(dir, card.id, options);
    expect(fixture.spawnCalls).toHaveLength(1);
    expect(recovered.email).toMatchObject({ status: "degraded", outcome: "unknown" });
    expect(recovered.email.detail).toMatch(/not retried/i);
    expect(recovered.card.morningBriefDelivery.completedAt).toBeTruthy();
  });

  it("retains the confirmed Gmail message identifier in the durable receipt", async () => {
    const dir = root();
    const card = await occurrence(dir, "Synthetic briefing.");
    const fixture = emailFixture();
    const delivered = await deliverMorningBriefCompletion(dir, card.id, deliveryOptions([], fixture.options));
    expect(delivered.email).toMatchObject({ status: "delivered", messageId: "fixture-message" });
    await deliverMorningBriefCompletion(dir, card.id, deliveryOptions([], fixture.options));
    expect(fixture.spawnCalls).toHaveLength(1);
  });

  it.each(["", "{}", '{"ok":true}', JSON.stringify({ ok: true, result: { id: "large-fixture", extra: "x".repeat(70_000) } })])(
    "does not claim email delivery without a bounded confirmed connector receipt (%#)",
    async (output) => {
      const dir = root();
      const card = await occurrence(dir, "Synthetic briefing.");
      const fixture = emailFixture(output);
      const result = await deliverMorningBriefCompletion(dir, card.id, deliveryOptions([], fixture.options));
      expect(result.email.status).toBe("degraded");
      expect(result.email.detail.length).toBeLessThan(350);
    }
  );

  it("migrates only the former stock briefing instructions and preserves operator edits", async () => {
    const dir = root();
    const stock = await createCard(dir, {
      title: "Morning briefing", list: "scheduled", systemKey: MORNING_BRIEF_SYSTEM_KEY,
      description: "Prepare today's morning briefing. Read today's Google Calendar events when the connector is available; summarise active and due Kanban work, blocked cards, and Needs attention; then recommend a concise focus for the day. After the actual Google connector call, write its machine-readable receipt to <runDir>/morning-briefing-evidence.json as {\"calendar\":{\"connector\":\"google\",\"action\":\"calendar.list_events\",\"ok\":true|false,\"checkedAt\":\"ISO timestamp\",\"eventCount\":0,\"reason\":\"failure reason when not ok\"}}; prose is not evidence. Deliver the completed briefing to the stable Garrison Web thread and directly to Omi when it is available. Record a missing Calendar or Omi connection as a visibly degraded section/delivery result; never invent unavailable data, and do not duplicate the Web delivery through Omi's fallback."
    });
    const migrated = await ensureMorningBriefTemplate(dir, seedBoard());
    expect(migrated.card.id).toBe(stock.id);
    expect(migrated.card.description).toContain("Recap yesterday factually");
    const custom = "Operator customization: discuss Project Alpha only.";
    await updateCardCAS(dir, stock.id, (card: any) => ({ ...card, description: custom }));
    const preserved = await ensureMorningBriefTemplate(dir, seedBoard());
    expect(preserved.card.description).toBe(custom);
    expect((await loadCard(dir, stock.id)).description).toBe(custom);
  });

});
