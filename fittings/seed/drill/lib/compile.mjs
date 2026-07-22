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

// ── Authenticated runs (log in before the checks) ────────────────────────────
// A login-gated app answers every check's fresh navigate with its login
// screen, so a whole run reads as N product failures for one auth problem. The
// Drill Book's `auth` block describes how to log in ONCE; the runner
// establishes the session in the shared browser context before the checks (the
// persistent profile then caches it across runs), and a login failure
// collapses into a single incident instead of N. Steps may be authored as bare
// strings ("click Sign in") or as { id?, description } objects.

// Stable automation ids: the login flow and its cheap re-validation probe.
// Fixed ids (no page/step) so the engine's action + assertion caches persist
// across runs — the second run replays the login deterministically.
export const AUTH_LOGIN_ID = "drill-__auth";
export const AUTH_PROBE_ID = "drill-__auth-probe";
export const AUTH_VERIFY_STEP = "__auth_verify";

function authStepDescription(step) {
  if (typeof step === "string") return step.trim();
  if (step && typeof step === "object") return String(step.description ?? "").trim();
  return "";
}

// True when the Book carries a usable login flow (at least one real action).
export function hasAuth(book) {
  const steps = book?.auth?.steps;
  return Array.isArray(steps) && steps.some((s) => authStepDescription(s));
}

// The login URL: auth.loginPath resolved against app.url (same rule as
// resolvePageUrl), or the app URL itself when no loginPath is given.
export function resolveAuthUrl(book) {
  const appUrl = book?.app?.url || "http://localhost:3000";
  const loginPath = book?.auth?.loginPath;
  if (!loginPath) return appUrl;
  try {
    return new URL(loginPath, appUrl).toString();
  } catch {
    return appUrl;
  }
}

// Normalize auth.steps to [{ id, description }] with stable, id-safe, UNIQUE
// ids (login-<i> when unnamed) so their action cache persists run to run and
// terminalFromAutomationRun can address exactly one step. Blank entries are
// dropped, not compiled into no-op steps. Ids must be unique within the flow:
// a duplicate (two hand-authored `id: login` steps, or a generated id that
// collides with an explicit one) would give the compiled automation two steps
// with the same id — the engine's per-step cache and result addressing key off
// stepId, so a collision silently crosses their verdicts. Collisions are
// suffixed deterministically.
export function normalizeAuthSteps(book) {
  const steps = Array.isArray(book?.auth?.steps) ? book.auth.steps : [];
  const out = [];
  const used = new Set();
  const uniqueId = (base) => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  for (const raw of steps) {
    const description = authStepDescription(raw);
    if (!description) continue;
    const rawId = raw && typeof raw === "object" ? raw.id : null;
    const base = typeof rawId === "string" && /^[A-Za-z0-9_-]+$/.test(rawId) ? rawId : `login-${out.length}`;
    out.push({ id: uniqueId(base), description });
  }
  return out;
}

// The success signal: a verify description that proves login worked. Optional
// but strongly recommended — without it the run cannot cheaply probe whether
// the cached session is still valid, so it re-runs the full flow every time.
export function authSuccess(book) {
  const s = book?.auth?.success;
  return typeof s === "string" && s.trim() ? s.trim() : null;
}

// The probe: navigate to the login URL and verify the success signal. When the
// cached session is still valid the app shows its authenticated shell (or
// redirects away from the login route) and this passes with no form-filling.
// Returns null when the Book has no success signal to verify against.
export function compileAuthProbe(book) {
  const success = authSuccess(book);
  if (!success) return null;
  return {
    id: AUTH_PROBE_ID,
    name: "Drill: auth probe",
    steps: [
      { id: "__auth_navigate", type: "navigate", url: resolveAuthUrl(book) },
      { id: AUTH_VERIFY_STEP, type: "verify", description: success }
    ]
  };
}

// The full login flow: navigate, run each login action (vision/e2e resolved by
// the engine, cached after the first run), then verify the success signal when
// one is given.
export function compileAuthLogin(book) {
  const success = authSuccess(book);
  const steps = [
    { id: "__auth_navigate", type: "navigate", url: resolveAuthUrl(book) },
    ...normalizeAuthSteps(book).map((s) => ({ id: s.id, type: "browser", description: s.description }))
  ];
  if (success) steps.push({ id: AUTH_VERIFY_STEP, type: "verify", description: success });
  return { id: AUTH_LOGIN_ID, name: "Drill: login", steps };
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
