// The DECISION-TIME autonomy consult (ORCHESTRATOR_COHERENCE.md §7.1/§7.5).
//
// The bands, the signal registry, the cold-start seed and the escalation evidence
// all existed before this run and NOTHING consulted them: the router had exactly
// one behaviour, decide and go. These tests pin the seam that changed that, and
// they are deliberately weighted toward the ways it could be WRONG rather than
// the happy path:
//
//   • the two folds must agree. The gateway cannot import src/lib, so the
//     evidence fold exists twice - once in the fitting (autonomy-consult.mjs, the
//     one the ROUTER acts on) and once in the shell (routing-tracks.ts, the one
//     the Autonomy panel SHOWS). If they drift, the panel displays a band the
//     router never used, which is exactly the "confident for reasons nobody can
//     reconstruct" failure the derived-tracks design exists to prevent.
//   • a hold must actually hold. Every dispatch path - the tick, the engine, a
//     PATCH auto-dispatch, a manual Start - has to respect it, and a QUICK turn
//     (the inline one that never reaches the board) has to be held too.
//   • the exempt lanes must stay exempt. A card-originated or scheduled turn was
//     already routed and already authorised; an explicit pin IS the answer.
//   • the budget must never suppress a REQUIRED question, only a nice-to-have.
//   • a broken consult must fail OPEN. Parking every turn because a module would
//     not import is not caution, it is an outage.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

const ROOT = path.resolve(__dirname, "..");
const KANBAN = path.join(ROOT, "fittings/seed/kanban-loop");

// ── env sandbox (set BEFORE anything reads a Garrison path) ──
const HOME = mkdtempSync(path.join(tmpdir(), "autonomy-home-"));
const BOARD = mkdtempSync(path.join(tmpdir(), "autonomy-board-"));
const RUNS = mkdtempSync(path.join(tmpdir(), "autonomy-runs-"));
const COMPOSITION = mkdtempSync(path.join(tmpdir(), "autonomy-comp-"));
process.env.GARRISON_HOME = HOME;
process.env.GARRISON_KANBAN_DIR = BOARD;
process.env.GARRISON_RUNS_DIR = RUNS;
process.env.GARRISON_POLICY_PATH = "/nonexistent/autonomy-policy.json";

