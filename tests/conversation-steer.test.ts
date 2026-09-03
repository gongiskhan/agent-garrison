// Steering a stretch in flight (2026-09-03). A message typed into a WORKING card
// used to be recorded "queued" and read only by the brief after the stretch -
// minutes later, on a runtime that had already committed to the wrong path.
// Steering is what typing into a working Claude Code session does: the turn in
// flight stops, and the same duty continues with the new instruction in front
// of it. It is neither a cancel (the loop goes on) nor a failure (no exit gate,
// no repair, no needs-input, no tripwire).
//
// The second suite pins the responder's card transitions: a message on a DONE
// card puts the card on Running while the responder works, settles it back to
// done after a question, and re-opens the work on the duty a follow-up asks for.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-ignore — pure .mjs (single-line on purpose: @ts-ignore only covers the next line)
import { runConversation, recordUserMessage, steerRunningStretch, steerableStretch, tripwires, steeredHandoff, applyFlowPolicy } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";
// @ts-ignore — pure .mjs
import { openConversation } from "../packages/claude-pty/src/conversation-store.mjs";

const CARD = "01M1STEERCARD0000000000001";
const LADDER = {
  ladder: "standard",
  rungs: [{ id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "haiku", params: {} }],
  defaultIndex: 0,
  ceilingIndex: 0,
};

let tmp: string;
let env: Record<string, string>;
let server: Server | undefined;
let prevHome: string | undefined;
let patches: Array<Record<string, unknown>>;
let boardCard: Record<string, unknown>;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "conv-steer-"));
  env = { GARRISON_HOME: tmp };
  mkdirSync(path.join(tmp, "ui-fittings"), { recursive: true });
  prevHome = process.env.GARRISON_HOME;
  process.env.GARRISON_HOME = tmp;
  patches = [];
  boardCard = { id: CARD, rev: 1, title: "t", list: "running", status: "running", conversationId: CARD, autonomous: true };
});

afterEach(() => {
  process.env.GARRISON_HOME = prevHome;
  server?.close();
  server = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

// A board that answers every read with the same card and REMEMBERS every
// engine PATCH, so a test can assert the exact list/status sequence a
// conversation wrote onto its card.
function startBoard(): Promise<number> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "PATCH") {
        const patch = JSON.parse(body || "{}");
        patches.push(patch);
        boardCard = { ...boardCard, ...patch, rev: Number(boardCard.rev ?? 0) + 1 };
        res.end(JSON.stringify({ ok: true, card: boardCard }));
        return;
      }
      res.end(JSON.stringify({ ok: true, card: boardCard, checklist: [], attachments: [] }));
    });
  });
  return new Promise((resolve) => server!.listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port)));
}

function handoffFor(brief: string, duty: string, next: string, extra: Record<string, unknown> = {}) {
  const handoffPath = /handoffPath: (.+)/.exec(brief)![1].trim();
  const stretchId = /stretchId: (.+)/.exec(brief)![1].trim();
  writeFileSync(handoffPath, JSON.stringify({
    v: 1, stretchId, duty, status: "complete", summary: `${duty} done`,
    evidenceRefs: [], nextSteps: { next, why: "w", items: [] },
    blocker: next === "needs-input" ? { what: "a look", needs: "user", who: "user" } : null,
    activeConstraints: [], failedApproaches: [], surprises: [], forceEscalation: null, synthesized: false,
    ...extra,
  }));
}

function fakeGateway(selectedDuties: string[], runTurn: (route: any, brief: string, opts: any) => Promise<any>) {
  const ladders = Object.fromEntries(selectedDuties.map((d) => [d, LADDER]));
  return {
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
      return { version: 3, selectedDuties, duties: {}, dutyLadder: ladders };
    },
    async executionRouteFor({ duty, level }: any) {
      return { targetId: "t", target: { id: "t", runtime: "agent-sdk", provider: "anthropic", model: "haiku", effort: "low", type: "runtime-target" }, duty, level, skill: null };
    },
    runAgentSdkTurn: (route: any, brief: string, _onChunk: unknown, opts: any) => runTurn(route, brief, opts),
    async releaseConversationSessions() { return 1; },
  };
}

const foldRepeats = (xs: unknown[]) => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);

