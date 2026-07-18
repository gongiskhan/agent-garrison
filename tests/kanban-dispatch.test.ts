// V1c regression: "moving a card to Plan does nothing" — the board now AUTO-DISPATCHES a
// card's run when it is moved onto an immediate agent list (shouldAutoDispatch), and only
// then (manual/interactive/scheduler-beat targets just move). Plus the engine actually
// runs + advances the card when dispatched (processCard with an injected runFn — the same
// path the board's gatewayRunFn drives against the live gateway).
import { describe, it, expect, afterEach } from "vitest";

// S4: the run engine reads the compiled Orchestrator policy for gate-evidence
// enforcement + phase classification. These tests exercise the PURE transition
// mechanics, so pin the policy path at a nonexistent file (policy-less mode);
// the policy-driven behavior is covered in tests/run-engine.test.ts.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
// S6 (D19): runDirs mint ABSOLUTE under the evidence home — sandbox it so
// tests never write the real ~/.garrison/runs.
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { shouldAutoDispatch, isEngineRequest, requestsAutoDispatch } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { gatewayRunFn } from "../fittings/seed/kanban-loop/lib/gateway-client.mjs";

const board = seedBoard();
const tmp = () => mkdtempSync(join(tmpdir(), "kanban-dispatch-"));

describe("v1c shouldAutoDispatch — Move onto an immediate agent list starts the run", () => {
  it("true ONLY for immediate agent lists", () => {
    expect(shouldAutoDispatch(board, "plan")).toBe(true);        // immediate agent
    expect(shouldAutoDispatch(board, "implement")).toBe(true);   // immediate agent
    expect(shouldAutoDispatch(board, "adversarial-review")).toBe(true);
    expect(shouldAutoDispatch(board, "validate")).toBe(true);
  });
  it("false for manual / interactive / scheduler-beat / unknown lists", () => {
    expect(shouldAutoDispatch(board, "backlog")).toBe(false);    // manual
    expect(shouldAutoDispatch(board, "todo")).toBe(false);       // manual
    expect(shouldAutoDispatch(board, "discuss")).toBe(false);    // interactive (James web chat)
    expect(shouldAutoDispatch(board, "test")).toBe(false);       // scheduler-beat (batched)
    expect(shouldAutoDispatch(board, "done")).toBe(false);       // manual terminal
    expect(shouldAutoDispatch(board, "no-such-list")).toBe(false);
  });

  it("when dispatched, the engine runs the card through the gateway runFn and advances it", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "SSO fix", project: "m365", list: "plan" });
    // The board's gatewayRunFn POSTs to the gateway; here we inject a stub that returns
    // the plan list's verdict (its router-prompt ends with `implement`).
    const runFn = async () => ({ reply: "implement" });
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("implement");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("implement");
    expect(typeof disk.runId).toBe("string");           // runId minted on the first agent-list entry
    expect(disk.runDir.endsWith(disk.runId)).toBe(true); // S6: absolute under the evidence home
    expect(disk.runDir.startsWith(process.env.GARRISON_RUNS_DIR!)).toBe(true);
  });
});

// V1d regression: a transient gateway failure must NEVER park a card (the user hit a
// "fetch failed" that stranded a card in needs-attention). A transport-tagged failure
// REVERTS the acquire (card stays put, iteration un-consumed) to retry; a genuine run
// failure parks.
describe("v1d transport-failure handling — gateway down reverts, real failure parks", () => {
  it("a transport-tagged runFn throw REVERTS the card (no park, iteration un-consumed)", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "transient", project: "g", list: "plan" });
    const runFn = async () => { const e: any = new Error("gateway unreachable: fetch failed"); e.transport = true; throw e; };
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("deferred");
    expect(outcome.reason).toBe("gateway-unavailable");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("plan");                 // stayed on the list
    expect(disk.status).not.toBe("needs-attention"); // NOT parked
    expect(disk.iterations).toBe(0);                 // iteration un-consumed (retriable)
  });

  it("a NON-transport runFn throw still PARKS the card (real run failure)", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "real fail", project: "g", list: "plan" });
    const runFn = async () => { throw new Error("orchestrator blew up"); };
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("needs-attention");
    expect(outcome.reason).toBe("run-failed");
    expect((await loadCard(root, card.id)).status).toBe("needs-attention");
  });
});

