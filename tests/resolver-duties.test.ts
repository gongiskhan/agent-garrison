import { describe, expect, it } from "vitest";
import {
  DEFAULT_READINESS_RULES,
  collectDuties,
  deriveKanbanLists,
  evaluateReadiness,
  resolveModel,
  resolveSequence,
  validateDutyGraph,
  type ResolverFittingInput
} from "@/lib/resolver";
import { parseGarrisonMetadata } from "@/lib/metadata";
import type { DutySpec, GarrisonMetadata } from "@/lib/types";

function fitting(
  id: string,
  options: {
    faculty?: GarrisonMetadata["faculty"];
    provides?: GarrisonMetadata["provides"];
    duties?: DutySpec[];
  } = {}
): ResolverFittingInput {
  const metadata: GarrisonMetadata = {
    faculty: options.faculty ?? "building",
    cardinality_hint: "single",
    component_shape: "skill",
    platforms: ["claude-code"],
    config_schema: [],
    provides: options.provides ?? [],
    consumes: [],
    verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 },
    ...(options.duties ? { duties: options.duties } : {})
  };
  return { id, metadata };
}

const implementDuty: DutySpec = {
  id: "implement",
  title: "Implement",
  description: "write the code for a planned change",
  levels: [
    { description: "level 1: direct edit", cell: { skill: "garrison-implement", target: "t-fast", effort: "medium" } },
    { description: "level 2: careful edit", cell: { skill: "garrison-implement", target: "t-deep", effort: "high" } }
  ]
};

const reviewDuty: DutySpec = {
  id: "review",
  title: "Review",
  description: "review a diff for defects",
  levels: [
    { description: "level 1: quick review", cell: { skill: "garrison-review", target: "t-fast", effort: "low" } },
    { description: "level 2: deep review", cell: { skill: "garrison-review", target: "t-deep", effort: "xhigh" } }
  ]
};

const developDuty: DutySpec = {
  id: "develop",
  title: "Develop",
  description: "develop a change end to end",
  levels: [
    {
      description: "level 1: quick fix, no plan",
      sequence: [{ duty: "implement" }]
    },
    {
      description: "level 2: adds review",
      sequence: [{ duty: "implement" }, { duty: "review" }]
    }
  ]
};

describe("duty metadata parsing (D2)", () => {
  const base = {
    faculty: "building",
    cardinality_hint: "single",
    component_shape: "skill",
    platforms: ["claude-code"],
    verify: { command: "echo ok", expect: "ok" }
  };

  it("parses a duty-providing fitting (provision name === duty id)", () => {
    const metadata = parseGarrisonMetadata({
      ...base,
      provides: [{ kind: "duty", name: "implement" }],
      duties: [implementDuty]
    });
    expect(metadata.duties?.[0]?.id).toBe("implement");
    expect(metadata.duties?.[0]?.levels).toHaveLength(2);
  });

  it("rejects a kind:duty provision without a matching duties[] spec", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...base,
        provides: [{ kind: "duty", name: "implement" }]
      })
    ).toThrow(/no matching duties\[\] spec/);
  });

  it("rejects a duties[] spec without a matching provision", () => {
    expect(() =>
      parseGarrisonMetadata({
        ...base,
        provides: [],
        duties: [implementDuty]
      })
    ).toThrow(/no provides entry/);
  });

  it("rejects a level that is both cell and sequence, or neither", () => {
    const both = {
      ...base,
      provides: [{ kind: "duty", name: "broken" }],
      duties: [
        {
          id: "broken",
          title: "Broken",
          description: "broken duty",
          levels: [
            { description: "bad", cell: {}, sequence: [{ duty: "implement" }] }
          ]
        }
      ]
    };
    expect(() => parseGarrisonMetadata(both)).toThrow(/exactly one/);
    const neither = {
      ...base,
      provides: [{ kind: "duty", name: "broken" }],
      duties: [
        { id: "broken", title: "Broken", description: "broken duty", levels: [{ description: "bad" }] }
      ]
    };
    expect(() => parseGarrisonMetadata(neither)).toThrow(/exactly one/);
  });

  it("multi-duty fittings are allowed", () => {
    const metadata = parseGarrisonMetadata({
      ...base,
      provides: [
        { kind: "duty", name: "implement" },
        { kind: "duty", name: "review" }
      ],
      duties: [implementDuty, reviewDuty]
    });
    expect(metadata.duties).toHaveLength(2);
  });
});

