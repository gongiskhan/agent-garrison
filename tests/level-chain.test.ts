// The level chain, END TO END (ORCHESTRATOR_COHERENCE.md §2.3).
//
// `fittings/seed/orchestrator/lib/level-resolution.mjs` has been complete and
// correct since the day it was written and had ZERO production callers: pins were
// validated and displayed but never applied, no escalation could be produced, and
// a card's sequence came from `model.sequences[duty][level]` - the apm.yml duty
// ladder, whose cells are all leaves, so every sequence was ONE duty. The last
// E2E card ran `implement` alone while its flow said implement, test.
//
// This file pins the chain where it now actually runs:
//
//   1. the flow definition decides the SEQUENCE and each duty's LEVEL (pins
//      included), at the gateway seam that creates the card;
//   2. the card carries that resolution (`dutyLevels`) and the engine dispatches
//      each phase at ITS level, not the card's;
//   3. the board's rail resolves the same levelled plan, through the same flow
//      aliases, so a card written before the 2026-08-09 library rewrite still
//      renders instead of throwing;
//   4. an escalation raises ONE duty on ONE card, never lowers, and is always
//      logged in a shape the router's track record can read.
//
// Every "legacy" assertion here is load-bearing: a card with no dutyLevels must
// behave EXACTLY as it did before this existed.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evidenceFromDecision } from "@/lib/routing-tracks";
import { compilePolicy } from "../fittings/seed/orchestrator/lib/routing-core.mjs";
// @ts-ignore - pure .mjs
import * as levels from "../fittings/seed/orchestrator/lib/level-resolution.mjs";
// @ts-ignore - pure .mjs
import * as policyCore from "../fittings/seed/orchestrator/lib/policy-core.mjs";
// @ts-ignore - pure .mjs
import { RoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore - pure .mjs
import * as boardPolicy from "../fittings/seed/kanban-loop/lib/policy.mjs";
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


const { railForCard, classificationForPhase, tierForLevel } = boardPolicy;

const ROOT = path.resolve(__dirname, "..");
const SEED = JSON.parse(
  readFileSync(path.join(ROOT, "fittings/seed/orchestrator/config/routing.seed.json"), "utf8")
);
const POLICY = compilePolicy(JSON.parse(JSON.stringify(SEED)));

/** A gateway receiver built off the prototype - the established pattern in this
 *  suite for exercising RoutedGateway methods without a pool, a session or a live
 *  board (gateway-run-context.test.ts's `bareGateway` does the same). */
function gatewayFor(overrides: Record<string, unknown> = {}): any {
  const gw = Object.create(RoutedGateway.prototype);
  return Object.assign(gw, {
    config: SEED,
    compositionDir: ROOT,
    decisionsFile: path.join(ROOT, ".garrison", "decisions.jsonl"),
    core: { appendDecision: async () => {} },
    nowFn: () => "2026-08-13T10:00:00.000Z",
    logFn: () => {},
    flowAliases: {},
    ...overrides
  });
}

const onPhases = (rail: { phases: { id: string; on: boolean }[] }) =>
  rail.phases.filter((p) => p.on).map((p) => p.id);

// ─────────────────────────────────────────────────────────────────────────────
describe("1. the flow definition decides the sequence and the per-duty levels", () => {
  it("resolves the routed flow's duty list at the routed level, not the duty ladder's", async () => {
    const gw = gatewayFor();
    // `implement` at level 1 derives the `fix` flow (defaultFlowForDuty), whose
    // level 1 runs implement THEN test. The duty ladder would have said
    // [implement] alone - that is the bug this seam fixes.
    const plan = await gw.resolvedFlowPlan("implement", 1);
    expect(plan.flow).toBe("fix");
    expect(plan.flowLevel).toBe(1);
    expect(plan.sequence).toEqual(["implement", "test"]);
    expect(plan.dutyLevels).toEqual({ implement: 1, test: 1 });
  });

  it("an explicit flow pin chooses the flow, and a RETIRED pin resolves through the alias", async () => {
    const gw = gatewayFor();
    const pinned = await gw.resolvedFlowPlan("implement", 3, "feature");
    expect(pinned.flow).toBe("feature");
    expect(pinned.sequence).toEqual(SEED.flows.feature.levels["3"].duties);
    // `full-feature` was retired into `feature` by the 2026-08-09 rewrite. Cards,
    // saved rails and decision records still name it.
    const retired = await gw.resolvedFlowPlan("implement", 3, "full-feature");
    expect(retired.flow).toBe("feature");
    expect(retired.sequence).toEqual(pinned.sequence);
  });

  it("a PIN inside the flow definition raises exactly one duty, and only at its own level", async () => {
    // The shipped seed's pins all equal the level they sit at, so they are
    // currently no-ops; this fixture is the shape a pin is FOR ("at flow level 2,
    // review runs at 3") and is what proves the chain applies it.
    const config = {
      ...SEED,
      flows: {
        ...SEED.flows,
        pinned: {
          defaultLevel: 2,
          levels: {
            "1": { duties: ["implement"], evidence: "logs" },
            "2": { duties: ["implement", "review"], pins: { review: 3 }, evidence: "text" }
          }
        }
      }
    };
    const gw = gatewayFor({ config });
    const plan = await gw.resolvedFlowPlan("implement", 2, "pinned");
    expect(plan.sequence).toEqual(["implement", "review"]);
    expect(plan.dutyLevels).toEqual({ implement: 2, review: 3 });
    // At level 1 the pin does not exist, so nothing is raised.
    const low = await gw.resolvedFlowPlan("implement", 1, "pinned");
    expect(low.dutyLevels).toEqual({ implement: 1 });
  });

  it("falls back to the duty ladder for an unlevelled or unknown flow (legacy, byte-identical)", async () => {
    const gw = gatewayFor({
      config: { ...SEED, flows: { flat: { phasePlan: "full" } }, defaultFlow: "flat" }
    });
    expect(await gw.resolvedFlowPlan("implement", 2, "flat")).toBeNull();
    expect(await gw.resolvedFlowPlan("implement", 2, "no-such-flow")).toBeNull();
    // No config at all (the shape three-door-divergence's receiver has).
    expect(await gatewayFor({ config: null }).resolvedFlowPlan("implement", 2)).toBeNull();
  });

  it("the card payload carries dutyLevels, and carries nothing when there are none", () => {
    const withLevels = policyCore.buildAutonomousCardPayload({
      brief: "b",
      duty: "implement",
      level: 1,
      sequence: ["implement", "test"],
      dutyLevels: { implement: 1, test: 1 }
    });
    expect(withLevels.dutyLevels).toEqual({ implement: 1, test: 1 });
    expect(withLevels.sequence).toEqual(["implement", "test"]);
    // Absent, not null: a card without it must be shaped exactly as before.
    expect(policyCore.buildAutonomousCardPayload({ brief: "b" })).not.toHaveProperty("dutyLevels");
    expect(policyCore.buildAutonomousCardPayload({ brief: "b", dutyLevels: {} })).not.toHaveProperty("dutyLevels");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("2. a phase's tier is derived from ITS resolved level, not the card's", () => {
  // executionContextForCard — the board-side resolver that turned (card, phase)
  // into the exact execution cell, applying the card's per-duty `dutyLevels` pin
  // — went out with the Conversations cut, together with the list-driven engine
  // that called it. Per-conversation escalation is the stretch launcher's RUNG
  // LADDER now (a sticky per-duty escalation floor in the conversation summary),
  // covered by the stretch-launcher suite. What still resolves here is the
  // policy-side half: a level maps to a tier, and a phase's level wins over the
  // card's.
  it("classificationForPhase derives the tier from the PHASE's level, keeping card.tier as the fallback", () => {
    expect(tierForLevel(POLICY, 1)).toBe("T0-trivial");
    expect(tierForLevel(POLICY, 2)).toBe("T1-standard");
    expect(tierForLevel(POLICY, 3)).toBe("T2-deep");
    expect(tierForLevel(POLICY, null)).toBeNull();
    const card = { level: 2, tier: "T1-standard", dutyLevels: { implement: 2, review: 3 } };
    expect(classificationForPhase(POLICY, "implement", card)).toEqual({
      taskType: "implement",
      tier: "T1-standard"
    });
    expect(classificationForPhase(POLICY, "review", card)).toEqual({
      taskType: "review",
      tier: "T2-deep"
    });
    // No levels anywhere → the card's own tier, exactly as before.
    expect(classificationForPhase(POLICY, "implement", { tier: "T2-deep" })).toEqual({
      taskType: "implement",
      tier: "T2-deep"
    });
    expect(classificationForPhase(POLICY, "implement", { tier: "bogus" })!.tier).toBe("T1-standard");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("3. the board's rail resolves the same levelled plan, through the same aliases", () => {
  it("a levelled flow's rail is its duty list AT THE CARD'S LEVEL", () => {
    expect(onPhases(railForCard(POLICY, { flow: "fix", level: 1 }))).toEqual(["implement", "test"]);
    expect(onPhases(railForCard(POLICY, { flow: "fix", level: 3 }))).toEqual(
      SEED.flows.fix.levels["3"].duties
    );
    // No level on the card → the flow's own default level, never a higher one.
    expect(onPhases(railForCard(POLICY, { flow: "feature" }))).toEqual(
      SEED.flows.feature.levels[String(SEED.flows.feature.defaultLevel)].duties
    );
    // Evidence comes from the level definition, not from a phase plan.
    expect(railForCard(POLICY, { flow: "fix", level: 3 }).evidence).toBe(SEED.flows.fix.levels["3"].evidence);
  });

  it("a card carrying a RETIRED flow name renders its successor's rail instead of throwing", () => {
    // The live failure this fixes: every card on a real board predates the
    // rewrite, and policy-core's railFor throws `policy: unknown flow` on one.
    const rail = railForCard(POLICY, { flow: "full-feature", level: 3 });
    expect(rail.flow).toBe("feature");
    expect(onPhases(rail)).toEqual(SEED.flows.feature.levels["3"].duties);
    expect(() => policyCore.railFor(SEED, "full-feature", null, 3)).not.toThrow();
    expect(policyCore.railFor(SEED, "ui-change", null, 1).flow).toBe("feature");
    // Still throws for a name that is neither live nor aliased - an unknown flow
    // is a real error, and the alias must not turn it into a silent default.
    expect(() => policyCore.railFor(SEED, "not-a-flow")).toThrow(/unknown flow "not-a-flow"/);
  });

  it("a MANUAL flow is all-off and owes no evidence, whatever its levels say", async () => {
    // The regression this pins: `personal` used to be {phasePlan: "manual-only",
    // evidence: false}; the levelled library gave it levels.1.duties = ["other"],
    // so a levels-aware rail would turn every personal card agent-dispatchable
    // (railIsManualOnly false, consumed by the board's Start guard) and start
    // demanding evidence from a card whose journey is the manual head and tail.
    expect(SEED.flows.personal.manual).toBe(true);
    expect(SEED.flows.personal.levels["1"].duties).toEqual(["other"]);
    const rail = railForCard(POLICY, { flow: "personal", level: 1 });
    expect(onPhases(rail)).toEqual([]);
    expect(boardPolicy.railIsManualOnly(rail)).toBe(true);
    expect(rail.evidenceRequired).toBe(false);
    expect(rail.phases.every((p: { off_reason?: string }) => p.off_reason === "manual-flow")).toBe(true);
    expect(boardPolicy.phaseOnForCard(rail, "implement")).toBe(false);
    // Config-side too: the rendered rail must never advertise a phase that will
    // never run.
    const authored = policyCore.railFor(SEED, "personal", null, 1);
    expect(authored.phases.filter((p: { on: boolean }) => p.on)).toEqual([]);
    // ...and no plan is needed for a manual flow, at any level it does not define.
    expect(() => policyCore.railFor(SEED, "personal", null, 3)).not.toThrow();
    // The gateway refuses to author a sequence from it at all.
    expect(await gatewayFor().resolvedFlowPlan("other", 1, "personal")).toBeNull();
  });

  it("the retired `channel` flow aliases to a MANUAL successor, not an agentful one", () => {
    // `task` is the same size and the wrong answer: its level 1 really runs the
    // `other` duty, while the retired channel flow was manual-only. An alias must
    // preserve what a card MEANT, and manual-vs-agentful outranks subject matter.
    expect(policyCore.FLOW_ALIASES.channel).toBe("personal");
    expect(SEED.flows[policyCore.FLOW_ALIASES.channel].manual).toBe(true);
    const rail = railForCard(POLICY, { flow: "channel" });
    expect(rail.flow).toBe("personal");
    expect(boardPolicy.railIsManualOnly(rail)).toBe(true);
    expect(boardPolicy.railIsManualOnly(railForCard(POLICY, { flow: "task" }))).toBe(false);
  });

  it("an unresolvable flow stays forgiving on the board and reports the name AS WRITTEN", () => {
    const rail = railForCard(POLICY, { flow: "mystery" });
    expect(rail.flow).toBe("mystery");
    expect(rail.phases.every((p: { on: boolean }) => p.on)).toBe(true);
  });

  it("the alias table and the level read are byte-equal to policy-core's", () => {
    expect({ ...boardPolicy.FLOW_ALIASES }).toEqual({ ...policyCore.FLOW_ALIASES });
    for (const [retired, live] of Object.entries(policyCore.FLOW_ALIASES as Record<string, string>)) {
      expect(boardPolicy.adoptFlowValue(retired), retired).toBe(live);
      expect(policyCore.adoptFlow(retired), retired).toBe(live);
    }
    // Every flow, every level: the board's mirror must read what policy-core reads.
    for (const [id, flow] of Object.entries(SEED.flows as Record<string, unknown>)) {
      for (const level of [undefined, 1, 2, 3, 9, null]) {
        expect(boardPolicy.levelPlanFor(flow, level), `${id} L${level}`).toEqual(
          policyCore.levelPlanFor(flow, level)
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("4. escalation raises one duty on one card, never lowers, always logged", () => {
  function escalationFixture(card: Record<string, unknown> | null) {
    const written: Record<string, unknown>[] = [];
    const patched: Record<string, unknown>[] = [];
    const gw = gatewayFor({
      core: { appendDecision: async (_f: string, r: Record<string, unknown>) => void written.push(r) },
      _cardsLib: {
        cardById: async () => card,
        patchCardDutyLevels: async (args: Record<string, unknown>) => {
          patched.push(args);
          return { ok: true };
        }
      }
    });
    return { gw, written, patched };
  }

  const CARD = { id: "01CARD0000000000000000000A", flow: "fix", level: 1, duty: "implement" };

  it("an applied raise patches the card and writes a record STAMPED WITH THE FLOW", async () => {
    const { gw, written, patched } = escalationFixture(CARD);
    const r = await gw.escalateCardDuty({
      cardId: CARD.id,
      duty: "test",
      toLevel: 3,
      reason: "the suite is flaky at this level"
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    expect(r.body.resolved.level).toBe(3);
    expect(patched).toEqual([
      expect.objectContaining({ id: CARD.id, dutyLevels: { test: 3 }, reason: "the suite is flaky at this level" })
    ]);
    expect(written).toHaveLength(1);
    // The flow stamp is the trap: escalateDuty is handed a flow DEFINITION and
    // cannot know its name, while summariseEscalations groups on `flow`. Without
    // this an escalation can never become the pin it is evidence for.
    expect(written[0]).toMatchObject({
      kind: "escalation",
      flow: "fix",
      cardId: CARD.id,
      duty: "test",
      from: 1,
      to: 3,
      applied: true,
      reason: "the suite is flaky at this level",
      at: "2026-08-13T10:00:00.000Z"
    });
    expect(levels.summariseEscalations([written[0], written[0], written[0]], { threshold: 3 })[0]).toMatchObject({
      flow: "fix",
      duty: "test",
      to: 3,
      count: 3,
      recurring: true
    });
  });

  it("a LOWER is refused, recorded, and never touches the card", async () => {
    const { gw, written, patched } = escalationFixture({ ...CARD, level: 3 });
    const r = await gw.escalateCardDuty({
      cardId: CARD.id,
      duty: "test",
      toLevel: 1,
      reason: "trying to save tokens"
    });
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(false);
    expect(r.body.record.rejected).toMatchObject({ requested: 1, keptAt: 3 });
    expect(patched).toEqual([]); // the card is untouched
    // A refusal is still evidence: it is logged like everything else.
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ kind: "escalation", applied: false, flow: "fix" });
  });

  it("a reasonless escalation is refused before anything is logged or patched", async () => {
    for (const reason of [undefined, "", "   "]) {
      const { gw, written, patched } = escalationFixture(CARD);
      const r = await gw.escalateCardDuty({ cardId: CARD.id, duty: "test", toLevel: 3, reason });
      expect(r.status).toBe(400);
      expect(written).toEqual([]);
      expect(patched).toEqual([]);
    }
  });

  it("refuses a bad card, a bad level, and a card whose flow is not levelled", async () => {
    const missing = escalationFixture(null);
    expect((await missing.gw.escalateCardDuty({ cardId: "01NOPE", duty: "test", toLevel: 3, reason: "r" })).status).toBe(404);
    const bad = escalationFixture(CARD);
    expect((await bad.gw.escalateCardDuty({ cardId: CARD.id, duty: "test", toLevel: 9, reason: "r" })).status).toBe(400);
    expect((await bad.gw.escalateCardDuty({ cardId: CARD.id, duty: "", toLevel: 3, reason: "r" })).status).toBe(400);
    const flat = escalationFixture({ ...CARD, flow: "flat" });
    flat.gw.config = { ...SEED, flows: { flat: { phasePlan: "full" } } };
    expect((await flat.gw.escalateCardDuty({ cardId: CARD.id, duty: "test", toLevel: 3, reason: "r" })).status).toBe(409);
  });

  it("a board refusal makes the escalation report FAILED rather than claiming it applied", async () => {
    const { gw } = escalationFixture(CARD);
    gw._cardsLib = {
      cardById: async () => CARD,
      patchCardDutyLevels: async () => ({ ok: false, error: "dutyLevels.test would lower 3 → 1" })
    };
    const r = await gw.escalateCardDuty({ cardId: CARD.id, duty: "test", toLevel: 3, reason: "r" });
    expect(r.status).toBe(502);
    expect(r.body.applied).toBe(false);
    expect(r.body.error).toContain("lower");
  });

  it("the record it writes is exactly what the router's track record reads", async () => {
    const { gw, written } = escalationFixture(CARD);
    await gw.escalateCardDuty({ cardId: CARD.id, duty: "test", toLevel: 3, reason: "flaky" });
    // evidenceFromDecision keys on kind + applied and takes the SHAPE from
    // `flow ?? duty ?? taskType` - the flow stamp is what makes the evidence land
    // on the flow's track instead of a bare duty bucket.
    expect(evidenceFromDecision(written[0])).toEqual([
      { category: "level", shape: "fix", signal: "escalation", at: "2026-08-13T10:00:00.000Z" }
    ]);
    // A refused escalation is deliberately NOT evidence about the level: nothing
    // was raised, so there is nothing to learn about the router's calibration.
    const refused = { ...written[0], applied: false };
    expect(evidenceFromDecision(refused)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("5. the gateway edge speaks the same flow vocabulary", () => {
  let gatewayPty: Record<string, any>;

  beforeAll(async () => {
    // Documented helpers-only import (no listener, no claude spawn).
    process.env.GARRISON_GATEWAY_NO_LISTEN = "1";
    gatewayPty = await import(
      pathToFileURL(path.join(ROOT, "fittings/seed/http-gateway/scripts/gateway-pty.mjs")).href
    );
  });

  it("a pinned RETIRED flow is aliased and then accepted, not rejected", () => {
    const vocabulary = {
      tiers: SEED.tiers,
      flows: Object.keys(SEED.flows),
      phases: SEED.phases,
      flowAliases: policyCore.FLOW_ALIASES
    };
    const live = gatewayPty.sanitizeRouting({ flow: "feature" }, vocabulary);
    expect(live.routing).toEqual({ flow: "feature" });
    expect(live.rejected).toEqual([]);
    const retired = gatewayPty.sanitizeRouting({ flow: "full-feature" }, vocabulary);
    expect(retired.routing).toEqual({ flow: "feature" });
    expect(retired.rejected).toEqual([]);
    // A genuinely unknown flow still dies at the edge, with a reason.
    const bogus = gatewayPty.sanitizeRouting({ flow: "not-a-flow" }, vocabulary);
    expect(bogus.routing).toBeNull();
    expect(bogus.rejected).toEqual([{ field: "flow", reason: "flow-not-in-vocabulary" }]);
    // No aliases published yet (the level chain has not loaded) → unchanged
    // behaviour: the retired name is simply out of vocabulary.
    const noAliases = gatewayPty.sanitizeRouting({ flow: "full-feature" }, { ...vocabulary, flowAliases: {} });
    expect(noAliases.routing).toBeNull();
  });

  it("the menu previews a LEVELLED flow's phases (they were empty for every live flow)", () => {
    for (const [id, flow] of Object.entries(SEED.flows as Record<string, unknown>)) {
      expect(gatewayPty.flowLevelPlan(flow), `${id} preview`).toEqual(policyCore.levelPlanFor(flow, undefined));
      for (const level of [1, 2, 3]) {
        expect(gatewayPty.flowLevelPlan(flow, level), `${id} L${level}`).toEqual(
          policyCore.levelPlanFor(flow, level)
        );
      }
    }
    // The pre-levels shape keeps returning null so the phasePlans fallback runs.
    expect(gatewayPty.flowLevelPlan({ phasePlan: "full" })).toBeNull();
  });
});