// @ts-ignore - pure ESM .mjs, no .d.ts
import * as consult from "../fittings/seed/orchestrator/lib/autonomy-consult.mjs";
// @ts-ignore
import { DEFAULT_THRESHOLDS } from "../fittings/seed/orchestrator/lib/routing-autonomy.mjs";
// @ts-ignore
import { autonomyHoldPlan, autonomyDecisionRecord, RoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore
import { resolveDiscussInterception } from "../fittings/seed/http-gateway/scripts/lib/discuss-intercept.mjs";
// @ts-ignore
import * as dispatchCore from "../fittings/seed/orchestrator/lib/dispatch-core.mjs";
// @ts-ignore
import * as routingCore from "../fittings/seed/orchestrator/lib/routing-core.mjs";
// @ts-ignore
import * as routingTelemetry from "../fittings/seed/orchestrator/lib/routing-telemetry.mjs";
// @ts-ignore
import { autonomyActedMessage, ORIGIN_EVENT_KINDS } from "../fittings/seed/kanban-loop/lib/notify-origin.mjs";
// @ts-ignore
import { isAckableEventKind } from "../fittings/seed/kanban-loop/lib/ack.mjs";

const queueFile = path.join(HOME, "improver", "feedback-queue.jsonl");
const decisionsFile = path.join(COMPOSITION, ".garrison", "decisions.jsonl");

function writeLogs(queue: unknown[], decisions: unknown[]) {
  mkdirSync(path.dirname(queueFile), { recursive: true });
  mkdirSync(path.dirname(decisionsFile), { recursive: true });
  writeFileSync(queueFile, queue.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(decisionsFile, decisions.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function clearLogs() {
  writeLogs([], []);
  rmSync(path.join(COMPOSITION, ".garrison", "ask-budget.json"), { force: true });
}

afterAll(() => {
  for (const dir of [HOME, BOARD, RUNS, COMPOSITION]) rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────── the fold, twice

describe("evidence fold parity - the fitting's fold and the shell's must agree", () => {
  it("folds the same records into the same bands", async () => {
    // One fixture exercising every branch both folds claim to have: a right and a
    // wrong verdict, a wrong that names neither dimension, a record from ANOTHER
    // producer on the same shared queue, a tombstoned record, an applied
    // escalation, a turn-override pin, and a burst of identical evidence inside
    // the collapse window.
    const verdictKeep = {
      id: "fq-keep-1",
      area: "orchestrator",
      question: "decision-verdict",
      answer: "right",
      original: { flow: "fix", duty: "implement" },
      timestamp: "2026-08-01T10:00:00.000Z",
      provenance: "decision-verdict"
    };
    const verdictWrongFlow = {
      id: "fq-wrong-1",
      area: "orchestrator",
      question: "decision-verdict",
      answer: "wrong",
      original: { flow: "feature", duty: "implement" },
      applied: { flow: "fix" },
      timestamp: "2026-08-01T11:00:00.000Z",
      provenance: "decision-verdict"
    };
    const verdictWrongBoth = {
      id: "fq-wrong-2",
      area: "orchestrator",
      question: "decision-verdict",
      answer: "wrong",
      original: { duty: "research" },
      timestamp: "2026-08-01T12:00:00.000Z",
      provenance: "decision-verdict"
    };
    const verdictUnsure = {
      id: "fq-unsure-1",
      area: "orchestrator",
      question: "decision-verdict",
      answer: "unsure",
      original: { flow: "fix" },
      timestamp: "2026-08-01T12:30:00.000Z",
      provenance: "decision-verdict"
    };
    // Another producer's record on the SAME queue. Its `answer` is free text and
    // reading it as a verdict would train the router on noise.
    const override = {
      id: "fq-override-1",
      area: "orchestrator",
      question: "override",
      answer: "just do it quickly",
      original: { taskType: "code", tier: "T2-deep" },
      applied: { taskType: "code", tier: "T0-trivial" },
      timestamp: "2026-08-01T13:00:00.000Z",
      provenance: "override"
    };
    const verdictDeleted = {
      id: "fq-deleted-1",
      area: "orchestrator",
      question: "decision-verdict",
      answer: "wrong",
      original: { flow: "docs" },
      applied: { flow: "chore" },
      timestamp: "2026-08-01T14:00:00.000Z",
      provenance: "decision-verdict"
    };
    const tombstone = { kind: "tombstone", target: "fq-deleted-1", at: "2026-08-01T15:00:00.000Z" };
    // An id-less historical record, deleted by its DERIVED line key - the format
    // three readers have to agree on byte for byte.
    const legacy = {
      area: "orchestrator",
      question: "decision-verdict",
      answer: "wrong",
      original: { duty: "ops" },
      timestamp: "2026-08-01T16:00:00.000Z",
      provenance: "decision-verdict"
    };
    const legacyTombstone = {
      kind: "tombstone",
      target: consult.derivedKeyForLine(JSON.stringify(legacy)),
      at: "2026-08-01T17:00:00.000Z"
    };

    const decisions = [
      { at: "2026-08-02T09:00:00.000Z", kind: "escalation", applied: true, flow: "fix", duty: "implement" },
      { at: "2026-08-02T09:05:00.000Z", kind: "escalation", applied: false, flow: "fix" },
      { at: "2026-08-02T10:00:00.000Z", via: "turn-override", flow: "feature", level: 3 },
      // A retired duty name, which both folds adopt onto its successor.
      { at: "2026-08-02T11:00:00.000Z", via: "turn-override", duty: "code", level: 2 },
      // A burst: three identical pins ~15s apart is one machine loop, not three
      // corrections. Both folds must count ONE.
      { at: "2026-08-02T12:00:00.000Z", via: "turn-override", flow: "image", level: 1 },
      { at: "2026-08-02T12:00:15.000Z", via: "turn-override", flow: "image", level: 1 },
      { at: "2026-08-02T12:00:30.000Z", via: "turn-override", flow: "image", level: 1 },
      // An ordinary routed decision is not evidence about anything.
      { at: "2026-08-02T13:00:00.000Z", kind: "duty-route", duty: "implement", level: 2 }
    ];

    writeLogs(
      [verdictKeep, verdictWrongFlow, verdictWrongBoth, verdictUnsure, override, verdictDeleted, tombstone, legacy, legacyTombstone],
      decisions
    );

    const { summariseTracks } = await import("@/lib/routing-tracks");
    const shell = await summariseTracks(COMPOSITION, { seed: [] });
    const fitting = await consult.summariseTracks({ compositionDir: COMPOSITION, seed: [] });

    const shape = (rows: any[]) =>
      rows
        .map((r) => `${r.category}:${r.shape} obs=${r.observations} band=${r.band.band} conf=${r.band.confidence.toFixed(6)} ${JSON.stringify(r.signals)}`)
        .sort();

    expect(shape(fitting)).toEqual(shape(shell));
    // And the fold is not trivially empty - a parity test that compares two
    // empty lists proves nothing.
    expect(shell.length).toBeGreaterThan(4);
    // Spot-check the branches that were easiest to get wrong.
    const byKey = Object.fromEntries(shell.map((r: any) => [`${r.category}:${r.shape}`, r]));
    expect(byKey["flow:fix"].signals["explicit-confirmation"]).toBe(1);
    expect(byKey["flow:feature"].signals["explicit-negative"]).toBe(1);
    expect(byKey["level:research"].signals["explicit-negative"]).toBe(1); // wrong naming neither dimension
    expect(byKey["level:fix"].signals["escalation"]).toBe(1); // only the APPLIED escalation
    expect(byKey["flow:image"].signals["manual-override"]).toBe(1); // burst collapsed
    expect(byKey["level:implement"].signals["manual-override"]).toBe(1); // `code` adopted onto `implement`
    expect(byKey["flow:docs"]).toBeUndefined(); // tombstoned by id
    expect(byKey["level:ops"]).toBeUndefined(); // tombstoned by derived line key
    // The other producer's record contributed nothing.
    expect(shell.some((r: any) => r.shape === "unknown")).toBe(false);
  });

  it("reads the seed the same way the Autonomy panel does", async () => {
    clearLogs();
    const seed = await consult.loadSeedEntries(COMPOSITION);
    expect(seed.length).toBeGreaterThan(0);
    const fitting = await consult.summariseTracks({ compositionDir: COMPOSITION, seed });
    const fixFlow = fitting.find((r: any) => r.category === "flow" && r.shape === "fix");
    // The shipped seed's cap lands a mined shape ON the lower threshold: above
    // ask, below act-inform. Inferred history may buy act-revert, never more.
    expect(fixFlow.band.band).toBe("act-revert");
    expect(fitting.every((r: any) => r.band.band !== "act-inform")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────── the consult

describe("consultAutonomy", () => {
  it("cold start asks: no track record means no freedom", async () => {
    clearLogs();
    const out = await consult.consultAutonomy({
      compositionDir: COMPOSITION,
      decision: { flow: "brand-new-shape", duty: "implement", level: 2 },
      action: "card-create",
      seed: []
    });
    expect(out.band).toBe("ask");
    expect(out.ask).toBe(true);
    expect(out.reason).toBe("cold-start");
    expect(out.question).toMatch(/reply go to proceed, or correct me/i);
    expect(out.question).toContain("brand-new-shape");
  });

  it("a seeded shape acts, and offers to revert", async () => {
    clearLogs();
    const out = await consult.consultAutonomy({
      compositionDir: COMPOSITION,
      decision: { flow: "fix", duty: "implement", level: 2 },
      action: "card-create"
    });
    expect(out.band).toBe("act-revert");
    expect(out.ask).toBe(false);
    expect(out.seeded).toBe(true);
  });

  it("the whole decision moves at the pace of its least-trusted half", async () => {
    clearLogs();
    // Corrections on the LEVEL track only. The flow track keeps its seeded
    // act-revert; the decision must still come back ask.
    writeLogs(
      [],
      Array.from({ length: 6 }, (_, i) => ({
        at: `2026-08-0${i + 1}T09:00:00.000Z`,
        kind: "escalation",
        applied: true,
        flow: "fix"
      }))
    );
    const out = await consult.consultAutonomy({
      compositionDir: COMPOSITION,
      decision: { flow: "fix", duty: "implement", level: 2 },
      action: "card-create"
    });
    expect(out.decisions.flow.band).toBe("act-revert");
    expect(out.decisions.level.band).toBe("ask");
    expect(out.band).toBe("ask");
    expect(out.ask).toBe(true);
  });

  it("an irreversible action never reaches the top band, however good the record", async () => {
    clearLogs();
    const perfect = Array.from({ length: 40 }, (_, i) => ({
      id: `fq-perfect-${i}`,
      area: "orchestrator",
      question: "decision-verdict",
      answer: "right",
      original: { flow: "outreach" },
      // Outside the burst window so each one counts.
      timestamp: new Date(Date.UTC(2026, 6, 1, i, 0, 0)).toISOString(),
      provenance: "decision-verdict"
    }));
    writeLogs(perfect, []);
    const reversible = await consult.consultAutonomy({
      compositionDir: COMPOSITION,
      decision: { flow: "outreach", duty: "implement", level: 2 },
      action: "code-change",
      seed: []
    });
    const irreversible = await consult.consultAutonomy({
      compositionDir: COMPOSITION,
      decision: { flow: "outreach", duty: "implement", level: 2 },
      action: "outbound-message",
      seed: []
    });
    expect(reversible.band).toBe("act-inform");
    expect(irreversible.band).toBe("act-revert");
    expect(irreversible.decisions.flow.delaySeconds).toBeGreaterThan(0);
  });

  it("the budget defers an information-value question but never a required one", async () => {
    clearLogs();
    const day = consult.budgetDay();
    mkdirSync(path.join(COMPOSITION, ".garrison"), { recursive: true });
    writeFileSync(
      path.join(COMPOSITION, ".garrison", "ask-budget.json"),
      JSON.stringify({ date: day, asked: DEFAULT_THRESHOLDS.maxQuestionsPerDay }),
      "utf8"
    );

    // A seeded shape sits ON the lower threshold, so its question is
    // near-boundary: real, but not required. Over budget it defers.
    const informational = await consult.consultAutonomy({
      compositionDir: COMPOSITION,
      decision: { flow: "fix", duty: "implement", level: 2 },
      action: "card-create"
    });
    expect(informational.band).toBe("act-revert");
    expect(informational.ask).toBe(false);
    expect(informational.deferred).toBeTruthy();
    expect(informational.question).toBeNull();

    // A cold-start shape is in the ASK band: the router is not allowed to act on
    // it, so the rate limit must not be able to silence the question.
    const required = await consult.consultAutonomy({
      compositionDir: COMPOSITION,
      decision: { flow: "never-seen", duty: "implement", level: 2 },
      action: "card-create"
    });
    expect(required.band).toBe("ask");
    expect(required.ask).toBe(true);
    expect(required.question).toBeTruthy();
    expect(required.askBudget.askedToday).toBe(DEFAULT_THRESHOLDS.maxQuestionsPerDay);
  });

  it("recordAsked counts posed questions and resets with the day", async () => {
    clearLogs();
    const first = await consult.recordAsked(COMPOSITION);
    expect(first.asked).toBe(1);
    const second = await consult.recordAsked(COMPOSITION);
    expect(second.asked).toBe(2);
    expect((await consult.readAskBudget(COMPOSITION)).asked).toBe(2);
    // A counter from another day is not today's counter.
    writeFileSync(
      path.join(COMPOSITION, ".garrison", "ask-budget.json"),
      JSON.stringify({ date: "1999-01-01", asked: 99 }),
      "utf8"
    );
    expect((await consult.readAskBudget(COMPOSITION)).asked).toBe(0);
  });

  it("a go writes a confirmation both folds read as explicit-confirmation", async () => {
    clearLogs();
    const record = consult.buildGoConfirmationRecord({
      flow: "brand-new-shape",
      duty: "implement",
      level: 2,
      decisionId: "dec-1",
      at: "2026-08-13T09:00:00.000Z"
    });
    expect(record.provenance).toBe("decision-verdict");
    expect(record.answer).toBe("right");
    expect(record.original).toMatchObject({ flow: "brand-new-shape" });
    expect(String(record.id).startsWith("fq-")).toBe(true);

    writeLogs([record], []);
    const { summariseTracks } = await import("@/lib/routing-tracks");
    const shell = await summariseTracks(COMPOSITION, { seed: [] });
    const fitting = await consult.summariseTracks({ compositionDir: COMPOSITION, seed: [] });
    const key = (rows: any[]) => rows.find((r) => r.category === "flow" && r.shape === "brand-new-shape");
    expect(key(fitting).signals["explicit-confirmation"]).toBe(1);
    expect(key(shell).signals["explicit-confirmation"]).toBe(1);
  });

  it("a broken or absent evidence log degrades to a cold start, never to a throw", async () => {
    mkdirSync(path.dirname(queueFile), { recursive: true });
    writeFileSync(queueFile, "{not json\n\n{\"provenance\":\"decision-verdict\"}\n", "utf8");
    rmSync(decisionsFile, { force: true });
    const out = await consult.consultAutonomy({
      compositionDir: COMPOSITION,
      decision: { flow: "whatever", duty: "implement", level: 1 },
      seed: []
    });
    expect(out.band).toBe("ask");
    clearLogs();
  });
});

// ─────────────────────────────────────────────────────── the hold decision

describe("autonomyHoldPlan - a quick turn is held exactly like a significant one", () => {
  const asking = { ask: true, band: "ask" };
  it("holds a significant turn onto the list it would have started on", () => {
    expect(autonomyHoldPlan(asking, { significant: true, sequence: ["plan", "implement"], targetList: "plan" })).toEqual({
      hold: true,
      resumeList: "plan"
    });
  });
  it("holds a QUICK turn instead of running it inline", () => {
    expect(autonomyHoldPlan(asking, { significant: false, sequence: ["implement"] })).toEqual({
      hold: true,
      resumeList: "implement"
    });
    expect(autonomyHoldPlan(asking, { significant: false })).toEqual({ hold: true, resumeList: "implement" });
  });
  it("never holds an acting band, and never holds when there was no consult", () => {
    expect(autonomyHoldPlan({ ask: false, band: "act-revert" }, { significant: true }).hold).toBe(false);
    expect(autonomyHoldPlan(null, { significant: false }).hold).toBe(false);
  });
});

describe("autonomyDecisionRecord - what the decisions log can prove afterwards", () => {
  it("carries the band per category, the confidence behind it, and whether it leaned on the seed", () => {
    const record = autonomyDecisionRecord({
      band: "act-revert",
      shape: "fix",
      seeded: true,
      informational: true,
      reason: "near-boundary",
      decisions: {
        flow: { band: "act-revert", confidence: 0.8000123, observations: 50 },
        level: { band: "act-revert", confidence: 0.79999, observations: 50 }
      }
    });
    expect(record).toMatchObject({
      band: "act-revert",
      shape: "fix",
      seeded: true,
      informed: true,
      reason: "near-boundary"
    });
    expect(record!.bands.flow).toEqual({ band: "act-revert", confidence: 0.8, observations: 50 });
  });
  it("records a deferred question rather than letting it evaporate", () => {
    const record = autonomyDecisionRecord({ band: "act-revert", decisions: {}, deferred: "near-boundary" });
    expect(record).toMatchObject({ deferred: true, reason: "near-boundary" });
  });
  it("is null when no consult was taken", () => {
    expect(autonomyDecisionRecord(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────── the gateway seam

function fixtureModel() {
  const levels = [
    { description: "trivial", cell: { target: "sdk-haiku", effort: "low" } },
    { description: "standard", cell: { target: "sdk-haiku", effort: "medium" } },
    { description: "deep", cell: { target: "sdk-haiku", effort: "high" } }
  ];
  return {
    duties: {
      implement: { id: "implement", title: "Implement", description: "write software", levels },
      other: { id: "other", title: "Other", description: "anything else", levels }
    },
    selectedDuties: ["implement", "other"]
  };
}

function gatewayFor(duty = "implement", level = 2) {
  const gw = new RoutedGateway({
    // The same core the production gateway merges (routing-core + telemetry);
    // preRouteV4 writes the decision record through it.
    core: { ...routingCore, ...routingTelemetry },
    config: { taskTypes: [], tiers: [] },
    compositionDir: COMPOSITION,
    decisionsFile,
    logFn: () => {},
    dispatcher: {
      core: dispatchCore,
      model: fixtureModel(),
      call: async () => ({ ok: true, structured: { duty, level, confidence: "high", reason: "fixture" } })
    }
  });
  // The board's resolved-model lib, stubbed: these tests are about the consult,
  // not about cell resolution. An agent-sdk target keeps preRouteV4 off the
  // live-session switch path.
  gw._resolvedModelLib = {
    loadResolvedModel: () => fixtureModel(),
    executionRouteFor: () => ({
      targetId: "sdk-haiku",
      target: { runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", effort: "low" },
      phase: duty,
      skill: null
    })
  };
  return gw;
}

function lastDecision() {
  const lines = readFileSync(decisionsFile, "utf8").trim().split("\n").filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

describe("the router consults the bands at decision time", () => {
  it("an unpinned human turn on a cold shape comes back holding, and says so in the log", async () => {
    clearLogs();
    const gw = gatewayFor("implement", 2);
    const pre = await gw.preRoute("do the thing", { channel: "web", sessionId: "t-hold" });
    expect(pre.autonomy).toBeTruthy();
    expect(pre.autonomy.ask).toBe(true);
    expect(pre.autonomy.band).toBe("ask");
    const record = lastDecision();
    expect(record.kind).toBe("duty-route");
    expect(record.autonomy).toMatchObject({ band: "ask", asked: true });
    expect(record.autonomy.bands.flow.band).toBe("ask");
    expect(record.autonomy.bands.level.band).toBe("ask");
  });

  it("a card-originated turn is never re-gated - it was routed and authorised already", async () => {
    clearLogs();
    const gw = gatewayFor("implement", 2);
    const pre = await gw.preRoute("run the next phase", { channel: "kanban", sessionId: "t-card" });
    expect(pre.autonomy).toBeNull();
    expect(lastDecision().autonomy).toBeUndefined();
  });

  it("a scheduled/internal turn is never re-gated either", async () => {
    clearLogs();
    const gw = gatewayFor("implement", 2);
    const pre = await gw.preRoute("nightly sweep", { channel: "scheduler" });
    expect(pre.autonomy).toBeNull();
  });

  it("an explicit pin IS the answer - the router does not ask about it", async () => {
    clearLogs();
    const gw = gatewayFor("implement", 2);
    const pre = await gw.preRoute("do the thing", {
      channel: "web",
      sessionId: "t-pin",
      routing: { flow: "fix" }
    });
    expect(pre.autonomy).toBeNull();
    expect(lastDecision().autonomy).toBeUndefined();
  });

  it("fails OPEN: an unavailable consult routes exactly as it did before the seam existed", async () => {
    clearLogs();
    const gw = gatewayFor("implement", 2);
    gw._autonomyLib = null; // the module would not import on this box
    const pre = await gw.preRoute("do the thing", { channel: "web", sessionId: "t-open" });
    expect(pre.autonomy).toBeNull();
    expect(pre.duty).toBe("implement");
    expect(lastDecision().autonomy).toBeUndefined();
  });

  it("an acting band proceeds and enriches the record instead of holding", async () => {
    clearLogs();
    // Enough deliberate confirmations on this shape to clear the upper threshold.
    writeLogs(
      Array.from({ length: 40 }, (_, i) => ({
        id: `fq-trusted-${i}`,
        area: "orchestrator",
        question: "decision-verdict",
        answer: "right",
        original: { duty: "implement" },
        timestamp: new Date(Date.UTC(2026, 6, 2, i, 0, 0)).toISOString(),
        provenance: "decision-verdict"
      })),
      []
    );
    const gw = gatewayFor("implement", 2);
    const pre = await gw.preRoute("do the thing", { channel: "web", sessionId: "t-act" });
    expect(pre.autonomy.ask).toBe(false);
    expect(["act-revert", "act-inform"]).toContain(pre.autonomy.band);
    const record = lastDecision();
    expect(record.autonomy.band).toBe(pre.autonomy.band);
    expect(typeof record.autonomy.bands.flow.confidence).toBe("number");
    clearLogs();
  });
});

// ─────────────────────────────────────────────────────── the hold, on the board

describe("a held card holds, and a go releases it", () => {
  let boardServer: http.Server;
  let gatewayServer: http.Server;
  let base = "";
  let chatPosts = 0;

  async function listen(server: http.Server) {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as { port: number }).port;
  }
  async function jsend(method: string, url: string, body?: unknown) {
    const r = await fetch(base + url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  async function getCard(id: string) {
    return (await jsend("GET", `/cards/${id}`)).body.card;
  }
  // The card SUMMARY carries `eventCount`, never the timeline itself (it can be
  // long): GET /cards/:id hands the detail's full `events` array back beside the
  // card, newest first. Read it from there rather than off the summary.
  async function getCardEvents(id: string): Promise<any[]> {
    const events = (await jsend("GET", `/cards/${id}`)).body.events;
    return Array.isArray(events) ? events : [];
  }
  async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  beforeAll(async () => {
    mkdirSync(path.join(BOARD, "cards"), { recursive: true });
    gatewayServer = http.createServer((req, res) => {
      if (req.method === "POST") {
        if (String(req.url).startsWith("/chat")) chatPosts += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`event: done\ndata: ${JSON.stringify({ reply: "done" })}\n\n`);
        return res.end();
      }
      res.writeHead(200);
      res.end("ok");
    });
    const gatewayUrl = `http://127.0.0.1:${await listen(gatewayServer)}`;

    // @ts-ignore
    const { makeRequestHandler } = await import("../fittings/seed/kanban-loop/scripts/server.mjs");
    // @ts-ignore
    const { seedBoard } = await import("../fittings/seed/kanban-loop/scripts/kanban.mjs");
    // @ts-ignore
    const { saveBoard } = await import("../fittings/seed/kanban-loop/lib/board.mjs");
    const board = seedBoard();
    board.lists.find((l: { id: string }) => l.id === "plan").validNext = ["done"];
    await saveBoard(board, BOARD);
    boardServer = http.createServer(
      makeRequestHandler({ root: BOARD, cwd: BOARD, gatewayUrl, cap: 5 }, path.join(KANBAN, "dist"))
    );
    base = `http://127.0.0.1:${await listen(boardServer)}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => boardServer.close(() => r()));
    await new Promise<void>((r) => gatewayServer.close(() => r()));
  });

  async function createHeld(threadId: string) {
    const created = await jsend("POST", "/cards", {
      title: "held work",
      description: "held work",
      project: "demo",
      goalMode: true,
      originChannel: { channel: "web", threadId },
      duty: "implement",
      level: 2,
      sequence: ["plan"],
      autonomyHeld: true,
      autonomyAsk: {
        question: "I would run this as the fix flow, duty implement, level 2 - I have no track record on this shape yet. Reply go to proceed, or correct me.",
        band: "ask",
        reason: "cold-start",
        flow: "fix",
        duty: "implement",
        level: 2,
        tier: "T1-standard",
        decisionId: "dec-held-1",
        resumeList: "plan"
      }
    });
    expect(created.status).toBe(201);
    return created.body.card ?? created.body;
  }

  it("creates the card HELD in the capture list and poses the question through its origin", async () => {
    const card = await createHeld("hold-1");
    const stored = await getCard(card.id);
    expect(stored.autonomyHeld).toBe(true);
    expect(stored.list).toBe("backlog"); // never on a dispatching list
    expect(stored.autonomyAsk.resumeList).toBe("plan");
    expect((await getCardEvents(card.id)).some((e: any) => e.kind === "autonomy-hold")).toBe(true);

    // @ts-ignore
    const { readOriginEvents } = await import("../fittings/seed/kanban-loop/lib/origins.mjs");
    const posed = await waitFor(() =>
      readOriginEvents(BOARD, "web:hold-1").some((e: any) => e.kind === "needs-input" && e.cardId === card.id)
    );
    expect(posed).toBe(true);
    const event = readOriginEvents(BOARD, "web:hold-1").find((e: any) => e.kind === "needs-input");
    expect(event.detail.questions[0]).toMatch(/reply go to proceed/i);
  });

  it("no dispatch path runs a held card - not the engine seam, not the tick", async () => {
    const card = await createHeld("hold-2");
    // Put it on a dispatching list WITHOUT clearing the hold, which is the state
    // a guard-less implementation would happily run.
    // @ts-ignore
    const { loadCard, saveCardCAS, loadBoard } = await import("../fittings/seed/kanban-loop/lib/board.mjs");
    // @ts-ignore
    const { processCard } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    const disk = { ...(await loadCard(BOARD, card.id)), id: card.id };
    await saveCardCAS(BOARD, { ...disk, list: "plan" }, disk.rev ?? 0, new Date().toISOString());
    const fresh = { ...(await loadCard(BOARD, card.id)), id: card.id };
    const board = await loadBoard(BOARD);

    let ran = false;
    const out = await processCard({
      root: BOARD,
      board,
      card: fresh,
      runFn: async () => ((ran = true), { reply: "done" }),
      cwd: BOARD
    });
    expect(out.outcome).toMatchObject({ status: "skipped", reason: "autonomy-held" });
    expect(ran).toBe(false);

    // A manual Start is a button next to the question, not an answer to it.
    const started = await processCard({
      root: BOARD,
      board,
      card: fresh,
      runFn: async () => ((ran = true), { reply: "done" }),
      cwd: BOARD,
      manualStart: true
    });
    expect(started.outcome.reason).toBe("autonomy-held");
    expect(ran).toBe(false);
  });

  it("a Move clears the hold in the same write, records it, and starts the card", async () => {
    const card = await createHeld("hold-3");
    const before = chatPosts;
    const fresh = await getCard(card.id);
    const moved = await jsend("PATCH", `/cards/${card.id}`, { list: "plan", rev: fresh.rev });
    expect(moved.status).toBe(200);
    const stored = await getCard(card.id);
    expect(stored.autonomyHeld).toBe(false);
    expect(stored.list).toBe("plan");
    expect((await getCardEvents(card.id)).some((e: any) => e.kind === "autonomy-go")).toBe(true);
    // Releasing IS the authorisation to progress: the card runs rather than
    // waiting for a tick to notice it.
    expect(await waitFor(() => chatPosts > before)).toBe(true);
  });

  it("the go is channel-agnostic and never fires on an unheld card", async () => {
    const held = { id: "C1", list: "backlog", autonomyHeld: true, autonomyAsk: { resumeList: "plan" } };
    const free = { id: "C2", list: "backlog", autonomyHeld: false };
    for (const channel of ["web", "omi", "slack"]) {
      const decision = await resolveDiscussInterception({
        text: "go",
        channel,
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: async () => ({ attach: held })
      });
      expect(decision).toEqual({ action: "autonomy-go", card: held });
    }
    expect(
      await resolveDiscussInterception({
        text: "go",
        channel: "web",
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: async () => ({ attach: free })
      })
    ).toBeNull();
    // A sentence containing the word is not a GO. On a HELD card it is the ask's
    // other answer - a correction (2026-08-13) - which is what this sentence
    // plainly is: "check whether the tests pass first" corrects the plan. Before
    // that branch existed this returned null and the sentence was routed as a
    // brand-new turn with none of the thread's context.
    expect(
      await resolveDiscussInterception({
        text: "go ahead and check whether the tests pass first",
        channel: "web",
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: async () => ({ attach: held })
      })
    ).toMatchObject({ action: "autonomy-correct", card: held });
    // On an UNHELD card the same sentence is still an ordinary turn.
    expect(
      await resolveDiscussInterception({
        text: "go ahead and check whether the tests pass first",
        channel: "web",
        sessionId: "t1",
        pendingQuestions: new Map(),
        resolveThreadCard: async () => ({ attach: free })
      })
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────── the acting notice

describe("the acting notice", () => {
  it("is a routable origin kind, and is NOT speech", () => {
    expect(ORIGIN_EVENT_KINDS).toContain("autonomy-acted");
    expect(isAckableEventKind("autonomy-acted")).toBe(false);
  });

  it("offers a concrete revert in the middle band and merely informs in the top one", () => {
    const card = { id: "01CARD", title: "a card" };
    const revert = autonomyActedMessage(card, { band: "act-revert", flow: "fix", level: 2 });
    expect(revert).toContain("Acting on fix L2 (act-revert)");
    expect(revert).toContain("move the card back");
    expect(revert).toContain("/cards/01CARD/abandon");
    const inform = autonomyActedMessage(card, { band: "act-inform", flow: "fix", level: 2 });
    expect(inform).toContain("Acting on fix L2 (act-inform)");
    expect(inform).not.toContain("abandon");
  });

  it("carries an informational question rather than interrupting with it separately", () => {
    const text = autonomyActedMessage({ id: "01CARD", title: "a card" }, {
      band: "act-revert",
      flow: "fix",
      level: 2,
      question: "Still the right shape for this?"
    });
    expect(text).toContain("Still the right shape for this?");
  });

  it("fires once, at the first real dispatch, and never again", async () => {
    // @ts-ignore
    const { saveBoard, loadBoard, loadCard, saveCardCAS, createCard } = await import("../fittings/seed/kanban-loop/lib/board.mjs");
    // @ts-ignore
    const { seedBoard } = await import("../fittings/seed/kanban-loop/scripts/kanban.mjs");
    // @ts-ignore
    const { processCard } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    // @ts-ignore
    const { readOriginEvents } = await import("../fittings/seed/kanban-loop/lib/origins.mjs");

    const root = mkdtempSync(path.join(tmpdir(), "autonomy-notice-"));
    mkdirSync(path.join(root, "cards"), { recursive: true });
    const board = seedBoard();
    board.lists.find((l: { id: string }) => l.id === "plan").validNext = ["done"];
    await saveBoard(board, root);
    const created = await createCard(root, {
      title: "acted work",
      description: "acted work",
      project: "demo",
      list: "plan",
      originChannel: { channel: "web", threadId: "acted-1" }
    });
    const withBand = {
      ...(await loadCard(root, created.id)),
      id: created.id,
      list: "plan",
      autonomy: { band: "act-revert", flow: "fix", duty: "implement", level: 2 }
    };
    await saveCardCAS(root, withBand, withBand.rev ?? 0, new Date().toISOString());

    const live = await loadBoard(root);
    const first = { ...(await loadCard(root, created.id)), id: created.id };
    await processCard({ root, board: live, card: first, runFn: async () => ({ reply: "next: done" }), cwd: root });

    const events = () => readOriginEvents(root, "web:acted-1").filter((e: any) => e.kind === "autonomy-acted");
    expect(events().length).toBe(1);
    expect(events()[0].detail).toMatchObject({ band: "act-revert", flow: "fix" });
    const stamped = await loadCard(root, created.id);
    expect(typeof stamped.autonomyNoticedAt).toBe("string");

    // A second dispatch of the same card announces nothing: the stamp rode into
    // the acquire CAS, so "announced" and "running" became true together.
    const again = { ...(await loadCard(root, created.id)), id: created.id, list: "plan", status: "ok" };
    await saveCardCAS(root, again, again.rev ?? 0, new Date().toISOString());
    const rerun = { ...(await loadCard(root, created.id)), id: created.id };
    await processCard({ root, board: live, card: rerun, runFn: async () => ({ reply: "next: done" }), cwd: root });
    expect(events().length).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });
});
