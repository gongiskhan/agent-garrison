// Graduation (B8/B12/Q3): flip a step's mode to "e2e" and (re-)emit its
// page's committed Playwright spec. Idempotent — re-graduating (the healer
// path, B7: a stale graduated assertion falls back to vision, heals, and
// this re-emits with the fresh assertion) just overwrites the step + the
// whole page spec file.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPage, savePage, drillTargetRoot } from "./store.mjs";
import { emitPageSpec, isEmittableAction } from "./spec-emit.mjs";
import { normalizeStepActions } from "./compile.mjs";
import { resolvePageUrl } from "./compile.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function atomicWriteFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, file);
}

export function specRelPath(pageId) {
  return path.join("tests", "drills", `${pageId}.spec.ts`);
}

async function ensureDrillJudgeAsset(root = drillTargetRoot()) {
  const src = path.join(HERE, "..", "assets", "drill-judge.ts");
  const dest = path.join(root, "tests", "drills", "support", "drill-judge.ts");
  const content = await fs.readFile(src, "utf8");
  await atomicWriteFile(dest, content);
  return dest;
}

// Pair each of a check's AUTHORED actions with the concrete action the engine
// actually resolved for it, harvested from the automation run record.
//
// The engine persists the resolved action on every tier at
// `record.steps[i].result.action` (browser-orchestrator returns it for cached,
// vision and recovered alike), which is what lets an interaction be committed
// as real Playwright instead of re-resolved by a model on every future run.
//
// Matching walks the record and takes the LAST record per step id: a run may
// carry more than one entry for an id, and the one that produced the final
// verdict is the last. Returns null unless EVERY authored action resolved to
// something emittable — a partially-resolved interaction must not graduate,
// since the emitted spec would perform only some of the steps it claims to.
export function harvestResolvedActions(step, automationRun) {
  const authored = normalizeStepActions(step);
  if (!authored.length) return [];
  if (!automationRun) return null;
  const byId = new Map();
  for (const rec of automationRun.steps ?? []) {
    if (rec?.type !== "browser" || rec.status !== "completed") continue;
    if (!rec.result?.action) continue;
    byId.set(rec.stepId, rec.result.action); // last wins
  }
  const out = [];
  for (const a of authored) {
    const resolved = byId.get(a.id);
    if (!resolved || !isEmittableAction(resolved)) return null;
    out.push({ id: a.id, description: a.description, resolved });
  }
  return out;
}

// Given a step's run outcome, decide whether (and how) to graduate it.
// - step.judgment === true (author-marked, B9): graduates to a drillJudge()
//   call regardless of any deterministic assertion the model produced — the
//   author already decided this needs ongoing judgment, not a one-time find.
// - otherwise: graduates using outcome.assertion (the model-discovered
//   deterministic assertion, delta 5's richer kinds) when present.
// Returns null when there is nothing to graduate (no assertion, not a
// judgment step, or the outcome wasn't a vision/recovered pass).
export function graduationPlanFor(step, outcome, automationRun) {
  if (!outcome || outcome.status !== "completed") return null;
  if (outcome.tier !== "vision" && outcome.tier !== "recovered") return null;
  // Honesty gate (S6): a verdict the model reached WITHOUT being able to
  // observe the outcome must never become a committed spec. Graduating it is
  // how one unprovable pass turns into a permanent, deterministic lie.
  if (outcome.result?.requiresInteraction === true) return null;
  // A check with authored interactions only graduates once all of them
  // resolved; otherwise the emitted spec would assert a post-interaction state
  // it never produced.
  const actions = harvestResolvedActions(step, automationRun);
  if (actions === null) return null;
  // Omit the key entirely for the overwhelmingly common no-interaction check,
  // so a plan stays byte-identical to what it was before actions existed.
  const withActions = actions.length ? { actions } : {};
  if (step.judgment === true) return { judgment: true, ...withActions };
  if (outcome.result?.assertion) return { assertion: outcome.result.assertion, ...withActions };
  return null;
}

// Decide whether a check's INTERACTIONS need (re-)pinning, independently of
// its verdict. Graduation only fires on a vision/recovered pass that produced
// an assertion, which leaves two large populations permanently unpinned:
// checks that graduated before they had interactions at all, and checks whose
// verify now answers from its pinned assertion (tier "cached") and so never
// re-enters graduation. Both would re-resolve every interaction through vision
// on every run, forever. This is the separate, idempotent path for that — it
// moves pins and nothing else, so it is safe on an already-graduated step.
//
// Returns null when there is nothing to write: no authored interactions, a
// partial resolution (same all-or-nothing rule graduation uses — a half-pinned
// check would drive some interactions deterministically and vision-resolve the
// rest against a page the pinned ones already moved), or pins that already
// match what this run resolved.
export function actionPinFor(step, automationRun) {
  const harvested = harvestResolvedActions(step, automationRun);
  if (!harvested?.length) return null;
  const current = Array.isArray(step.actions) ? step.actions : [];
  const same = harvested.every((a, i) => {
    const prev = current[i];
    return prev && typeof prev === "object" && JSON.stringify(prev.resolved ?? null) === JSON.stringify(a.resolved);
  });
  return same ? null : harvested;
}

// Write a step patch back to its page and re-emit the page's committed spec.
// Emission is unconditional because emitPageSpec renders the WHOLE page from
// its currently-emittable steps — pinning actions can itself make a step
// emittable, and a page with none emits an empty describe block, which is the
// honest rendering of "nothing on this page has graduated yet".
async function writeStepUpdate(book, pageId, stepId, patch, root) {
  const page = await getPage(pageId, root);
  if (!page) throw new Error(`page not found: ${pageId}`);
  const step = page.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`step not found: ${pageId}/${stepId}`);

  const nextSteps = page.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
  const updatedPage = { ...page, steps: nextSteps };

  await ensureDrillJudgeAsset(root);
  const specSource = emitPageSpec(updatedPage, resolvePageUrl(book, updatedPage));
  const specFile = path.join(root, specRelPath(pageId));
  await atomicWriteFile(specFile, specSource);

  const saved = await savePage(pageId, { steps: nextSteps }, root);
  return { step: saved.steps.find((s) => s.id === stepId), specFile };
}

// `root` pins the repo the graduation writes into - a run resolves it ONCE at
// request start so a mid-run project switch can't land specs in another repo.
export async function graduateStep(book, pageId, stepId, plan, root = drillTargetRoot()) {
  if (!plan || (!plan.assertion && !plan.judgment)) throw new Error("graduateStep requires an assertion or judgment=true");
  return writeStepUpdate(book, pageId, stepId, {
    mode: "e2e",
    spec: `${specRelPath(pageId)}#${stepId}`,
    // Persist the resolved interactions alongside the assertion so the spec can
    // be re-emitted without another live run, so a reader of the Book can see
    // what the check actually drives, and so the next run replays them
    // deterministically instead of re-resolving them (compile.mjs cachedAction).
    ...(plan.actions?.length ? { actions: plan.actions } : {}),
    ...(plan.judgment ? { judgment: true, assertion: undefined } : { assertion: plan.assertion })
  }, root);
}

// Pin (or re-pin) a check's interactions without touching its verdict.
export async function pinStepActions(book, pageId, stepId, actions, root = drillTargetRoot()) {
  if (!actions?.length) throw new Error("pinStepActions requires at least one resolved action");
  return writeStepUpdate(book, pageId, stepId, { actions }, root);
}