const until = async (pred: () => boolean, ms = 5000) => {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("steering a stretch in flight", () => {
  it("interrupts the running stretch and re-runs the SAME duty with the message in its brief", async () => {
    const port = await startBoard();
    writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    const briefs: string[] = [];
    let stopCalls = 0;
    const gateway = fakeGateway(["implement", "responder"], async (route, brief, opts) => {
      briefs.push(brief);
      if (briefs.length === 1) {
        // The first implement stretch "works" until its stop primitive fires -
        // exactly the seam the adapter's cancel goes through.
        await new Promise<void>((resolve) => {
          opts.registerStop(() => { stopCalls += 1; resolve(); });
        });
        // A stopped turn settles with what it had streamed so far.
        return { reply: "half-way through the wrong approach", session_id: "sid-1", usedTokens: 3, model: route.target.model };
      }
      handoffFor(brief, route.duty, "needs-input");
      return { reply: "ok", session_id: "sid-2", usedTokens: 1, model: route.target.model };
    });

    const run = runConversation(gateway as never, { conversationId: CARD, task: "build the thing", env });
    await until(() => steerableStretch(CARD) !== null);
    expect(steerableStretch(CARD)).toMatchObject({ duty: "implement" });

    // The person types into the working card - recorded FIRST (durable),
    // interrupted second, as the gateway's message door does.
    const store = openConversation(CARD, { role: "test", env });
    const rec = recordUserMessage(store, { text: "STEER: use the other approach instead", origin: "kanban", delivery: "steer", steered: true });
    expect(store.tail(1, { kinds: ["user-message"] })[0].payload).toMatchObject({ disposition: "steer", delivery: "steer" });
    expect(steerRunningStretch(CARD, { seq: rec.seq, text: "STEER: use the other approach instead" })).toBe(true);
    // A second steer on the same stretch finds nothing left to interrupt.
    expect(steerRunningStretch(CARD, { seq: rec.seq + 1, text: "again" })).toBe(false);

    const result = await run;
    expect(stopCalls).toBe(1);
    expect(result).toEqual({ stretches: 2, terminal: "needs-input" });
    expect(steerableStretch(CARD)).toBeNull();

    // The same duty ran twice; only the second brief carries the steer, and it
    // is a continuation (attempt 1), not a retry of a failed attempt.
    expect(briefs).toHaveLength(2);
    expect(briefs[0]).toContain("## Your duty: implement (level 1)");
    expect(briefs[0]).not.toContain("STEER:");
    expect(briefs[1]).toContain("## Your duty: implement (level 1)");
    expect(briefs[1]).not.toContain("attempt 2");
    expect(briefs[1]).toContain("STEER: use the other approach instead");

    // The ledger says what happened, in order: a steer record, a steered
    // handoff routing back to implement, an ended record with outcome steered.
    const steered = store.tail(50, { kinds: ["stretch-steered"] });
    expect(steered).toHaveLength(1);
    expect(steered[0].payload).toMatchObject({ seq: rec.seq, text: "STEER: use the other approach instead" });
    const handoffs = store.tail(50, { kinds: ["handoff"] });
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0].payload).toMatchObject({ steered: true, status: "partial", duty: "implement", nextSteps: { next: "implement" }, partialReply: "half-way through the wrong approach" });
    expect(handoffs[0].payload._gate).toMatchObject({ source: "steer", synthesized: true });
    expect(handoffs[1].payload.status).toBe("complete");
    expect(handoffs[1].payload.steered).toBeUndefined();
    const ended = store.tail(50, { kinds: ["stretch-ended"] });
    expect(ended.map((e: { payload: { outcome: string } }) => e.payload.outcome)).toEqual(["steered", "handoff"]);
    expect(ended[0].payload).toMatchObject({ stoppedReason: "steered", next: "implement" });
    // The interrupted stretch never became a failure: no needs-input park, no
    // attention reason on the card between the two implement stretches.
    // Two starts (one per implement stretch, nothing between them: a steer
    // writes no ended transition), then the closing handoff's park - which the
    // loop re-asserts once more at its end, hence the fold.
    expect(patches.filter((p) => p.list === "running")).toHaveLength(2);
    expect(foldRepeats(patches.map((p) => p.list))).toEqual(["running", "needs-attention"]);
  }, 15000);

  it("a steered handoff trips no wire and counts as no attempt", () => {
    const store = openConversation(`${CARD}W`, { role: "test", env });
    store.init({ title: "t" });
    for (let i = 0; i < 3; i++) {
      store.append({ kind: "handoff", duty: "implement", stretch: `s${i}`, payload: steeredHandoff({ stretchId: `s${i}`, duty: "implement", steer: { text: `steer ${i}` } }) });
    }
    expect(tripwires(store, { duty: "implement" })).toMatchObject({ noProgress: 0, testFails: 0, fires: null });
    // A steered handoff quotes the message and points back at its own duty.
    const h = steeredHandoff({ stretchId: "s9", duty: "review", steer: { text: "  look at   the tests  " }, reply: "" });
    expect(h.summary).toContain('"look at the tests"');
    expect(h.nextSteps.next).toBe("review");
    expect(h).not.toHaveProperty("partialReply");
  });

  it("a cancel still stops the whole conversation, steer or no steer", async () => {
    const port = await startBoard();
    writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    const briefs: string[] = [];
    const gateway = fakeGateway(["implement", "responder"], async (route, brief, opts) => {
      briefs.push(brief);
      await new Promise<void>((resolve) => { opts.registerStop(() => resolve()); });
      return { reply: "", session_id: "sid", usedTokens: 1, model: route.target.model };
    });
    const controller = new AbortController();
    const run = runConversation(gateway as never, { conversationId: CARD, task: "build", env, signal: controller.signal });
    await until(() => steerableStretch(CARD) !== null);
    controller.abort();
    const result = await run;
    expect(result.terminal).toBe("cancelled");
    // One STRETCH brief. (The exit gate's re-ask and repair prompts also go
    // through runAgentSdkTurn on a cancelled stretch - pre-existing, and not
    // what this test is about.)
    expect(briefs.filter((b) => b.includes("# Stretch brief"))).toHaveLength(1);
    expect(steerableStretch(CARD)).toBeNull();
    const store = openConversation(CARD, { role: "test", env });
    expect(store.tail(10, { kinds: ["stretch-steered"] })).toHaveLength(0);
  }, 15000);
});

