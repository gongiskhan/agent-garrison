// The Probe, off the Stop hook.
//
// The Probe used to have exactly one way to reach a person: block a Claude Code
// Stop and have the model relay the question through AskUserQuestion. When
// nobody has that terminal open, the question is written to a pending file and
// then swept as "dismissed" 90 seconds later — a question asked into an empty
// room and recorded as refused. On prod one sat unanswered from 31 July onward.
//
// These tests pin the three things that fix it: the question reaches running
// channels, an answer coming back from one of them writes the SAME record the
// AskUserQuestion capture writes (so the learning loop cannot tell the paths
// apart), and the sweep stops treating a pushed question as 90-seconds-perishable.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { startStateService } from "./state-service-harness";

// @ts-ignore - pure .mjs
import * as store from "../fittings/seed/improver/lib/probe-store.mjs";
// @ts-ignore - pure .mjs
import * as signals from "../fittings/seed/improver/lib/feedback-signals.mjs";
// @ts-ignore - pure .mjs
import * as notify from "../fittings/seed/improver/lib/probe-notify.mjs";
// @ts-ignore - pure .mjs
import * as feedbackRule from "../fittings/seed/improver/lib/feedback-rule.mjs";

const AT = "2026-08-13T09:00:00.000Z";

let home: string;
let dataDir: string;
const savedHome = process.env.GARRISON_HOME;
const savedData = process.env.IMPROVER_DATA;
const savedStateUrl = process.env.GARRISON_STATE_URL;
const savedStateToken = process.env.GARRISON_STATE_TOKEN;
let h: Awaited<ReturnType<typeof startStateService>>;

function pending(extra: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    session_id: "sess-1",
    mode: "probe",
    askedAt: AT,
    target: "cc-haiku",
    questions: [
      {
        area: "orchestrator",
        question: "Garrison routed that as fix (T1-standard). Was that the right call?",
        options: ["Right call", "Should have gone deeper", "Overkill - too heavy", "Wrong task type"],
        classification: { kind: "fix", tier: "T1-standard", plan: null },
        card_id: null,
      },
    ],
    ...extra,
  };
}

// The feedback queue is the state service now (mesh phase 2, §4.5), so the
// records these paths write are read back through it rather than off a file.
// A fresh service per test is the isolation: both feedback tables are
// append-only and have no delete verb.
async function readQueue(): Promise<any[]> {
  const rows = await h.client.listFeedback({ limit: 500 });
  return rows.map((r: { payload: unknown }) => r.payload);
}

function registerFitting(id: string, url: string) {
  const dir = path.join(home, "ui-fittings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ fittingId: id, url, port: Number(new URL(url).port) }));
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "gar-probe-oob-"));
  dataDir = path.join(home, "improver");
  mkdirSync(dataDir, { recursive: true });
  process.env.GARRISON_HOME = home;
  process.env.IMPROVER_DATA = dataDir;
  h = await startStateService();
  process.env.GARRISON_STATE_URL = h.url;
  process.env.GARRISON_STATE_TOKEN = h.token;
  signals.resetFeedbackClient();
});

