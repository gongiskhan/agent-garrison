// The stretch launcher's pure core: rung resolution precedence, store-derived
// tripwires, the two flow-policy invariants, and the full conversation loop
// against a fake gateway whose "model" writes handoff files like a real
// stretch would.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";
// @ts-ignore — pure .mjs
import { resolveRung, tripwires, applyFlowPolicy, buildStretchBrief, runConversation, recordUserMessage, makeStretchEventTee, TRIPWIRE_NO_PROGRESS, TRIPWIRE_TEST_FAILS } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

let tmp: string;
let env: Record<string, string>;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "stretch-"));
  env = { GARRISON_HOME: tmp };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const LADDER = {
  ladder: "standard",
  rungs: [
    { id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", params: {} },
    { id: "middle", target: "cc-sonnet", runtime: "agent-sdk", provider: "anthropic", model: "sonnet", params: {} },
    { id: "top", target: "cc-opus", runtime: "agent-sdk", provider: "anthropic", model: "opus", params: {} },
  ],
  defaultIndex: 1,
  ceilingIndex: 2,
};

describe("resolveRung", () => {
  it("default → the duty default; sticky floor wins over default", () => {
    expect(resolveRung({ ladder: LADDER })).toMatchObject({ index: 1, chosenBy: "default" });
    expect(resolveRung({ ladder: LADDER, floorRungId: "top" })).toMatchObject({ index: 2, chosenBy: "floor" });
  });

  it("tripwire raises one rung above the floor; forced escalation too; pin overrides", () => {
    expect(resolveRung({ ladder: LADDER, tripwire: "no-progress" })).toMatchObject({
      index: 2,
      chosenBy: "escalation-tripwire",
      chosenWhy: "no-progress",
    });
    expect(resolveRung({ ladder: LADDER, forced: "review demanded it" })).toMatchObject({
      index: 2,
      chosenBy: "escalation-forced",
    });
    expect(resolveRung({ ladder: LADDER, tripwire: "no-progress", pinRungId: "floor" })).toMatchObject({
      index: 0,
      chosenBy: "pin",
    });
  });

  it("clamps to the ceiling and says so; top rung sets the notify flag", () => {
    const capped = { ...LADDER, ceilingIndex: 1 };
    expect(resolveRung({ ladder: capped, tripwire: "test-fail" })).toMatchObject({
      index: 1,
      chosenBy: "ceiling-clamp",
      clamped: true,
    });
    expect(resolveRung({ ladder: LADDER, floorRungId: "top" })!.notify).toBe("top-tier");
    expect(resolveRung({ ladder: LADDER })!.notify).toBeNull();
    // a one-rung synthetic ladder never notifies
    const single = { ladder: "synthetic", rungs: [LADDER.rungs[0]], defaultIndex: 0, ceilingIndex: 0 };
    expect(resolveRung({ ladder: single })!.notify).toBeNull();
  });
});

describe("tripwires", () => {
  function handoff(store: any, duty: string, status: string, evidence: any[] = []) {
    store.append({ kind: "handoff", duty, payload: { status, evidenceRefs: evidence, nextSteps: { next: duty } } });
  }

  it("no-progress: 3 same-duty non-complete handoffs without new evidence fire", () => {
    const store = openConversation("t1", { role: "gateway", env });
    handoff(store, "implement", "partial");
    handoff(store, "implement", "partial");
    expect(tripwires(store, { duty: "implement" }).fires).toBeNull();
    handoff(store, "implement", "failed");
    const w = tripwires(store, { duty: "implement" });
    expect(w.noProgress).toBeGreaterThanOrEqual(TRIPWIRE_NO_PROGRESS);
    expect(w.fires).toBe("no-progress");
    // a complete handoff resets
    handoff(store, "implement", "complete");
    expect(tripwires(store, { duty: "implement" }).fires).toBeNull();
  });

  it("new evidence between attempts resets the no-progress count", () => {
    const store = openConversation("t2", { role: "gateway", env });
    handoff(store, "implement", "partial", [{ kind: "file", ref: "/a" }]);
    handoff(store, "implement", "partial", [{ kind: "file", ref: "/b" }]);
    handoff(store, "implement", "partial", [{ kind: "file", ref: "/c" }]);
    expect(tripwires(store, { duty: "implement" }).fires).toBeNull();
  });

  it("test-fail: 2 consecutive gate-duty failures fire", () => {
    const store = openConversation("t3", { role: "gateway", env });
    handoff(store, "test", "failed");
    expect(tripwires(store, { duty: "implement" }).fires).toBeNull();
    handoff(store, "test", "partial");
    const w = tripwires(store, { duty: "implement" });
    expect(w.testFails).toBe(TRIPWIRE_TEST_FAILS);
    expect(w.fires).toBe("test-fail");
  });
});

describe("applyFlowPolicy", () => {
  it("implement → done is rewritten to review-before-done", () => {
    const store = openConversation("f1", { role: "gateway", env });
    const res = applyFlowPolicy("done", { store, duty: "implement", selectedDuties: ["implement", "adversarial-review", "test"] });
    expect(res).toMatchObject({ next: "adversarial-review", rewritten: true, reason: "review-before-done" });
  });

  it("done without resolvable gate/run evidence is rewritten to test", () => {
    const store = openConversation("f2", { role: "gateway", env });
    store.append({ kind: "handoff", duty: "review", payload: { status: "complete", evidenceRefs: [] } });
    const res = applyFlowPolicy("done", { store, duty: "review", selectedDuties: ["review", "test"] });
    expect(res).toMatchObject({ next: "test", rewritten: true, reason: "done-without-evidence" });
  });

  it("done with a resolvable run ref passes", () => {
    const store = openConversation("f3", { role: "gateway", env });
    const proof = path.join(tmp, "evidence.md");
    writeFileSync(proof, "proof");
    store.append({ kind: "handoff", duty: "review", payload: { status: "complete", evidenceRefs: [{ kind: "run", ref: proof }] } });
    expect(applyFlowPolicy("done", { store, duty: "review", selectedDuties: ["review", "test"] }).rewritten).toBe(false);
  });

  it("a non-done next is never rewritten", () => {
    const store = openConversation("f4", { role: "gateway", env });
    expect(applyFlowPolicy("implement", { store, duty: "triage", selectedDuties: ["implement"] }).rewritten).toBe(false);
  });
});

describe("buildStretchBrief", () => {
  it("carries the summary, the exit contract, the absolute handoff path and the duty", () => {
    const brief = buildStretchBrief({
      conversationId: "c1",
      conversationDir: "/x/conversations/c1",
      summaryText: "# T\n## Objective\nspin",
      duty: "implement",
      level: 2,
      handoffPath: "/x/conversations/c1/handoffs/0003.json",
      stretchId: "st_1",
      selectedDuties: ["implement", "review"],
      userMessages: ["please also fix the header"],
    });
    expect(brief).toContain("## Objective");
    expect(brief).toContain("Exit contract (MANDATORY)");
    expect(brief).toContain("handoffPath: /x/conversations/c1/handoffs/0003.json");
    expect(brief).toContain("Your duty: implement (level 2");
    expect(brief).toContain("please also fix the header");
    expect(brief).toContain('selected duties for "next": implement, review, done, needs-input');
  });
});

// ── the loop against a fake gateway ─────────────────────────────────────────

function fakeGateway(script: Record<string, (brief: string) => any>, opts: { evidenceFile?: string } = {}) {
  const calls: any[] = [];
  const model = {
    version: 3,
    selectedDuties: ["triage", "responder", "implement", "adversarial-review", "test", "review"],
    duties: {
      triage: { description: "Read the request, write the objective, name the first duty." },
      implement: { description: "Write the code." },
      "adversarial-review": { description: "Refute the work." },
    },
    dutyLadder: {
      triage: { ...LADDER, defaultIndex: 0, ceilingIndex: 1 },
      responder: { ...LADDER, defaultIndex: 0, ceilingIndex: 1 },
      implement: LADDER,
      "adversarial-review": {
        ladder: "adversarial",
        rungs: [{ id: "cross", target: "sol", runtime: "codex", provider: "openai", model: "gpt-5.6-sol", params: { type: "secondary" } }],
        defaultIndex: 0,
        ceilingIndex: 0,
      },
      test: LADDER,
      review: LADDER,
    },
  };
  const writeHandoffFromBrief = (brief: string, duty: string) => {
    const handoffPath = /handoffPath: (.+)/.exec(brief)![1].trim();
    const stretchId = /stretchId: (.+)/.exec(brief)![1].trim();
    const make = script[duty];
    if (!make) throw new Error(`fake model has no script for duty ${duty}`);
    const handoff = make(brief);
    handoff.v = 1;
    handoff.stretchId = stretchId;
    handoff.duty = duty;
    writeFileSync(handoffPath, JSON.stringify(handoff));
    return `did ${duty}`;
  };
  const gateway = {
    compositionDir: opts.evidenceFile ? path.dirname(opts.evidenceFile) : "/tmp",
    logFn: (e: any) => calls.push({ log: e }),
    _laneQueues: new Map(),
    _onLane(key: string, fn: () => Promise<any>) {
      const prev = this._laneQueues.get(key) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(fn);
      this._laneQueues.set(key, run.catch(() => {}));
      return run;
    },
    async executionModel() {
      return model;
    },
    async executionRouteFor({ duty, level }: any) {
      return {
        targetId: "cell-target",
        target: { id: "cell-target", runtime: "agent-sdk", provider: "anthropic", model: "sonnet", effort: "high", type: "runtime-target" },
        duty,
        level,
        skill: null,
      };
    },
    async runAgentSdkTurn(route: any, brief: string, _onChunk: any, o: any = {}) {
      calls.push({ lane: "agent-sdk", duty: route.duty, model: route.target.model, sessionKey: o.sessionKey });
      const reply = writeHandoffFromBrief(brief, route.duty);
      return { reply, session_id: `sid-${calls.length}`, usedTokens: 111, model: route.target.model };
    },
    async runSecondaryTurn(route: any, brief: string) {
      calls.push({ lane: "secondary", duty: route.duty, runtime: route.target.runtime, model: route.target.model });
      const reply = writeHandoffFromBrief(brief, route.duty);
      return { reply, session_id: null, model: route.target.model };
    },
    async releaseConversationSessions(sessionKey: string) {
      calls.push({ released: sessionKey });
      return 1;
    },
  };
  return { gateway, calls, model };
}

describe("runConversation", () => {
  it("drives triage → implement → review(codex) → done, with review-before-done and evidence enforced", async () => {
    const proof = path.join(tmp, "evidence.md");
    writeFileSync(proof, "tests pass, screenshot attached");
    const base = {
      status: "complete",
      summary: "step done",
      evidenceRefs: [],
      nextSteps: { next: "done", why: "w", items: [] },
      blocker: null,
      activeConstraints: ["no new branches"],
      failedApproaches: [],
      surprises: [],
      forceEscalation: null,
      synthesized: false,
    };
    const { gateway, calls } = fakeGateway(
      {
        triage: () => ({ ...base, summary: "objective set", nextSteps: { next: "implement", why: "work to do", items: [] } }),
        implement: () => ({
          ...base,
          summary: "code written",
          evidenceRefs: [{ kind: "run", ref: proof }],
          nextSteps: { next: "done", why: "looks complete", items: [] }, // policy must rewrite to review
        }),
        "adversarial-review": () => ({
          ...base,
          summary: "review found nothing",
          evidenceRefs: [{ kind: "run", ref: proof }],
          nextSteps: { next: "done", why: "verified", items: [] },
        }),
      },
      { evidenceFile: proof }
    );
    const frames: any[] = [];
    const result = await runConversation(gateway as any, {
      conversationId: "conv-loop",
      task: "make the widget spin",
      env,
      onFrame: (n: string, d: any) => frames.push({ n, d }),
    });
    expect(result.terminal).toBe("done");
    expect(result.stretches).toBe(3);
    // the review stretch really took the codex lane
    expect(calls.filter((c) => c.lane === "secondary")).toHaveLength(1);
    expect(calls.find((c) => c.lane === "secondary")).toMatchObject({ runtime: "codex", model: "gpt-5.6-sol" });
    // every agent-sdk stretch got a fresh stretch-keyed session and was released
    const sdkCalls = calls.filter((c) => c.lane === "agent-sdk");
    expect(sdkCalls.every((c) => String(c.sessionKey).startsWith("stretch:st_"))).toBe(true);
    expect(calls.filter((c) => c.released).length).toBeGreaterThanOrEqual(sdkCalls.length);
    // the store carries the whole record
    const store = openConversation("conv-loop", { env });
    const kinds = store.tail(100).map((e: any) => e.kind);
    expect(kinds).toContain("conversation-opened");
    expect(kinds).toContain("user-message");
    expect(kinds.filter((k: string) => k === "stretch-started")).toHaveLength(3);
    expect(kinds.filter((k: string) => k === "stretch-ended")).toHaveLength(3);
    expect(kinds.filter((k: string) => k === "handoff")).toHaveLength(3);
    expect(kinds).toContain("policy-rewrite"); // implement→done rewritten to review
    // L1 got maintained by the exit gate
    const summary = store.parseSummary();
    expect(summary!.currentState).toContain("adversarial-review/complete");
    expect(summary!.activeConstraints).toContain("no new branches");
    // frames mirror the ledger
    expect(frames.map((f) => f.n)).toContain("stretch-started");
    expect(frames[frames.length - 1]).toMatchObject({ n: "done", d: { terminal: "done" } });
  }, 20000);

  it("a responder stretch answers a user message on a settled conversation without touching cards", async () => {
    const { gateway } = fakeGateway({
      triage: () => ({
        status: "complete",
        summary: "answered directly",
        evidenceRefs: [],
        nextSteps: { next: "needs-input", why: "waiting on the user", items: [] },
        blocker: { what: "user answer", needs: "a reply", who: "user" },
        activeConstraints: [],
        failedApproaches: [],
        surprises: [],
        forceEscalation: null,
        synthesized: false,
      }),
      responder: () => ({
        status: "complete",
        summary: "answered the follow-up; committed to nothing new",
        evidenceRefs: [],
        nextSteps: { next: "needs-input", why: "conversation settles again", items: [] },
        blocker: { what: "user", needs: "next question", who: "user" },
        activeConstraints: [],
        failedApproaches: [],
        surprises: [],
        forceEscalation: null,
        synthesized: false,
      }),
    });
    // first run settles the conversation at needs-input
    await runConversation(gateway as any, { conversationId: "conv-resp", task: "hello", env });
    const store = openConversation("conv-resp", { role: "web", env });
    recordUserMessage(store, { text: "one more question", origin: "web" });
    const result = await runConversation(gateway as any, { conversationId: "conv-resp", env });
    expect(result.stretches).toBe(1);
    const started = store.tail(50, { kinds: ["stretch-started"] });
    expect(started[started.length - 1].duty).toBe("responder");
  }, 20000);

  it("an unproductive duty escalates through the tripwire and the floor sticks in L1", async () => {
    let attempt = 0;
    const models: string[] = [];
    const { gateway } = fakeGateway({
      triage: () => ({
        status: "complete",
        summary: "to implement",
        evidenceRefs: [],
        nextSteps: { next: "implement", why: "w", items: [] },
        blocker: null,
        activeConstraints: [],
        failedApproaches: [],
        surprises: [],
        forceEscalation: null,
        synthesized: false,
      }),
      implement: () => {
        attempt += 1;
        if (attempt <= 4) {
          return {
            status: "partial",
            summary: `attempt ${attempt} went nowhere`,
            evidenceRefs: [],
            nextSteps: { next: "implement", why: "try again", items: [] },
            blocker: null,
            activeConstraints: [],
            failedApproaches: [{ approach: `attempt ${attempt}`, why: "no progress" }],
            surprises: [],
            forceEscalation: null,
            synthesized: false,
          };
        }
        return {
          status: "complete",
          summary: "finally",
          evidenceRefs: [],
          nextSteps: { next: "needs-input", why: "confirm before done", items: [] },
          blocker: { what: "confirmation", needs: "user look", who: "user" },
          activeConstraints: [],
          failedApproaches: [],
          surprises: [],
          forceEscalation: null,
          synthesized: false,
        };
      },
    });
    const realRun = gateway.runAgentSdkTurn.bind(gateway);
    gateway.runAgentSdkTurn = async (route: any, brief: string, onChunk: any, o: any) => {
      if (route.duty === "implement") models.push(route.target.model);
      return realRun(route, brief, onChunk, o);
    };
    const result = await runConversation(gateway as any, { conversationId: "conv-esc", task: "hard thing", env });
    expect(result.terminal).toBe("needs-input");
    // after 3 no-progress handoffs the tripwire must move implement off the default rung
    expect(models.slice(0, 3).every((m) => m === "sonnet")).toBe(true);
    expect(models).toContain("opus");
    const store = openConversation("conv-esc", { env });
    expect(store.tail(50, { kinds: ["escalation"] }).length).toBeGreaterThanOrEqual(1);
    const floor = store.parseSummary()!.escalationFloor;
    expect(floor.implement?.rung).toBe("top");
  }, 20000);
});

// The transcript tee: without it the store — the single source of truth the UI
// renders — carries only ledger boundaries, and a conversation reads as
// "stretch started … handoff … stretch ended" with the assistant's prose
// reachable nowhere (found live by the web-channel integration).
describe("makeStretchEventTee — the stretch transcript reaches the store", () => {
  it("throttles revisions per event id and flush()es the final state", () => {
    const store = openConversation("tee-1", { role: "gateway", env });
    store.init({ title: "tee" });
    let t = 0;
    const tee = makeStretchEventTee(store, { stretchId: "st_t1", duty: "implement", throttleMs: 1000, now: () => t });
    const ev = (text: string) => ({ id: "blk-1", ts: "2026-08-27T00:00:00Z", role: "assistant", blocks: [{ type: "text", text }] });
    tee.event(ev("hel"));
    t = 200; tee.event(ev("hello"));
    t = 400; tee.event(ev("hello wor"));
    tee.flush();
    const recs = store.tail(50, { kinds: ["session-event"] });
    expect(recs).toHaveLength(2); // first append + the flushed final, never one per revision
    expect(recs[0].payload.blocks[0].text).toBe("hel");
    expect(recs[1].payload.blocks[0].text).toBe("hello wor");
    expect(recs.every((r: any) => r.stretch === "st_t1")).toBe(true);
  });

  it("synthesizes ONE text event from exec-lane chunks, honouring replace", () => {
    const store = openConversation("tee-2", { role: "gateway", env });
    store.init({ title: "tee" });
    let t = 0;
    const tee = makeStretchEventTee(store, { stretchId: "st_t2", duty: "adversarial-review", syntheticFromChunks: true, throttleMs: 1000, now: () => t });
    tee.chunk("part one", false);
    t = 2000; tee.chunk(" and two", false);
    t = 2100; tee.chunk("a fresh copy", true);
    tee.flush();
    const recs = store.tail(50, { kinds: ["session-event"] });
    expect(recs.at(-1).payload.blocks[0].text).toBe("a fresh copy");
    expect(new Set(recs.map((r: any) => r.payload.id)).size).toBe(1); // one synthetic event, revised
  });

  it("ignores chunks when real session events carry the prose (agent-sdk lane)", () => {
    const store = openConversation("tee-3", { role: "gateway", env });
    store.init({ title: "tee" });
    const tee = makeStretchEventTee(store, { stretchId: "st_t3", duty: "implement", syntheticFromChunks: false, now: () => 0 });
    tee.chunk("streamed text", false);
    tee.flush();
    expect(store.tail(50, { kinds: ["session-event"] })).toHaveLength(0);
  });

  it("caps oversized block text below the store's spill threshold — a spilled event is unrenderable", () => {
    const store = openConversation("tee-4", { role: "gateway", env });
    store.init({ title: "tee" });
    const tee = makeStretchEventTee(store, { stretchId: "st_t4", duty: "implement", now: () => 0 });
    tee.event({ id: "big", ts: "2026-08-27T00:00:00Z", role: "assistant", blocks: [{ type: "text", text: "x".repeat(100_000) }] });
    const rec = store.tail(5, { kinds: ["session-event"] })[0];
    expect(rec.payload.spilled).toBeUndefined();
    expect(rec.payload.blocks[0].text.length).toBeLessThan(64_000);
    expect(rec.payload.blocks[0].text).toContain("truncated for the ledger");
  });
});

describe("message routing pin — the Turn Rail reaches the rung", () => {
  it("a routing pin on the user message decides the responder's rung", async () => {
    const settled = (summary: string) => ({
      status: "complete",
      summary,
      evidenceRefs: [],
      nextSteps: { next: "needs-input", why: "waiting on the user", items: [] },
      blocker: { what: "user answer", needs: "a reply", who: "user" },
      activeConstraints: [],
      failedApproaches: [],
      surprises: [],
      forceEscalation: null,
      synthesized: false,
    });
    const { gateway } = fakeGateway({
      triage: () => settled("opened"),
      responder: () => settled("answered with the pinned model"),
    });
    await runConversation(gateway as any, { conversationId: "conv-pin", task: "hello", env });
    const store = openConversation("conv-pin", { role: "web", env });
    recordUserMessage(store, { text: "answer harder", origin: "web", routing: { rung: "middle" }, context: "the card brief says: settings tab" });
    await runConversation(gateway as any, { conversationId: "conv-pin", env });
    const started = store.tail(50, { kinds: ["stretch-started"] });
    const last = started.at(-1);
    expect(last.duty).toBe("responder");
    expect(last.payload.chosenBy).toBe("pin");
    expect(last.payload.rung.id).toBe("middle");
  }, 20000);
});
