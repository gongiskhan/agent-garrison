import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assembleLayeredPrompt,
  buildAuthoredSections,
  buildLayeredSections,
  buildLockedSections,
  buildOrchestratorPreview,
  regenerateLockedSections,
  renderCapabilities,
  renderDutiesAndLevels,
  renderReadiness,
  type PromptSection
} from "@/lib/orchestrator-sections";
import {
  AUTHORED_SECTION_DEFAULTS,
  AUTHORED_SECTION_IDS
} from "@/lib/orchestrator-authored-defaults";
import { AUTHORED_OVERRIDES_REL, readAuthoredOverrides } from "@/lib/orchestrator-projection";
import { resolveModel, type ResolverFittingInput } from "@/lib/resolver";
import type { CapabilityProvision, DutySpec, GarrisonMetadata, LibraryEntry } from "@/lib/types";

// ── Fixtures ────────────────────────────────────────────────────────────────

function metadata(opts: {
  faculty?: GarrisonMetadata["faculty"];
  provides?: CapabilityProvision[];
  duties?: DutySpec[];
  forConsumers?: string;
  summary?: string;
}): GarrisonMetadata {
  return {
    faculty: opts.faculty ?? "building",
    cardinality_hint: "single",
    component_shape: "skill",
    platforms: ["claude-code"],
    config_schema: [],
    provides: opts.provides ?? [],
    consumes: [],
    verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 },
    ...(opts.duties ? { duties: opts.duties } : {}),
    ...(opts.forConsumers ? { for_consumers: opts.forConsumers } : {}),
    ...(opts.summary ? { summary: opts.summary } : {})
  };
}

function libEntry(
  id: string,
  opts: Parameters<typeof metadata>[0] = {}
): LibraryEntry {
  const md = metadata(opts);
  return {
    id,
    name: id,
    faculty: md.faculty,
    repo: `local/${id}`,
    summary: opts.summary ?? id,
    platforms: ["claude-code"],
    ratings: {},
    metadata: md
  };
}

const toFittings = (entries: LibraryEntry[]): ResolverFittingInput[] =>
  entries.map((entry) => ({ id: entry.id, metadata: entry.metadata }));

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
    { description: "level 1: quick fix, no plan", sequence: [{ duty: "implement" }] },
    { description: "level 2: adds review", sequence: [{ duty: "implement" }, { duty: "review" }] }
  ]
};

// A three-level duty to prove all levels render.
const hardenDuty: DutySpec = {
  id: "harden",
  title: "Harden",
  description: "raise the security bar on a change",
  levels: [
    { description: "level 1: lint only", cell: { skill: "garrison-security-review", target: "t-fast", effort: "low" } },
    { description: "level 2: static analysis", cell: { skill: "garrison-security-review", target: "t-deep", effort: "high" } },
    { description: "level 3: cross-model checkpoint", cell: { skill: "garrison-codex-checkpoint", target: "t-codex", effort: "max" } }
  ]
};

