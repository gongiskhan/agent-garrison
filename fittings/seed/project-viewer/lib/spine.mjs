// Turn a runtime capture into a flow SPEC — the skeleton a narrator fills in.
//
// WHY A SPEC AND NOT A MANIFEST. A capture knows, mechanically and beyond dispute,
// what happened and in what order: the actions, the URL each one was on, and the
// file that served that URL. What it does NOT know is which LINES of that file to
// show. Choosing a span is an editorial act, and this tool has exactly one door
// through which code enters a manifest — `spanSample()` reading `git show`. Emitting
// a manifest here would mean either inventing spans or shipping steps with no
// sample, and both are worse than handing the narrator a skeleton.
//
// So the spine becomes a spec: order locked, files identified, candidates ranked,
// prose and spans left blank. `build-flow.mjs --spec` then produces the manifest
// through the same validated path every other flow goes through.
//
// WHAT STOPS THE NARRATOR REWRITING HISTORY. The spec carries a frozen `spine`, and
// `buildFromSpec` checks the built manifest against it: every recorded action must
// appear, exactly once, in the order it happened. Adding steps is allowed — folding
// glue into a one-line step is the brief's own instruction. Dropping or reordering
// one is not. That makes "collapse never omit" structural for runtime flows rather
// than a rule someone remembers.
//
// Pure: no I/O, no clock. The caller passes the capture and gets a spec back.

import { safeId } from "./manifest.mjs";

/** How each recorded action is labelled before a narrator retitles it. */
const VERB_LABEL = {
  goto: "Navigate to",
  click: "Click",
  dblclick: "Double-click",
  fill: "Fill",
  press: "Press",
  check: "Check",
  uncheck: "Uncheck",
  selectOption: "Select",
  setInputFiles: "Attach file to",
  hover: "Hover",
  tap: "Tap",
  waitForURL: "Wait for",
};

const TITLE_MAX = 90;

/**
 * Grouping key for actions that happened before any navigation. A named constant
 * rather than a magic string with a leading space, which is both unreadable and — as
 * this file found out the hard way — the kind of literal that survives an edit as
 * something other than what it looks like.
 */
const NO_PAGE = "(no page yet)";

/** Actions that establish a page rather than act on one. */
export function isNavigationAction(action) {
  return action === "goto" || action === "waitForURL";
}

/**
 * A mechanical, honest placeholder title. The narrator is expected to improve it.
 *
 * A navigation carries its target in `url`, not in `arg` — the reporter deliberately
 * splits those — so without the fallback a `goto` came out titled just "Navigate to".
 */
