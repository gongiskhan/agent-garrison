import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as engine from "../fittings/seed/kanban-loop/lib/engine.mjs";

// Regression guard for a bug that shipped: scripts/kanban.mjs is the CLI entrypoint the
// fitting's setup hook runs during `up` (`node scripts/kanban.mjs --setup`). It imports its
// whole board-helper surface from engine.mjs. phaseForList is defined in policy.mjs and
// engine.mjs imported it for INTERNAL use only, without re-exporting it — so the CLI's
// top-level import threw "does not provide an export named 'phaseForList'" and setup exited
// 1 the first time a live `up` ran. No vitest loads kanban.mjs's module graph, so the
// marathon's gates (which validate via resolveModel, not a live up) never hit it. This test
// asserts engine.mjs re-exports EVERY symbol the CLI imports from it, auto-tracking future
// additions so a new missing export can't slip through the same blind spot again.

const kanbanCliUrl = new URL("../fittings/seed/kanban-loop/scripts/kanban.mjs", import.meta.url);

function symbolsImportedFromEngine(src: string): string[] {
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*lib\/engine\.mjs["']/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("kanban-loop engine facade — scripts/kanban.mjs CLI import surface", () => {
  it("engine.mjs re-exports every symbol the --setup CLI entrypoint imports from it", () => {
    const src = readFileSync(fileURLToPath(kanbanCliUrl), "utf8");
    const names = symbolsImportedFromEngine(src);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        typeof (engine as Record<string, unknown>)[name],
        `engine.mjs must export "${name}" — scripts/kanban.mjs imports it, and a missing export makes \`node scripts/kanban.mjs --setup\` exit 1 during \`up\``
      ).toBe("function");
    }
    // The exact symbol that regressed:
    expect(names).toContain("phaseForList");
  });

  it("phaseForList is importable from the engine facade (the specific fix)", () => {
    expect(typeof (engine as Record<string, unknown>).phaseForList).toBe("function");
  });
});
