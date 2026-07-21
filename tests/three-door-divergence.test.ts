// S4b — DIVERGENCE ZERO across the three doors (GARRISON-UNIFY-V1 D15 acceptance 9).
//
// "All three doors (web-channel direct, Kanban, the garrison skill via a
// garrison-control read tool) consult the SAME resolved model with divergence
// zero." Before S4b the doors diverged: web-channel classified via the gateway,
// the board treated the list as the task type, and the garrison skill used
// policy.defaultWorkKind. This test drives EACH door's OWN "what sequence does
// this (duty, level) card VISIT" code path and asserts the three answers are
// identical — the resolved sequence, not the entry point (a legitimate per-door
// difference the acceptance explicitly allows).
//
//   Door 1 (gateway)  — RoutedGateway.resolvedSequenceForDispatch / dispatchRoute,
//                        reading the runner-projected model.json.
//   Door 2 (board)    — resolved-model.mjs resolveCardSequence, reading the SAME
//                        model.json (S4a's board decider).
//   Door 3 (skill)    — garrison-control resolvedSequenceFrom over the SAME
//                        composition (the read tool the skill consults).

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the board's model dir BEFORE importing the model helpers — writeKanban-
// ResolvedModel (runner projection) and loadResolvedModel (board read) both key off
// GARRISON_KANBAN_DIR at call time, so both hit this one file.
const KANBAN_DIR = mkdtempSync(join(tmpdir(), "three-door-kanban-"));
mkdirSync(KANBAN_DIR, { recursive: true });
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;

import { beforeAll, describe, expect, it } from "vitest";

import { writeKanbanResolvedModel } from "@/lib/kanban-model";
import { buildControlModel, resolvedSequenceFrom } from "@/lib/garrison-control";
import type { DutySpec, GarrisonMetadata } from "@/lib/types";
// @ts-ignore — pure .mjs board decider (door 2), the SAME module the gateway imports
import { loadResolvedModel, resolveCardSequence } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore — pure .mjs gateway routing layer (door 1)
import { RoutedGateway } from "../fittings/seed/http-gateway/scripts/lib/gateway-routing.mjs";
// @ts-ignore — pure .mjs dispatch core (door 1's real dispatch path)
import * as dispatchCore from "../fittings/seed/dispatcher/lib/dispatch-core.mjs";

// The develop composite (level 2 = the full inner pipeline) + its leaf steps.
const leaf = (id: string): DutySpec => ({
  id,
  title: id,
  description: "",
  levels: [{ description: "do", cell: { skill: id, target: "cc-sonnet", effort: "low" } }]
});
const developDuty: DutySpec = {
  id: "develop",
  title: "Develop",
  description: "develop a change end to end",
  levels: [
    { description: "quick", sequence: [{ duty: "implement", level: 1 }] },
    {
      description: "full",
      sequence: [
        { duty: "plan", level: 1 },
        { duty: "implement", level: 1 },
        { duty: "review", level: 1 },
        { duty: "test", level: 1 }
      ]
    }
  ]
};
const DUTIES: DutySpec[] = [developDuty, leaf("plan"), leaf("implement"), leaf("review"), leaf("test")];
const composition = { id: "three-door", duties: DUTIES, selectedDuties: ["develop"] };
const fittings: Array<{ id: string; metadata: GarrisonMetadata }> = [];

const EXPECTED = ["plan", "implement", "review", "test"];

// The dispatcher's in-memory model (duties keyed by id) for door 1's full
// dispatchRoute path — same shape the gateway wires at runtime.
const dispatcherModel = {
  duties: Object.fromEntries(DUTIES.map((d) => [d.id, d])),
  selectedDuties: ["develop"]
};

beforeAll(async () => {
  // Project the composition's resolved model to the sandbox model.json — exactly
  // what the runner does at up(). Doors 1 and 2 read THIS file.
  await writeKanbanResolvedModel(composition, fittings);
});

// Each door's "what sequence does a (develop, 2) card VISIT", via its own path.
async function door1GatewayConsult(): Promise<string[]> {
  const gw = new RoutedGateway({});
  return gw.resolvedSequenceForDispatch("develop", 2);
}

async function door1GatewayDispatch(): Promise<string[]> {
  const gw = new RoutedGateway({
    decisionsFile: join(KANBAN_DIR, "decisions.jsonl"),
    nowFn: () => "2026-07-13T00:00:00Z",
    dispatcher: {
      core: dispatchCore,
      model: dispatcherModel,
      call: async () => ({ ok: true, structured: { duty: "develop", level: 2, confidence: "high", reason: "x" } })
    }
  });
  const out = await gw.dispatchRoute("build the thing properly");
  return out.sequence ?? [];
}

function door2BoardConsult(): string[] {
  const model = loadResolvedModel();
  return resolveCardSequence({ duty: "develop", level: 2 }, model);
}

function door3SkillConsult(): string[] {
  const model = buildControlModel({ composition, fittings });
  return resolvedSequenceFrom(model, "develop", 2);
}

describe("three-door divergence zero (D15 acceptance 9)", () => {
  it("each door resolves (develop, 2) to [plan, implement, review, test]", async () => {
    expect(await door1GatewayConsult()).toEqual(EXPECTED);
    expect(await door1GatewayDispatch()).toEqual(EXPECTED);
    expect(door2BoardConsult()).toEqual(EXPECTED);
    expect(door3SkillConsult()).toEqual(EXPECTED);
  });

  it("DIVERGENCE = 0: the three doors' resolved sequences are byte-identical", async () => {
    const doors = {
      "door1-gateway": await door1GatewayConsult(),
      "door2-board": door2BoardConsult(),
      "door3-skill": door3SkillConsult()
    };
    // Count pairwise disagreements — the acceptance's literal "divergence" metric.
    const seqs = Object.values(doors);
    const reference = JSON.stringify(seqs[0]);
    const divergence = seqs.filter((s) => JSON.stringify(s) !== reference).length;
    expect(divergence).toBe(0);
    // Every door walks the same sequence (belt-and-suspenders on the count).
    for (const [name, seq] of Object.entries(doors)) {
      expect(seq, `${name} diverged`).toEqual(seqs[0]);
    }
  });

  it("the divergence is zero at OTHER (duty, level) points too, not just the headline one", async () => {
    // level 1 (quick) — a narrower card visits ONLY [implement] on every door.
    const gw = new RoutedGateway({});
    const door1 = await gw.resolvedSequenceForDispatch("develop", 1);
    const door2 = resolveCardSequence({ duty: "develop", level: 1 }, loadResolvedModel());
    const door3 = resolvedSequenceFrom(buildControlModel({ composition, fittings }), "develop", 1);
    expect(door1).toEqual(["implement"]);
    expect(door2).toEqual(["implement"]);
    expect(door3).toEqual(["implement"]);
  });
});
