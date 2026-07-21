// Graduation (B8/B12/Q3): flip a step's mode to "e2e" and (re-)emit its
// page's committed Playwright spec. Idempotent — re-graduating (the healer
// path, B7: a stale graduated assertion falls back to vision, heals, and
// this re-emits with the fresh assertion) just overwrites the step + the
// whole page spec file.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPage, savePage, drillTargetRoot } from "./store.mjs";
import { emitPageSpec } from "./spec-emit.mjs";
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

// Given a step's run outcome, decide whether (and how) to graduate it.
// - step.judgment === true (author-marked, B9): graduates to a drillJudge()
//   call regardless of any deterministic assertion the model produced — the
//   author already decided this needs ongoing judgment, not a one-time find.
// - otherwise: graduates using outcome.assertion (the model-discovered
//   deterministic assertion, delta 5's richer kinds) when present.
// Returns null when there is nothing to graduate (no assertion, not a
// judgment step, or the outcome wasn't a vision/recovered pass).
export function graduationPlanFor(step, outcome) {
  if (!outcome || outcome.status !== "completed") return null;
  if (outcome.tier !== "vision" && outcome.tier !== "recovered") return null;
  if (step.judgment === true) return { judgment: true };
  if (outcome.result?.assertion) return { assertion: outcome.result.assertion };
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