describe("duty graph validation (D3)", () => {
  it("accepts a valid leaf + composite DAG", () => {
    const { duties } = collectDuties([
      fitting("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] }),
      fitting("f-rev", { provides: [{ kind: "duty", name: "review" }], duties: [reviewDuty] }),
      fitting("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [developDuty] })
    ]);
    expect(validateDutyGraph(duties)).toEqual([]);
  });

  it("reports an unknown duty reference loudly", () => {
    const { duties } = collectDuties([
      fitting("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [developDuty] })
    ]);
    const errors = validateDutyGraph(duties);
    expect(errors.some((e) => e.code === "missing-duty-ref" && e.message.includes("implement"))).toBe(true);
  });

  it("reports an explicit level override beyond the referenced duty's range", () => {
    const dev: DutySpec = {
      ...developDuty,
      levels: [
        { description: "l1", sequence: [{ duty: "implement", level: 9 }] }
      ]
    };
    const { duties } = collectDuties([
      fitting("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] }),
      fitting("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [dev] })
    ]);
    const errors = validateDutyGraph(duties);
    expect(errors.some((e) => e.code === "level-out-of-range")).toBe(true);
  });

  it("reports a parent-level default that the referenced duty cannot satisfy", () => {
    const shallow: DutySpec = {
      id: "shallow",
      title: "Shallow",
      description: "one-level duty",
      levels: [{ description: "only level", cell: { target: "t-fast" } }]
    };
    const dev: DutySpec = {
      id: "develop",
      title: "Develop",
      description: "develop",
      levels: [
        { description: "l1", sequence: [{ duty: "shallow" }] },
        { description: "l2", sequence: [{ duty: "shallow" }] } // runs shallow at level 2 — missing
      ]
    };
    const { duties } = collectDuties([
      fitting("f-s", { provides: [{ kind: "duty", name: "shallow" }], duties: [shallow] }),
      fitting("f-d", { provides: [{ kind: "duty", name: "develop" }], duties: [dev] })
    ]);
    const errors = validateDutyGraph(duties);
    expect(errors.some((e) => e.code === "missing-level" && e.level === 2)).toBe(true);
  });

  it("detects cycles (A → B → A)", () => {
    const a: DutySpec = {
      id: "a",
      title: "A",
      description: "a",
      levels: [{ description: "l1", sequence: [{ duty: "b" }] }]
    };
    const b: DutySpec = {
      id: "b",
      title: "B",
      description: "b",
      levels: [{ description: "l1", sequence: [{ duty: "a" }] }]
    };
    const { duties } = collectDuties([
      fitting("f-a", { provides: [{ kind: "duty", name: "a" }], duties: [a] }),
      fitting("f-b", { provides: [{ kind: "duty", name: "b" }], duties: [b] })
    ]);
    const errors = validateDutyGraph(duties);
    expect(errors.some((e) => e.code === "cycle")).toBe(true);
  });

  it("flags the same duty provided by two fittings", () => {
    const { errors } = collectDuties([
      fitting("f-1", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] }),
      fitting("f-2", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] })
    ]);
    expect(errors.some((e) => e.code === "duplicate-duty")).toBe(true);
  });
});

describe("sequence resolution (D3/D4 — levels stored flat)", () => {
  const duties = collectDuties([
    fitting("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] }),
    fitting("f-rev", { provides: [{ kind: "duty", name: "review" }], duties: [reviewDuty] }),
    fitting("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [developDuty] })
  ]).duties;

  it("a leaf level resolves to its own single step", () => {
    const steps = resolveSequence("implement", 2, duties);
    expect(steps).toEqual([
      {
        duty: "implement",
        level: 2,
        cell: { skill: "garrison-implement", target: "t-deep", effort: "high" },
        description: "level 2: careful edit"
      }
    ]);
  });

  it("develop level 1 and level 2 resolve to DIFFERENT visited sequences", () => {
    const l1 = resolveSequence("develop", 1, duties).map((s) => `${s.duty}@${s.level}`);
    const l2 = resolveSequence("develop", 2, duties).map((s) => `${s.duty}@${s.level}`);
    expect(l1).toEqual(["implement@1"]);
    expect(l2).toEqual(["implement@2", "review@2"]);
    expect(l1).not.toEqual(l2);
  });

  it("a per-entry level override beats the parent default", () => {
    const dev: DutySpec = {
      ...developDuty,
      levels: [
        { description: "l1", sequence: [{ duty: "implement", level: 2 }, { duty: "review" }] }
      ]
    };
    const merged = collectDuties([
      fitting("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] }),
      fitting("f-rev", { provides: [{ kind: "duty", name: "review" }], duties: [reviewDuty] }),
      fitting("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [dev] })
    ]).duties;
    const steps = resolveSequence("develop", 1, merged).map((s) => `${s.duty}@${s.level}`);
    expect(steps).toEqual(["implement@2", "review@1"]);
  });

  it("levels are flat — level 2 content is fully explicit, not inherited", () => {
    // implement level 2 stands alone: nothing of level 1 leaks in.
    const steps = resolveSequence("implement", 2, duties);
    expect(steps[0].cell.effort).toBe("high");
    expect(steps[0].cell.target).toBe("t-deep");
  });

  it("composition duty definitions override fitting-shipped defaults (D8)", () => {
    const override: DutySpec = {
      ...implementDuty,
      levels: [
        { description: "level 1: custom", cell: { skill: "garrison-implement", target: "t-custom", effort: "low" } }
      ]
    };
    const merged = collectDuties(
      [fitting("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] })],
      [override]
    ).duties;
    expect(merged.implement.levels).toHaveLength(1);
    expect(merged.implement.levels[0].cell?.target).toBe("t-custom");
    // provider attribution survives the override
    expect(merged.implement.providerFittingId).toBe("f-impl");
  });
});

describe("kanban list derivation (D15)", () => {
  it("every leaf duty in any selected composite's sequences is a list; composites are not", () => {
    const duties = collectDuties([
      fitting("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] }),
      fitting("f-rev", { provides: [{ kind: "duty", name: "review" }], duties: [reviewDuty] }),
      fitting("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [developDuty] })
    ]).duties;
    const lists = deriveKanbanLists(["develop"], duties);
    expect(lists).toEqual(["implement", "review"]);
  });

  it("a standing leaf duty is its own list; unselected duties are absent", () => {
    const duties = collectDuties([
      fitting("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] }),
      fitting("f-rev", { provides: [{ kind: "duty", name: "review" }], duties: [reviewDuty] })
    ]).duties;
    expect(deriveKanbanLists(["implement"], duties)).toEqual(["implement"]);
  });
});

describe("readiness rules (D10)", () => {
  const dispatcherDuty: DutySpec = {
    id: "dispatch",
    title: "Dispatch",
    description: "route a message to (duty, level)",
    levels: [{ description: "l1", cell: { target: "t-fast", effort: "low" } }]
  };

  it("reports every unmet default rule with a message", () => {
    const results = evaluateReadiness([], {}, []);
    expect(results).toHaveLength(DEFAULT_READINESS_RULES.length);
    expect(results.every((r) => !r.met)).toBe(true);
    expect(results[0].message).toMatch(/missing/);
  });

  it("passes when the composition satisfies the rules", () => {
    const fittings: ResolverFittingInput[] = [
      fitting("orch", { faculty: "orchestrator", provides: [{ kind: "orchestrator", name: "main" }] }),
      fitting("rt", { faculty: "runtimes", provides: [{ kind: "runtime", name: "claude" }] }),
      fitting("chan", { faculty: "channels", provides: [{ kind: "channel", name: "web" }] }),
      fitting("mem", { faculty: "memory", provides: [{ kind: "memory-store", name: "basic" }] }),
      fitting("gw", { faculty: "gateway" }),
      fitting("ident", { faculty: "orchestrator", provides: [{ kind: "identity", name: "gary" } as never] }),
      fitting("disp", { provides: [{ kind: "duty", name: "dispatch" }], duties: [dispatcherDuty] })
    ];
    const { duties } = collectDuties(fittings);
    const results = evaluateReadiness(fittings, duties, ["dispatch"]);
    expect(results.filter((r) => !r.met)).toEqual([]);
  });
});

describe("resolveModel (D1 — one source for Muster, board, prompt, garrison-control)", () => {
  it("emits duties, kanban lists, errors, rules, ready", () => {
    const fittings = [
      fitting("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] }),
      fitting("f-rev", { provides: [{ kind: "duty", name: "review" }], duties: [reviewDuty] }),
      fitting("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [developDuty] })
    ];
    const model = resolveModel({ fittings, selectedDuties: ["develop"] });
    expect(model.errors).toEqual([]);
    expect(model.kanbanLists).toEqual(["implement", "review"]);
    expect(model.duties.develop.providerFittingId).toBe("f-dev");
    // not ready: no orchestrator/runtime/channel/memory/gateway/identity/dispatcher
    expect(model.ready).toBe(false);
    expect(model.rules.some((r) => !r.met)).toBe(true);
  });

  it("suppresses list derivation when the graph is invalid", () => {
    const broken: DutySpec = {
      id: "develop",
      title: "Develop",
      description: "develop",
      levels: [{ description: "l1", sequence: [{ duty: "missing" }] }]
    };
    const model = resolveModel({
      fittings: [fitting("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [broken] })]
    });
    expect(model.errors.length).toBeGreaterThan(0);
    expect(model.kanbanLists).toEqual([]);
    expect(model.ready).toBe(false);
  });
});
