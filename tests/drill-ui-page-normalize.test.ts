// The Authoring view white-screened with "Cannot read properties of undefined
// (reading 'map')" on `page.states.map(...)`. The page came from the PUT that
// saves an area: a server predating the store's savePage normalisation returns
// the RAW page file, and 17 of a freshly planned Book's 22 pages carry no
// `states:` key at all. mutatePage dropped that object straight into `pages`,
// and the next render unmounted the whole surface.
//
// The server-side fix (store.mjs) is covered by drill-page-normalize.test.ts.
// These cover the client side of the wire, which is a separate deployment: the
// browser bundle and the fitting's long-lived server process are updated
// independently, so the UI must not depend on the server having normalised.
import { describe, expect, it } from "vitest";
import { normalizePage, normalizePages, type PageShape } from "../fittings/seed/drill/ui/page-normalize";

// Exactly what the pre-fix server returned from PUT /api/pages/<id> for a page
// authored with no named states - the object that crashed the render.
const rawSavedPage = {
  id: "automations",
  title: "Automations",
  path: "/automations",
  mode: "steps" as const,
  steps: [{ id: "heading-visible", area: 0 }]
};

describe("normalizePage", () => {
  it("fills in the collections a page file is allowed to omit", () => {
    const page = normalizePage(rawSavedPage);
    expect(page.states).toEqual([]);
    expect(page.areas).toEqual([]);
    expect(page.steps).toHaveLength(1);
  });

  it("makes the reads that crashed the Authoring view safe", () => {
    const page = normalizePage(rawSavedPage);
    expect(() => page.states.map((state: any) => state.id)).not.toThrow();
    expect(() => page.areas.map((area: any) => area.n)).not.toThrow();
    expect(page.states.map((state: any) => state.id)).toEqual([]);
  });

  it("keeps everything the page did carry, and does not mutate the input", () => {
    const page = normalizePage(rawSavedPage);
    expect(page.id).toBe("automations");
    expect(page.title).toBe("Automations");
    expect(page.path).toBe("/automations");
    expect(page.mode).toBe("steps");
    expect((rawSavedPage as any).states).toBeUndefined();
  });

  it("coerces a hand-edited non-array to an empty collection", () => {
    // Shapes the types say cannot happen but a hand-edited YAML file can.
    const page = normalizePage({ id: "x", states: "default", areas: null } as unknown as PageShape);
    expect(page.states).toEqual([]);
    expect(page.areas).toEqual([]);
  });

  it("leaves a populated collection untouched", () => {
    const states = [{ id: "empty" }, { id: "filled" }];
    expect(normalizePage({ id: "x", states }).states).toBe(states);
  });
});

describe("normalizePages", () => {
  it("normalises every page off the wire", () => {
    const pages = normalizePages<{ id: string; states: unknown[] }>([rawSavedPage, { id: "login" }]);
    expect(pages).toHaveLength(2);
    expect(pages.every((page) => Array.isArray(page.states))).toBe(true);
  });

  // An error body, an older server, or a truncated response must not throw on
  // the `.some`/`.map`/`.length` that follows every /api/pages fetch.
  it("turns a missing or malformed list into an empty one", () => {
    expect(normalizePages(undefined)).toEqual([]);
    expect(normalizePages(null)).toEqual([]);
    expect(normalizePages({ error: "boom" })).toEqual([]);
  });

  it("drops non-object entries rather than carrying a crash forward", () => {
    expect(normalizePages([null, "login", rawSavedPage])).toHaveLength(1);
  });
});
