// apply-core.mjs — the Improver apply contract (BRIEF U3).
//
// Approved proposals are applied ONLY through the never-clobber authoring
// contract: capture the target's baselineSha at plan time; on apply, re-read and
// refuse (409 conflict) if the target changed since — then the caller re-reads +
// re-diffs against the NEW baseline and retries. On a clean apply, run
// reconcile("post-authoring") (injected so it can be the real reconcile scoped to
// tmp dirs, or the hosted-API trigger). Mirrors src/lib/claude-md.ts's sha +
// baselineSha → 409 semantics so the Improver speaks the same authoring contract.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export function shaOf(content) {
  return `sha256:${createHash("sha256").update(content ?? "").digest("hex")}`;
}

// The single source of truth for what "applied" looks like on disk - any
// caller that needs to detect whether a proposal's marked block survived
// (e.g. the reapply sweep) must use this, not re-derive the literal.
export function markerFor(proposalId) {
  return `<!-- improver:${proposalId} -->`;
}

export async function readTarget(targetFile) {
  let content = "";
  try {
    content = await readFile(targetFile, "utf8");
  } catch {
    content = ""; // a not-yet-existing target reads as empty (sha of "")
  }
  return { content, sha: shaOf(content) };
}

// Build the post-apply content for a proposal: append a marked block derived
// from the proposal diff's "+" lines. Idempotent — re-applying the same proposal
// id is a no-op (the marker is already present).
export function buildNewContent(baseContent, proposal) {
  const marker = markerFor(proposal.id);
  if (baseContent.includes(marker)) return baseContent;
  const additions = String(proposal.diff || "")
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .map((l) => l.replace(/^\+\s?/, ""))
    .join("\n");
  const header = `\n\n${marker}\n## ${proposal.rule}: ${proposal.claim ?? ""}`.trimEnd();
  return `${baseContent}${header}\n${additions}\n`;
}

// Materialize an apply plan against the CURRENT target (captures baselineSha).
export async function planApply({ proposal, targetFile }) {
  const cur = await readTarget(targetFile);
  const newContent = buildNewContent(cur.content, proposal);
  return { proposalId: proposal.id, targetFile, baselineSha: cur.sha, newContent, changed: newContent !== cur.content };
}

// Apply with the never-clobber baselineSha guard; reconcile on success.
export async function applyPlan({ plan, reconcileFn }) {
  const cur = await readTarget(plan.targetFile);
  if (cur.sha !== plan.baselineSha) {
    return { ok: false, code: "conflict", current: cur, expected: plan.baselineSha };
  }
  await writeFile(plan.targetFile, plan.newContent, "utf8");
  let reconciled = null;
  if (reconcileFn) {
    try {
      reconciled = (await reconcileFn("post-authoring")) ?? true;
    } catch (err) {
      reconciled = { error: String(err?.message || err) };
    }
  }
  return {
    ok: true,
    sha: shaOf(plan.newContent),
    reconciled,
    evidence: { targetFile: plan.targetFile, bytes: plan.newContent.length, sha: shaOf(plan.newContent) },
  };
}

// Approve = plan → apply; on a 409 conflict, re-read + re-diff against the NEW
// baseline and apply once more (the conflict handler the brief requires).
// `beforeApply(attempt)` is an optional hook fired after planning, before the
// first write — instrumentation, and the seam a test uses to simulate a
// concurrent writer landing between plan and apply.
export async function applyWithRetry({ proposal, targetFile, reconcileFn, beforeApply }) {
  let plan = await planApply({ proposal, targetFile });
  if (beforeApply) await beforeApply(0);
  let res = await applyPlan({ plan, reconcileFn });
  if (!res.ok && res.code === "conflict") {
    plan = await planApply({ proposal, targetFile }); // re-read + re-diff
    res = await applyPlan({ plan, reconcileFn });
    res.recoveredFromConflict = true;
  }
  return res;
}
