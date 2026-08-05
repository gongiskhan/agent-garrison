// Plan-time exploration: the surface the planning agent drives to SEE the app
// before it writes a single check.
//
// The planning stage used to be a prompt with no eyes. It read the router, the
// components and the config, then authored a Book of plain-English criteria and
// no assertions at all — every one of which had to be discovered by RUNNING it,
// through a model, once per check per run. Two costs followed: the first real
// run was entirely vision, and a criterion invented from source rather than
// from the rendered page is frequently a criterion the page cannot answer
// (asserting a control that is only on another route, a behaviour with no
// interaction authored to cause it).
//
// So the planner drives the app itself. The plan agent IS the vision here: it
// navigates, observes (a11y tree + a screenshot it reads with its own eyes),
// clicks, and observes the result. Nothing in this module calls a model — a
// nested model call would just move the cost, and the agent already sees.
//
// The one thing exploration must not do is guess. A check the agent authors as
// deterministic carries an `assertion`, and that assertion is only allowed into
// the Book after `assertExplore` has evaluated it against the live page through
// the AUTOMATIONS ENGINE'S OWN evaluator — the same code that will judge it on
// every future run. Author-time blessing computed any other way would be a
// different question answered by different code, which is how a plan quietly
// fills up with assertions that were never true.

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import {
  openTab, navigateTab, observeTab, executeAction, closeTab, readConsole, readNetwork, setViewport
} from "./browser-fitting-client.mjs";
import { automationsBaseUrl } from "./automations-client.mjs";
import { resolveViewport } from "./viewports.mjs";
import {
  compactExploreElements, compactExploreNetwork, isCoherentExploreQuiet,
  safeExploreBrowserContext, safeExploreNetworkUrl, safeExplorePageUrl,
  safeExploreQuietMetadata, sanitizeExploreConsoleText
} from "./explore-evidence.mjs";

// The same preset a default run executes at — exploration must see what the
// run will see.
const DEFAULT_EXPLORE_VIEWPORT = resolveViewport("desktop");

const MAX_CONSOLE = 25;

export function exploreDir() {
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return path.join(home, "drill", "explore");
}

// Live exploration tabs, keyed by the project root: one per plan session. Keyed
// by root (not global) so two projects explored at once never share a tab, in
// the same spirit as the authoring tab pool.
const tabs = new Map(); // root -> { tabId, shots, networkSince, observationSeq, receipts }

export function exploreTabFor(root) {
  return tabs.get(root)?.tabId ?? null;
}

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptCopy(receipt) {
  return receipt ? jsonClone(receipt) : null;
}

function safeObservationSource(value) {
  const kind = ["open", "act", "observe", "assert"].includes(value?.kind) ? value.kind : "observe";
  const source = { source: kind };
  if (kind === "act") {
    const actionKind = String(value?.actionKind ?? "").trim().toLowerCase();
    if (/^[a-z][a-z0-9-]{0,31}$/.test(actionKind)) source.actionKind = actionKind;
  }
  return source;
}

function constraintPath(value) {
  try {
    const target = new URL(String(value), "http://drill.invalid");
    return safeExploreNetworkUrl(target, target);
  }
  catch { return String(value); }
}

function webOrigin(value) {
  try {
    const target = new URL(String(value));
    return ["http:", "https:", "ws:", "wss:"].includes(target.protocol) ? target.origin : null;
  } catch { return null; }
}

// Read-only in the important sense: callers receive defensive copies and can
// never mutate the live receipt store. A public close drops the Browser tab but
// retains these receipts until planner integrity has consumed them.
export function getExploreObservation(root, observationId) {
  return receiptCopy(tabs.get(root)?.receipts.get(String(observationId)) ?? null);
}

export function listExploreObservations(root) {
  const entry = tabs.get(root);
  return entry ? [...entry.receipts.values()].map(receiptCopy) : [];
}

