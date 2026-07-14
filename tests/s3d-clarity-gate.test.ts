// S3d - the clarity gate + discuss-in-thread (D9b): dispatcher clarity, gateway
// carding to Discuss, the engine's gated-discuss dispatch (+ James-mode regression),
// the needs-input round trip, brief-to-thread + pass-through advance, and the
// gate: explicit flag through BOTH schemas.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

const KANBAN_DIR = mkdtempSync(join(tmpdir(), "s3d-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "s3d-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "s3d-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore - pure .mjs
import * as dispatchCore from "../fittings/seed/dispatcher/lib/dispatch-core.mjs";
// @ts-ignore - pure .mjs
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore - pure .mjs
import { seedBoard, phaseTemplatesFrom } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore - pure .mjs
import { saveBoard, createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore - pure .mjs
import { buildBoard, dutyGateExplicit } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore - pure .mjs
import { processCard, buildCardPrompt, isGatedDiscuss } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore - pure .mjs
import { readOriginEvents } from "../fittings/seed/kanban-loop/lib/origins.mjs";
// @ts-ignore - pure .mjs
import { gatewayRunFn } from "../fittings/seed/kanban-loop/lib/gateway-client.mjs";
// @ts-ignore - pure .mjs
import { RoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore - pure .mjs
import { resolveDiscussInterception, pickPendingQuestion, isAffirmativeGo } from "../fittings/seed/http-gateway/scripts/lib/discuss-intercept.mjs";
import { parseCompositionV4 } from "../src/lib/compositions";
import { computeKanbanResolvedModel } from "../src/lib/kanban-model";

// A dispatch model (duties-and-levels) the pure core reads.
const dispModel: any = {
  duties: { code: { id: "code", title: "Code", description: "code", levels: [{ description: "l1", cell: {} }, { description: "l2", cell: {} }] } },
  selectedDuties: ["code"]
};

// A board that INCLUDES a discuss list (interactive, edged to plan) so the engine +
// server exercise the real gated-discuss path.
const boardModel: any = {
  version: 2,
  compositionId: "t",
  kanbanLists: ["discuss", "plan", "implement", "review", "test"],
  sequences: { develop: { "2": ["plan", "implement", "review", "test"] } },
  cells: {},
  holds: {},
  gates: {}
};
const board = buildBoard(boardModel, { templates: phaseTemplatesFrom(seedBoard()) });

const DISCUSS_CARD = (over: any = {}) => ({
  title: "Build a thing",
  list: "discuss",
  clarity: "needs-discuss",
  sequence: ["plan", "implement", "review", "test"],
  project: "p",
  ...over
});

let server: http.Server;
let base = "";
beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(board, KANBAN_DIR);
  // gatewayUrl "" - an auto-dispatch on move is skipped (no operative in a unit test),
  // so a carding move just persists the card on Discuss.
  server = http.createServer(makeRequestHandler({ root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl: "", cap: 10 }, join(FITTING, "dist")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
  writeFileSync(join(GARRISON_HOME, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: base }));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// ── Part 1: dispatch-core clarity ────────────────────────────────────────────
describe("dispatch-core clarity", () => {
  it("dispatchSchema carries clarity as an OPTIONAL property (never required)", () => {
    const schema = dispatchCore.dispatchSchema();
    expect(schema.properties.clarity).toEqual({ type: "string" });
    expect(schema.required).not.toContain("clarity");
  });

  it("buildDispatchPrompt folds the clarity line + rubric + example; a custom rubric wins", () => {
    const p = dispatchCore.buildDispatchPrompt(dispModel, "do X");
    expect(p).toContain("clarity - one of: clear, needs-discuss.");
    expect(p).toContain(dispatchCore.DEFAULT_CLARITY_RUBRIC);
    expect(p).toContain('"clarity":"clear"');
    const custom = dispatchCore.buildDispatchPrompt(dispModel, "do X", { clarityRubric: "MY RUBRIC HERE" });
    expect(custom).toContain("MY RUBRIC HERE");
    expect(custom).not.toContain(dispatchCore.DEFAULT_CLARITY_RUBRIC);
  });

  it("parseDispatch clamps clarity to clear|needs-discuss, defaulting clear", () => {
    expect(dispatchCore.parseDispatch({ structured: { duty: "code", level: 2, clarity: "needs-discuss" } }, dispModel)?.clarity).toBe("needs-discuss");
    expect(dispatchCore.parseDispatch({ structured: { duty: "code", level: 2, clarity: "bogus" } }, dispModel)?.clarity).toBe("clear");
    expect(dispatchCore.parseDispatch({ structured: { duty: "code", level: 2 } }, dispModel)?.clarity).toBe("clear");
  });

  it("fallbackDispatch defaults clarity to clear", () => {
    expect(dispatchCore.fallbackDispatch(dispModel).clarity).toBe("clear");
  });

  it("clarityShortCircuit: explicit phrasing wins both directions; plain asks are null", () => {
    expect(dispatchCore.clarityShortCircuit("just do it")).toMatchObject({ clarity: "clear", overrideSource: "message" });
    expect(dispatchCore.clarityShortCircuit("no questions, ship it")).toMatchObject({ clarity: "clear" });
    expect(dispatchCore.clarityShortCircuit("let's discuss this first")).toMatchObject({ clarity: "needs-discuss", overrideSource: "message" });
    expect(dispatchCore.clarityShortCircuit("discuss before building")).toMatchObject({ clarity: "needs-discuss" });
    expect(dispatchCore.clarityShortCircuit("add a login form")).toBeNull();
  });

  it("dispatch() carries the model clarity, a phrasing override BEATS the model, and evidence has clarity + digest not the raw message", async () => {
    const model = await dispatchCore.dispatch(dispModel, "build me something big", {
      call: async () => ({ ok: true, structured: { duty: "code", level: 2, clarity: "needs-discuss" } })
    });
    expect(model.clarity).toBe("needs-discuss");
    expect(model.clarityOverrideSource).toBeNull();
    expect(model.evidence.clarity).toBe("needs-discuss");

    const overridden = await dispatchCore.dispatch(dispModel, "just do it - SECRET_TASK_TEXT", {
      call: async () => ({ ok: true, structured: { duty: "code", level: 2, clarity: "needs-discuss" } })
    });
    expect(overridden.clarity).toBe("clear"); // override beat the model's needs-discuss
    expect(overridden.clarityOverrideSource).toBe("message");
    expect(overridden.evidence.clarity).toBe("clear");
    expect(overridden.evidence.messageDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(overridden.evidence)).not.toContain("SECRET_TASK_TEXT");
  });
});

// ── Part 2: gateway carding to Discuss ───────────────────────────────────────
describe("gateway carding (judgeClarity + createAutonomousCard)", () => {
  it("judgeClarity honours an injected clarity fn", async () => {
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] }, clarity: async () => ({ clarity: "needs-discuss", source: "injected" }) });
    expect((await gw.judgeClarity("x")).clarity).toBe("needs-discuss");
  });

  it("judgeClarity resolves phrasing via the dispatcher short-circuit, default clear otherwise", async () => {
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] } });
    expect((await gw.judgeClarity("let's discuss this first")).clarity).toBe("needs-discuss");
    expect((await gw.judgeClarity("just do it, ship the fix")).clarity).toBe("clear");
    expect((await gw.judgeClarity("add a login form")).clarity).toBe("clear"); // no dispatcher -> default
  });

  it("judgeClarity consults an INJECTED DISPATCHER for the model verdict", async () => {
    const gw = new RoutedGateway({
      config: { taskTypes: [], tiers: [] },
      dispatcher: { core: dispatchCore, model: dispModel, call: async () => ({ ok: true, structured: { duty: "code", level: 2, clarity: "needs-discuss" } }) }
    });
    expect((await gw.judgeClarity("build me a thing, unclear scope")).clarity).toBe("needs-discuss");
  });

  it("createAutonomousCard lands a needs-discuss card on Discuss with clarity stamped", async () => {
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] } });
    const card = await gw.createAutonomousCard("build the thing", { taskType: "code", tier: "T1-standard" }, { targetList: "discuss", clarity: "needs-discuss" });
    expect(card?.id).toBeTruthy();
    const disk = await loadCard(KANBAN_DIR, card.id);
    expect(disk.list).toBe("discuss");
    expect(disk.clarity).toBe("needs-discuss");
  });
});