describe("v1d gatewayRunFn — failure classification", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("tags a network failure (fetch rejects) as transport", async () => {
    globalThis.fetch = (async () => { throw new Error("fetch failed"); }) as any;
    let err: any;
    try { await gatewayRunFn("http://127.0.0.1:24777")({ prompt: "x", list: { skill: "s" } }); }
    catch (e) { err = e; }
    expect(err?.transport).toBe(true);
  });

  it("tags 503 as transport but a 500 as a real failure", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503 })) as any;
    let e503: any; try { await gatewayRunFn("u")({ prompt: "x", list: {} }); } catch (e) { e503 = e; }
    expect(e503?.transport).toBe(true);
    globalThis.fetch = (async () => ({ ok: false, status: 500 })) as any;
    let e500: any; try { await gatewayRunFn("u")({ prompt: "x", list: {} }); } catch (e) { e500 = e; }
    expect(e500).toBeTruthy();
    expect(e500.transport).toBeFalsy();
  });

  it("returns the reply from the SSE `done` event on success", async () => {
    const enc = new TextEncoder();
    const body = (async function* () {
      yield enc.encode(`event: open\ndata: {"ts":1}\n\n`);
      yield enc.encode(`event: chunk\ndata: {"text":"working"}\n\n`);
      yield enc.encode(`event: done\ndata: {"reply":"implement"}\n\n`);
    })();
    globalThis.fetch = (async () => ({ ok: true, body })) as any;
    const out = await gatewayRunFn("u")({ prompt: "x", list: {} });
    expect(out.reply).toBe("implement");
  });

  it("preserves max-turn + exact route evidence from the SSE `done` event", async () => {
    const enc = new TextEncoder();
    const body = (async function* () {
      yield enc.encode(`event: done\ndata: ${JSON.stringify({
        reply: "Plan and gate written.",
        route: "sdk-sonnet-full",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "medium",
        effortApplied: true,
        stoppedReason: "max_turns",
        tier: "T1-standard"
      })}\n\n`);
    })();
    globalThis.fetch = (async () => ({ ok: true, body })) as any;
    const out = await gatewayRunFn("u")({ prompt: "plan", list: {} });
    expect(out).toMatchObject({
      reply: "Plan and gate written.",
      stoppedReason: "max_turns",
      route: {
        targetId: "sdk-sonnet-full",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        effort: "medium",
        effortApplied: true,
        tier: "T1-standard"
      }
    });
  });

  it("a stream that ends without `done` is a transport failure (retriable)", async () => {
    const enc = new TextEncoder();
    const body = (async function* () { yield enc.encode(`event: open\ndata: {}\n\n`); })();
    globalThis.fetch = (async () => ({ ok: true, body })) as any;
    let err: any; try { await gatewayRunFn("u")({ prompt: "x", list: {} }); } catch (e) { err = e; }
    expect(err?.transport).toBe(true);
  });
});

// V1d: the operative's verdict is followed by gateway status badges the router appends
// ("[route: …]", "[orchestrator-active]"). parseNextList must see through them, or every
// dispatched card parks despite a correct verdict.
describe("v1d parseNextList — tolerates trailing gateway status badges", () => {
  it("finds the verdict when the gateway appended route/active badges after it", async () => {
    // @ts-ignore — pure .mjs
    const { parseNextList } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    const reply = [
      "Plan written to docs/autothing/runs/X/FLOW_PLAN.md.",
      "implement",
      "",
      "[route: cc-opus-high | rule: cell:code/T2-deep | profile: balanced]",
      "[orchestrator-active]"
    ].join("\n");
    expect(parseNextList(reply, ["implement", "needs-attention"])).toBe("implement");
  });
  it("still returns null when the last real line is not a valid next list", async () => {
    // @ts-ignore — pure .mjs
    const { parseNextList } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    expect(parseNextList("I am not sure\n[orchestrator-active]", ["implement"])).toBe(null);
  });

  it("finds the verdict when badges + the token are FLOWED onto ONE line (the real bug)", async () => {
    // @ts-ignore — pure .mjs
    const { parseNextList } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    // The xterm screen-reader reflowed prose + gateway badges + the verdict onto one line.
    const reply = "Plan written. Gate green. [route: cc-sonnet-med | rule: row:code | profile: balanced] [orchestrator-active] implement";
    expect(parseNextList(reply, ["implement", "review"])).toBe("implement");
  });

  it("does NOT grab a valid-next word buried in trailing prose (stays conservative)", async () => {
    // @ts-ignore — pure .mjs
    const { parseNextList } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    // ends on prose, not the bare token → park (the operative didn't follow the convention)
    expect(parseNextList("I might implement this later", ["implement"])).toBe(null);
  });
});