afterEach(async () => {
  await h?.stop();
  if (savedHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = savedHome;
  if (savedData === undefined) delete process.env.IMPROVER_DATA;
  else process.env.IMPROVER_DATA = savedData;
  if (savedStateUrl === undefined) delete process.env.GARRISON_STATE_URL;
  else process.env.GARRISON_STATE_URL = savedStateUrl;
  if (savedStateToken === undefined) delete process.env.GARRISON_STATE_TOKEN;
  else process.env.GARRISON_STATE_TOKEN = savedStateToken;
  signals.resetFeedbackClient();
  rmSync(home, { recursive: true, force: true });
});

describe("out-of-band delivery", () => {
  it("pushes the question to every running fitting that accepts /notify, and skips the ones that 404", async () => {
    registerFitting("web-channel-default", "http://127.0.0.1:7083");
    registerFitting("kanban-loop", "http://127.0.0.1:7080");
    registerFitting("improver", "http://127.0.0.1:7093");
    const seen: Array<{ url: string; body: any }> = [];
    const fetchImpl = async (url: string, init: any) => {
      seen.push({ url, body: JSON.parse(init.body) });
      // Only the channel implements the notify contract; the board 404s, which
      // is how a non-channel fitting opts out without anyone maintaining a list.
      return { status: url.includes("7083") ? 200 : 404, ok: url.includes("7083") };
    };
    const res = await notify.deliverProbeQuestion(pending(), {
      selfUrl: "http://127.0.0.1:7093",
      fetchImpl,
      serveMap: new Map([[7093, "https://box.tail31efa.ts.net:8093"]]),
    });
    expect(res.channels).toEqual(["web-channel-default"]);
    // The improver never notifies itself.
    expect(seen.map((s) => s.url)).not.toContain("http://127.0.0.1:7093/notify");
    expect(seen).toHaveLength(2);
  });

  it("every option becomes an action pointing at the answer route", async () => {
    registerFitting("web-channel-default", "http://127.0.0.1:7083");
    let body: any = null;
    const fetchImpl = async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return { status: 200, ok: true };
    };
    await notify.deliverProbeQuestion(pending(), {
      selfUrl: "http://127.0.0.1:7093",
      fetchImpl,
      serveMap: new Map([[7093, "https://box.tail31efa.ts.net:8093"]]),
    });
    expect(body.actions).toHaveLength(4);
    expect(body.actions[0].label).toBe("Right call");
    expect(body.actions[0].url).toBe(
      "https://box.tail31efa.ts.net:8093/api/probe/p-1/answer?question=0&answer=Right%20call"
    );
    // Transports that cannot render buttons still see every option.
    expect(body.text).toContain("Right call · Should have gone deeper");
  });

  it("says so when the answer URL is only reachable from this machine", async () => {
    // HARD RULE: the operator's browser is almost never on the Garrison box. A
    // loopback action URL is a button that silently does nothing on a phone, so
    // the caller is told rather than left to assume delivery worked.
    registerFitting("web-channel-default", "http://127.0.0.1:7083");
    const res = await notify.deliverProbeQuestion(pending(), {
      selfUrl: "http://127.0.0.1:7093",
      fetchImpl: async () => ({ status: 200, ok: true }),
      serveMap: new Map(), // nothing published by `tailscale serve`
    });
    expect(res.reachable).toBe(false);
    expect(res.reason).toContain("tailscale serve");
  });

  it("a channel that is down never blocks the others", async () => {
    registerFitting("web-channel-default", "http://127.0.0.1:7083");
    registerFitting("slack-channel", "http://127.0.0.1:7086");
    const fetchImpl = async (url: string) => {
      if (url.includes("7086")) throw new Error("ECONNREFUSED");
      return { status: 200, ok: true };
    };
    const res = await notify.deliverProbeQuestion(pending(), {
      selfUrl: "http://127.0.0.1:7093",
      fetchImpl,
      serveMap: new Map(),
    });
    expect(res.channels).toEqual(["web-channel-default"]);
  });
});

