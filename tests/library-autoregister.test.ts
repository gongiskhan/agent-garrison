import { describe, it, expect } from "vitest";
import { readLibrary } from "../src/lib/library";

/**
 * Auto-registration means ONE bad manifest breaks the entire library: a
 * manifest that fails metadata validation throws out of resolveLibraryEntry,
 * and /api/library returns 500 for every consumer.
 *
 * That is not hypothetical — it happened three times while this landed, each
 * time from a pre-pivot value in a fitting that had been invisible because it
 * was unregistered: `kind: agent-skill` and `kind: soul` (both dropped in the
 * Quarters pivot), and two faculties whose accepted `shapes` did not include
 * the fitting's own component_shape.
 *
 * So this test resolves EVERY fitting on disk. It is the guard that makes
 * always-register safe.
 */
describe("library auto-registration", () => {
  it("resolves every fitting on disk without throwing", async () => {
    const entries = await readLibrary();
    expect(entries.length).toBeGreaterThan(75);
  });

  it("gives every entry a category so the Fittings views never show an unsorted bucket", async () => {
    const entries = await readLibrary();
    expect(entries.filter((entry) => !entry.category).map((entry) => entry.id)).toEqual([]);
  });

  it("has no duplicate ids across seed and local", async () => {
    const ids = (await readLibrary()).map((entry) => entry.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
