// POST /api/muster/duty create/delete (Kanban board list management).
//
// createDuty / deleteDuty write composition-local duties into the fixture
// manifest and reproject the (sandboxed) kanban model.json when the fixture is
// the "active" composition (model.json stamped with its id). GARRISON_HOME and
// GARRISON_KANBAN_DIR point at temp sandboxes for the whole file so the live
// board state (~/.garrison/kanban-loop, ~/.garrison/ui-fittings) is never read
// or written - with no ui-fittings/kanban-loop.json in the sandbox the board
// poke is skipped and every result reports reconciled: false, no network.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { assembleMusterModel, createDuty, deleteDuty } from "@/app/api/muster/model";
import { getCompositionDirectory, type CompositionTarget } from "@/lib/compositions";
import { kanbanModelPath } from "@/lib/kanban-model";
import type { DutySpec } from "@/lib/types";

const FIXTURE_ID = `muster-duty-create-fixture-${process.pid}`;
const FIXTURE_DIR = getCompositionDirectory(FIXTURE_ID);

const developDuty: DutySpec = {
  id: "develop",
  title: "Develop",
  description: "develop a change end to end",
  levels: [{ description: "standard", cell: { target: "cc-sonnet", effort: "medium" } }]
};
const choreDuty: DutySpec = {
  id: "chore",
  title: "Chore",
  description: "a small chore",
  levels: [
    { description: "quick", cell: { target: "cc-sonnet", effort: "low" } },
    { description: "thorough", cell: { target: "cc-sonnet", effort: "medium" } }
  ]
};
// pipeline REFERENCES chore (level 2): deleting chore must deselect only.
const pipelineDuty: DutySpec = {
  id: "pipeline",
  title: "Pipeline",
  description: "a composite pipeline",
  levels: [{ description: "runs chore thoroughly", sequence: [{ duty: "chore", level: 2 }] }]
};
// cc-opus deliberately FIRST so the default-target test proves cc-sonnet is
// PREFERRED (not merely first-wins).
const TARGETS: CompositionTarget[] = [
  { id: "cc-opus", runtime: "claude-code", model: "opus" },
  { id: "cc-sonnet", runtime: "claude-code", model: "sonnet" }
];

async function writeFixture(selectedDuties: string[], targets: CompositionTarget[] = TARGETS): Promise<void> {
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
        name: "Muster Duty Create Fixture",
        selections: {},
        duties: [developDuty, choreDuty, pipelineDuty],
        selected_duties: selectedDuties,
        targets,
        prompt_sources: { orchestrator: ".garrison/prompts/orchestrator.md", soul: ".garrison/prompts/soul.md" }
      }
    }
  };
  // Atomic write (temp + rename): compositions/ is shared with parallel test
  // files whose listCompositions() may readdir this dir mid-write.
  const target = path.join(FIXTURE_DIR, "apm.yml");
  const tmp = path.join(FIXTURE_DIR, `apm.yml.tmp-${process.pid}`);
  await fs.writeFile(tmp, yaml.dump(manifest), "utf8");
  await fs.rename(tmp, target);
}

interface ManifestComposition {
  duties: Array<{ id: string; title: string; description: string; levels: Array<{ description: string; cell?: { target?: string; effort?: string } }> }>;
  selected_duties: string[];
}

async function readManifestComposition(): Promise<ManifestComposition> {
  const raw = await fs.readFile(path.join(FIXTURE_DIR, "apm.yml"), "utf8");
  const doc = yaml.load(raw) as { "x-garrison": { composition: ManifestComposition } };
  return doc["x-garrison"].composition;
}

