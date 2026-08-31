// The number of adversarial reviews a task takes was a free per-stretch choice
// by the model: three runs of the same easy task took zero, one and two passes
// and swung 2.4x in cost. The GATE decides whether a change is worth a second
// read; the BUDGET is the ceiling on how many second reads the task may buy.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { applyFlowPolicy, reviewBudgetFor, reviewBudgetDecision, reviewsUsed, reviewsRequested, runConversation, REVIEW_BUDGET_DEFAULT, REVIEW_GATE } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

let tmp: string;
let env: Record<string, string>;
let proof: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "review-budget-"));
  env = { GARRISON_HOME: tmp };
  proof = path.join(tmp, "evidence.md");
  writeFileSync(proof, "tests pass");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const DUTIES = ["implement", "adversarial-review", "review", "test"];
const started = (duty: string) => ({ kind: "stretch-started", duty, payload: { duty } });
const bigWrite = (stretch: string, id: string) => ({
  kind: "session-event",
  stretch,
  payload: { id, blocks: [{ type: "tool_use", toolUseId: id, name: "Write", input: JSON.stringify({ file_path: "/p/a.ts", content: "x".repeat(REVIEW_GATE.changedBytes + 1) }) }] },
});

describe("reviewBudgetFor", () => {
  it("defaults to two", () => {
    expect(reviewBudgetFor({ env: {} })).toEqual({ cap: REVIEW_BUDGET_DEFAULT, source: "default" });
    expect(REVIEW_BUDGET_DEFAULT).toBe(2);
  });

  it("config sets it, and a large number disables the cap", () => {
    expect(reviewBudgetFor({ env: { GARRISON_HTTPGATEWAY_REVIEW_BUDGET: "0" } })).toEqual({ cap: 0, source: "config" });
    expect(reviewBudgetFor({ env: { GARRISON_HTTPGATEWAY_REVIEW_BUDGET: "9999" } }).cap).toBe(9999);
  });

  it("reads the override out of the conversation's own messages too", () => {
    const store = openConversation("rb-brief", { role: "gateway", env });
    store.append({ kind: "user-message", payload: { text: "build the thing\nreview budget: 0" } });
    expect(reviewBudgetDecision(store, { env }).cap).toBe(0);
  });

  it("a task overrides it in its own brief, and routing wins over prose", () => {
    expect(reviewBudgetFor({ card: { description: "Do the thing.\nreview budget: 0\n" }, env: {} })).toEqual({ cap: 0, source: "brief" });
    expect(reviewBudgetFor({ card: { acceptance: "Review budget = 4" }, env: {} }).cap).toBe(4);
    expect(reviewBudgetFor({ card: { description: "review budget: 4", routing: { reviewBudget: 1 } }, env: {} }))
      .toEqual({ cap: 1, source: "card.routing.reviewBudget" });
  });
});

describe("counting off the ledger", () => {
  it("counts review stretches that started, and asks that were made", () => {
    const store = openConversation("rb-count", { role: "gateway", env });
    store.append(started("implement"));
    store.append(started("adversarial-review"));
    store.append(started("review"));
    expect(reviewsUsed(store)).toBe(2);
    store.append({ kind: "handoff", duty: "implement", payload: { nextSteps: { next: "adversarial-review" } } });
    store.append({ kind: "handoff", duty: "implement", payload: { nextSteps: { next: "done" } } });
    expect(reviewsRequested(store)).toBe(1);
  });
});

