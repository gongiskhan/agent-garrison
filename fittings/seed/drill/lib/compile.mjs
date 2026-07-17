// Compile a Drill page's enabled steps to automations engine steps (B6, R3).
// Pure - no I/O - so the compile logic is unit-testable without a browser or
// an engine. Drill's step vocabulary (page-level + area-scoped, vision/e2e
// mode) compiles down to the SAME `verify` step type regardless of mode: mode
// only gates Phase-5 graduation eligibility, not the Phase-4 run mechanism -
// an ungraduated step has no `assertion` yet, so it resolves via vision on
// first run and the engine's own cache remembers it (tier "cached") from then
// on, exactly like a graduated step whose cachedAssertion later goes stale
// falls back to vision and re-caches (the healing path, B7/self-test item 5).

import { anchorsToLocatorHint } from "./picker.mjs";

// Resolve a page's target URL against the Drill Book's app URL, mirroring the
// server's /api/authoring/tab resolution (data:/about: bases have no real
// path hierarchy to resolve a sub-path against).
export function resolvePageUrl(book, page) {
  const appUrl = book?.app?.url || "http://localhost:3000";
  if (!page?.path) return appUrl;
  try {
    return new URL(page.path, appUrl).toString();
  } catch {
    return appUrl;
  }
}

// Compile ONE Drill step to ONE automations `verify` step. A step's
// `assertion` (set once graduated, Phase 5) becomes the deterministic
// cachedAssertion; an area-scoped step with no assertion yet still carries
// its anchor as `areaHint` (informational - not consumed by the engine, just
// round-tripped onto the result for the UI to show which area a step covers).
// blind (R12/F8): the adversarial pass receives ONLY areas and acceptance-
// level step descriptions - never the emitted specs or cached actions. So a
// blind compile omits cachedAssertion/areaHint even for an already-graduated
// step, forcing vision resolution from the description alone.
export function compileStep(step, page, { blind = false } = {}) {
  const area = page.areas.find((a) => a.n === step.area);
  const compiled = {
    id: step.id,
    type: "verify",
    description: step.description,
    tags: step.tags ?? []
  };
  if (blind) return compiled;
  if (step.assertion) compiled.cachedAssertion = step.assertion;
  else if (area) {
    // No deterministic assertion yet - attach the area's locator as a hint
    // so a FUTURE richer-assertion authoring pass has something to start
    // from. Never fabricates a cachedAssertion (R11 "never guess" spirit).
    try { compiled.areaHint = anchorsToLocatorHint(area.anchors); } catch { /* area has no usable anchor yet */ }
  }
  return compiled;
}

// Select which of a page's steps run for a given (state, viewport) - enabled,
// state-matched, and (when a viewport is given) tagged for that viewport.
// Page YAML is also authored outside the UI (the plan agent, hand edits), so
// an omitted field means the permissive default - enabled, state "default",
// all viewports - never a silently dead step. Only an explicit
// `enabled: false` or a non-matching state/viewport list excludes a step.
export function selectSteps(page, { state = "default", viewport } = {}) {
  return (page.steps ?? []).filter((s) =>
    s.enabled !== false
    && (s.state ?? "default") === state
    && (!viewport || !s.viewports?.length || s.viewports.includes(viewport))
  );
}

// A state's reach path (C5): ordered actions that put the page into that
// state, compiled as normal `browser` (action) engine steps - cache->vision->
// execute, same as any action step, so "the action cache makes reaching
// cheap after the first time" falls out of the existing engine mechanics
// with no new plumbing.
export function compileReachPath(state) {
  if (!state?.reachPath?.length) return [];
  return state.reachPath.map((r) => ({ id: r.id, type: "browser", description: r.description }));
}

// Compile ONE step to its own two-step automation (navigate + the verify
// step), with a STABLE id (`drill-<page>-<step>`) so the action/assertion
// cache persists across runs of the SAME Drill step. Each Drill step is its
// own engine run - deliberately, NOT one page = one automation with N steps -
// because the automations engine halts the whole run on a step failure
// (correct for a sequential click-through flow; wrong for a page's
// independent assertions, which must all report their own verdict even when
// a sibling step fails). See FINDING at Phase 4 close for the tradeoff.
//
// A state-scoped step (step.state !== "default") gets its state's reach path
// compiled in BEFORE the step itself (C5) - same automation, same cache
// namespace, so a second run of the same step reuses both the reach actions'
// cache entries and the step's own assertion cache.
export function compileStepAutomation(book, page, step, { blind = false } = {}) {
  const state = step.state && step.state !== "default" ? page.states?.find((s) => s.id === step.state) : null;
  const reachSteps = compileReachPath(state);
  return {
    id: `drill-${page.id}-${step.id}`,
    name: `Drill: ${page.title} / ${step.id}`,
    steps: [
      { id: "__drill_navigate", type: "navigate", url: resolvePageUrl(book, page) },
      ...reachSteps,
      compileStep(step, page, { blind })
    ]
  };
}