let sandbox: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "muster-duty-create-"));
  for (const key of ["GARRISON_HOME", "GARRISON_KANBAN_DIR"]) savedEnv[key] = process.env[key];
  process.env.GARRISON_HOME = path.join(sandbox, "garrison-home");
  process.env.GARRISON_KANBAN_DIR = path.join(sandbox, "kanban");
  await fs.mkdir(process.env.GARRISON_HOME, { recursive: true });
  await fs.mkdir(process.env.GARRISON_KANBAN_DIR, { recursive: true });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("createDuty", () => {
  it("derives a kebab id from the title, writes the definition, and appends to a non-empty selection", async () => {
    await writeFixture(["develop"]);
    const result = await createDuty({ compositionId: FIXTURE_ID, title: "My List", effort: "high" });
    expect(result).toMatchObject({ ok: true, dutyId: "my-list", created: true, reconciled: false });

    const comp = await readManifestComposition();
    const written = comp.duties.find((d) => d.id === "my-list");
    expect(written?.title).toBe("My List");
    expect(written?.description).toBe("User-created list from the Kanban board.");
    expect(written?.levels).toHaveLength(1);
    expect(written?.levels[0].description).toBe("Default level for My List");
    // Default target: cc-sonnet is PREFERRED even though cc-opus is first.
    expect(written?.levels[0].cell).toEqual({ target: "cc-sonnet", effort: "high" });
    expect(comp.selected_duties).toEqual(["develop", "my-list"]);

    const model = await assembleMusterModel(FIXTURE_ID);
    expect(model.duties["my-list"]?.title).toBe("My List");
    expect(model.selectedDuties).toContain("my-list");
  });

  it("with only a dutyId derives a Title Case title and defaults effort to medium", async () => {
    await writeFixture(["develop"]);
    const result = await createDuty({ compositionId: FIXTURE_ID, dutyId: "Ops Triage!" });
    expect(result.dutyId).toBe("ops-triage");
    const written = (await readManifestComposition()).duties.find((d) => d.id === "ops-triage");
    expect(written?.title).toBe("Ops Triage");
    expect(written?.levels[0].cell?.effort).toBe("medium");
    // an out-of-vocabulary effort also lands on medium
    const second = await createDuty({ compositionId: FIXTURE_ID, dutyId: "second-list", effort: "turbo" });
    expect(second.dutyId).toBe("second-list");
    const secondWritten = (await readManifestComposition()).duties.find((d) => d.id === "second-list");
    expect(secondWritten?.levels[0].cell?.effort).toBe("medium");
  });

  it("refuses reserved ids, already-known duty ids, and underivable names - without writing", async () => {
    await writeFixture(["develop"]);
    await expect(createDuty({ compositionId: FIXTURE_ID, dutyId: "done" })).rejects.toThrow(/reserved/);
    await expect(createDuty({ compositionId: FIXTURE_ID, title: "Needs Attention" })).rejects.toThrow(/reserved/);
    await expect(createDuty({ compositionId: FIXTURE_ID, dutyId: "dispatch" })).rejects.toThrow(/reserved/);
    await expect(createDuty({ compositionId: FIXTURE_ID, dutyId: "develop" })).rejects.toThrow(/already exists/);
    await expect(createDuty({ compositionId: FIXTURE_ID, title: "123" })).rejects.toThrow(/cannot derive/);
    const comp = await readManifestComposition();
    expect(comp.duties.map((d) => d.id)).toEqual(["develop", "chore", "pipeline"]);
    expect(comp.selected_duties).toEqual(["develop"]);
  });

  it("rejects an unknown passed target as an error, not a silent null cell", async () => {
    await writeFixture(["develop"]);
    await expect(
      createDuty({ compositionId: FIXTURE_ID, dutyId: "ghost-list", target: "ghost" })
    ).rejects.toThrow(/unknown target/);
    const comp = await readManifestComposition();
    expect(comp.duties.some((d) => d.id === "ghost-list")).toBe(false);
    expect(JSON.stringify(comp)).not.toContain("ghost");
  });

  it("leaves an EMPTY selected_duties empty (select-all) instead of materialising a one-entry list", async () => {
    await writeFixture([]);
    const result = await createDuty({ compositionId: FIXTURE_ID, title: "Extra Work" });
    expect(result.dutyId).toBe("extra-work");
    const comp = await readManifestComposition();
    expect(comp.duties.some((d) => d.id === "extra-work")).toBe(true);
    // A [extra-work] write here would silently DESELECT develop/chore/pipeline.
    expect(comp.selected_duties).toEqual([]);
  });
});