function receiptMatchesConstraints(receipt, constraints) {
  // An older Browser can still let exploration proceed during a rolling
  // deploy, but its `unavailable` marker is not evidence strong enough to
  // bless a deterministic assertion.
  if (!isCoherentExploreQuiet(receipt?.quiet)) return false;
  if (receipt?.network?.summary?.historyKnown !== true) return false;
  if (receipt?.network?.summary?.historyTruncated !== false) return false;
  if (!constraints || typeof constraints !== "object") return true;
  if (constraints.since !== null && constraints.since !== undefined && constraints.since !== "") {
    const since = new Date(constraints.since).getTime();
    const observed = new Date(receipt.observedAt).getTime();
    if (!Number.isFinite(since) || !Number.isFinite(observed) || observed < since) return false;
  }
  if (constraints.url && receipt.url !== constraints.url) return false;
  const expectedOriginInput = constraints.appOrigin ?? constraints.origin ?? constraints.appUrl;
  if (expectedOriginInput !== null && expectedOriginInput !== undefined && expectedOriginInput !== "") {
    const expectedOrigin = webOrigin(expectedOriginInput);
    if (!expectedOrigin) return false;
    if (receipt.conditions?.requestedOrigin !== expectedOrigin) return false;
    if (receipt.conditions?.finalOrigin !== expectedOrigin) return false;
  }
  if (constraints.path && receipt.conditions?.requestedPath !== constraintPath(constraints.path)) return false;
  if (constraints.finalPath && receipt.conditions?.finalPath !== constraintPath(constraints.finalPath)) return false;
  const expectedActionCount = constraints.pristine === true ? 0 : constraints.actionsSinceOpen;
  if (expectedActionCount !== null && expectedActionCount !== undefined) {
    const expectedActions = Number(expectedActionCount);
    if (!Number.isSafeInteger(expectedActions) || expectedActions < 0) return false;
    if (receipt.conditions?.actionsSinceOpen !== expectedActions) return false;
  }
  if (constraints.viewport) {
    const actual = receipt.conditions?.viewport ?? {};
    if (typeof constraints.viewport === "string") {
      if (actual.id !== constraints.viewport) return false;
    } else if (typeof constraints.viewport === "object") {
      if (constraints.viewport.id && actual.id !== constraints.viewport.id) return false;
      const expectedWidth = Number(constraints.viewport.width ?? constraints.viewport.w);
      const expectedHeight = Number(constraints.viewport.height ?? constraints.viewport.h);
      if (Number.isFinite(expectedWidth) && actual.width !== expectedWidth) return false;
      if (Number.isFinite(expectedHeight) && actual.height !== expectedHeight) return false;
    }
  }
  return true;
}

export function hasPassedExploreAssertion(root, assertion, constraints = null) {
  const expected = canonicalJson(assertion);
  return listExploreObservations(root).some((receipt) =>
    receiptMatchesConstraints(receipt, constraints) &&
    (receipt.assertions ?? []).some((result) => result.passed === true && canonicalJson(result.assertion) === expected)
  );
}

function screenshotExtension(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  return ".img";
}

