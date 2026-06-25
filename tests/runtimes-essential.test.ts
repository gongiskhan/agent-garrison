import { describe, expect, it } from "vitest";
import { faculties, getFaculty } from "@/lib/faculties";

// S4: `runtimes` is an essential Faculty — every Operative runs ON a runtime
// (the orchestrator's own engine is the primary runtime), so it belongs in the
// Compose grid's "Every agent needs these" group (StationGrid filters on
// `faculty.essential`). Kept as a dedicated, slice-owned assertion independent
// of the broader faculties.test.ts.
describe("runtimes essential Faculty (S4)", () => {
  it("getFaculty('runtimes').essential === true", () => {
    expect(getFaculty("runtimes").essential).toBe(true);
  });

  it("the essential set includes runtimes alongside the original base-need roles", () => {
    const essential = faculties.filter((f) => f.essential).map((f) => f.id);
    expect(essential).toContain("runtimes");
    for (const id of ["orchestrator", "channels", "gateway", "memory"]) {
      expect(essential, `${id} stays essential`).toContain(id);
    }
  });

  it("essential is orthogonal to the display tier (runtimes may be essential AND dev-tier)", () => {
    const runtimes = getFaculty("runtimes");
    expect(runtimes.essential).toBe(true);
    // The tier axis is owned elsewhere; we only assert it remains a valid value.
    if (runtimes.tier !== undefined) {
      expect(["agent", "dev"]).toContain(runtimes.tier);
    }
  });
});
