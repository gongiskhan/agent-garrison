// Duty model ladders (Garrison Conversations, slice A2).
//
// A LADDER is an ordered set of named model tiers (floor -> top) declared once
// per composition; a duty names one plus the rung it starts on (`default`) and
// the highest rung it may reach unaided (`ceiling`). A rung is model TIER and a
// duty level is DEPTH OF WORK - two independent axes, which is why nothing here
// touches levels or cells and effort still comes from the level cell.
//
// The load-bearing property is the fallback: a duty that declares NO ladder
// lines must keep routing exactly where it always did, via a synthetic one-rung
// ladder derived from its level-1 cell. That is what makes this slice additive -
// no existing composition needs a single YAML edit.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { manifestToComposition, parseCompositionV4 } from "@/lib/compositions";
import { computeKanbanResolvedModel } from "@/lib/kanban-model";
import { readYamlFile } from "@/lib/yaml";
import { compositionManifestPath } from "./helpers/shipped-compositions";
// @ts-ignore — pure .mjs, no types
import { ladderFor, loadResolvedModel, rungTarget } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";

type Block = Parameters<typeof parseCompositionV4>[0];
const block = (partial: Record<string, unknown>): Block => partial as unknown as Block;

const LADDERS = {
  standard: [
    { id: "floor", target: "sdk-haiku" },
    { id: "middle", target: "cc-sonnet" },
    { id: "top", target: "cc-opus" }
  ],
  adversarial: [{ id: "cross", target: "sol" }]
};

const TARGETS = [
  { id: "sdk-haiku", runtime: "agent-sdk", model: "claude-haiku-4-5", provider: "anthropic", params: { authMode: "api-key" } },
  { id: "cc-sonnet", runtime: "agent-sdk", model: "sonnet", provider: "anthropic", params: { promptMode: "coding" } },
  { id: "cc-opus", runtime: "agent-sdk", model: "opus", provider: "anthropic", params: {} },
  { id: "sol", runtime: "codex", model: "gpt-5.6-sol", provider: "anthropic", params: { type: "secondary" } }
];

// A duty with one leaf level, plus whatever ladder lines the case needs.
const duty = (id: string, target: string, lines: Record<string, string> = {}) => ({
  id,
  title: id,
  description: `${id} things`,
  levels: [{ description: "standard: do it", cell: { target, effort: "medium" as const } }],
  ...lines
});

const compose = (duties: ReturnType<typeof duty>[], ladders: unknown = LADDERS) =>
  manifestToComposition("t", {
    name: "t",
    version: "0.1.0",
    target: "claude",
    "x-garrison": {
      composition: { schema: 4, id: "t", duties, selected_duties: duties.map((d) => d.id), targets: TARGETS, ladders }
    }
  } as unknown as Parameters<typeof manifestToComposition>[1]);

describe("ladder parsing", () => {
  it("parses the ladders block and the per-duty ladder/default/ceiling lines", () => {
    const parsed = parseCompositionV4(
      block({
        schema: 4,
        ladders: LADDERS,
        duties: [
          duty("implement", "cc-opus", { default: "middle", ceiling: "top" }),
          duty("adversarial-review", "sol", { ladder: "adversarial", default: "cross", ceiling: "cross" }),
          duty("test", "cc-sonnet")
        ],
        selected_duties: ["implement", "adversarial-review", "test"],
        targets: TARGETS
      })
    );

    expect(parsed.ladders).toEqual(LADDERS);
    expect(parsed.duties[0].default).toBe("middle");
    expect(parsed.duties[0].ceiling).toBe("top");
    expect(parsed.duties[1].ladder).toBe("adversarial");
    // A duty with no lines keeps exactly the shape it had before ladders existed.
    expect(parsed.duties[2].ladder).toBeUndefined();
    expect(parsed.duties[2].default).toBeUndefined();
    // Levels are UNTOUCHED by the ladder: depth of work and model tier are
    // separate axes, and effort still lives on the cell.
    expect(parsed.duties[0].levels[0].cell).toEqual({ target: "cc-opus", effort: "medium" });
  });

  it("a composition with no ladders block still parses (the field is additive)", () => {
    const parsed = parseCompositionV4(
      block({ schema: 4, duties: [duty("test", "cc-sonnet")], selected_duties: ["test"], targets: TARGETS })
    );
    expect(parsed.ladders).toBeUndefined();
  });

  it("rejects a duplicate rung id - `default: middle` must name exactly one rung", () => {
    expect(() =>
      parseCompositionV4(
        block({
          schema: 4,
          ladders: { standard: [{ id: "middle", target: "cc-sonnet" }, { id: "middle", target: "cc-opus" }] },
          duties: [],
          selected_duties: []
        })
      )
    ).toThrow(/declared twice/);
  });

  it("rejects a non-kebab rung id and an empty ladder", () => {
    expect(() =>
      parseCompositionV4(block({ schema: 4, ladders: { standard: [{ id: "Top", target: "cc-opus" }] } }))
    ).toThrow(/kebab-case/);
    expect(() => parseCompositionV4(block({ schema: 4, ladders: { standard: [] } }))).toThrow(/at least one rung/);
  });
});