// Everything the agent needs to decide what is worth checking here: what the
// page IS (url/title/heading), what it can address (roles + names, the same
// vocabulary assertions and actions are written in), what it looks like (an image
// it reads with its own vision), and whether the page is complaining.
async function snapshot(root, tabId, { screenshot = true, source = { kind: "observe" } } = {}) {
  const entry = tabs.get(root);
  if (!entry || entry.tabId !== tabId) throw new Error("exploration tab is no longer active for this project");
  const observation = await observeTab(tabId, { screenshot, quiet: true });
  const [consoleResult, networkResult] = await Promise.allSettled([
    readConsole(tabId, { limit: 200, since: entry.networkSince }),
    readNetwork(tabId, { since: entry.networkSince })
  ]);
  const observedAtMs = Date.now();
  const observedAt = new Date(observedAtMs).toISOString();
  let shotPath = null;
  if (screenshot && observation.screenshotB64) {
    const dir = entry.screenshotDir;
    await mkdir(dir, { recursive: true });
    const n = ++entry.shots;
    const bytes = Buffer.from(observation.screenshotB64, "base64");
    shotPath = path.join(dir, `explore-${String(n).padStart(4, "0")}${screenshotExtension(bytes)}`);
    await writeFile(shotPath, bytes);
  }
  let consoleErrors = [];
  if (consoleResult.status === "fulfilled") {
    const buffer = consoleResult.value;
    consoleErrors = (buffer.messages ?? buffer.entries ?? [])
      .filter((m) => (m?.type ?? m?.level) === "error")
      .slice(-MAX_CONSOLE)
      .map((m) => sanitizeExploreConsoleText(m.text ?? m.message ?? ""));
  }
  const network = compactExploreNetwork(
    networkResult.status === "fulfilled"
      ? (networkResult.value.entries ?? networkResult.value.network ?? [])
      : [],
    { pageUrl: observation.url, since: entry.networkSince, now: observedAtMs }
  );
  if (networkResult.status === "fulfilled") {
    const historyKnown = typeof networkResult.value.historyTruncated === "boolean";
    network.summary.historyKnown = historyKnown;
    if (historyKnown) network.summary.historyTruncated = networkResult.value.historyTruncated;
    const dropped = Number(networkResult.value.historyDroppedCount);
    if (Number.isFinite(dropped) && dropped >= 0) network.summary.historyDroppedCount = Math.round(dropped);
  } else {
    network.summary.historyKnown = false;
    network.summary.unavailable = true;
  }
  const compactedElements = compactExploreElements(observation.a11y);
  const observationId = `observation-${entry.sessionPrefix}-${String(++entry.observationSeq).padStart(4, "0")}`;
  const quiet = safeExploreQuietMetadata(observation.quiet);
  const browserContext = safeExploreBrowserContext(observation.browserContext);
  const stabilityToken = typeof observation.stabilityToken === "string"
    && /^stability-v1-[a-f0-9]{32}$/.test(observation.stabilityToken)
    ? observation.stabilityToken
    : null;
  const observationSource = safeObservationSource(source);
  const rawObservationUrl = observation.url ?? null;
  const pageUrl = rawObservationUrl ? safeExplorePageUrl(rawObservationUrl) : null;
  const result = {
    tabId,
    observationId,
    observedAt,
    url: pageUrl,
    title: observation.title ?? null,
    heading: observation.headingText ?? null,
    viewport: observation.viewport ?? null,
    screenshot: shotPath,
    elements: compactedElements.elements,
    elementsTruncated: compactedElements.truncated,
    consoleErrors,
    quiet,
    network,
    browserContext,
    actionsSinceOpen: entry.actionsSinceOpen,
    source: observationSource.source,
    ...(observationSource.actionKind ? { actionKind: observationSource.actionKind } : {})
  };
  const actualViewport = observation.viewport ?? null;
  const conditionViewport = {
    ...(entry.viewport?.id ? { id: entry.viewport.id } : {}),
    ...(Number.isFinite(Number(actualViewport?.w)) ? { width: Number(actualViewport.w) } : {}),
    ...(Number.isFinite(Number(actualViewport?.h)) ? { height: Number(actualViewport.h) } : {})
  };
  const requestedPath = entry.requestedUrl
    ? safeExploreNetworkUrl(entry.requestedUrl, entry.requestedUrl)
    : null;
  const finalPath = rawObservationUrl ? safeExploreNetworkUrl(rawObservationUrl, rawObservationUrl) : null;
  const requestedOrigin = webOrigin(entry.requestedUrl);
  const finalOrigin = webOrigin(rawObservationUrl);
  entry.receipts.set(observationId, {
    observationId,
    root,
    observedAt,
    tabId,
    url: pageUrl,
    viewport: jsonClone(result.viewport),
    screenshot: shotPath,
    quiet: jsonClone(quiet),
    network: jsonClone(network),
    browserContext: jsonClone(browserContext),
    stabilityToken,
    conditions: {
      // `path` remains an alias for the requested route for tolerant older
      // integrity readers. Redirect checks need both halves: `/` was requested
      // and `/chat` was honestly observed.
      path: requestedPath,
      requestedPath,
      finalPath,
      requestedOrigin,
      finalOrigin,
      viewport: conditionViewport,
      actionsSinceOpen: entry.actionsSinceOpen,
      quietOutcome: quiet.outcome ?? "unknown",
      browserContext: jsonClone(browserContext),
      source: observationSource.source,
      ...(observationSource.actionKind ? { actionKind: observationSource.actionKind } : {}),
      evidenceWindowStartedAt: new Date(entry.networkSince).toISOString()
    },
    assertions: []
  });
  return result;
}

// Open (or reuse) the exploration tab and go to `url`.
//
// A viewport is ALWAYS emulated, defaulting to the same desktop size a run
// uses. Left unset, the tab inherits the headless window (observed: 780x493) -
// a size no run ever executes at and no user ever has, so the agent would plan
// against a cramped layout, mistake a below-the-fold control for a missing one,
// and author checks that fail the moment a real run opens the page properly.
export async function openExplore({ root, url, viewport = null }) {
  const vp = viewport ?? DEFAULT_EXPLORE_VIEWPORT;
  let entry = tabs.get(root);
  if (!entry) {
    const networkSince = Date.now();
    const tabId = await openTab(url, { viewport: vp });
    const sessionPrefix = randomUUID().replaceAll("-", "").slice(0, 12);
    entry = {
      tabId, shots: 0, networkSince, viewport: vp, requestedUrl: url,
      sessionPrefix,
      screenshotDir: path.join(exploreDir(), path.basename(root), sessionPrefix),
      observationSeq: 0, receipts: new Map(), actionsSinceOpen: 0
    };
    tabs.set(root, entry);
  } else if (!entry.tabId) {
    // The public close route releases the live Browser tab but retains this
    // plan session's proof. A later open starts a fresh tab and evidence window
    // without throwing earlier assertion receipts away.
    const networkSince = Date.now();
    const tabId = await openTab(url, { viewport: vp });
    entry.tabId = tabId;
    entry.networkSince = networkSince;
    entry.viewport = vp;
    entry.requestedUrl = url;
    entry.actionsSinceOpen = 0;
  } else {
    await setViewport(entry.tabId, vp).catch(() => {});
    // Pin immediately before navigation. Actions and explicit observations keep
    // this same baseline until the next /explore/open replaces it.
    entry.networkSince = Date.now();
    entry.viewport = vp;
    entry.requestedUrl = url;
    entry.actionsSinceOpen = 0;
    await navigateTab(entry.tabId, url);
  }
  return snapshot(root, entry.tabId, { source: { kind: "open" } });
}

