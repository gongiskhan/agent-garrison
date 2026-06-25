import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROMOTED_CATALOG,
  resolvePromotedFittings,
  type PromotedMember
} from "@/lib/promoted-catalog";
import { validateSetupSteps } from "@/lib/promoted-fittings";
import { facultyIds, type FacultyId } from "@/lib/types";
import { getFaculty } from "@/lib/faculties";
import type { PrimitiveRecord, PrimitiveSurface, StateModel } from "@/lib/primitive-state";

const SURFACES: PrimitiveSurface[] = ["skill", "command", "rule", "plugin", "hook", "mcp"];

// Build a StateModel from a flat list of {surface,name} present primitives.
function fakeModel(present: PromotedMember[]): StateModel {
  const bySurface = Object.fromEntries(SURFACES.map((s) => [s, [] as PrimitiveRecord[]])) as Record<
    PrimitiveSurface,
    PrimitiveRecord[]
  >;
  const records: PrimitiveRecord[] = present.map((m) => ({
    id: `${m.surface}:${m.name}`,
    surface: m.surface,
    name: m.name,
    state: "loose" as const,
    presence: "enabled" as const
  }));
  for (const r of records) bySurface[r.surface].push(r);
  return { records, counts: { loose: records.length, owned: 0, parked: 0 }, bySurface };
}

describe("promoted catalog — descriptor integrity", () => {
  it("every Fitting has a unique id", () => {
    const ids = PROMOTED_CATALOG.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every Fitting is fully authored (title, plain + technical descriptions, members)", () => {
    for (const f of PROMOTED_CATALOG) {
      expect(f.title.trim().length, f.id).toBeGreaterThan(0);
      // A real, non-trivial plain-language description for a non-technical reader.
      expect(f.descriptionPlain.trim().length, `${f.id} plain`).toBeGreaterThan(40);
      expect(f.descriptionTechnical.trim().length, `${f.id} technical`).toBeGreaterThan(10);
      expect(f.members.length, `${f.id} members`).toBeGreaterThan(0);
      expect(Array.isArray(f.provides), `${f.id} provides`).toBe(true);
      expect(Array.isArray(f.consumes), `${f.id} consumes`).toBe(true);
      expect(Array.isArray(f.setup), `${f.id} setup`).toBe(true);
    }
  });

  it("every Fitting names a real faculty and a valid internal component_shape", () => {
    for (const f of PROMOTED_CATALOG) {
      expect(facultyIds as readonly string[], `${f.id} faculty`).toContain(f.faculty);
      const shapes = Array.isArray(f.componentShape) ? f.componentShape : [f.componentShape];
      for (const s of shapes) {
        expect(SURFACES, `${f.id} shape ${s}`).toContain(s);
      }
    }
  });

  it("each member's surface matches one of the Fitting's internal component_shapes", () => {
    for (const f of PROMOTED_CATALOG) {
      const shapes = new Set(Array.isArray(f.componentShape) ? f.componentShape : [f.componentShape]);
      for (const m of f.members) {
        expect(shapes.has(m.surface), `${f.id} member ${m.name} (${m.surface})`).toBe(true);
      }
    }
  });

  it("every `packaged: true` Fitting references a real fittings/seed package (Hybrid claim is verified)", () => {
    const seedRoot = path.resolve(__dirname, "..", "fittings", "seed");
    const packaged = PROMOTED_CATALOG.filter((f) => f.packaged);
    expect(packaged.length, "expected at least one packaged (Hybrid) Fitting").toBeGreaterThan(0);
    for (const f of packaged) {
      const hasSeed = f.members.some((m) => fs.existsSync(path.join(seedRoot, m.name)));
      expect(hasSeed, `${f.id}: no real seed package found for any member`).toBe(true);
    }
  });

  it("only uses the new optional capability faculties + memory (never the runtime/infra roles)", () => {
    const allowed = new Set<FacultyId>([
      "knowledge",
      "research",
      "building",
      "code-intelligence",
      "design",
      "browser-qa",
      "coordination",
      "memory"
    ]);
    for (const f of PROMOTED_CATALOG) {
      expect(allowed.has(f.faculty), `${f.id} -> ${f.faculty}`).toBe(true);
    }
  });
});

describe("promoted catalog — vocabulary discipline (the whole point)", () => {
  // The primitive-type words must never be the user-facing label. They are
  // allowed only in the technical line, the notes, component_shape, and members.
  const FORBIDDEN = /\b(skill|skills|mcp|mcps|plugin|plugins|hook|hooks)\b/i;

  it("no Fitting title contains a primitive-type word", () => {
    for (const f of PROMOTED_CATALOG) {
      expect(FORBIDDEN.test(f.title), `${f.id} title "${f.title}"`).toBe(false);
    }
  });

  it("no plain-language description contains a primitive-type word", () => {
    for (const f of PROMOTED_CATALOG) {
      expect(FORBIDDEN.test(f.descriptionPlain), `${f.id} plain`).toBe(false);
    }
  });
});