describe("the shipped default composition", () => {
  it("declares the standard + adversarial ladders over targets it actually has", async () => {
    const manifest = await readYamlFile<Record<string, any>>(compositionManifestPath("default"));
    const composition = manifestToComposition("default", manifest as never);

    expect(composition.ladders?.standard).toEqual([
      { id: "floor", target: "sdk-haiku" },
      { id: "middle", target: "cc-sonnet" },
      { id: "top", target: "cc-opus" }
    ]);
    expect(composition.ladders?.adversarial).toEqual([{ id: "cross", target: "sol" }]);

    // Every rung must name a declared target, or the launcher routes to nothing.
    const declared = new Set(composition.targets.map((t) => t.id));
    const rungTargets = Object.values(composition.ladders ?? {}).flatMap((rungs) => rungs.map((r) => r.target));
    expect(rungTargets.filter((id) => !declared.has(id))).toEqual([]);
  });

  it("carries the duty lines, and triage + responder are defined AND selected", async () => {
    const manifest = await readYamlFile<Record<string, any>>(compositionManifestPath("default"));
    const composition = manifestToComposition("default", manifest as never);
    const byId = new Map(composition.duties.map((d) => [d.id, d]));

    expect(byId.get("implement")).toMatchObject({ default: "middle", ceiling: "top" });
    expect(byId.get("plan")).toMatchObject({ default: "middle", ceiling: "top" });
    expect(byId.get("adversarial-review")).toMatchObject({
      ladder: "adversarial",
      default: "cross",
      ceiling: "cross"
    });
    expect(byId.get("triage")).toMatchObject({ default: "floor", ceiling: "middle" });
    expect(byId.get("responder")).toMatchObject({ default: "floor", ceiling: "middle" });
    expect(composition.selectedDuties).toEqual(expect.arrayContaining(["triage", "responder"]));
  });

  it("projects a coherent dutyLadder for every selected duty", async () => {
    const manifest = await readYamlFile<Record<string, any>>(compositionManifestPath("default"));
    const composition = manifestToComposition("default", manifest as never);
    const model = computeKanbanResolvedModel(composition, []);

    expect(model.version).toBe(3);
    expect(model.dutyLadder?.implement).toMatchObject({ ladder: "standard", defaultIndex: 1, ceilingIndex: 2 });
    expect(model.dutyLadder?.triage).toMatchObject({ ladder: "standard", defaultIndex: 0, ceilingIndex: 1 });
    expect(model.dutyLadder?.["adversarial-review"]).toMatchObject({
      ladder: "adversarial",
      defaultIndex: 0,
      ceilingIndex: 0
    });
    // Untouched duties fall back to their own level-1 cell, so the projection
    // covers everything the board can route without a single extra YAML line.
    expect(model.dutyLadder?.test).toMatchObject({ ladder: null, defaultIndex: 0, ceilingIndex: 0 });
    for (const id of composition.selectedDuties) {
      expect(model.dutyLadder?.[id], `duty "${id}" has no projected ladder`).toBeTruthy();
    }
  });
});

describe("computeKanbanResolvedModel - ladder projection", () => {
  it("resolves every rung's target into engine identity", () => {
    const model = computeKanbanResolvedModel(compose([duty("implement", "cc-opus", { default: "middle", ceiling: "top" })]), []);
    expect(model.ladders?.standard).toEqual([
      { id: "floor", target: "sdk-haiku", runtime: "agent-sdk", provider: "anthropic", model: "claude-haiku-4-5", params: { authMode: "api-key" } },
      { id: "middle", target: "cc-sonnet", runtime: "agent-sdk", provider: "anthropic", model: "sonnet", params: { promptMode: "coding" } },
      { id: "top", target: "cc-opus", runtime: "agent-sdk", provider: "anthropic", model: "opus", params: {} }
    ]);
    const implement = model.dutyLadder!.implement;
    expect(implement.rungs[implement.defaultIndex].model).toBe("sonnet");
    expect(implement.rungs[implement.ceilingIndex].model).toBe("opus");
  });

  it("a duty with NO ladder fields gets a synthetic one-rung ladder from its level-1 cell", () => {
    const model = computeKanbanResolvedModel(compose([duty("test", "cc-sonnet")]), []);
    expect(model.dutyLadder?.test).toEqual({
      ladder: null,
      rungs: [
        {
          id: "cc-sonnet",
          target: "cc-sonnet",
          runtime: "agent-sdk",
          provider: "anthropic",
          model: "sonnet",
          params: { promptMode: "coding" }
        }
      ],
      defaultIndex: 0,
      ceilingIndex: 0
    });
  });

  it("a duty naming only a ladder spans it end to end", () => {
    const model = computeKanbanResolvedModel(compose([duty("plan", "cc-sonnet", { ladder: "standard" })]), []);
    expect(model.dutyLadder?.plan).toMatchObject({ ladder: "standard", defaultIndex: 0, ceilingIndex: 2 });
  });

  it("an unknown rung id throws at PROJECTION time, not at dispatch", () => {
    expect(() => computeKanbanResolvedModel(compose([duty("implement", "cc-opus", { default: "nope" })]), [])).toThrow(
      /default rung "nope" is not on ladder "standard"/
    );
    expect(() => computeKanbanResolvedModel(compose([duty("implement", "cc-opus", { ceiling: "nope" })]), [])).toThrow(
      /ceiling rung "nope" is not on ladder "standard"/
    );
  });

  it("a missing ladder throws, naming what the composition does declare", () => {
    expect(() =>
      computeKanbanResolvedModel(compose([duty("implement", "cc-opus", { ladder: "aggressive", default: "top" })]), [])
    ).toThrow(/names ladder "aggressive", which the composition does not declare/);
    // Ladder lines with no ladders block at all is the same failure.
    expect(() => computeKanbanResolvedModel(compose([duty("implement", "cc-opus", { default: "middle" })], {}), [])).toThrow(
      /does not declare/
    );
  });

  it("a ceiling BELOW the default throws - the range would be empty", () => {
    expect(() =>
      computeKanbanResolvedModel(compose([duty("implement", "cc-opus", { default: "top", ceiling: "floor" })]), [])
    ).toThrow(/below its default/);
  });

  it("a rung naming an undeclared target still projects, with null identity", () => {
    const composition = compose([duty("implement", "cc-opus", { default: "ghost" })], {
      standard: [{ id: "ghost", target: "not-a-target" }]
    });
    const model = computeKanbanResolvedModel(composition, []);
    expect(model.ladders?.standard[0]).toEqual({
      id: "ghost",
      target: "not-a-target",
      runtime: null,
      provider: null,
      model: null,
      params: {}
    });
  });
});