// ── Part 3: the engine dispatches a gated discuss card, skips a human one ─────
describe("engine gated-discuss dispatch", () => {
  it("isGatedDiscuss keys on the clarity marker AND an interactive list", () => {
    const discuss = { interactive: true };
    expect(isGatedDiscuss({ clarity: "needs-discuss" }, discuss)).toBe(true);
    expect(isGatedDiscuss({ clarity: null }, discuss)).toBe(false);
    expect(isGatedDiscuss({ clarity: "needs-discuss" }, { interactive: false })).toBe(false);
  });

  it("dispatches a CLARITY-GATED discuss card (advances to plan)", async () => {
    const c = await createCard(KANBAN_DIR, DISCUSS_CARD());
    let ran = false;
    const runFn = async () => {
      ran = true;
      return { reply: "plan" };
    };
    const loaded = { ...(await loadCard(KANBAN_DIR, c.id)), id: c.id };
    const { card: next, outcome } = await processCard({ root: KANBAN_DIR, board, card: loaded, runFn, cap: 10, model: boardModel, cwd: KANBAN_DIR });
    expect(ran).toBe(true);
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("plan");
    expect(next.list).toBe("plan");
  });

  it("SKIPS a human (James-mode) discuss card - no gate marker, never dispatched", async () => {
    const c = await createCard(KANBAN_DIR, { title: "Talk it through", list: "discuss", project: "p" });
    let ran = false;
    const runFn = async () => {
      ran = true;
      return { reply: "plan" };
    };
    const loaded = { ...(await loadCard(KANBAN_DIR, c.id)), id: c.id };
    const { outcome } = await processCard({ root: KANBAN_DIR, board, card: loaded, runFn, cap: 10, model: boardModel, cwd: KANBAN_DIR });
    expect(ran).toBe(false);
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("interactive");
  });

  it("buildCardPrompt for the discuss phase instructs Q&A, brief, and the plan verdict", () => {
    const prompt = buildCardPrompt({
      list: { kind: "agent-interactive", title: "Discuss", interactive: true },
      card: DISCUSS_CARD({ id: "C1" }),
      validNext: ["plan"],
      phase: "discuss",
      briefPath: "/abs/cards/C1/brief.md"
    });
    expect(prompt).toContain("Discuss this run's scope before it is planned");
    expect(prompt).toContain("AskUserQuestion");
    expect(prompt).toContain("/abs/cards/C1/brief.md");
    expect(prompt).toContain("end your reply with `plan`");
  });
});