// V1d CRITICAL regression (the user hit this): the BATCH verdict "<cardId> adversarial-test"
// arrived flowed onto one line with prose + gateway badges, and the old line-start matcher
// discarded a CORRECT verdict → the card parked. parseBatchVerdicts must read through it.
describe("v1d parseBatchVerdicts — verdict flowed onto a badge/prose line", () => {
  const board = seedBoard();
  it("reads `<cardId> adversarial-test` out of the exact flowed reply the user saw", async () => {
    // @ts-ignore — pure .mjs
    const { parseBatchVerdicts } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    const id = "01KVZ7KG523ASDPNMHQDMMHQM5";
    const card = { id, list: "test" };
    const reply =
      "New text present (1), old text absent (0), HTML parses cleanly. Gate green. " +
      "[route: cc-sonnet-med | rule: row:code | profile: balanced] [orchestrator-active] " +
      `${id} adversarial-test`;
    const verdicts = parseBatchVerdicts(reply, [card], board);
    expect(verdicts[id]).toBe("adversarial-test");
  });

  it("attributes each card's verdict to ITS id (no cross-talk) and rejects junk", async () => {
    // @ts-ignore — pure .mjs
    const { parseBatchVerdicts } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    const a = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZA", list: "test" };
    const b = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZB", list: "test" };
    const reply = `${a.id} adversarial-test\n${b.id} implement`;
    const v = parseBatchVerdicts(reply, [a, b], board);
    expect(v[a.id]).toBe("adversarial-test");
    expect(v[b.id]).toBe("implement");
    // a card whose id never appears, or appears with no valid token, gets null
    const c = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZC", list: "test" };
    expect(parseBatchVerdicts(`${c.id} not-a-list`, [c], board)[c.id]).toBe(null);
  });
});

// V1d: a parked card MOVES to the needs-attention COLUMN (not just a status flag) and
// carries WHY (attentionReason) + WHERE from (parkedFrom).
describe("v1d park → needs-attention column with a reason", () => {
  it("no valid next list parks the card in the needs-attention column with reason + origin", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "park me", project: "g", list: "plan" });
    const runFn = async () => ({ reply: "I rambled and never named a list" });
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("needs-attention");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("needs-attention");          // MOVED to the column
    expect(disk.status).toBe("needs-attention");
    expect(typeof disk.attentionReason).toBe("string"); // says why
    expect(disk.attentionReason.length).toBeGreaterThan(0);
    expect(disk.parkedFrom).toBe("plan");               // remembers origin
  });
});

// V1d: processChain runs CONSECUTIVE immediate agent lists automatically (the flow),
// stopping when it lands somewhere that doesn't auto-run.
describe("v1d processChain — auto-runs the flow through immediate agent lists", () => {
  it("chains plan → implement → … and stops at a non-immediate / parked / terminal list", async () => {
    // @ts-ignore — pure .mjs
    const { processChain } = await import("../fittings/seed/kanban-loop/lib/engine.mjs");
    const root = tmp();
    const card = await createCard(root, { title: "flow", project: "g", list: "plan" });
    let calls = 0;
    // The stub returns the current list's first valid next — so the chain advances.
    const runFn = async ({ list }: any) => { calls++; return { reply: (list.validNext || [])[0] || "needs-attention" }; };
    const { card: final } = await processChain({ root, board, card, runFn, cap: 50 });
    expect(calls).toBeGreaterThan(1);                    // it CHAINED (ran more than one turn)
    const disk = await loadCard(root, final.id);
    expect(disk.list).not.toBe("plan");                 // it moved forward through the pipeline
  });
});

// rev2-s567 S5-2 regression: the garrison doorway positions a card on the
// immediate agent list "plan" with the x-garrison-engine header, then drives it
// in-session via advanceCardPhase. The PATCH handler must NOT ALSO fire a
// background processChain for its self-driven engine request (double-drive → the
// background flow races the in-session driver into invalid-verdict/park). A
// significant gateway registration is also engine-context, but explicitly hands
// progression to the board and therefore must dispatch.
describe("engine move dispatch ownership (S5-2 + Web registration)", () => {
  const board = {
    lists: [
      { id: "plan", kind: "agent", trigger: "immediate" },
      { id: "backlog", kind: "manual", trigger: "manual" }
    ]
  };
  it("isEngineRequest detects the x-garrison-engine header", () => {
    expect(isEngineRequest({ headers: { "x-garrison-engine": "garrison-doorway" } })).toBe(true);
    expect(isEngineRequest({ headers: {} })).toBe(false);
    expect(isEngineRequest({ headers: { "x-garrison-engine": "" } })).toBe(false);
  });
  it("dispatches human/explicit-handoff moves but suppresses the self-driven doorway", () => {
    const human = { headers: {} };
    const doorway = { headers: { "x-garrison-engine": "garrison-doorway" } };
    const gateway = { headers: { "x-garrison-engine": "gateway", "x-garrison-dispatch": "auto" } };
    // the exact composed guard from handlePatchCard:
    const dispatches = (req: { headers: Record<string, string> }) =>
      shouldAutoDispatch(board, "plan") && !(isEngineRequest(req) && !requestsAutoDispatch(req));
    expect(shouldAutoDispatch(board, "plan")).toBe(true);   // plan is immediate+agent
    expect(dispatches(human)).toBe(true);                    // human move -> board dispatch
    expect(dispatches(doorway)).toBe(false);                 // doorway self-drives -> no double-drive
    expect(dispatches(gateway)).toBe(true);                  // Web registration hands off -> board dispatch
  });
});
