// The menu's grouping axis.
//
// History: the sidebar first grouped Fittings by FACULTY (seventeen of them —
// a precise type system and an unusable menu), then by the six-value CATEGORY
// vocabulary. 2026-08-26 dropped sub-grouping from the menu entirely: Command
// and Fittings are two flat, alphabetical, collapsible groups, and the row you
// want is where its name says it is. Categories are still the axis the Compose
// grid and the library use, so these tests keep BOTH honest: nothing groups the
// menu, and no fitting loses its category.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fittingCategories, CATEGORY_BY_FACULTY, type FacultyId } from "../src/lib/types";
import { faculties } from "../src/lib/faculties";
import { readLibrary } from "../src/lib/library";
import { COMMAND_ITEMS } from "../src/components/chrome/Sidebar";

const SIDEBAR = readFileSync(
  join(import.meta.dirname, "../src/components/chrome/Sidebar.tsx"),
  "utf8"
);

describe("the menu is two flat alphabetical groups", () => {
  it("does not sub-group the Fittings list", () => {
    // Both retired axes must be gone from the menu, or a fitting is hidden
    // inside a collapsed bucket the user did not ask for.
    expect(SIDEBAR).not.toContain("for (const category of fittingCategories)");
    expect(SIDEBAR).not.toContain("row.entry.faculty === faculty.id");
  });

  it("sorts both groups by label rather than trusting declaration order", () => {
    // Command rows are declared as data; a route appended to the list must land
    // in alphabetical position without anyone remembering to place it.
    expect(SIDEBAR).toContain("[...COMMAND_ITEMS]\n    .sort((a, b) => a.label.localeCompare(b.label))");
    expect(SIDEBAR).toContain("fittingRows.sort((a, b) => a.label.localeCompare(b.label));");
  });

  it("resolves the auto-expand group on the SAME axis as the groups", () => {
    // Keying the groups by `command`/`fittings` while resolving the active
    // group by anything else would expand an id that does not exist, and
    // navigating would leave the row hidden inside a collapsed group.
    expect(SIDEBAR).toMatch(
      /activeGroupId\s*=\s*activeFittingId\s*\?\s*"fittings"\s*:\s*activeCommand\s*\?\s*"command"\s*:\s*null/
    );
  });

  it("keeps every Garrison route on the menu", () => {
    // The refit moved these from inline JSX into data; a route dropped in that
    // move would silently vanish from the shell.
    expect(COMMAND_ITEMS.map((item) => item.href).sort()).toEqual([
      "/",
      "/accounts",
      "/compose",
      "/connectors",
      "/coordination",
      "/mesh",
      "/quarters",
      "/talk",
      "/vault"
    ]);
  });
});

describe("categories still resolve for the surfaces that use them", () => {
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