// ── Part 4: needs-input round trip ───────────────────────────────────────────
describe("needs-input round trip", () => {
  it("gatewayRunFn forwards a `tool` SSE event to onTool (previously dropped)", async () => {
    const gw = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: open\ndata: {}\n\n");
      res.write(`event: tool\ndata: ${JSON.stringify({ tool_use_id: "t1", questions: [{ question: "Which auth?" }] })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "plan" })}\n\n`);
      res.end();
    });
    await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
    const gwUrl = `http://127.0.0.1:${(gw.address() as any).port}`;
    try {
      const tools: any[] = [];
      const out = await gatewayRunFn(gwUrl)({ prompt: "x", onTool: (p: any) => tools.push(p) });
      expect(out.reply).toBe("plan");
      expect(tools).toHaveLength(1);
      expect(tools[0].questions[0].question).toBe("Which auth?");
    } finally {
      await new Promise<void>((r) => gw.close(() => r()));
    }
  });

  it("the engine routes the questions to the card's origin + records a needs-input timeline event", async () => {
    const c = await createCard(KANBAN_DIR, DISCUSS_CARD());
    const runFn = async ({ onTool }: any) => {
      onTool({ tool_use_id: "t1", questions: [{ question: "Which framework?" }, "What database?"] });
      return { reply: "plan" };
    };
    const loaded = { ...(await loadCard(KANBAN_DIR, c.id)), id: c.id };
    const { card: next, outcome } = await processCard({ root: KANBAN_DIR, board, card: loaded, runFn, cap: 10, model: boardModel, cwd: KANBAN_DIR });
    expect(outcome.status).toBe("moved");
    // origin event log carries a needs-input event for THIS card
    const originEvents = readOriginEvents(KANBAN_DIR, "board").filter((e: any) => e.cardId === c.id);
    const ni = originEvents.find((e: any) => e.kind === "needs-input");
    expect(ni).toBeTruthy();
    expect(ni.detail.questions).toContain("Which framework?");
    // card timeline carries the deferred needs-input event (folded into the final save)
    expect(next.events.some((e: any) => e.kind === "needs-input")).toBe(true);
  });
});