export function stepTitle({ action, arg, url }) {
  const label = VERB_LABEL[action] ?? action;
  const subject = arg || (isNavigationAction(action) ? url : null);
  const text = subject ? `${label} ${subject}` : label;
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

/**
 * The facts a capture admits about itself, as short strings the narrator must not
 * lose. These exist because the capture pipeline records its own uncertainty —
 * a redirect it followed, a redirect target it could not derive, a URL that
 * resolved to no file — and prose written without reading them would describe a
 * page the reader never saw.
 */
export function admissionsFor({ action, route, isNavigation = true }) {
  const out = [];
  // Redirect facts belong to the navigation that was redirected. A click that
  // happened afterwards did not ask for anything and was not redirected; repeating
  // the hop under it read as though every interaction had been bounced.
  if (isNavigation) {
    if (action?.requestedUrl && action.requestedUrl !== action.url) {
      out.push(`the test asked for ${action.requestedUrl} and a redirect landed it on ${action.url}`);
    }
    for (const hop of route?.via ?? []) {
      out.push(`passed through the redirect stub ${hop.file} -> ${hop.to}`);
    }
  }
  if (route?.redirects === "dynamic") {
    out.push(
      `${route.file} redirects, but the target is computed at runtime — it was not derived, so do not guess it`
    );
  }
  if (action?.ok === false) {
    out.push("this action FAILED in the run; say so rather than describing the happy path");
  }
  if (!route) {
    out.push("no file was resolved for this URL — narrate it as glue or file a finding, do not invent a file");
  }
  return out;
}

/**
 * Build a flow spec from one capture.
 *
 * States are one per distinct page, in first-visit order, because a page is what a
 * reader navigates between. Steps are one per action, in the order they happened.
 */
export function specFromCapture(capture, { captureRef = null, flowId = null, title = null } = {}) {
  if (!capture || typeof capture !== "object") throw new Error("specFromCapture needs a capture object");
  const events = Array.isArray(capture.events) ? capture.events : [];
  const actions = events.filter((e) => e.type === "action");
  if (!actions.length) {
    // The driver already refuses to write an empty capture; this is the second
    // gate, for a capture that arrived from somewhere else.
    throw new Error("this capture records no actions, so there is no spine to build a spec from");
  }

  // Index the route and candidate events by the action they belong to, then by URL,
  // so an action revisiting a page still finds the route resolved on first visit.
  const routeByForSeq = new Map();
  const candidatesByRouteSeq = new Map();
  for (const e of events) {
    if (e.type === "route") routeByForSeq.set(e.forSeq, e);
    if (e.type === "candidates") candidatesByRouteSeq.set(e.forSeq, e);
  }
  const routeByUrl = new Map();
  for (const a of actions) {
    const route = routeByForSeq.get(a.seq);
    if (route && a.url && !routeByUrl.has(a.url)) routeByUrl.set(a.url, route);
  }

  const states = [];
  const spine = [];
  const byUrl = new Map();

  for (const action of actions) {
    const url = action.url ?? null;
    // A hand-authored source may declare several states at the SAME path — a page
    // empty and the same page full are two things worth reading about, not one — so
    // the grouping key is the declared state where there is one, the URL otherwise.
    const key = action.state?.key ?? url ?? NO_PAGE;
    let state = byUrl.get(key);
    if (!state) {
      state = {
        id: `s${states.length + 1}`,
        label: action.state?.label ?? url ?? "Before any navigation",
        description: "",
        steps: [],
      };
      byUrl.set(key, state);
      states.push(state);
    }

    const route = url ? routeByUrl.get(url) ?? null : null;
    const isFirstOnPage = state.steps.length === 0;
    const id = `${state.id}a${state.steps.length + 1}`;

    const step = {
      id,
      title: stepTitle(action),
      description: "",
      // Without a resolved file there is nothing to extract, and `code` would fail
      // validation for want of a sample. `glue` is the truthful shape: something
      // happened, and we cannot point at the code for it.
      kind: route ? "code" : "glue",
      hints: {
        action: action.action,
        ...(action.arg ? { arg: action.arg } : {}),
        url,
        ...(action.requestedUrl ? { requestedUrl: action.requestedUrl } : {}),
        ...(action.at ? { specLine: `${action.at.file}:${action.at.line}` } : {}),
        // A hand-authored intent outranks every candidate ranking below it: it is a
        // person saying what this page is for. Narrate from it.
        ...(action.intent ? { intent: action.intent } : {}),
        ...(route
          ? {
              // The file to narrate FROM, and the files it pulls in. The narrator
              // picks one and a span; it may not introduce a file from nowhere.
              routeFile: route.file,
              ...(route.params ? { routeParams: route.params } : {}),
              ...(route.layouts?.length ? { layouts: route.layouts } : {}),
              // Candidates only on the first step of a page: repeating twelve paths
              // under every click would bury the spine in noise.
              ...(isFirstOnPage && candidatesByRouteSeq.has(route.seq)
                ? { candidates: candidatesByRouteSeq.get(route.seq).files.map((f) => f.file) }
                : {}),
            }
          : {}),
      },
    };

    const admissions = admissionsFor({
      action,
      route,
      isNavigation: isNavigationAction(action.action),
    });
    if (admissions.length) step.hints.admissions = admissions;

    state.steps.push(step);
    spine.push({ id, action: action.action, url });
  }

  const derivedTitle = title ?? capture.test?.title ?? "Untitled flow";
  return {
    flowId: flowId ?? safeId(capture.test?.title ?? "", "flow"),
    title: derivedTitle,
    summary: "",
    source: capture.source ?? "e2e",
    // A drillbook page is not a test file, and calling it one would send whoever reads
    // the provenance looking for a spec that does not exist.
    provenance: {
      ...(capture.source === "drillbook"
        ? {
            ...(capture.test?.file ? { drillbookPage: capture.test.file } : {}),
            ...(capture.drillbook?.stepIds?.length ? { drillbookStep: capture.drillbook.stepIds.join(", ") } : {}),
          }
        : capture.test?.file
          ? { testFile: capture.test.file }
          : {}),
      ...(captureRef ? { captureRef } : {}),
      ...(capture.runId ? { runId: capture.runId } : {}),
    },
    // Recorded so a reader of the spec knows whether the run it came from passed.
    // A spine captured from a failing test is still a real spine, but the narration
    // must not describe it as if everything worked.
    runStatus: capture.status ?? "unknown",
    spine,
    states,
  };
}

/**
 * Check a built manifest against the frozen spine.
 *
 * Extra steps pass: the narrator is told to add glue and grouping steps. What fails
 * is an action that executed and is nowhere in the document, or two actions whose
 * order was swapped — both of which would make the flow a plausible story about a
 * run that did not happen that way.
 */
export function checkSpine(flow, spine) {
  const errors = [];
  if (!Array.isArray(spine) || spine.length === 0) return { ok: true, errors };

  const ordered = [];
  for (const state of flow?.states ?? []) {
    for (const step of state?.steps ?? []) ordered.push(step.id);
  }
  const seen = new Map();
  for (const id of ordered) seen.set(id, (seen.get(id) ?? 0) + 1);

  const missing = spine.filter((s) => !seen.has(s.id));
  if (missing.length) {
    errors.push(
      `${missing.length} recorded action(s) are missing from the manifest: ` +
        missing.map((s) => `${s.id} (${s.action}${s.url ? ` on ${s.url}` : ""})`).join(", ") +
        ". Collapse a step if it is trivial; do not drop it."
    );
  }
  for (const s of spine) {
    if ((seen.get(s.id) ?? 0) > 1) errors.push(`spine step "${s.id}" appears ${seen.get(s.id)} times`);
  }

  // Order: the spine ids, in the order they appear in the manifest, must equal the
  // spine's own order.
  const present = spine.filter((s) => seen.has(s.id)).map((s) => s.id);
  const asRendered = ordered.filter((id) => present.includes(id));
  const firstDivergence = present.findIndex((id, i) => asRendered[i] !== id);
  if (firstDivergence !== -1 && !missing.length) {
    errors.push(
      `the manifest reorders the run: expected "${present[firstDivergence]}" at position ` +
        `${firstDivergence + 1} of the recorded actions, found "${asRendered[firstDivergence]}".`
    );
  }

  return { ok: errors.length === 0, errors };
}
