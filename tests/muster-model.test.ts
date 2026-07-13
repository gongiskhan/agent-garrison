import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";

import {
  assembleMusterModel,
  buildMusterPayload,
  setCellTarget,
  setSelectedDuty
} from "@/app/api/muster/model";
import { getCompositionDirectory, type CompositionTarget } from "@/lib/compositions";
import { validateCellCompatibility } from "@/lib/router-migrate";
import { validateCell } from "@/components/muster/cell-validation";
import type { DutySpec } from "@/lib/types";

// A fixture composition written into compositions/<id> so the fs-backed mutation
// helpers have a real manifest to read/write. Unique per pid; removed afterAll.
const FIXTURE_ID = `muster-unit-fixture-${process.pid}`;
const FIXTURE_DIR = getCompositionDirectory(FIXTURE_ID);

const developDuty: DutySpec = {
  id: "develop",
  title: "Develop",
  description: "develop a change end to end",
  levels: [{ description: "standard", cell: { skill: "garrison-implement", target: "cc-sonnet", effort: "medium" } }]
};
const choreDuty: DutySpec = {
  id: "chore",
  title: "Chore",
  description: "a small chore",
  levels: [{ description: "quick", cell: { target: "cc-sonnet", effort: "low" } }]
};
const TARGETS: CompositionTarget[] = [
  { id: "cc-sonnet", runtime: "claude-code", model: "sonnet" },
  { id: "oneshot", runtime: "garrison-call", model: "none" }
];

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
        name: "Muster Unit Fixture",
        selections: {},
        duties: [developDuty, choreDuty],
        selected_duties: ["develop"],
        targets: TARGETS,
        prompt_sources: { orchestrator: ".garrison/prompts/orchestrator.md", soul: ".garrison/prompts/soul.md" }
      }
    }
  };
  // Atomic write (temp + rename): compositions/ is shared with parallel test
  // files whose listCompositions() may readdir this dir; a half-written apm.yml
  // would fail their YAML parse. Rename is atomic on the same filesystem.
  const target = path.join(FIXTURE_DIR, "apm.yml");
  const tmp = path.join(FIXTURE_DIR, `apm.yml.tmp-${process.pid}`);
  await fs.writeFile(tmp, yaml.dump(manifest), "utf8");
  await fs.rename(tmp, target);
}

async function readManifestComposition(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(FIXTURE_DIR, "apm.yml"), "utf8");
  const doc = yaml.load(raw) as { "x-garrison": { composition: Record<string, unknown> } };
  return doc["x-garrison"].composition;
}

beforeAll(writeFixture);
afterAll(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
});

describe("buildMusterPayload (pure)", () => {
  it("resolves selected duties in order and exposes them", () => {
    const payload = buildMusterPayload({
      composition: { id: "c", name: "C", duties: [developDuty, choreDuty], selectedDuties: ["develop"], targets: TARGETS },
      fittings: [],
      compositions: [{ id: "c", name: "C" }]
    });
    expect(payload.selectedDuties).toEqual(["develop"]);
    expect(payload.duties.develop?.title).toBe("Develop");
    expect(payload.duties.chore?.title).toBe("Chore"); // known but unselected
    expect(payload.targets).toHaveLength(2);
    expect(payload.compositions).toEqual([{ id: "c", name: "C" }]);
  });

  it("reports readiness rules unmet with no fittings, and the dispatch rule keys off selected duties", () => {
    const bare = buildMusterPayload({
      composition: { id: "c", name: "C", duties: [developDuty], selectedDuties: ["develop"], targets: TARGETS },
      fittings: [],
      compositions: []
    });
    expect(bare.ready).toBe(false);
    expect(bare.rules.find((r) => r.rule.id === "orchestrator")?.met).toBe(false);
    expect(bare.rules.find((r) => r.rule.id === "dispatcher")?.met).toBe(false);

    // A composition whose fitting provides the orchestrator kind flips that one rule.
    const withOrch = buildMusterPayload({
      composition: { id: "c", name: "C", duties: [developDuty], selectedDuties: ["develop"], targets: TARGETS },
      fittings: [
        {
          id: "orch",
          metadata: {
            faculty: "orchestrator",
            provides: [{ kind: "orchestrator", name: "main" }]
          } as never
        }
      ],
      compositions: []
    });
    expect(withOrch.rules.find((r) => r.rule.id === "orchestrator")?.met).toBe(true);
  });
});

describe("cell-validation replica agrees with the canonical rule (router-migrate)", () => {
  const cases = [
    { name: "skill + agentic target", cell: { skill: "s", target: "cc-sonnet" } },
    { name: "skill + garrison-call (single-shot)", cell: { skill: "s", target: "oneshot" } },
    { name: "skill + unknown target", cell: { skill: "s", target: "ghost" } },
    { name: "skill + no target", cell: { skill: "s" } },
    { name: "no skill (automation cell)", cell: { target: "oneshot" } }
  ];
  for (const c of cases) {
    it(c.name, () => {
      const canonical = validateCellCompatibility(c.cell, TARGETS);
      const replica = validateCell(c.cell, TARGETS);
      expect(replica.length).toBe(canonical.length);
      if (canonical.length > 0) {
        expect(replica[0].code).toBe(canonical[0].code);
      }
    });
  }
});

describe("mutation helpers (fs-backed)", () => {
  it("adds and removes a selected duty in the manifest and the returned model", async () => {
    const added = await setSelectedDuty(FIXTURE_ID, "chore", "add");
    expect(added.selectedDuties).toContain("chore");
    expect(((await readManifestComposition()).selected_duties as string[])).toContain("chore");

    const removed = await setSelectedDuty(FIXTURE_ID, "develop", "remove");
    expect(removed.selectedDuties).not.toContain("develop");
    expect(((await readManifestComposition()).selected_duties as string[])).not.toContain("develop");

    // rejects an unknown duty on add
    await expect(setSelectedDuty(FIXTURE_ID, "does-not-exist", "add")).rejects.toThrow(/unknown duty/);
  });

  it("sets a leaf cell's target and effort into composition.duties", async () => {
    const afterTarget = await setCellTarget(FIXTURE_ID, "develop", 1, { target: "oneshot" });
    expect(afterTarget.duties.develop?.levels[0].cell?.target).toBe("oneshot");

    const afterEffort = await setCellTarget(FIXTURE_ID, "develop", 1, { effort: "high" });
    expect(afterEffort.duties.develop?.levels[0].cell?.effort).toBe("high");

    const block = await readManifestComposition();
    const duties = block.duties as Array<{ id: string; levels: Array<{ cell?: { target?: string; effort?: string } }> }>;
    const develop = duties.find((d) => d.id === "develop");
    expect(develop?.levels[0].cell?.target).toBe("oneshot");
    expect(develop?.levels[0].cell?.effort).toBe("high");

    // a composite / out-of-range level cannot be assigned as a leaf
    await expect(setCellTarget(FIXTURE_ID, "develop", 9, { target: "cc-sonnet" })).rejects.toThrow(/no level 9/);
  });

  it("assembleMusterModel reads the fixture back with its live selection state", async () => {
    const model = await assembleMusterModel(FIXTURE_ID);
    expect(model.compositionId).toBe(FIXTURE_ID);
    expect(model.compositions.some((c) => c.id === FIXTURE_ID)).toBe(true);
    expect(Object.keys(model.duties)).toEqual(expect.arrayContaining(["develop", "chore"]));
  });
});
