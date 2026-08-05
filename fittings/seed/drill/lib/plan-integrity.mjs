// Post-plan integrity guard.
//
// The planner writes the target repo directly, so prompt rules alone cannot
// establish provenance. This module snapshots the parsed Book before the agent
// starts, compares the verification contract after it exits, and applies the
// small set of safe mechanical corrections Drill can prove:
//
// - a new/changed deterministic answer is plan-authored, never run-proven;
// - an answer with no exact current exploration receipt falls back to vision;
// - a new empirical finding with no current quiet observation is quarantined;
// - an unsupported empirical rewrite of an existing check is rejected by
//   restoring that one baseline step; and
// - empirical/history prose cannot be smuggled into globalRules.
//
// The Book remains hand-editable. This is deliberately a PLAN-finalization
// guard, not a strict store schema: Authoring is allowed to persist drafts.

import fs from "node:fs/promises";
import path from "node:path";
import { getDrillBook, getPage, listPages, saveDrillBook, savePage } from "./store.mjs";
import { specRelPath, writePageSpecFile } from "./graduate.mjs";

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stateReachPath(page, step) {
  const stateId = step?.state ?? "default";
  if (stateId === "default") return [];
  return page?.states?.find((state) => state?.id === stateId)?.reachPath ?? [];
}

// Provenness belongs to the whole verification contract, not just the
// assertion JSON. Keeping the same locator while changing "is visible" to
// "submits successfully", or changing the state/path/actions, invalidates the
// prior proof just as surely as changing the assertion itself.
export function verificationFingerprint(book, page, step) {
  return stable({
    appUrl: book?.app?.url ?? "",
    path: page?.path ?? "",
    description: step?.description ?? "",
    state: step?.state ?? "default",
    reachPath: stateReachPath(page, step),
    actions: step?.actions ?? [],
    viewports: step?.viewports ?? book?.viewports ?? [],
    assertion: step?.assertion ?? null
  });
}

const EMPIRICAL_PATTERNS = [
  ["authoring-observation", /\bobserv(?:ed|ation)\s+(?:at|during)\s+authoring\b/i],
  ["authoring-time", /\bauthoring[- ]time\s+(?:observation|finding|defect|note)\b/i],
  ["observed-defect", /\bobserved\s+(?:defect|failure|bug)\b/i],
  ["dated-recheck", /\bre-?checked\s+\d{4}-\d{2}-\d{2}\b/i],
  ["known-finding", /\bknown\s+(?:defect|failure|bug|blocker)\b/i],
  ["standing-defect", /\bstanding\s+defect\b/i],
  ["retracted-claim", /\bretracted\s+claim\b/i],
  ["current-runtime-report", /\b(?:this\s+(?:page|build)|the\s+(?:page|form|loader|request|button|region|panel|list|table))\s+currently\s+(?:shows?|renders?|reports?|returns?|stays?|hangs?|spins?)\b/i],
  ["api-observation", /\b(?:the\s+same\s+)?api\s+(?:returned|answered|responded)\b/i],
  ["runtime-scope", /\b(?:in\s+this\s+build|reproduces?\s+(?:on|in|with))\b/i],
  ["diagnosis", /\b(?:root\s+cause|harness\s+artifact)\b/i],
  ["timeout-banner", /\b(?:request\s+)?timed\s+out\s+after\s+\d+\s*(?:ms|milliseconds?|s|seconds?|min|minutes?)\b/i],
  ["per-page-wait", /\b(?:wait|allow|give|given|be\s+given)\b.{0,40}\b(?:\d+|one|two|three|four|five)\s*\+?\s*(?:s|seconds?|min|minutes?)\b/i],
  ["expected-failure-rate", /(?:\b(?:expect(?:ed)?(?:\s+result)?\s+(?:(?:failure|failures|red)\b.{0,35}(?:\d+\s*%|\d+\s*\/\s*\d+)|(?:\d+\s*%|\d+\s*\/\s*\d+).{0,35}(?:fail(?:ure|ures?)?|red))|(?:\d+\s*%|\d+\s*\/\s*\d+).{0,35}(?:expected\s+)?(?:fail(?:ure|ures?)?|red))\b|\bexpect(?:ed)?\s+~?\s*(?:a|one)\s+(?:third|quarter|half)\s+of\s+(?:all\s+)?(?:assertions|pages|checks|steps)\s+to\s+be\s+(?:red|fail(?:ing)?)\b)/i],
  ["browser-data-never-arrives", /\b(?:loaders?|(?:authenticated\s+)?data\s+(?:reads?|requests?)|authenticated\s+requests?)(?:\s+(?:and|or)\s+(?:loaders?|(?:authenticated\s+)?data\s+(?:reads?|requests?)|authenticated\s+requests?))?\s+never\s+(?:resolv(?:e|es|ing)|reach(?:es|ing)?|return(?:s|ing)?|arriv(?:e|es|ing))(?:\s+(?:the\s+)?browser)?\b/i],
  // Finite exploration can establish a deadline miss, never an absolute.
  ["unbounded-time", /(?:\b(?:the\s+(?:page|form|loader|request|button|region|panel|list|table)|it)\s+(?:never\s+(?:resolves?|returns?|finishes?|settles?)|(?:hangs?|spins?|stays?|remains?)\s+forever)\b|\bindefinitely\b)/i]
];

