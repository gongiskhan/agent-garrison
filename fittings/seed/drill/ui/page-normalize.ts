// A page file is hand-editable AND agent-authored, so it arrives carrying only
// the keys its writer thought were worth writing: a page with no named states
// simply has no `states:` key, which is exactly what the planner tells the
// agent to do. 17 of the 22 pages in a freshly planned Book are like that.
//
// lib/store.mjs normalises on every read so "absent means empty" holds for
// server-side consumers. This is the same guarantee re-established on the
// CLIENT side of the wire, and it is not redundant: the bundle running in the
// browser and the fitting's server process are deployed independently. A
// long-running server started before the store gained its normalisation - or a
// page shape that arrives from anywhere else - hands this UI a page with no
// `states`, and `page.states.map(...)` then throws during render, unmounting
// the whole surface to a white screen. That is exactly how the Authoring view
// died: the PUT that saves an area returned the raw file, mutatePage put it
// straight into `pages`, and the next render crashed.
//
// Normalising here, at the single point where a page crosses into the UI,
// makes every downstream `.areas` / `.steps` / `.states` read safe by
// construction instead of a rule each of the ~30 call sites has to remember.

// The three collections a page file may omit. The return types below say the
// result HAS them, so a caller that forgets is a compile error rather than a
// white screen.
type Collections = { areas: unknown[]; steps: unknown[]; states: unknown[] };
export type PageShape = Partial<Collections> & { id?: unknown };

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Fill in the optional collections a page file is allowed to omit. */
export function normalizePage<T extends PageShape>(page: T): T & Collections {
  return {
    ...page,
    areas: asArray(page.areas),
    steps: asArray(page.steps),
    states: asArray(page.states)
  } as T & Collections;
}

/**
 * Normalise a page list straight off the wire. A non-array (an error body, an
 * older server, a truncated response) becomes an empty list rather than
 * throwing on the `.map`/`.some` that follows every fetch.
 */
export function normalizePages<T extends PageShape>(pages: unknown): Array<T & Collections> {
  if (!Array.isArray(pages)) return [];
  return pages
    .filter((page): page is T => Boolean(page) && typeof page === "object")
    .map((page) => normalizePage(page));
}