describe("deleteDuty", () => {
  it("deselects and deletes an unreferenced composition-local definition", async () => {
    await writeFixture(["develop", "chore", "pipeline"]);
    const result = await deleteDuty({ compositionId: FIXTURE_ID, dutyId: "develop" });
    expect(result).toMatchObject({ ok: true, dutyId: "develop", deleted: true, reconciled: false });
    expect(result.selectedOnly).toBeUndefined();

    const comp = await readManifestComposition();
    expect(comp.duties.some((d) => d.id === "develop")).toBe(false);
    expect(comp.selected_duties).toEqual(["chore", "pipeline"]);
  });

  it("keeps a definition referenced by another duty's sequence - deselect only, selectedOnly", async () => {
    await writeFixture(["develop", "chore", "pipeline"]);
    const result = await deleteDuty({ compositionId: FIXTURE_ID, dutyId: "chore" });
    expect(result).toMatchObject({ ok: true, dutyId: "chore", deleted: true, selectedOnly: true });
    expect(result.note).toMatch(/referenced/);

    const comp = await readManifestComposition();
    // The definition survives (pipeline runs chore at level 2)...
    expect(comp.duties.some((d) => d.id === "chore")).toBe(true);
    // ...but the duty is deselected.
    expect(comp.selected_duties).toEqual(["develop", "pipeline"]);
    // The model still resolves without graph errors.
    const model = await assembleMusterModel(FIXTURE_ID);
    expect(model.errors).toEqual([]);
  });

  it("materialises the explicit all-known-minus-this list when selected_duties was empty (select-all)", async () => {
    await writeFixture([]);
    const result = await deleteDuty({ compositionId: FIXTURE_ID, dutyId: "develop" });
    expect(result.deleted).toBe(true);

    const comp = await readManifestComposition();
    // Every OTHER known duty is now explicitly selected - an empty list would
    // have kept auto-selecting the deleted duty.
    expect(comp.selected_duties).toEqual(["chore", "pipeline"]);
    // develop was unreferenced and composition-local: definition gone too.
    expect(comp.duties.some((d) => d.id === "develop")).toBe(false);
  });

  it("refuses an unknown duty", async () => {
    await writeFixture(["develop"]);
    await expect(deleteDuty({ compositionId: FIXTURE_ID, dutyId: "no-such" })).rejects.toThrow(/unknown duty/);
  });
});

describe("live board reproject (sandboxed model.json)", () => {
  it("rewrites model.json only when it is stamped with the edited composition's id", async () => {
    await writeFixture(["develop"]);
    const modelFile = kanbanModelPath();

    // Stamped with ANOTHER composition: the edit must leave it untouched.
    const foreign = { version: 2, compositionId: "someone-else", kanbanLists: ["x"], sequences: {}, cells: {} };
    await fs.mkdir(path.dirname(modelFile), { recursive: true });
    await fs.writeFile(modelFile, JSON.stringify(foreign), "utf8");
    const inert = await createDuty({ compositionId: FIXTURE_ID, title: "Board Made" });
    expect(inert.reconciled).toBe(false);
    expect(JSON.parse(await fs.readFile(modelFile, "utf8"))).toEqual(foreign);

    // Stamped with THIS composition: the edit reprojects it in place.
    await fs.writeFile(
      modelFile,
      JSON.stringify({ version: 2, compositionId: FIXTURE_ID, kanbanLists: ["develop"], sequences: {}, cells: {} }),
      "utf8"
    );
    const created = await createDuty({ compositionId: FIXTURE_ID, title: "Second Board" });
    // The board itself is down in the sandbox (no ui-fittings/kanban-loop.json),
    // so the poke is skipped - but model.json carries the new list.
    expect(created.reconciled).toBe(false);
    let projected = JSON.parse(await fs.readFile(modelFile, "utf8"));
    expect(projected.compositionId).toBe(FIXTURE_ID);
    expect(projected.kanbanLists).toContain("second-board");
    expect(projected.kanbanLists).toContain("board-made");

    // Delete reprojects too: the list leaves the model so the board's reconcile
    // can drop it.
    const deleted = await deleteDuty({ compositionId: FIXTURE_ID, dutyId: "second-board" });
    expect(deleted.deleted).toBe(true);
    projected = JSON.parse(await fs.readFile(modelFile, "utf8"));
    expect(projected.kanbanLists).not.toContain("second-board");
    expect(projected.kanbanLists).toContain("develop");
  });
});