describe("promoted catalog — discovery join", () => {
  it("marks a Fitting present when any of its members is discovered", () => {
    const model = fakeModel([{ surface: "skill", name: "playwright-cli" }]);
    const view = resolvePromotedFittings(model);
    const pw = view.fittings.find((f) => f.id === "playwright-cli");
    expect(pw?.present).toBe(true);
    expect(pw?.members[0]?.present).toBe(true);
  });

  it("marks a Fitting absent when none of its members is discovered", () => {
    const view = resolvePromotedFittings(fakeModel([]));
    expect(view.fittings.find((f) => f.id === "playwright-cli")?.present).toBe(false);
  });

  it("matches a plugin member by its exact key", () => {
    const model = fakeModel([{ surface: "plugin", name: "document-skills@anthropic-agent-skills" }]);
    const view = resolvePromotedFittings(model);
    expect(view.fittings.find((f) => f.id === "document-skills")?.present).toBe(true);
  });

  it("does NOT mark a plugin present for a same-named install from a different marketplace", () => {
    const model = fakeModel([{ surface: "plugin", name: "document-skills@some-other-marketplace" }]);
    const view = resolvePromotedFittings(model);
    expect(view.fittings.find((f) => f.id === "document-skills")?.present).toBe(false);
  });

  it("matches a matcher-less hook by its bare event name (the real discovery format)", () => {
    const model = fakeModel([{ surface: "hook", name: "SessionStart" }]);
    const view = resolvePromotedFittings(model);
    // codegraph + autothing + coordination all reference a SessionStart hook.
    const member = view.fittings.find((f) => f.id === "codegraph")?.members.find((m) => m.name === "SessionStart");
    expect(member?.present).toBe(true);
  });

  it("matches a hook discovered WITH a matcher, named 'Event (matcher)'", () => {
    // primitive-state names a hook group with a matcher "<Event> (<matcher>)".
    const model = fakeModel([{ surface: "hook", name: "SessionStart (*)" }]);
    const view = resolvePromotedFittings(model);
    const member = view.fittings.find((f) => f.id === "codegraph")?.members.find((m) => m.name === "SessionStart");
    expect(member?.present).toBe(true);
  });
});

describe("promoted catalog — faculty grouping by Agent/Dev tier", () => {
  it("splits groups into agent and dev by the faculty tier", () => {
    const view = resolvePromotedFittings(fakeModel([]));
    for (const g of view.agent) {
      expect(getFaculty(g.faculty).tier, g.faculty).toBe("agent");
    }
    for (const g of view.dev) {
      expect(getFaculty(g.faculty).tier, g.faculty).toBe("dev");
    }
  });

  it("orders groups by the faculty display order", () => {
    const view = resolvePromotedFittings(fakeModel([]));
    const all = [...view.agent, ...view.dev];
    // each list is internally ordered
    for (const list of [view.agent, view.dev]) {
      const orders = list.map((g) => getFaculty(g.faculty).order);
      expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    }
    expect(all.length).toBeGreaterThan(0);
  });

  it("places office documents under the Agent Knowledge faculty and autothing under the Dev Software Building faculty", () => {
    const view = resolvePromotedFittings(fakeModel([]));
    const knowledge = view.agent.find((g) => g.faculty === "knowledge");
    expect(knowledge?.fittings.some((f) => f.id === "document-skills")).toBe(true);
    const building = view.dev.find((g) => g.faculty === "building");
    expect(building?.fittings.some((f) => f.id === "autothing")).toBe(true);
  });
});

describe("promoted catalog — setup overrides", () => {
  it("uses the authored baseline setup when no override exists", () => {
    const view = resolvePromotedFittings(fakeModel([]));
    const pw = view.fittings.find((f) => f.id === "playwright-cli");
    expect(pw?.setup[0]?.command).toContain("playwright");
  });

  it("merges an override over the baseline setup", () => {
    const override = { "playwright-cli": [{ command: "echo custom", idempotent: true }] };
    const view = resolvePromotedFittings(fakeModel([]), override);
    const pw = view.fittings.find((f) => f.id === "playwright-cli");
    expect(pw?.setup).toHaveLength(1);
    expect(pw?.setup[0]?.command).toBe("echo custom");
  });

  it("an explicit empty override clears a non-empty baseline (does not fall back)", () => {
    // playwright-cli ships a 2-step baseline; an explicit [] override must win.
    const view = resolvePromotedFittings(fakeModel([]), { "playwright-cli": [] });
    expect(view.fittings.find((f) => f.id === "playwright-cli")?.setup).toEqual([]);
  });
});

describe("validateSetupSteps", () => {
  it("accepts a valid ordered list and defaults idempotent to true", () => {
    const steps = validateSetupSteps([
      { command: "npm i -g playwright", label: "Install" },
      { command: "playwright install chromium", idempotent: false, timeout_ms: 60000 }
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0].idempotent).toBe(true);
    expect(steps[0].label).toBe("Install");
    expect(steps[1].idempotent).toBe(false);
    expect(steps[1].timeout_ms).toBe(60000);
  });

  it("trims commands and labels", () => {
    const steps = validateSetupSteps([{ command: "  echo hi  ", label: "  Greet  " }]);
    expect(steps[0].command).toBe("echo hi");
    expect(steps[0].label).toBe("Greet");
  });

  it("rejects a non-array", () => {
    expect(() => validateSetupSteps({ command: "x" })).toThrow();
  });

  it("rejects a step with an empty command", () => {
    expect(() => validateSetupSteps([{ command: "   " }])).toThrow();
  });

  it("rejects a non-positive timeout", () => {
    expect(() => validateSetupSteps([{ command: "echo x", timeout_ms: 0 }])).toThrow();
  });

  it("accepts an empty list (clears the override → falls back to baseline)", () => {
    expect(validateSetupSteps([])).toEqual([]);
  });
});