describe("applyFlowPolicy with the budget", () => {
  it("lets the model have its reviews while it is inside the budget", () => {
    const store = openConversation("rb-1", { role: "gateway", env });
    store.append(started("adversarial-review"));
    const res = applyFlowPolicy("adversarial-review", { store, duty: "implement", selectedDuties: DUTIES, env });
    expect(res).toMatchObject({ next: "adversarial-review", rewritten: false });
  });

  it("converts the ask to done once the budget is spent, and says how many were asked for", () => {
    const store = openConversation("rb-2", { role: "gateway", env });
    store.append(started("adversarial-review"));
    store.append(started("adversarial-review"));
    store.append({ kind: "handoff", duty: "implement", payload: { nextSteps: { next: "adversarial-review" } } });
    store.append({ kind: "handoff", duty: "review", payload: { status: "complete", evidenceRefs: [{ kind: "run", ref: proof }] } });
    const res = applyFlowPolicy("adversarial-review", { store, duty: "adversarial-review", selectedDuties: DUTIES, cwd: tmp, env });
    expect(res.next).toBe("done");
    expect(res.rewritten).toBe(true);
    expect(res.reviewBudget).toMatchObject({ cap: 2, used: 2, trigger: "asked", from: "adversarial-review", to: "done" });
    expect(res.reviewBudget.requested).toBeGreaterThanOrEqual(2);
    expect(res.reason).toContain("review-budget");
  });

  it("a cap of zero also stops the orchestrator inserting one before done", () => {
    const store = openConversation("rb-3", { role: "gateway", env });
    store.append(bigWrite("st_1", "t1"));
    store.append({ kind: "handoff", duty: "implement", payload: { status: "complete", evidenceRefs: [{ kind: "run", ref: proof }] } });
    const res = applyFlowPolicy("done", {
      store, duty: "implement", selectedDuties: DUTIES, cwd: tmp, stretchId: "st_1",
      handoff: { status: "complete" }, card: { description: "review budget: 0" }, env,
    });
    expect(res.next).toBe("done");
    expect(res.reviewBudget).toMatchObject({ cap: 0, used: 0, trigger: "insert" });
    expect(res.skippedReview).toContain("review budget spent");
  });

  it("without the cap that same change would have been sent to review", () => {
    const store = openConversation("rb-4", { role: "gateway", env });
    store.append(bigWrite("st_1", "t1"));
    store.append({ kind: "handoff", duty: "implement", payload: { status: "complete", evidenceRefs: [{ kind: "run", ref: proof }] } });
    const res = applyFlowPolicy("done", {
      store, duty: "implement", selectedDuties: DUTIES, cwd: tmp, stretchId: "st_1",
      handoff: { status: "complete" }, env,
    });
    expect(res.next).toBe("adversarial-review");
    expect(res.reviewBudget).toBeFalsy();
  });

  it("the budget buys no shortcut past done-requires-evidence", () => {
    const store = openConversation("rb-5", { role: "gateway", env });
    store.append(started("adversarial-review"));
    store.append(started("adversarial-review"));
    const res = applyFlowPolicy("adversarial-review", { store, duty: "adversarial-review", selectedDuties: DUTIES, cwd: tmp, env });
    expect(res.next).toBe("test");
    expect(res.reviewBudget).toBeTruthy();
  });
});

describe("the loop with a brief that sets the cap to zero", () => {
  it("runs no review stretch and leaves the reason in the ledger", async () => {
    const LADDER = {
      ladder: "standard",
      rungs: [{ id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "haiku", params: {} }],
      defaultIndex: 0,
      ceilingIndex: 0,
    };
    // implement always asks for another adversarial review; only the budget can stop it.
    const script: Record<string, any> = {
      implement: { next: "adversarial-review", status: "complete" },
      "adversarial-review": { next: "adversarial-review", status: "complete" },
    };
    const duties: string[] = [];
    const gateway = {
      compositionDir: tmp,
      logFn: () => {},
      _laneQueues: new Map(),
      _onLane(key: string, fn: () => Promise<unknown>) {
        const prev = this._laneQueues.get(key) ?? Promise.resolve();
        const run = prev.catch(() => {}).then(fn);
        this._laneQueues.set(key, run.catch(() => {}));
        return run;
      },
      async executionModel() {
        return {
          version: 3,
          selectedDuties: ["implement", "adversarial-review", "test"],
          duties: {},
          dutyLadder: { implement: LADDER, "adversarial-review": LADDER, test: LADDER },
        };
      },
      async executionRouteFor({ duty, level }: any) {
        return { targetId: "t", target: { id: "t", runtime: "agent-sdk", provider: "anthropic", model: "haiku", effort: "low", type: "runtime-target" }, duty, level, skill: null };
      },
      async runAgentSdkTurn(route: any, brief: string) {
        duties.push(route.duty);
        const handoffPath = /handoffPath: (.+)/.exec(brief)![1].trim();
        const stretchId = /stretchId: (.+)/.exec(brief)![1].trim();
        const plan = script[route.duty] ?? { next: "done", status: "complete" };
        writeFileSync(handoffPath, JSON.stringify({
          v: 1, stretchId, duty: route.duty, status: plan.status, summary: "did it",
          evidenceRefs: [{ kind: "run", ref: proof }], nextSteps: { next: plan.next, why: "w", items: [] },
          blocker: null, activeConstraints: [], failedApproaches: [], surprises: [],
          forceEscalation: null, synthesized: false,
        }));
        return { reply: "ok", session_id: "sid", usedTokens: 1, model: route.target.model };
      },
      async releaseConversationSessions() { return 1; },
    };
    // The card IS the brief; this one sets the cap to zero in its own body.
    const store = openConversation("rb-loop", { role: "gateway", env });
    store.init({ title: "capped" });
    store.append({ kind: "handoff", duty: "triage", payload: { v: 1, status: "complete", summary: "start", evidenceRefs: [], nextSteps: { next: "implement", why: "w", items: [] } } });
    const result = await runConversation(gateway as never, {
      conversationId: "rb-loop",
      task: "build the thing\nreview budget: 0",
      env,
    });

    expect(duties).toContain("implement");
    expect(duties.filter((d) => d === "adversarial-review"), "no review stretch may run").toEqual([]);
    expect(result.terminal).toBe("done");
    const events = openConversation("rb-loop", { env }).tail(200);
    const bit = events.find((e: any) => e.kind === "review-budget");
    expect(bit, "the ledger says the budget bit").toBeTruthy();
    expect(bit.payload).toMatchObject({ cap: 0, used: 0, allowed: false, to: "done" });
    expect(bit.payload.requested).toBeGreaterThanOrEqual(1);
  }, 20000);
});