// ── Part 4b: reply-as-answer discriminator (resolveThreadCard) ───────────────
describe("reply-as-answer gating (thread-card discriminator)", () => {
  it("resolveThreadCard surfaces a live DISCUSS card (answer path) vs a non-discuss / absent card (normal turn)", async () => {
    const gw = new RoutedGateway({ config: { taskTypes: [], tiers: [] } });
    // a live discuss card for this origin -> the reply-routing forwards as the answer
    const d = await createCard(KANBAN_DIR, DISCUSS_CARD({ originChannel: { channel: "web", threadId: "th-disc" }, origin_id: "web:th-disc" }));
    const rd = await gw.resolveThreadCard("web:th-disc");
    expect(rd?.attach?.id).toBe(d.id);
    expect(rd?.attach?.list).toBe("discuss");
    // a live NON-discuss card -> the reply-routing falls through to a normal turn
    await createCard(KANBAN_DIR, { title: "Live build", list: "implement", project: "p", originChannel: { channel: "web", threadId: "th-impl" }, origin_id: "web:th-impl" });
    const ri = await gw.resolveThreadCard("web:th-impl");
    expect(ri?.attach?.list).toBe("implement");
    // no card for the origin -> null (normal turn)
    expect(await gw.resolveThreadCard("web:th-none")).toBeNull();
  });
});

