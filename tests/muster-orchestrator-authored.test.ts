import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  writeAuthoredOverride,
  isAuthoredSectionId,
  MAX_AUTHORED_SECTION_BYTES
} from "@/lib/orchestrator-authored-store";
import {
  AUTHORED_OVERRIDES_REL,
  readAuthoredOverrides
} from "@/lib/orchestrator-projection";
import { buildOrchestratorPreview, type PromptSection } from "@/lib/orchestrator-sections";
import { LOCKED_SECTION_IDS } from "@/lib/orchestrator-sections";
import { resolveModel, type ResolverFittingInput } from "@/lib/resolver";
import type { CapabilityProvision, DutySpec, GarrisonMetadata, LibraryEntry } from "@/lib/types";

// S5c — the Muster orchestrator panel's WRITE path. The store is the only writer
// of the authored-overrides JSON; constraint 12 (locked blocks never hand-edited)
// is enforced here, so these tests lean on the store + the pure preview builder
// rather than the HTTP wrapper (matching the repo's fs-helper test convention).

// ── a tiny resolved model + providers (mirrors orchestrator-sections.test) ───
function metadata(opts: {
  provides?: CapabilityProvision[];
  duties?: DutySpec[];
}): GarrisonMetadata {
  return {
    faculty: "building",
    cardinality_hint: "single",
    component_shape: "skill",
    platforms: ["claude-code"],
    config_schema: [],
    provides: opts.provides ?? [],
    consumes: [],
    verify: { command: "echo ok", expect: "ok", timeout_ms: 10000 },
    ...(opts.duties ? { duties: opts.duties } : {})
  };
}
function libEntry(id: string, opts: Parameters<typeof metadata>[0] = {}): LibraryEntry {
  const md = metadata(opts);
  return { id, name: id, faculty: md.faculty, repo: `local/${id}`, summary: id, platforms: ["claude-code"], ratings: {}, metadata: md };
}
const implementDuty: DutySpec = {
  id: "implement",
  title: "Implement",
  description: "write the code for a planned change",
  levels: [{ description: "l1", cell: { skill: "garrison-implement", target: "t-fast", effort: "medium" } }]
};
function fixtureModel() {
  const entries = [libEntry("f-impl", { provides: [{ kind: "duty", name: "implement" }], duties: [implementDuty] })];
  const fittings: ResolverFittingInput[] = entries.map((e) => ({ id: e.id, metadata: e.metadata }));
  const model = resolveModel({ fittings, selectedDuties: ["implement"] });
  return { entries, model };
}

const lockedOf = (sections: PromptSection[]) => sections.filter((s) => s.locked);
const byId = (sections: PromptSection[], id: string) => sections.find((s) => s.id === id);

const DIRS: string[] = [];
async function tmpCompositionDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "muster-authored-"));
  DIRS.push(dir);
  return dir;
}
afterEach(async () => {
  while (DIRS.length) {
    const dir = DIRS.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("writeAuthoredOverride — persistence", () => {
  it("persists an authored section and reads it back verbatim", async () => {
    const dir = await tmpCompositionDir();
    const body = "Route narrow first.\nEscalate only on repeated failure.";
    const merged = await writeAuthoredOverride(dir, "routing-philosophy", body);

    expect(merged["routing-philosophy"]).toBe(body);
    const onDisk = await readAuthoredOverrides(dir);
    expect(onDisk["routing-philosophy"]).toBe(body);

    // The JSON file exists and holds ONLY the authored key we wrote.
    const raw = JSON.parse(await fs.readFile(path.join(dir, AUTHORED_OVERRIDES_REL), "utf8"));
    expect(Object.keys(raw)).toEqual(["routing-philosophy"]);
  });

  it("merges multiple authored sections without dropping prior edits", async () => {
    const dir = await tmpCompositionDir();
    await writeAuthoredOverride(dir, "routing-philosophy", "philosophy text");
    await writeAuthoredOverride(dir, "escalation-policy", "escalation text");
    const onDisk = await readAuthoredOverrides(dir);
    expect(onDisk["routing-philosophy"]).toBe("philosophy text");
    expect(onDisk["escalation-policy"]).toBe("escalation text");
  });

  it("an empty body RESETS a section to its default (drops the key)", async () => {
    const dir = await tmpCompositionDir();
    await writeAuthoredOverride(dir, "routing-philosophy", "custom");
    await writeAuthoredOverride(dir, "routing-philosophy", "   ");
    const onDisk = await readAuthoredOverrides(dir);
    expect(onDisk["routing-philosophy"]).toBeUndefined();
  });
});

describe("constraint 12 — locked sections are never hand-editable", () => {
  it("refuses a LOCKED section id and never writes it", async () => {
    const dir = await tmpCompositionDir();
    for (const locked of LOCKED_SECTION_IDS) {
      await expect(writeAuthoredOverride(dir, locked, "evil")).rejects.toThrow(/not an editable/i);
    }
    // No file was created for any refused write.
    await expect(fs.access(path.join(dir, AUTHORED_OVERRIDES_REL))).rejects.toThrow();
  });

  it("refuses an unknown section id", async () => {
    const dir = await tmpCompositionDir();
    await expect(writeAuthoredOverride(dir, "made-up", "x")).rejects.toThrow(/not an editable/i);
    expect(isAuthoredSectionId("made-up")).toBe(false);
    expect(isAuthoredSectionId("routing-philosophy")).toBe(true);
  });

  it("a foreign LOCKED key poked into the JSON never leaks into the preview", async () => {
    const dir = await tmpCompositionDir();
    // Simulate a tampered/stale file carrying a locked key alongside an authored one.
    await fs.mkdir(path.join(dir, ".garrison"), { recursive: true });
    await fs.writeFile(
      path.join(dir, AUTHORED_OVERRIDES_REL),
      JSON.stringify({ capabilities: "INJECTED LOCKED TEXT", "routing-philosophy": "ok" }),
      "utf8"
    );
    const authored = await readAuthoredOverrides(dir);
    // The locked key is filtered out; only the authored key survives.
    expect((authored as Record<string, string>).capabilities).toBeUndefined();
    expect(authored["routing-philosophy"]).toBe("ok");
  });

  it("editing an authored section leaves every locked block byte-identical", async () => {
    const dir = await tmpCompositionDir();
    const { entries, model } = fixtureModel();

    const before = buildOrchestratorPreview({ model, entries, authored: {} });
    await writeAuthoredOverride(dir, "routing-philosophy", "MY BESPOKE ROUTING DOCTRINE");
    const authored = await readAuthoredOverrides(dir);
    const after = buildOrchestratorPreview({ model, entries, authored });

    // The authored edit took effect...
    expect(byId(after.sections, "routing-philosophy")!.content).toBe("MY BESPOKE ROUTING DOCTRINE");
    // ...and every locked block is unchanged (regenerated from the same model).
    for (const locked of lockedOf(before.sections)) {
      const twin = byId(after.sections, locked.id)!;
      expect(twin.locked).toBe(true);
      expect(twin.content).toBe(locked.content);
      expect(twin.regeneratedFrom).toBe("composition");
    }
  });

  it("rejects a section body over the byte cap", async () => {
    const dir = await tmpCompositionDir();
    const huge = "x".repeat(MAX_AUTHORED_SECTION_BYTES + 1);
    await expect(writeAuthoredOverride(dir, "routing-philosophy", huge)).rejects.toThrow(/cap/i);
  });
});
