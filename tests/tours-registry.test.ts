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

  it("unions the seed-directory scan with the library, de-duplicated by id", async () => {
    // readFittingSources merges the curated library with a raw scan of
    // fittings/seed, so a fitting present in only one of them is still covered
    // by the "every UI fitting ships a tour" invariant. There is no seed-only UI
    // fitting today — vault-sync was the last, and it retired with the outposts
    // (2026-08-24) — so what is asserted here is the union's shape: every
    // library UI fitting appears exactly once, alongside the repo-root shell
    // tours that belong to no fitting.
    const tours = await loadTours();
    const perFitting = new Map<string, number>();
    for (const tour of tours) {
      if (!tour.fitting) continue;
      perFitting.set(tour.fitting, (perFitting.get(tour.fitting) ?? 0) + 1);
    }
    const library = await readLibrary();
    const uiFittings = library.filter((entry) => (entry.metadata.ui?.views?.length ?? 0) > 0);
    expect(uiFittings.length).toBeGreaterThan(0);
    for (const entry of uiFittings) {
      expect(perFitting.get(entry.id), `${entry.id} tour count`).toBeGreaterThanOrEqual(1);
    }
    // The repo-root <repo>/tours source contributes ids that are NOT library
    // entries at all — proof the loader is a union rather than a library read.
    const nonLibrary = [...perFitting.keys()].filter((id) => !library.some((entry) => entry.id === id));
    expect(nonLibrary.sort()).toEqual(["compose", "quarters", "shell"]);
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
