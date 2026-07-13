// S4b — the garrison-control READ TOOL (GARRISON-UNIFY-V1 D15, acceptance 9).
//
// garrison-control is DOOR 3's consult surface: it exposes the active
// composition's resolved model (duties, kanbanLists, per-(duty,level) sequences,
// readiness) READ-ONLY, so the garrison skill registers a card that walks the SAME
// resolved sequence the board (door 2) and the gateway dispatch (door 1) walk.
// These tests prove (a) it returns the resolved model + a correct sequence for
// (develop, 2) = [plan, implement, review, test], and (b) it is read-only.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

import * as garrisonControl from "@/lib/garrison-control";
import { buildControlModel, resolvedSequenceFrom, getResolvedModel, getResolvedSequence, getReadiness } from "@/lib/garrison-control";
import { getCompositionDirectory } from "@/lib/compositions";
import type { DutySpec, GarrisonMetadata } from "@/lib/types";

// The develop COMPOSITE (level 1 = quick implement, level 2 = the full inner
// pipeline) plus its leaf steps — the same shape S4a's board test uses, so
// garrison-control's answer is cross-checkable against the board's.
const leaf = (id: string): DutySpec => ({
  id,
  title: id,
  description: `the ${id} leaf duty`,
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

const composition = { id: "gc-unit", duties: DUTIES, selectedDuties: ["develop"] };
const fittings: Array<{ id: string; metadata: GarrisonMetadata }> = [];

describe("garrison-control pure core (buildControlModel / resolvedSequenceFrom)", () => {
  it("(a) resolves (develop, 2) → [plan, implement, review, test]", () => {
    const model = buildControlModel({ composition, fittings });
    expect(resolvedSequenceFrom(model, "develop", 2)).toEqual(["plan", "implement", "review", "test"]);
  });

  it("resolves (develop, 1) → [implement] (the quick level)", () => {
    const model = buildControlModel({ composition, fittings });
    expect(resolvedSequenceFrom(model, "develop", 1)).toEqual(["implement"]);
  });

  it("exposes the whole resolved model — duties, selectedDuties, kanbanLists, sequences, readiness", () => {
    const model = buildControlModel({ composition, fittings });
    expect(model.compositionId).toBe("gc-unit");
    expect(model.selectedDuties).toEqual(["develop"]);
    expect(Object.keys(model.duties).sort()).toEqual(["develop", "implement", "plan", "review", "test"]);
    // The union list set carries every leaf the develop composite reaches.
    expect(model.kanbanLists).toEqual(expect.arrayContaining(["plan", "implement", "review", "test"]));
    expect(model.sequences.develop["2"]).toEqual(["plan", "implement", "review", "test"]);
    expect(Array.isArray(model.rules)).toBe(true);
    expect(typeof model.ready).toBe("boolean");
    expect(model.errors).toEqual([]);
  });

  it("an unknown duty/level yields [] rather than throwing (a read tool answers)", () => {
    const model = buildControlModel({ composition, fittings });
    expect(resolvedSequenceFrom(model, "nope", 1)).toEqual([]);
    expect(resolvedSequenceFrom(model, "develop", 99)).toEqual([]);
  });
});

// (b) READ-ONLY: garrison-control exposes ONLY reads. Its exported surface is
// exactly the read set — no set/write/update/mutate/save/delete/patch — so a
// caller (the skill, the API route, another door) can never mutate a composition
// through it. Every write goes through Muster.
describe("garrison-control is READ-ONLY", () => {
  it("exports exactly the read-only surface (no mutation function)", () => {
    const exported = Object.keys(garrisonControl)
      .filter((k) => typeof (garrisonControl as Record<string, unknown>)[k] === "function")
      .sort();
    expect(exported).toEqual([
      "buildControlModel",
      "getReadiness",
      "getResolvedModel",
      "getResolvedSequence",
      "resolvedSequenceFrom"
    ]);
    const mutation = /^(set|write|update|mutate|save|delete|remove|patch|put|post|create|add)/i;
    expect(exported.filter((k) => mutation.test(k))).toEqual([]);
  });
});

// The fs wrappers read the ACTIVE composition exactly as Muster does. A fixture
// composition on disk proves getResolvedModel / getResolvedSequence / getReadiness
// resolve the real manifest and return the same answer as the pure core.
const FIXTURE_ID = `gc-fs-fixture-${process.pid}`;
const FIXTURE_DIR = getCompositionDirectory(FIXTURE_ID);

async function writeFixture(): Promise<void> {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
  const manifest = {
    name: FIXTURE_ID,
    version: "0.1.0",
    target: "claude",
    dependencies: { apm: [] },
    "x-garrison": {
      composition: {
        schema: 4,
        id: FIXTURE_ID,
        name: "garrison-control fs fixture",
        selections: {},
        duties: DUTIES,
        selected_duties: ["develop"],
        targets: [{ id: "cc-sonnet", runtime: "claude-code", model: "sonnet" }],
        prompt_sources: { orchestrator: ".garrison/prompts/orchestrator.md", soul: ".garrison/prompts/soul.md" }
      }
    }
  };
  const target = path.join(FIXTURE_DIR, "apm.yml");
  const tmp = path.join(FIXTURE_DIR, `apm.yml.tmp-${process.pid}`);
  await fs.writeFile(tmp, yaml.dump(manifest), "utf8");
  await fs.rename(tmp, target);
}

afterAll(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
});

describe("garrison-control fs wrappers (read the active composition)", () => {
  it("getResolvedModel + getResolvedSequence + getReadiness resolve the on-disk composition", async () => {
    await writeFixture();

    const model = await getResolvedModel(FIXTURE_ID);
    expect(model.compositionId).toBe(FIXTURE_ID);
    expect(model.sequences.develop["2"]).toEqual(["plan", "implement", "review", "test"]);

    const seq = await getResolvedSequence("develop", 2, FIXTURE_ID);
    expect(seq).toEqual({ duty: "develop", level: 2, sequence: ["plan", "implement", "review", "test"] });

    const readiness = await getReadiness(FIXTURE_ID);
    expect(Array.isArray(readiness.rules)).toBe(true);
    expect(typeof readiness.ready).toBe("boolean");
  });

  it("REJECTS a missing composition instead of creating it (read-only, codex S4b)", async () => {
    const fs = await import("node:fs");
    const { getCompositionDirectory } = await import("@/lib/compositions");
    const missingId = `gc-missing-${process.pid}`;
    const dir = getCompositionDirectory(missingId);
    // Precondition: it does not exist.
    expect(fs.existsSync(dir)).toBe(false);
    await expect(getResolvedModel(missingId)).rejects.toThrow(/not found/);
    // The read must NOT have materialised the composition (no write side effect).
    expect(fs.existsSync(dir)).toBe(false);
  });
});
