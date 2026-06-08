import { describe, expect, it } from "vitest";
import { QUARTERS_CATEGORIES, QUARTERS_SLUGS, categoryBySlug, WRITER_LABEL } from "@/components/quarters/quartersTypes";
import { runQuartersAction } from "@/lib/quarters";

describe("quartersTypes", () => {
  it("declares 10 categories with unique slugs", () => {
    expect(QUARTERS_CATEGORIES).toHaveLength(10);
    expect(new Set(QUARTERS_SLUGS).size).toBe(10);
  });

  it("includes the brief's named categories", () => {
    for (const slug of ["settings", "context", "skills", "hooks", "mcps", "plugins", "scripts", "plans", "logs", "sessions"]) {
      expect(categoryBySlug(slug)).toBeDefined();
    }
  });

  it("every category has a writer label and primitives categories carry surfaces", () => {
    for (const cat of QUARTERS_CATEGORIES) {
      expect(WRITER_LABEL[cat.writer]).toBeTruthy();
      if (cat.kind === "primitives") expect(cat.surfaces?.length).toBeGreaterThan(0);
    }
  });
});

describe("runQuartersAction validation", () => {
  it("rejects an unknown action", async () => {
    await expect(runQuartersAction({ action: "bogus" } as never)).rejects.toThrow(/unknown quarters action/);
  });

  it("requires an id for promote", async () => {
    await expect(runQuartersAction({ action: "promote", id: "" })).rejects.toThrow(/promote requires/);
  });

  it("requires a fittingId for park", async () => {
    await expect(runQuartersAction({ action: "park", fittingId: "" })).rejects.toThrow(/park requires/);
  });
});