describe("resolved-model.mjs - loading and reading a ladder", () => {
  const writeModel = (model: unknown): string => {
    const root = mkdtempSync(path.join(tmpdir(), "duty-ladder-"));
    writeFileSync(path.join(root, "model.json"), JSON.stringify(model), "utf8");
    return root;
  };

  const V2 = {
    version: 2,
    compositionId: "t",
    kanbanLists: ["implement", "test"],
    sequences: {},
    cells: {
      implement: { "1": { target: "cc-sonnet", effort: "medium", runtime: "agent-sdk", model: "sonnet", provider: "anthropic" } }
    },
    targets: TARGETS
  };

  const V3 = {
    ...V2,
    version: 3,
    ladders: { standard: LADDERS.standard.map((r) => ({ ...r, runtime: "agent-sdk", provider: "anthropic", model: r.id, params: {} })) },
    dutyLadder: {
      implement: {
        ladder: "standard",
        rungs: LADDERS.standard.map((r) => ({ ...r, runtime: "agent-sdk", provider: "anthropic", model: r.id, params: {} })),
        defaultIndex: 1,
        ceilingIndex: 2
      }
    }
  };

  it("loads a v2 projection (no dutyLadder) and a v3 projection alike", () => {
    expect(loadResolvedModel(writeModel(V2))?.version).toBe(2);
    expect(loadResolvedModel(writeModel(V2))?.dutyLadder).toBeUndefined();
    expect(loadResolvedModel(writeModel(V3))?.version).toBe(3);
    expect(loadResolvedModel(writeModel(V3))?.dutyLadder?.implement?.defaultIndex).toBe(1);
  });

  it("still fails closed on a version it does not understand", () => {
    expect(loadResolvedModel(writeModel({ ...V3, version: 4 }))).toBeNull();
  });

  it("ladderFor returns the projected ladder, and synthesises one for a v2 model", () => {
    expect(ladderFor(V3, "implement")).toMatchObject({ ladder: "standard", defaultIndex: 1, ceilingIndex: 2 });
    // Same duty, v2 model: one rung off the level-1 cell, no escalation room.
    expect(ladderFor(V2, "implement")).toEqual({
      ladder: null,
      rungs: [
        {
          id: "cc-sonnet",
          target: "cc-sonnet",
          runtime: "agent-sdk",
          provider: "anthropic",
          model: "sonnet",
          params: { promptMode: "coding" }
        }
      ],
      defaultIndex: 0,
      ceilingIndex: 0
    });
    // A duty with neither a projected ladder nor a level-1 cell has no tier.
    expect(ladderFor(V3, "nonexistent")).toBeNull();
    expect(ladderFor(null, "implement")).toBeNull();
  });

  it("rungTarget clamps into the ladder instead of falling off it", () => {
    expect(rungTarget(V3, "implement", 0).id).toBe("floor");
    expect(rungTarget(V3, "implement", 2).id).toBe("top");
    // Escalating past the top rung lands ON the top rung, never on nothing.
    expect(rungTarget(V3, "implement", 9).id).toBe("top");
    expect(rungTarget(V3, "implement", -3).id).toBe("floor");
    // A non-integer index falls back to the duty's default rung.
    expect(rungTarget(V3, "implement", undefined).id).toBe("middle");
    expect(rungTarget(V2, "implement", 5).target).toBe("cc-sonnet");
    expect(rungTarget(V3, "nonexistent", 0)).toBeNull();
  });
});