// Perform one resolved action, then show the agent what it did. Returning the
// post-action page is the whole value: this is how the agent learns that a
// click opened a popover worth checking, and what is inside it.
export async function actExplore({ root, action }) {
  const entry = tabs.get(root);
  if (!entry?.tabId) throw new Error("no exploration tab open for this project - call /api/explore/open first");
  await executeAction(entry.tabId, action);
  entry.actionsSinceOpen += 1;
  return snapshot(root, entry.tabId, {
    source: { kind: "act", actionKind: action?.kind }
  });
}

// Re-observe the current page without changing it. This replaces the planner's
// former no-op hover/sleep loops with an explicit, receipted browser snapshot.
export async function observeExplore({ root }) {
  const entry = tabs.get(root);
  if (!entry?.tabId) throw new Error("no exploration tab open for this project - call /api/explore/open first");
  return snapshot(root, entry.tabId, { source: { kind: "observe" } });
}

// Ask the AUTOMATIONS ENGINE whether this assertion holds right now. Going
// through the engine rather than evaluating here is the point (see the header):
// one evaluator, shared between blessing an assertion and judging it.
export async function assertExplore({ root, assertion, fetchImpl = globalThis.fetch }) {
  const entry = tabs.get(root);
  if (!entry?.tabId) throw new Error("no exploration tab open for this project - call /api/explore/open first");
  const base = automationsBaseUrl();
  if (!base) throw new Error("automations engine not running - cannot validate an assertion");
  // All assertion kinds now begin from one bounded mechanical state. The
  // Automations evaluator still owns the verdict; this observation is the
  // evidence receipt that proves what was on the adopted tab immediately
  // before it answered.
  const evidence = await snapshot(root, entry.tabId, {
    screenshot: false,
    source: { kind: "assert" }
  });
  const res = await fetchImpl(`${base}/api/assert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId: entry.tabId, assertion })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `automations ${res.status}`);
  const passed = !!body.passed;
  const kind = body.kind ?? assertion?.kind ?? "text-contains";
  const receipt = entry.receipts.get(evidence.observationId);
  const postAssertion = await observeTab(entry.tabId, { screenshot: false, quiet: true });
  const postToken = typeof postAssertion?.stabilityToken === "string" ? postAssertion.stabilityToken : null;
  if (!receipt?.stabilityToken || !isCoherentExploreQuiet(postAssertion?.quiet)
    || postToken !== receipt.stabilityToken) {
    throw new Error("page changed while the assertion was evaluated; no assertion receipt was recorded - re-open or re-observe the route and retry");
  }
  if (receipt) {
    receipt.assertions.push({
      assertion: jsonClone(assertion),
      passed,
      kind,
      assertedAt: new Date().toISOString()
    });
  }
  return {
    passed,
    kind,
    observationId: evidence.observationId,
    observedAt: evidence.observedAt,
    quiet: evidence.quiet,
    network: evidence.network,
    browserContext: evidence.browserContext,
    source: evidence.source,
    ...(evidence.actionKind ? { actionKind: evidence.actionKind } : {})
  };
}

export async function closeExplore({ root, keepShots = false, retainEvidence = false }) {
  const entry = tabs.get(root);
  if (!entry) return { closed: false };
  const tabId = entry.tabId;
  // Detach before the Browser DELETE yields. Planner finalization is allowed to
  // be fire-and-forget; an immediate next plan must never adopt the closing tab
  // or have this old cleanup delete its new receipt store.
  entry.tabId = null;
  if (!retainEvidence) tabs.delete(root);
  if (tabId) await closeTab(tabId).catch(() => { /* already gone */ });
  if (retainEvidence) {
    return {
      closed: !!tabId,
      retainedEvidence: true,
      shots: entry.shots,
      observations: entry.receipts.size
    };
  }
  if (!keepShots) {
    await rm(entry.screenshotDir, { recursive: true, force: true }).catch(() => {});
  }
  return { closed: !!tabId, retainedEvidence: false, shots: entry.shots };
}

// Server shutdown / plan cancel: never leave a driven tab behind.
export async function closeAllExplore() {
  const roots = [...tabs.keys()];
  await Promise.all(roots.map((root) => closeExplore({ root }).catch(() => {})));
  return roots.length;
}