describe("a message on a settled card puts it back to work", () => {
  it("the responder moves the card to Running, answers, and settles it back to done", async () => {
    const port = await startBoard();
    writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    boardCard = { ...boardCard, list: "done", status: "ok" };
    const briefs: Array<{ duty: string; brief: string }> = [];
    const gateway = fakeGateway(["triage", "responder"], async (route, brief) => {
      briefs.push({ duty: route.duty, brief });
      // Triage parks (a terminal); the responder answers the question and
      // leaves the conversation where it stood.
      handoffFor(brief, route.duty, route.duty === "triage" ? "needs-input" : "done");
      return { reply: "answered", session_id: "sid", usedTokens: 1, model: route.target.model };
    });
    await runConversation(gateway as never, { conversationId: CARD, task: "open the work", env });
    patches.length = 0;

    const store = openConversation(CARD, { role: "test", env });
    recordUserMessage(store, { text: "is this deployed already?", origin: "kanban" });
    const result = await runConversation(gateway as never, { conversationId: CARD, env });
    expect(result).toEqual({ stretches: 1, terminal: "done" });
    expect(briefs.at(-1)!.duty).toBe("responder");
    expect(briefs.at(-1)!.brief).toContain("How to answer on this duty");
    expect(briefs.at(-1)!.brief).toContain("is this deployed already?");
    // Running while it worked, done once it answered - and a question on a
    // done card does not become new work through the evidence invariant. (The
    // loop re-asserts the terminal once more at its end, the wedge heal; the
    // sequence is read with consecutive repeats folded.)
    expect(foldRepeats(patches.map((p) => p.list))).toEqual(["running", "done"]);
    expect(patches[1]).toMatchObject({ status: "ok", lastReply: "responder done" });
  }, 15000);

  it("a follow-up ask re-opens the work on the duty the responder names", async () => {
    const port = await startBoard();
    writeFileSync(path.join(tmp, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    const duties: string[] = [];
    const gateway = fakeGateway(["triage", "implement", "responder"], async (route, brief) => {
      duties.push(route.duty);
      if (route.duty === "responder") handoffFor(brief, "responder", "implement", { summary: "On it - implement picks this up next." });
      else handoffFor(brief, route.duty, "needs-input");
      return { reply: "ok", session_id: "sid", usedTokens: 1, model: route.target.model };
    });
    await runConversation(gateway as never, { conversationId: CARD, task: "open the work", env });
    expect(duties).toEqual(["triage"]);
    patches.length = 0;

    const store = openConversation(CARD, { role: "test", env });
    recordUserMessage(store, { text: "now also add the export button", origin: "kanban" });
    const result = await runConversation(gateway as never, { conversationId: CARD, env });
    expect(duties).toEqual(["triage", "responder", "implement"]);
    expect(result).toEqual({ stretches: 2, terminal: "needs-input" });
    // Running (responder) -> handed to implement -> Running (implement) ->
    // parked by implement's own handoff.
    expect(foldRepeats(patches.map((p) => p.list ?? `duty:${p.duty}`))).toEqual(["running", "duty:implement", "running", "needs-attention"]);
    expect(patches[1]).toMatchObject({ status: "ok", lastReply: "On it - implement picks this up next." });
  }, 15000);

  it("the responder's routing is exempt from the work invariants", () => {
    const store = openConversation(`${CARD}P`, { role: "test", env });
    store.init({ title: "t" });
    expect(applyFlowPolicy("done", { store, duty: "responder", selectedDuties: ["triage", "implement", "review", "responder"], env })).toEqual({ next: "done", rewritten: false, reason: null });
    expect(applyFlowPolicy("implement", { store, duty: "responder", selectedDuties: ["triage", "implement", "responder"], env })).toEqual({ next: "implement", rewritten: false, reason: null });
  });
});
