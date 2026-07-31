// The Fittings menu groups by CATEGORY, not faculty.
//
// Seventeen faculties make a precise type system and an unusable menu
// (src/lib/types.ts: "faculty is no longer the grouping axis"). The category
// vocabulary was introduced with CATEGORY_BY_FACULTY and every manifest gained a
// `category`, but the only surface converted was StationGrid.tsx — which is
// rendered NOWHERE. The live sidebar kept grouping by faculty, so the whole
// change was invisible. These tests pin the axis so that cannot recur.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fittingCategories, CATEGORY_BY_FACULTY, type FacultyId } from "../src/lib/types";
import { faculties } from "../src/lib/faculties";
import { readLibrary } from "../src/lib/library";

const SIDEBAR = readFileSync(
  join(import.meta.dirname, "../src/components/chrome/Sidebar.tsx"),
  "utf8"
);

describe("sidebar Fittings menu groups by category", () => {
  it("iterates the category vocabulary, not the faculty list", () => {
    expect(SIDEBAR).toContain("for (const category of fittingCategories)");
    // The old axis must be gone from the grouping loop.
    expect(SIDEBAR).not.toContain("row.entry.faculty === faculty.id");
  });

  it("resolves the auto-expand group on the SAME axis as the groups", () => {
    // Keying the groups by category while resolving the active group by faculty
    // would expand an id that does not exist, and navigating to a fitting would
    // leave its row hidden inside a collapsed group.
    expect(SIDEBAR).toMatch(/activeGroupId\s*=\s*activeEntry\s*\?\s*\(categoryOf\(activeEntry\)/);
  });

  it("every faculty maps to a declared category, so no fitting can fall through", () => {
    for (const f of faculties) {
      const category = CATEGORY_BY_FACULTY[f.id as FacultyId];
      expect(category, `faculty ${f.id} has no category`).toBeTruthy();
      expect(fittingCategories).toContain(category);
    }
  });

  it("every registered fitting resolves to a declared category", async () => {
    // resolveLibraryEntry populates `category` from the manifest or the faculty
    // map. If either drifted, entries would silently pile into "Other".
    const lib = await readLibrary();
    expect(lib.length).toBeGreaterThan(0);
    const bad = lib
      .map((e) => ({ id: e.id, category: e.category ?? CATEGORY_BY_FACULTY[e.faculty] }))
      .filter((e) => !e.category || !fittingCategories.includes(e.category));
    expect(bad, "fittings with no declared category").toEqual([]);
  });

  it("the six categories are the ones the manifests actually use", async () => {
    const lib = await readLibrary();
    const used = new Set(lib.map((e) => e.category ?? CATEGORY_BY_FACULTY[e.faculty]));
    // Not every category must be populated in a given composition, but nothing
    // may be used that is not declared.
    for (const c of used) expect(fittingCategories).toContain(c);
  });
});