// globalRules is intentionally limited to durable tone/brand/layout
// invariants. Operational browser claims belong to per-page observations even
// when phrased without an explicit "currently" or "observed" marker.
const GLOBAL_RUNTIME_PATTERNS = [
  ["global-runtime-network", /\b(?:api|fetch|xhr|network|endpoint|http\s+status|requests?|responses?)\b/i],
  ["global-runtime-loading", /\b(?:loaders?|loading|spinners?|timeouts?|timed\s+out)\b/i],
  ["global-runtime-state", /\b(?:error\s+banner|empty\s+state|blank\s+(?:page|panel)|data\s+(?:read|load|request))s?\b/i]
];

export function empiricalClaimMarkers(text) {
  const source = String(text ?? "");
  const out = [];
  for (const [code, pattern] of EMPIRICAL_PATTERNS) {
    const match = source.match(pattern);
    if (match) out.push({ code, text: match[0] });
  }
  return out;
}

export function hasEmpiricalClaim(text) {
  return empiricalClaimMarkers(text).length > 0;
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function proseClauses(value) {
  return String(value ?? "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalizeWhitespace)
    .filter(Boolean);
}

function isDeletionOnlyProseChange(before, after) {
  const oldClauses = proseClauses(before);
  const nextClauses = proseClauses(after);
  if (nextClauses.length === 0) return oldClauses.length > 0;
  if (nextClauses.length >= oldClauses.length) return false;
  const remaining = [...oldClauses];
  for (const clause of nextClauses) {
    const index = remaining.indexOf(clause);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

// A polluted legacy rule may be cleaned by deletion. Anything else that leaves
// empirical prose in a changed scalar is rejected; a single prose blob cannot
// be safely split into "good" and "bad" clauses mechanically.
export function plannerAddedEmpiricalGlobalRules(before, after) {
  const oldText = String(before ?? "");
  const nextText = String(after ?? "");
  if (oldText === nextText) return false;
  const afterMarkers = [
    ...empiricalClaimMarkers(nextText),
    ...GLOBAL_RUNTIME_PATTERNS.flatMap(([code, pattern]) => {
      const match = nextText.match(pattern);
      return match ? [{ code, text: match[0] }] : [];
    })
  ];
  if (afterMarkers.length === 0) return false;
  const beforeMarkers = [
    ...empiricalClaimMarkers(oldText),
    ...GLOBAL_RUNTIME_PATTERNS.flatMap(([code, pattern]) => {
      const match = oldText.match(pattern);
      return match ? [{ code, text: match[0] }] : [];
    })
  ];
  const deletionOnly = afterMarkers.length < beforeMarkers.length
    && isDeletionOnlyProseChange(oldText, nextText);
  return !deletionOnly;
}

function plannerExpandedGlobalRules(before, after) {
  const oldText = normalizeWhitespace(before);
  const nextText = normalizeWhitespace(after);
  if (oldText === nextText || nextText === "") return false;
  // Removing a clause from a legacy rule is cleanup, not a new app-wide
  // assertion. Additions and rewrites both need independent route evidence.
  return !isDeletionOnlyProseChange(oldText, nextText);
}

export async function capturePlanBaseline(root) {
  const [book, pages] = await Promise.all([
    getDrillBook(root),
    listPages(root).catch(() => [])
  ]);
  const pageMap = {};
  for (const meta of pages) {
    const page = await getPage(meta.id, root).catch(() => null);
    if (page) pageMap[meta.id] = clone(page);
  }
  return { book: clone(book), pages: pageMap };
}

function receiptIds(step) {
  const observation = step?.authoringObservation;
  if (!observation || typeof observation !== "object") return [];
  const raw = Array.isArray(observation.receipts)
    ? observation.receipts
    : observation.receipt
      ? [observation.receipt]
      : [];
  return raw.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim());
}

function pathOnly(value) {
  if (!value) return null;
  try { return new URL(String(value), "http://drill.invalid").pathname; } catch { return String(value); }
}

function webOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function hasKnownCompleteNetworkWindow(observation) {
  const summary = observation?.network?.summary;
  return Boolean(summary)
    && summary.unavailable !== true
    && summary.historyKnown === true
    && summary.historyTruncated === false;
}

function observationMatchesStep(observation, { root, startedAt, book, page, step }) {
  if (!observation || typeof observation !== "object") return false;
  if (observation.root !== root) return false;
  const at = Date.parse(observation.observedAt ?? observation.at ?? observation.createdAt ?? "");
  const since = Date.parse(startedAt ?? "");
  if (!Number.isFinite(at) || (Number.isFinite(since) && at < since)) return false;

  const conditions = observation.conditions ?? {};
  const observedPath = pathOnly(
    conditions.requestedPath
    ?? conditions.path
    ?? conditions.finalPath
    ?? observation.url
  );
  const expectedPath = pathOnly(page?.path ?? "/");
  if (observedPath !== expectedPath || pathOnly(conditions.finalPath ?? observation.url) !== expectedPath) return false;
  const expectedOrigin = webOrigin(book?.app?.url);
  if (expectedOrigin && (
    conditions.requestedOrigin !== expectedOrigin
    || conditions.finalOrigin !== expectedOrigin
    || webOrigin(observation.url) !== expectedOrigin
  )) return false;

  const observedViewport = conditions.viewport?.id
    ?? observation.viewport?.id
    ?? observation.viewportId
    ?? (typeof observation.viewport === "string" ? observation.viewport : null);
  const expectedViewports = step?.viewports?.length ? step.viewports : (book?.viewports ?? []);
  if (expectedViewports.length && (!observedViewport || !expectedViewports.includes(observedViewport))) return false;

  // A raw DOM snapshot taken immediately after navigation is not evidence that
  // the page settled. The explore contract records bounded DOM/network
  // inactivity; fake shell sleeps cannot manufacture it, and even a quiet
  // result is not proof of semantic readiness.
  const quietOutcome = observation.quiet?.outcome ?? conditions.quietOutcome;
  if (!["quiet", "budget-exhausted"].includes(quietOutcome) || !observation.screenshot) return false;
  if (!hasKnownCompleteNetworkWindow(observation)) return false;
  const browserContext = observation.browserContext ?? conditions.browserContext;
  if (!browserContext || typeof browserContext !== "object" || Object.keys(browserContext).length === 0) return false;
  return true;
}

function observationSourceFields(observation) {
  const conditions = observation?.conditions ?? {};
  const raw = conditions.source ?? observation?.source;
  const source = typeof raw === "string" ? raw : raw?.kind;
  const actionKind = conditions.actionKind
    ?? (raw && typeof raw === "object" ? raw.actionKind : null)
    ?? (observation?.source && typeof observation.source === "object" ? observation.source.actionKind : null);
  return { source, actionKind };
}

function compactObservationConditions(observation) {
  const conditions = observation.conditions ?? {};
  const quiet = observation.quiet ?? {};
  const browserContext = observation.browserContext ?? conditions.browserContext ?? {};
  const viewport = conditions.viewport ?? observation.viewport ?? {};
  const compactQuiet = {};
  for (const key of [
    "outcome", "waitedMs", "quietForMs", "readyState", "networkQuiet", "domStable",
    "timedOut", "budgetMs", "pendingRequests", "persistentRequests"
  ]) {
    if (["string", "number", "boolean"].includes(typeof quiet[key])) compactQuiet[key] = quiet[key];
  }
  const compactContext = {};
  for (const key of ["persistentProfile", "tabAgeMs", "navigationAgeMs"]) {
    if (["number", "boolean"].includes(typeof browserContext[key])) compactContext[key] = browserContext[key];
  }
  const compactViewport = {};
  for (const key of ["id", "width", "height"]) {
    if (["string", "number"].includes(typeof viewport[key])) compactViewport[key] = viewport[key];
  }
  const network = observation.network?.summary ?? {};
  const networkSummary = {};
  for (const key of [
    "total", "pending", "persistent", "non2xx", "redirects", "notModified",
    "httpErrors", "otherNon2xx", "transportFailures", "completed2xx", "historyDroppedCount"
  ]) {
    if (typeof network[key] === "number") networkSummary[key] = network[key];
  }
  for (const key of ["historyKnown", "historyTruncated", "unavailable"]) {
    if (typeof network[key] === "boolean") networkSummary[key] = network[key];
  }
  const { source, actionKind } = observationSourceFields(observation);
  const requestedOrigin = webOrigin(conditions.requestedOrigin);
  const finalOrigin = webOrigin(conditions.finalOrigin);
  const actionsSinceOpen = Number(conditions.actionsSinceOpen);
  return {
    observedAt: observation.observedAt,
    requestedPath: conditions.requestedPath
      ?? conditions.path
      ?? conditions.finalPath
      ?? pathOnly(observation.url),
    finalPath: conditions.finalPath ?? pathOnly(observation.url),
    ...(requestedOrigin ? { requestedOrigin } : {}),
    ...(finalOrigin ? { finalOrigin } : {}),
    ...(Number.isSafeInteger(actionsSinceOpen) && actionsSinceOpen >= 0 ? { actionsSinceOpen } : {}),
    viewport: compactViewport,
    quiet: compactQuiet,
    browserContext: compactContext,
    ...(["open", "act", "observe", "assert"].includes(source) ? { source } : {}),
    ...(typeof actionKind === "string" && actionKind.length <= 40 ? { actionKind } : {}),
    ...(Object.keys(networkSummary).length ? { networkSummary } : {})
  };
}

async function validateAuthoringObservation(step, context, evidence, markers) {
  const ids = receiptIds(step);
  const kind = step?.authoringObservation?.kind;
  // No finite receipt can prove an absolute temporal diagnosis. The current
  // explore contract also has no independent multi-sample timed-wait receipt,
  // so timeout/data comparisons remain unsupported rather than being blessed
  // by a single screenshot or a separate curl.
  if (markers.some((marker) => marker.code === "unbounded-time")) {
    return { valid: false, reason: "observation-time-unbounded" };
  }
  if (!new Set(["snapshot", "timeout", "interaction", "data-mismatch"]).has(kind)) {
    return { valid: false, reason: "observation-kind-invalid" };
  }
  if (kind === "interaction") {
    return { valid: false, reason: "observation-interaction-unsupported" };
  }
  if (kind === "timeout" || kind === "data-mismatch") {
    return { valid: false, reason: `observation-${kind}-unsupported` };
  }
  if (ids.length === 0 || typeof evidence?.getObservation !== "function") {
    return { valid: false, reason: "observation-evidence-missing" };
  }
  const observations = [];
  for (const id of ids) {
    const observation = await evidence.getObservation(id);
    if (!observationMatchesStep(observation, context)) {
      return { valid: false, reason: "observation-receipt-mismatch" };
    }
    const { source } = observationSourceFields(observation);
    if (kind === "snapshot" && source && !["open", "observe", "act"].includes(source)) {
      return { valid: false, reason: "observation-snapshot-source-invalid" };
    }
    observations.push(observation);
  }
  const compact = observations.map(compactObservationConditions);
  return {
    valid: true,
    enriched: {
      kind,
      observedAt: compact.at(-1)?.observedAt ?? observations.at(-1)?.observedAt,
      conditions: compact
    }
  };
}

async function exactAssertionWasObserved(step, context, evidence) {
  if (typeof evidence?.hasPassedAssertion !== "function") return false;
  // Until exploration records and replays an exact setup/action sequence, a
  // receipt can only prove the untouched default page reached by explicit
  // navigation. Conservatively leave stateful and behavioural checks in the
  // vision lane instead of blessing them with unrelated DOM state.
  if ((step?.state ?? "default") !== "default") return false;
  if (Array.isArray(step?.actions) && step.actions.length > 0) return false;
  const viewports = step?.viewports?.length ? step.viewports : (context.book?.viewports ?? []);
  const required = viewports.length ? viewports : [null];
  for (const viewport of required) {
    const passed = await evidence.hasPassedAssertion(step.assertion, {
      since: context.startedAt,
      path: context.page?.path ?? "/",
      finalPath: context.page?.path ?? "/",
      appUrl: context.book?.app?.url ?? null,
      pristine: true,
      ...(viewport ? { viewport } : {})
    });
    if (!passed) return false;
  }
  return true;
}

function warning(pageId, stepId, text) {
  return `page "${pageId}" step "${stepId}": ${text}`;
}

async function reconcileExistingPageSpec(root, book, page) {
  const file = path.join(root, specRelPath(page.id));
  try {
    await fs.access(file);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await writePageSpecFile(book, page, root);
  return true;
}

export async function applyPlanIntegrity({ root, baseline, startedAt, evidence = {} }) {
  const warnings = [];
  let needsAttention = false;
  let quarantined = 0;
  let restoredSteps = 0;
  let downgradedAssertions = 0;
  let globalRulesRestored = false;
  let globalRulesEvidenceRoutes = 0;
  let removedCoverage = 0;
  let provenanceRepairs = 0;
  let bookConfigRepairs = 0;
  let bookConfigReviews = 0;
  const downgradedStepKeys = new Set();
  const countDowngrade = (pageId, stepId) => {
    const key = `${pageId}\u0000${stepId}`;
    if (downgradedStepKeys.has(key)) return;
    downgradedStepKeys.add(key);
    downgradedAssertions += 1;
  };

  const book = await getDrillBook(root);
  const baselineBook = baseline?.book ?? {};
  if (plannerAddedEmpiricalGlobalRules(baselineBook.globalRules, book.globalRules)) {
    await saveDrillBook({ globalRules: baselineBook.globalRules ?? "" }, root);
    warnings.push("globalRules: planner-added empirical/history language was rejected; restored the pre-plan timeless rules");
    needsAttention = true;
    globalRulesRestored = true;
  } else if (plannerExpandedGlobalRules(baselineBook.globalRules, book.globalRules)) {
    // A generic receipt proves only that a route was observed; it is not
    // semantically tied to arbitrary prose such as "all pages omit records".
    // Until Drill has a typed global invariant plus a predicate-specific proof
    // protocol, planner sessions may clean polluted clauses but may not add or
    // rewrite app-wide rules. Human-authored pre-plan rules remain untouched.
    await saveDrillBook({ globalRules: baselineBook.globalRules ?? "" }, root);
    warnings.push("globalRules: planner additions and rewrites are not accepted because route receipts cannot prove arbitrary app-wide prose; restored the pre-plan rules for manual curation");
    needsAttention = true;
    globalRulesRestored = true;
  }

  if (stable(book.auth) !== stable(baselineBook.auth)) {
    needsAttention = true;
    if (baselineBook.auth != null) {
      await saveDrillBook({ auth: clone(baselineBook.auth) }, root);
      book.auth = clone(baselineBook.auth);
      bookConfigRepairs += 1;
      warnings.push("auth: planner changed the pre-plan authentication contract without an exact replayable login receipt; restored the pre-plan auth block");
    } else {
      bookConfigReviews += 1;
      warnings.push("auth: planner added a new authentication contract without an exact replayable login receipt; kept it for manual review but blocked unattended plan-then-run");
    }
  }

  const baselineAppUrl = String(baselineBook.app?.url ?? "");
  const plannedAppUrl = String(book.app?.url ?? "");
  if (plannedAppUrl !== baselineAppUrl) {
    needsAttention = true;
    if (baselineAppUrl) {
      book.app = { ...(book.app ?? {}), url: baselineAppUrl };
      await saveDrillBook({ app: book.app }, root);
      bookConfigRepairs += 1;
      warnings.push("app.url: planner changed the established app target; restored the pre-plan URL because exploration receipts cannot authorize a target rewrite");
    } else {
      bookConfigReviews += 1;
      warnings.push("app.url: planner established the target for a fresh Book; kept it for manual review but blocked unattended plan-then-run");
    }
  }

  const pages = await listPages(root).catch(() => []);
  const currentPageIds = new Set(pages.map((page) => page.id));
  for (const baselinePageId of Object.keys(baseline?.pages ?? {})) {
    if (currentPageIds.has(baselinePageId)) continue;
    warnings.push(`page "${baselinePageId}": planner removed the pre-plan page file; review the coverage deletion before running`);
    needsAttention = true;
    removedCoverage += 1;
  }
  const currentLedger = new Map((book?.pages ?? []).map((page) => [page?.id, page]));
  for (const baselineMeta of baselineBook?.pages ?? []) {
    if (baselineMeta?.selected !== true) continue;
    if (currentLedger.get(baselineMeta.id)?.selected === true) continue;
    warnings.push(`page "${baselineMeta.id}": planner deselected or removed a previously selected Book page; review the coverage reduction before running`);
    needsAttention = true;
    removedCoverage += 1;
  }

  for (const meta of pages) {
    const page = await getPage(meta.id, root).catch(() => null);
    if (!page) continue;
    const baselinePage = baseline?.pages?.[page.id] ?? null;
    const baselineSteps = new Map((baselinePage?.steps ?? []).map((step) => [step.id, step]));
    const nextSteps = [];
    let pageChanged = false;

    for (const originalStep of page.steps ?? []) {
      let step = clone(originalStep);
      const prior = baselineSteps.get(step.id) ?? null;
      const context = { root, startedAt, book, page, step };
      const verificationChanged = !prior
        || verificationFingerprint(book, page, step) !== verificationFingerprint(baselineBook, baselinePage, prior);

      if (prior && !verificationChanged) {
        // Proof/provenance metadata is not an editorial field. A plan that did
        // not change the verification contract cannot promote, erase or point
        // it at a different spec merely by rewriting these side-band keys.
        for (const key of ["assertionSource", "spec"]) {
          if (stable(step[key]) === stable(prior[key])) continue;
          if (prior[key] === undefined) delete step[key];
          else step[key] = clone(prior[key]);
          pageChanged = true;
          needsAttention = true;
          provenanceRepairs += 1;
          warnings.push(warning(page.id, step.id, `planner changed ${key} without changing the verification contract; restored the pre-plan provenance`));
        }
        if (prior.planGuard?.status === "quarantined"
          && (stable(step.planGuard) !== stable(prior.planGuard) || step.enabled !== prior.enabled)) {
          step.planGuard = clone(prior.planGuard);
          step.enabled = prior.enabled;
          pageChanged = true;
          needsAttention = true;
          provenanceRepairs += 1;
          warnings.push(warning(page.id, step.id, "planner tried to re-enable an unchanged quarantined step; restored its pre-plan guard"));
        }
        if (prior.authoringObservation && step.authoringObservation === undefined) {
          step.authoringObservation = clone(prior.authoringObservation);
          pageChanged = true;
          needsAttention = true;
          provenanceRepairs += 1;
          warnings.push(warning(page.id, step.id, "planner removed provenance from an unchanged observation; restored the pre-plan attestation"));
        }
      }

      if (verificationChanged && step.assertion) {
        if (await exactAssertionWasObserved(step, context, evidence)) {
          // A spec names an earlier run-proven verification fingerprint. This
          // changed one is only plan-authored even when its exact assertion was
          // validated live, so the stale spec pointer must wait for a full run.
          if (step.spec !== undefined) {
            delete step.spec;
            pageChanged = true;
          }
          if (step.assertionSource !== "authored") {
            step.assertionSource = "authored";
            pageChanged = true;
          }
        } else {
          delete step.assertion;
          delete step.assertionSource;
          delete step.spec;
          step.mode = "vision";
          pageChanged = true;
          countDowngrade(page.id, step.id);
          needsAttention = true;
          warnings.push(warning(page.id, step.id, "deterministic assertion had no exact current passed explore receipt; downgraded to vision"));
        }
      } else if (verificationChanged && !step.assertion
        && (prior?.assertion || prior?.spec || step.assertionSource !== undefined || step.spec !== undefined)) {
        delete step.assertionSource;
        delete step.spec;
        step.mode = "vision";
        pageChanged = true;
        needsAttention = true;
        provenanceRepairs += 1;
        warnings.push(warning(page.id, step.id, "assertion was removed but stale proof metadata remained; cleared it and returned the check to vision"));
      }

      const empiricalMarkers = verificationChanged ? empiricalClaimMarkers(step.description) : [];
      // The structured field itself says "I observed a current failure" even
      // when the acceptance criterion is correctly timeless. Gate it as
      // evidence rather than forcing diagnostic prose into description just
      // to make provenance visible to this guard.
      const observationChanged = prior
        ? stable(step.authoringObservation) !== stable(prior.authoringObservation)
        : step.authoringObservation !== undefined;
      const hasEmpiricalEvidence = Boolean(step.authoringObservation) && (verificationChanged || observationChanged);
      if (empiricalMarkers.length || hasEmpiricalEvidence) {
        // Current findings never belong in the executable acceptance
        // criterion. Even a real receipt only proves what was observed under
        // its recorded conditions; it does not turn "standing defect" prose
        // into timeless product truth. The same receipt is accepted when the
        // description stays normative and provenance lives solely in the
        // structured authoringObservation field.
        const observation = empiricalMarkers.length
          ? {
              valid: false,
              reason: empiricalMarkers.some((marker) => marker.code === "unbounded-time")
                ? "observation-time-unbounded"
                : "observation-prose-not-acceptance-criterion"
            }
          : await validateAuthoringObservation(step, { ...context, step }, evidence, empiricalMarkers);
        if (!observation.valid) {
          needsAttention = true;
          if (prior) {
            step = clone(prior);
            // Restoring the prior step does not restore its surrounding page,
            // route, app URL, viewport defaults or state definition. If any of
            // those changed, its old proof/spec is no longer valid in the
            // current context and must fall back to vision.
            if (verificationFingerprint(book, page, step)
              !== verificationFingerprint(baselineBook, baselinePage, prior)) {
              const hadProof = Boolean(step.assertion || step.assertionSource || step.spec);
              delete step.assertion;
              delete step.assertionSource;
              delete step.spec;
              if (!step.judgment) step.mode = "vision";
              if (hadProof) countDowngrade(page.id, step.id);
            }
            restoredSteps += 1;
            warnings.push(warning(page.id, originalStep.id, `unsupported empirical authoring claim (${observation.reason}) was rejected; restored the pre-plan step`));
          } else {
            step.enabled = false;
            step.planGuard = { status: "quarantined", reason: observation.reason };
            quarantined += 1;
            warnings.push(warning(page.id, step.id, `empirical authoring claim was not supportable (${observation.reason}); quarantined`));
          }
          pageChanged = true;
        } else if (stable(step.authoringObservation) !== stable(observation.enriched)) {
          // Receipt ids are live-tab coordinates and die when exploration
          // closes. Persist only the safe attestation: time, route pair,
          // origins, action count, viewport, bounded quiet outcome, context
          // ages and network counts.
          step.authoringObservation = observation.enriched;
          pageChanged = true;
        }
      }

      nextSteps.push(step);
    }

    const nextStepIds = new Set((page.steps ?? []).map((step) => step.id));
    for (const priorStep of baselinePage?.steps ?? []) {
      if (nextStepIds.has(priorStep.id)) continue;
      warnings.push(warning(page.id, priorStep.id, "planner removed the pre-plan step; review the coverage deletion before running"));
      needsAttention = true;
      removedCoverage += 1;
      pageChanged = true;
    }

    if (pageChanged) {
      const savedPage = await savePage(page.id, { steps: nextSteps }, root);
      await reconcileExistingPageSpec(root, book, savedPage);
    }
  }

  return {
    warnings,
    needsAttention,
    quarantined,
    restoredSteps,
    downgradedAssertions,
    globalRulesRestored,
    globalRulesEvidenceRoutes,
    removedCoverage,
    provenanceRepairs,
    bookConfigRepairs,
    bookConfigReviews
  };
}