describe("the answer coming back", () => {
  it("writes exactly the record feedback-rule already consumes, and clears the pending", async () => {
    store.writePending(pending());
    const res = await store.recordProbeAnswer({
      pendingId: "p-1",
      questionIndex: 0,
      answer: "Should have gone deeper",
      now: AT,
      deliveredVia: "out-of-band:web-channel-default",
    });
    expect(res.ok).toBe(true);
    expect(res.cleared).toBe(true);
    expect(store.readPending("sess-1")).toBeNull();

    const [rec] = await readQueue();
    // The schema is the one probe-capture.mjs writes — same provenance, same
    // classification block, same question text. The learning loop must not be
    // able to tell which path the answer came in on.
    expect(rec).toMatchObject({
      session_id: "sess-1",
      area: "orchestrator",
      answer: "Should have gone deeper",
      provenance: "probe",
      classification: { kind: "fix", tier: "T1-standard", plan: null },
      delivered_via: "out-of-band:web-channel-default",
    });
    expect(rec.options).toHaveLength(4);
    expect(String(rec.id)).toMatch(/^fq-/);

    // And the rule really does consume it: two of these clear the min-signal bar.
    store.writePending(pending({ id: "p-2", session_id: "sess-2" }));
    await store.recordProbeAnswer({ pendingId: "p-2", answer: "Should have gone deeper", now: AT });
    const props = (await feedbackRule.runFeedbackRule({ now: AT })).proposals;
    expect(props.some((p: any) => p.id.startsWith("feedback-deeper-"))).toBe(true);
  });

  it("answering one of a retrospective's questions keeps the rest open", async () => {
    const multi = pending({
      mode: "retrospective",
      questions: [
        { area: "orchestrator", question: "Q1?", options: ["a", "b"], classification: {}, card_id: "c1" },
        { area: "orchestrator", question: "Q2?", options: ["a", "b"], classification: {}, card_id: "c2" },
      ],
    });
    store.writePending(multi);
    const res = await store.recordProbeAnswer({ pendingId: "p-1", questionIndex: 0, answer: "a", now: AT });
    expect(res.remaining).toBe(1);
    const still = store.readPending("sess-1");
    expect(still.questions).toHaveLength(1);
    expect(still.questions[0].question).toBe("Q2?");
    expect((await readQueue())[0]).toMatchObject({ provenance: "retrospective", question: "Q1?" });
  });

  it("a second tap on the same option records nothing", async () => {
    store.writePending(pending());
    await store.recordProbeAnswer({ pendingId: "p-1", answer: "Right call", now: AT });
    expect(await store.recordProbeAnswer({ pendingId: "p-1", answer: "Right call", now: AT })).toMatchObject({
      ok: false,
      code: "not-found",
    });
    expect(await readQueue()).toHaveLength(1);
  });

  it("refuses an empty answer rather than recording a blank verdict", async () => {
    store.writePending(pending());
    expect(await store.recordProbeAnswer({ pendingId: "p-1", answer: "  ", now: AT })).toMatchObject({ code: "empty-answer" });
    expect(await readQueue()).toHaveLength(0);
  });
});

describe("the stale sweep respects the delivery path", () => {
  const later = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();

  it("a relay-only question is still swept at 90 seconds", async () => {
    store.writePending(pending());
    const res = await store.sweepStalePending({ now: later(store.RELAY_MAX_AGE_MS + 1000), sessionId: "sess-1" });
    expect(res.swept).toBe(true);
    expect(res.outOfBand).toBe(false);
    expect((await readQueue())[0]).toMatchObject({ answer: "dismissed", delivered_via: "stop-hook-relay" });
  });

  it("a question pushed to a channel survives far past 90 seconds", async () => {
    // The 90s figure only ever made sense for a question open inside a blocking
    // AskUserQuestion. A notification sitting in a list does not expire in a
    // minute and a half, and sweeping it discards an answer the operator can
    // still give — the exact failure this pass exists to end.
    store.writePending(pending({ deliveredVia: { relay: true, channels: ["web-channel-default"] } }));
    expect(await store.sweepStalePending({ now: later(6 * 60 * 60 * 1000), sessionId: "sess-1" })).toMatchObject({ swept: false, fresh: true });
    expect(store.readPending("sess-1")).not.toBeNull();
  });

  it("but it does not live forever — a week out, it is dismissed and says which path timed out", async () => {
    store.writePending(pending({ deliveredVia: { relay: true, channels: ["web-channel-default", "omi-channel"] } }));
    const res = await store.sweepStalePending({ now: later(store.OUT_OF_BAND_MAX_AGE_MS + 1000), sessionId: "sess-1" });
    expect(res.swept).toBe(true);
    expect(res.outOfBand).toBe(true);
    expect((await readQueue())[0]).toMatchObject({
      answer: "dismissed",
      delivered_via: "out-of-band:web-channel-default,omi-channel",
    });
  });

  it("an EMPTY channel list is relay-only, not out-of-band", async () => {
    // Delivery was attempted and nothing accepted it. Treating that as
    // out-of-band would give a question nobody can see a seven-day lifetime.
    store.writePending(pending({ deliveredVia: { relay: true, channels: [] } }));
    expect((await store.sweepStalePending({ now: later(store.RELAY_MAX_AGE_MS + 1000), sessionId: "sess-1" })).swept).toBe(true);
  });
});
