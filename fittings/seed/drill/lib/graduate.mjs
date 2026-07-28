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

// `root` pins the repo the graduation writes into - a run resolves it ONCE at
// request start so a mid-run project switch can't land specs in another repo.
export async function graduateStep(book, pageId, stepId, plan, root = drillTargetRoot()) {
  const page = await getPage(pageId, root);
  if (!page) throw new Error(`page not found: ${pageId}`);
  const step = page.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`step not found: ${pageId}/${stepId}`);
  if (!plan || (!plan.assertion && !plan.judgment)) throw new Error("graduateStep requires an assertion or judgment=true");

  const updatedStep = {
    ...step,
    mode: "e2e",
    spec: `${specRelPath(pageId)}#${stepId}`,
    // Persist the resolved interactions alongside the assertion so the spec can
    // be re-emitted without another live run, and so a reader of the Book can
    // see what the check actually drives.
    ...(plan.actions?.length ? { actions: plan.actions } : {}),
    ...(plan.judgment ? { judgment: true, assertion: undefined } : { assertion: plan.assertion })
  };
  const nextSteps = page.steps.map((s) => (s.id === stepId ? updatedStep : s));
  const updatedPage = { ...page, steps: nextSteps };

  await ensureDrillJudgeAsset(root);
  const targetUrl = resolvePageUrl(book, updatedPage);
  const specSource = emitPageSpec(updatedPage, targetUrl);
  const specFile = path.join(root, specRelPath(pageId));
  await atomicWriteFile(specFile, specSource);

  const saved = await savePage(pageId, { steps: nextSteps }, root);
  return { step: saved.steps.find((s) => s.id === stepId), specFile };
}
