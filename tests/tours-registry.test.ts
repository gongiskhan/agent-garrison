import { describe, it, expect } from "vitest";
import { parseGarrisonMetadata, tourDescriptorSchema } from "@/lib/metadata";
import { loadTours, listTours, getTour } from "@/lib/tours-registry";
import { readLibrary } from "@/lib/library";

// --- metadata parse ---------------------------------------------------------

const baseManifest = {
  faculty: "sessions",
  cardinality_hint: "single",
  component_shape: "plugin",
  platforms: ["all"],
  verify: { command: "true", expect: "ok" }
};

describe("x-garrison.ui.tours metadata", () => {
  it("parses a ui block that declares inline tours", () => {
    const meta = parseGarrisonMetadata({
      ...baseManifest,
      ui: {
        views: [{ id: "main", placement: "faculty-tab", entry: "./ui/x.tsx", route: "/" }],
        tours: [
          {
            name: "my-tour",
            title: "My tour",
            route: "/",
            steps: [{ id: "s1", caption: "step one", selector: "text:Hello", spotlight: true }]
          }
        ]
      }
    });
    expect(meta.ui?.tours?.[0].name).toBe("my-tour");
    expect(meta.ui?.tours?.[0].steps).toHaveLength(1);
  });

  it("is additive — a ui block without tours still parses", () => {
    const meta = parseGarrisonMetadata({
      ...baseManifest,
      ui: { views: [{ id: "main", placement: "faculty-tab", entry: "./ui/x.tsx", route: "/" }] }
    });
    expect(meta.ui?.tours).toBeUndefined();
    expect(meta.ui?.views).toHaveLength(1);
  });

  it("rejects a tour with no steps", () => {
    expect(
      tourDescriptorSchema.safeParse({ name: "x", title: "X", route: "/", steps: [] }).success
    ).toBe(false);
  });

  it("rejects an assert with neither selector nor url", () => {
    const bad = tourDescriptorSchema.safeParse({
      name: "x",
      title: "X",
      route: "/",
      steps: [{ id: "s", caption: "c", selector: "text:a", assert: { text: "nope" } }]
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-kebab tour name", () => {
    expect(
      tourDescriptorSchema.safeParse({
        name: "MyTour",
        title: "X",
        route: "/",
        steps: [{ id: "s", caption: "c", selector: "text:a" }]
      }).success
    ).toBe(false);
  });
});

// --- registry discovery -----------------------------------------------------

describe("tours registry", () => {
  it("discovers the repo-root acceptance tours", async () => {
    const demo = await getTour("compose-demo");
    expect(demo?.route).toBe("/compose");
    expect(demo?.mode).toBe("demo");
    // The demo tour drives at least one action.
    expect(demo?.steps.some((s) => s.action)).toBe(true);

    const guided = await getTour("quarters-guided");
    expect(guided?.route).toBe("/quarters");
    expect(guided?.mode).toBe("guided");
    // The guided tour gates at least one advance on an assert.
    expect(guided?.steps.some((s) => s.assert)).toBe(true);
  });

  it("synthesizes a default tour for every UI fitting that ships none", async () => {
    const tours = await loadTours();
    const byFitting = new Set(tours.map((t) => t.fitting).filter(Boolean));
    const library = await readLibrary();
    const uiFittings = library.filter((entry) => (entry.metadata.ui?.views?.length ?? 0) > 0);
    // Invariant: every UI fitting is covered by at least one tour.
    for (const entry of uiFittings) {
      expect(byFitting.has(entry.id)).toBe(true);
    }
    // And there is at least one synthesized "-overview" default in the mix.
    expect(tours.some((t) => t.name.endsWith("-overview"))).toBe(true);
  });

  it("covers a valid seed UI fitting that is not listed in library.json", async () => {
    // vault-sync declares ui.views and parses cleanly but is not in the curated
    // library — the seed-directory scan must still cover it. (documents /
    // tier-classifier declare views too but use parked pre-pivot faculty ids the
    // parser rejects, so they are correctly excluded — dead seeds, not tours.)
    const tours = await loadTours();
    const byFitting = new Set(tours.map((t) => t.fitting));
    expect(byFitting.has("vault-sync")).toBe(true);
  });

  it("returns undefined for an unknown tour name", async () => {
    expect(await getTour("does-not-exist")).toBeUndefined();
  });

  it("summaries carry step counts and the synthesized flag", async () => {
    const summaries = await listTours();
    const demo = summaries.find((s) => s.name === "compose-demo");
    expect(demo?.steps).toBeGreaterThan(0);
    expect(demo?.synthesized).toBe(false);
    expect(summaries.some((s) => s.synthesized)).toBe(true);
  });
});