// ── Part 4c: HTTP-seam interception decision (review R1/R3) ──────────────────
describe("discuss interception decision (HTTP seam, review R1/R3)", () => {
  const P = (entries: any[]) => new Map(entries); // stand-in for pendingQuestions
  const board = (map: Record<string, any>) => async (originId: string) => (map[originId] ? { attach: map[originId] } : null);

  it("isAffirmativeGo matches only short affirmatives", () => {
    expect(isAffirmativeGo("go")).toBe(true);
    expect(isAffirmativeGo("Proceed.")).toBe(true);
    expect(isAffirmativeGo("yes, go ahead")).toBe(true);
    expect(isAffirmativeGo("ship it")).toBe(true);
    expect(isAffirmativeGo("go implement the whole thing with tests")).toBe(false);
    expect(isAffirmativeGo("let's discuss")).toBe(false);
  });

  it("pickPendingQuestion binds to the card; falls back only to a single UNBOUND question; never hijacks", () => {
    expect(pickPendingQuestion(P([["t1", { cardId: "A" }], ["t2", { cardId: "B" }]]), "A")).toBe("t1");
    expect(pickPendingQuestion(P([["t9", { cardId: null }]]), "A")).toBe("t9"); // single unbound -> fallback
    expect(pickPendingQuestion(P([["t1", { cardId: "B" }]]), "A")).toBeNull(); // single BOUND to another card -> no hijack
    expect(pickPendingQuestion(P([["t1", { cardId: null }], ["t2", { cardId: null }]]), "A")).toBeNull(); // ambiguous
  });

  it("ANSWER path: a pending question bound to this thread's live discuss card", async () => {
    const d = await resolveDiscussInterception({
      text: "use JWT", channel: "web", sessionId: "th1",
      pendingQuestions: P([["tq", { cardId: "CARD1" }]]),
      resolveThreadCard: board({ "web:th1": { id: "CARD1", list: "discuss" } })
    });
    expect(d).toMatchObject({ action: "answer", toolUseId: "tq", card: { id: "CARD1" } });
  });

  it("NORMAL turn: a stale / other-card pending question does NOT hijack this thread", async () => {
    const d = await resolveDiscussInterception({
      text: "use JWT", channel: "web", sessionId: "th1",
      pendingQuestions: P([["tq", { cardId: "OTHER" }]]),
      resolveThreadCard: board({ "web:th1": { id: "CARD1", list: "discuss" } })
    });
    expect(d).toBeNull();
  });

  it("NORMAL turn: a second thread whose live card is not in discuss", async () => {
    const d = await resolveDiscussInterception({
      text: "hello", channel: "web", sessionId: "th2",
      pendingQuestions: P([["tq", { cardId: "CARD1" }]]),
      resolveThreadCard: board({ "web:th2": { id: "X", list: "implement" } })
    });
    expect(d).toBeNull();
  });

  it("NO board lookup for an ordinary turn (no pending question, not affirmative)", async () => {
    let looked = false;
    const d = await resolveDiscussInterception({
      text: "please build a login page", channel: "web", sessionId: "th1",
      pendingQuestions: P([]),
      resolveThreadCard: async () => { looked = true; return null; }
    });
    expect(d).toBeNull();
    expect(looked).toBe(false); // ordinary turns pay no board round-trip
  });

  it("GO path: a bare affirmative on a card HELD in discuss by an explicit gate", async () => {
    const d = await resolveDiscussInterception({
      text: "go", channel: "web", sessionId: "th1",
      pendingQuestions: P([]),
      resolveThreadCard: board({ "web:th1": { id: "CARD1", list: "discuss", discussHeld: true } })
    });
    expect(d).toMatchObject({ action: "go", card: { id: "CARD1" } });
  });

  it("GO path is inert when the discuss card is NOT held", async () => {
    const d = await resolveDiscussInterception({
      text: "go", channel: "web", sessionId: "th1",
      pendingQuestions: P([]),
      resolveThreadCard: board({ "web:th1": { id: "CARD1", list: "discuss", discussHeld: false } })
    });
    expect(d).toBeNull();
  });

  it("non-web / missing session never intercepts", async () => {
    expect(await resolveDiscussInterception({ text: "go", channel: "kanban", sessionId: "th1", pendingQuestions: P([]), resolveThreadCard: board({}) })).toBeNull();
    expect(await resolveDiscussInterception({ text: "go", channel: "web", sessionId: null, pendingQuestions: P([]), resolveThreadCard: board({}) })).toBeNull();
  });
});

// ── Part 4d: tick self-heal predicate (review R2) ───────────────────────────
describe("tick self-heal predicate (review R2)", () => {
  it("a gated + not-held discuss card is tick-eligible; a held one is excluded", () => {
    const discussList = { interactive: true };
    const fresh: any = { clarity: "needs-discuss" };
    const held: any = { clarity: "needs-discuss", discussHeld: true };
    expect(isGatedDiscuss(fresh, discussList) && fresh.discussHeld !== true).toBe(true);
    expect(isGatedDiscuss(held, discussList) && held.discussHeld !== true).toBe(false);
  });
});

