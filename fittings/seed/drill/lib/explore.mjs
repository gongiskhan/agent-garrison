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
import { mkdir, writeFile, rm } from "node:fs/promises";
import {
  openTab, navigateTab, observeTab, executeAction, closeTab, readConsole, setViewport
} from "./browser-fitting-client.mjs";
import { automationsBaseUrl } from "./automations-client.mjs";
import { resolveViewport } from "./viewports.mjs";

// The same preset a default run executes at — exploration must see what the
// run will see.
const DEFAULT_EXPLORE_VIEWPORT = resolveViewport("desktop");

// A11y trees on a real app run to hundreds of nodes; the whole point of the
// screenshot is that the agent does not have to reconstruct the page from a
// list. Cap it, and drop the unnamed structural noise first.
const MAX_ELEMENTS = 120;
const MAX_CONSOLE = 25;

export function exploreDir() {
  const home = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
  return path.join(home, "drill", "explore");
}

// Live exploration tabs, keyed by the project root: one per plan session. Keyed
// by root (not global) so two projects explored at once never share a tab, in
// the same spirit as the authoring tab pool.
const tabs = new Map(); // root -> { tabId, shots }

export function exploreTabFor(root) {
  return tabs.get(root)?.tabId ?? null;
}

function compactElements(a11y) {
  const seen = new Set();
  const out = [];
  for (const node of a11y ?? []) {
    const role = String(node?.role ?? "").trim();
    const name = String(node?.name ?? "").trim();
    // An unnamed generic node tells the agent nothing it cannot see in the
    // screenshot, and there are hundreds of them.
    if (!name && !["textbox", "combobox", "checkbox", "radio"].includes(role)) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name ? { role, name } : { role });
    if (out.length >= MAX_ELEMENTS) break;
  }
  return out;
}

// Everything the agent needs to decide what is worth checking here: what the
// page IS (url/title/heading), what it can address (roles + names, the same
// vocabulary assertions and actions are written in), what it looks like (a PNG
// it reads with its own vision), and whether the page is complaining.
async function snapshot(root, tabId, { screenshot = true } = {}) {
  const observation = await observeTab(tabId, { screenshot });
  const entry = tabs.get(root);
  let shotPath = null;
  if (screenshot && observation.screenshotB64) {
    const dir = path.join(exploreDir(), path.basename(root));
    await mkdir(dir, { recursive: true });
    const n = entry ? ++entry.shots : 0;
    shotPath = path.join(dir, `explore-${String(n).padStart(4, "0")}.png`);
    await writeFile(shotPath, Buffer.from(observation.screenshotB64, "base64"));
  }
  let consoleErrors = [];
  try {
    const buffer = await readConsole(tabId, { limit: 200 });
    consoleErrors = (buffer.messages ?? buffer.entries ?? [])
      .filter((m) => (m?.type ?? m?.level) === "error")
      .slice(-MAX_CONSOLE)
      .map((m) => String(m.text ?? m.message ?? "").slice(0, 300));
  } catch { /* console buffer is a nicety, never a reason to fail exploration */ }
  return {
    tabId,
    url: observation.url ?? null,
    title: observation.title ?? null,
    heading: observation.headingText ?? null,
    viewport: observation.viewport ?? null,
    screenshot: shotPath,
    elements: compactElements(observation.a11y),
    elementsTruncated: (observation.a11y ?? []).length > MAX_ELEMENTS,
    consoleErrors
  };
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
    const tabId = await openTab(url, { viewport: vp });
    entry = { tabId, shots: 0 };
    tabs.set(root, entry);
  } else {
    await setViewport(entry.tabId, vp).catch(() => {});
    await navigateTab(entry.tabId, url);
  }
  return snapshot(root, entry.tabId);
}

// Perform one resolved action, then show the agent what it did. Returning the
// post-action page is the whole value: this is how the agent learns that a
// click opened a popover worth checking, and what is inside it.
export async function actExplore({ root, action }) {
  const entry = tabs.get(root);
  if (!entry) throw new Error("no exploration tab open for this project - call /api/explore/open first");
  await executeAction(entry.tabId, action);
  return snapshot(root, entry.tabId);
}

// Ask the AUTOMATIONS ENGINE whether this assertion holds right now. Going
// through the engine rather than evaluating here is the point (see the header):
// one evaluator, shared between blessing an assertion and judging it.
export async function assertExplore({ root, assertion, fetchImpl = globalThis.fetch }) {
  const entry = tabs.get(root);
  if (!entry) throw new Error("no exploration tab open for this project - call /api/explore/open first");
  const base = automationsBaseUrl();
  if (!base) throw new Error("automations engine not running - cannot validate an assertion");
  const res = await fetchImpl(`${base}/api/assert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tabId: entry.tabId, assertion })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `automations ${res.status}`);
  return { passed: !!body.passed, kind: body.kind ?? assertion?.kind ?? "text-contains" };
}

export async function closeExplore({ root, keepShots = false }) {
  const entry = tabs.get(root);
  if (!entry) return { closed: false };
  tabs.delete(root);
  await closeTab(entry.tabId).catch(() => { /* already gone */ });
  if (!keepShots) {
    await rm(path.join(exploreDir(), path.basename(root)), { recursive: true, force: true }).catch(() => {});
  }
  return { closed: true, shots: entry.shots };
}

// Server shutdown / plan cancel: never leave a driven tab behind.
export async function closeAllExplore() {
  const roots = [...tabs.keys()];
  await Promise.all(roots.map((root) => closeExplore({ root }).catch(() => {})));
  return roots.length;
}