function developModel() {
  const entries = [
    libEntry("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] }),
    libEntry("f-rev", { provides: [{ kind: "duty", name: "review" }], duties: [reviewDuty] }),
    libEntry("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [developDuty] }),
    libEntry("f-hard", { provides: [{ kind: "duty", name: "harden" }], duties: [hardenDuty] })
  ];
  const model = resolveModel({ fittings: toFittings(entries), selectedDuties: ["develop", "harden"] });
  return { entries, model };
}

const dispatchDuty: DutySpec = {
  id: "dispatch",
  title: "Dispatch",
  description: "route a message to (duty, level)",
  levels: [{ description: "l1", cell: { target: "t-fast", effort: "low" } }]
};

function readyModel() {
  const entries = [
    libEntry("orch", { faculty: "orchestrator", provides: [{ kind: "orchestrator", name: "main" }] }),
    libEntry("rt", { faculty: "runtimes", provides: [{ kind: "runtime", name: "claude" }] }),
    libEntry("chan", { faculty: "channels", provides: [{ kind: "channel", name: "web" }] }),
    libEntry("mem", { faculty: "memory", provides: [{ kind: "memory-store", name: "basic" }] }),
    libEntry("gw", { faculty: "gateway" }),
    libEntry("ident", { faculty: "orchestrator", provides: [{ kind: "identity", name: "gary" } as never] }),
    libEntry("disp", { provides: [{ kind: "duty", name: "dispatch" }], duties: [dispatchDuty] })
  ];
  const model = resolveModel({ fittings: toFittings(entries), selectedDuties: ["dispatch"] });
  return { entries, model };
}

// ── Duties-and-levels generator ─────────────────────────────────────────────

describe("renderDutiesAndLevels (locked)", () => {
  it("renders each reachable duty with id, title, verb-description and a level table", () => {
    const { model } = developModel();
    const out = renderDutiesAndLevels(model);
    // selected composite + its transitively referenced leaves
    expect(out).toContain("### develop (Develop)");
    expect(out).toContain("develop a change end to end");
    expect(out).toContain("### implement (Implement)");
    expect(out).toContain("### review (Review)");
    // leaf cell rendered as k=v triple
    expect(out).toContain("skill=garrison-implement, target=t-fast, effort=medium");
    expect(out).toContain("skill=garrison-implement, target=t-deep, effort=high");
    // composite sequences render the EFFECTIVE (inherited) level
    expect(out).toContain("sequence: implement (level 1)");
    expect(out).toContain("sequence: implement (level 2), review (level 2)");
  });

  it("a duty with 3 levels shows all 3 with their descriptions", () => {
    const { model } = developModel();
    const out = renderDutiesAndLevels(model);
    const harden = out.slice(out.indexOf("### harden"));
    expect(harden).toContain("level 1: lint only");
    expect(harden).toContain("level 2: static analysis");
    expect(harden).toContain("level 3: cross-model checkpoint");
    // three table rows for the three levels
    expect(harden).toContain("| 1 |");
    expect(harden).toContain("| 2 |");
    expect(harden).toContain("| 3 |");
  });

  it("renders an automation-shaped cell (no target/effort) without blanks", () => {
    const auto: DutySpec = {
      id: "capture",
      title: "Capture",
      description: "record a walkthrough",
      levels: [{ description: "just run it", cell: {} }]
    };
    const entries = [libEntry("f-cap", { provides: [{ kind: "duty", name: "capture" }], duties: [auto] })];
    const model = resolveModel({ fittings: toFittings(entries), selectedDuties: ["capture"] });
    expect(renderDutiesAndLevels(model)).toContain("automation (no target/effort)");
  });

  it("falls back to a note when no duties are selected", () => {
    const model = resolveModel({ fittings: [], selectedDuties: [] });
    expect(renderDutiesAndLevels(model)).toContain("No duties are selected");
  });
});

// ── Readiness generator ─────────────────────────────────────────────────────

describe("renderReadiness (locked)", () => {
  it("reflects unmet rules with unchecked boxes and NOT READY state", () => {
    const { model } = developModel();
    const out = renderReadiness(model);
    expect(out).toContain("State: NOT READY");
    // every default rule unmet here (no orchestrator/runtime/... provided)
    expect(out).toContain("[ ] orchestrator:");
    expect(out).toContain("[ ] dispatcher:");
    expect(out).not.toContain("[x]");
    // valid graph even though not ready
    expect(out).toContain("Duty graph: valid");
  });

  it("reflects met rules with checked boxes and READY state", () => {
    const { model } = readyModel();
    const out = renderReadiness(model);
    expect(out).toContain("State: READY");
    expect(out).toContain("[x] orchestrator:");
    expect(out).toContain("[x] dispatcher:");
    expect(out).not.toContain("[ ]");
  });

  it("surfaces duty-graph errors when the graph is invalid", () => {
    const broken: DutySpec = {
      id: "develop",
      title: "Develop",
      description: "develop",
      levels: [{ description: "l1", sequence: [{ duty: "missing" }] }]
    };
    const model = resolveModel({
      fittings: toFittings([libEntry("f-dev", { provides: [{ kind: "duty", name: "develop" }], duties: [broken] })])
    });
    const out = renderReadiness(model);
    expect(out).toContain("State: NOT READY");
    expect(out).toContain("Duty graph:");
    expect(out).toContain("missing-duty-ref");
  });
});

// ── Capabilities generator (reuses the runner renderer) ─────────────────────

describe("renderCapabilities (locked)", () => {
  it("folds provider for_consumers text into the block and leaks no placeholder", () => {
    const SENTINEL = "SENTINEL-for-consumers-9c2b";
    const entries = [
      libEntry("mem", { provides: [{ kind: "memory-store", name: "basic" }], forConsumers: SENTINEL })
    ];
    const out = renderCapabilities(entries);
    expect(out).toContain(SENTINEL);
    expect(out).not.toContain("{{capabilities}}");
  });

  it("renders the empty-composition sentinel with no providers", () => {
    expect(renderCapabilities([])).toContain("no Faculties");
  });
});

// ── Section model + markers ─────────────────────────────────────────────────

describe("section model", () => {
  it("locked sections carry locked:true + regeneratedFrom:composition; authored do not", () => {
    const { model, entries } = developModel();
    const sections = buildLayeredSections({ model, entries });
    const byId = new Map(sections.map((s) => [s.id, s]));
    for (const id of ["capabilities", "duties-and-levels", "readiness"]) {
      const s = byId.get(id)!;
      expect(s.kind).toBe("locked");
      expect(s.locked).toBe(true);
      expect(s.regeneratedFrom).toBe("composition");
    }
    for (const id of AUTHORED_SECTION_IDS) {
      const s = byId.get(id)!;
      expect(s.kind).toBe("authored");
      expect(s.locked).toBe(false);
      expect(s.regeneratedFrom).toBeUndefined();
    }
  });

  it("authored sections default to their predefined text and honor overrides", () => {
    const withDefaults = buildAuthoredSections();
    const routing = withDefaults.find((s) => s.id === "routing-philosophy")!;
    expect(routing.content).toBe(AUTHORED_SECTION_DEFAULTS["routing-philosophy"].content);

    const overridden = buildAuthoredSections({ "routing-philosophy": "CUSTOM DOCTRINE 42" });
    expect(overridden.find((s) => s.id === "routing-philosophy")!.content).toBe("CUSTOM DOCTRINE 42");
    // other authored sections still default
    expect(overridden.find((s) => s.id === "escalation-policy")!.content).toBe(
      AUTHORED_SECTION_DEFAULTS["escalation-policy"].content
    );
  });
});

// ── Assembly ────────────────────────────────────────────────────────────────

describe("assembleLayeredPrompt", () => {
  it("concatenates sections in canonical order with boundary markers and headings", () => {
    const { model, entries } = developModel();
    const { assembled } = buildOrchestratorPreview({ model, entries });
    const order = [
      "id=routing-philosophy",
      "id=capabilities",
      "id=duties-and-levels",
      "id=readiness",
      "id=escalation-policy",
      "id=when-to-ask",
      "id=identity-handoff"
    ];
    const positions = order.map((marker) => assembled.indexOf(marker));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // headings rendered from titles
    expect(assembled).toContain("## Duties and levels");
    expect(assembled).toContain("## Composition readiness");
    expect(assembled).toContain("## Routing philosophy");
    // locked marker carries the regeneration provenance for the UI badge
    expect(assembled).toContain("kind=locked regenerated-from=composition");
    // no leaked placeholders
    expect(assembled).not.toContain("{{capabilities}}");
  });
});

// ── Regeneration ────────────────────────────────────────────────────────────

describe("regenerateLockedSections", () => {
  it("replaces locked content from a fresh model but preserves authored edits", () => {
    const a = developModel();
    const original = buildLayeredSections({ model: a.model, entries: a.entries });

    // Hand-edit an authored section (as the Muster editor would).
    const edited: PromptSection[] = original.map((s) =>
      s.id === "routing-philosophy" ? { ...s, content: "MY CUSTOM ROUTING DOCTRINE" } : s
    );

    // A composition change: only the "capture" automation duty is now selected.
    const captureDuty: DutySpec = {
      id: "capture",
      title: "Capture",
      description: "record a walkthrough",
      levels: [{ description: "just run it", cell: {} }]
    };
    const bEntries = [libEntry("f-cap", { provides: [{ kind: "duty", name: "capture" }], duties: [captureDuty] })];
    const bModel = resolveModel({ fittings: toFittings(bEntries), selectedDuties: ["capture"] });

    const regenerated = regenerateLockedSections(edited, { model: bModel, entries: bEntries });
    const byId = new Map(regenerated.map((s) => [s.id, s]));

    // authored edit preserved verbatim
    expect(byId.get("routing-philosophy")!.content).toBe("MY CUSTOM ROUTING DOCTRINE");
    // locked duties block regenerated to the NEW model
    const duties = byId.get("duties-and-levels")!;
    expect(duties.content).toContain("### capture (Capture)");
    expect(duties.content).not.toContain("### develop");
    // still marked locked
    expect(duties.locked).toBe(true);
    expect(duties.regeneratedFrom).toBe("composition");
    // order preserved
    expect(regenerated.map((s) => s.id)).toEqual(original.map((s) => s.id));
  });

  it("a composition change re-derives the locked blocks (authored blocks unchanged)", () => {
    const a = developModel();
    const previewA = buildOrchestratorPreview({ model: a.model, entries: a.entries });

    const b = readyModel();
    const previewB = buildOrchestratorPreview({ model: b.model, entries: b.entries });

    const lockedA = previewA.sections.find((s) => s.id === "duties-and-levels")!.content;
    const lockedB = previewB.sections.find((s) => s.id === "duties-and-levels")!.content;
    expect(lockedA).not.toBe(lockedB);
    expect(lockedB).toContain("### dispatch (Dispatch)");

    // readiness locked block also re-derived (READY vs NOT READY)
    expect(previewA.sections.find((s) => s.id === "readiness")!.content).toContain("NOT READY");
    expect(previewB.sections.find((s) => s.id === "readiness")!.content).toContain("State: READY");

    // authored sections identical across compositions (defaults, no edits)
    for (const id of AUTHORED_SECTION_IDS) {
      const ca = previewA.sections.find((s) => s.id === id)!.content;
      const cb = previewB.sections.find((s) => s.id === id)!.content;
      expect(ca).toBe(cb);
    }
  });
});

// ── buildLockedSections isolation ───────────────────────────────────────────

describe("buildLockedSections", () => {
  it("returns exactly the three locked blocks", () => {
    const { model, entries } = developModel();
    const locked = buildLockedSections({ model, entries });
    expect(locked.map((s) => s.id)).toEqual(["capabilities", "duties-and-levels", "readiness"]);
    expect(locked.every((s) => s.locked)).toBe(true);
  });
});

// ── Authored overrides reader (fs, temp dir only) ───────────────────────────

describe("readAuthoredOverrides", () => {
  it("returns {} when the overrides file is absent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-authored-"));
    expect(await readAuthoredOverrides(dir)).toEqual({});
  });

  it("keeps only known authored string keys, dropping unknown/non-string values", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-authored-"));
    fs.mkdirSync(path.join(dir, ".garrison"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, AUTHORED_OVERRIDES_REL),
      JSON.stringify({
        "routing-philosophy": "edited routing",
        "escalation-policy": "  ", // whitespace-only → dropped
        "duties-and-levels": "locked cannot be authored", // locked id → dropped
        bogus: "nope", // unknown id → dropped
        "when-to-ask": 42 // non-string → dropped
      }),
      "utf8"
    );
    const overrides = await readAuthoredOverrides(dir);
    expect(overrides).toEqual({ "routing-philosophy": "edited routing" });
  });

  it("returns {} on invalid JSON", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-authored-"));
    fs.mkdirSync(path.join(dir, ".garrison"), { recursive: true });
    fs.writeFileSync(path.join(dir, AUTHORED_OVERRIDES_REL), "{ not json", "utf8");
    expect(await readAuthoredOverrides(dir)).toEqual({});
  });
});