// ── Part 5: brief-to-thread + pass-through advance + gate: explicit ──────────
describe("brief-to-thread + gate: explicit", () => {
  it("PASS-THROUGH: a discuss advance posts the brief to the origin and proceeds to plan", async () => {
    const c = await createCard(KANBAN_DIR, DISCUSS_CARD());
    mkdirSync(join(KANBAN_DIR, "cards", c.id), { recursive: true });
    writeFileSync(join(KANBAN_DIR, "cards", c.id, "brief.md"), "# Brief\nDecision: use JWT sessions.");
    const runFn = async () => ({ reply: "plan" });
    const loaded = { ...(await loadCard(KANBAN_DIR, c.id)), id: c.id };
    const { outcome } = await processCard({ root: KANBAN_DIR, board, card: loaded, runFn, cap: 10, model: boardModel, cwd: KANBAN_DIR });
    expect(outcome.to).toBe("plan");
    const brief = readOriginEvents(KANBAN_DIR, "board").filter((e: any) => e.cardId === c.id).find((e: any) => e.kind === "duty-summary" && e.detail?.gate === "pass-through");
    expect(brief).toBeTruthy();
    expect(brief.message).toContain("proceeding to plan");
    expect(brief.detail.brief).toContain("use JWT sessions");
  });

  it("gate: explicit HOLDS the card in discuss (does not auto-advance), stamps discussHeld, and posts a hold notice", async () => {
    const explicitModel = { ...boardModel, gates: { discuss: "explicit" } };
    const c = await createCard(KANBAN_DIR, DISCUSS_CARD());
    const runFn = async () => ({ reply: "plan" });
    const loaded = { ...(await loadCard(KANBAN_DIR, c.id)), id: c.id };
    const { card: next, outcome } = await processCard({ root: KANBAN_DIR, board, card: loaded, runFn, cap: 10, model: explicitModel, cwd: KANBAN_DIR });
    expect(outcome.status).toBe("held");
    expect(next.list).toBe("discuss"); // held, not advanced
    expect(next.discussHeld).toBe(true); // review R3: marked held-for-go
    expect(next.events.some((e: any) => e.kind === "discuss-hold")).toBe(true);
    const hold = readOriginEvents(KANBAN_DIR, "board").filter((e: any) => e.cardId === c.id).find((e: any) => e.detail?.gate === "explicit");
    expect(hold).toBeTruthy();
    expect(hold.message).toContain("holding in Discuss");
  });

  it("review R3: a HELD-for-go discuss card is NOT re-dispatched by processCard (waits for the go)", async () => {
    const c = await createCard(KANBAN_DIR, DISCUSS_CARD());
    let ran = false;
    const runFn = async () => {
      ran = true;
      return { reply: "plan" };
    };
    // discussHeld is stamped by the engine's hold branch (not a createCard field), so set
    // it on the card the engine processes.
    const loaded = { ...(await loadCard(KANBAN_DIR, c.id)), id: c.id, discussHeld: true };
    const { outcome } = await processCard({ root: KANBAN_DIR, board, card: loaded, runFn, cap: 10, model: boardModel, cwd: KANBAN_DIR });
    expect(ran).toBe(false);
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("discuss-held");
  });

  it("gate: explicit flows through BOTH schemas (composition-inline + fitting metadata) into model.gates", () => {
    // compositions.ts path - where context_hold was silently stripped (the brief's ask)
    const parsed = parseCompositionV4({
      schema: 4,
      duties: [{ id: "discuss", title: "Discuss", description: "talk it through", gate: "explicit", levels: [{ description: "l1", cell: { target: "cc-sonnet", effort: "medium" } }] }],
      selected_duties: ["discuss"],
      targets: [{ id: "cc-sonnet", runtime: "claude-code", model: "sonnet" }]
    } as any);
    expect(parsed.duties[0].gate).toBe("explicit");

    // the projection reads the gate off the merged duty and exposes gates[dutyId]
    const model = computeKanbanResolvedModel(
      { id: "c", duties: parsed.duties, selectedDuties: ["discuss"], targets: parsed.targets },
      []
    );
    expect(model.gates).toEqual({ discuss: "explicit" });
    expect(dutyGateExplicit(model, "discuss")).toBe(true);
    expect(dutyGateExplicit(model, "plan")).toBe(false);
  });
});
