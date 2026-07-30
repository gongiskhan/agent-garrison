// Promote a snapshot to a named state (C4): its screenshot becomes an
// authoring surface, its observe() parts become the fingerprint pre-filter
// reference. State metadata lives in the page's repo YAML; the screenshot
// file stays machine-local (Q8), re-capturable via the reach path.

import { getPage, savePage } from "./store.mjs";
import { getSnapshot } from "./snapshots.mjs";

export function slugifyStateId(label) {
  return String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "state";
}

export function assessAutomaticStateReference(outcome) {
  if (!outcome?.evidencePath) {
    return { eligible: false, reason: "no-evidence", warnings: [] };
  }
  // Honesty gate (S6): a verdict the model could not actually observe must not
  // become a state's reference screenshot or seed its matcher assertion —
  // that would promote an unverified page into the Book as ground truth.
  if (outcome?.result?.requiresInteraction === true) {
    return { eligible: false, reason: "requires-interaction", warnings: [] };
  }
  const warnings = Array.isArray(outcome?.result?.referenceWarnings)
    ? outcome.result.referenceWarnings
        .filter((warning) => warning && typeof warning === "object")
        .map((warning) => ({
          code: String(warning.code || "visible-page-error"),
          text: String(warning.text || "Unexpected error visible in the captured page")
        }))
    : [];
  if (warnings.length) {
    return { eligible: false, reason: "unexpected-page-error", warnings };
  }
  return { eligible: true, reason: null, warnings: [] };
}

// Promote a run screenshot to a named state — the operator pressed "Save as
// state" on evidence the run already captured. A human decision, so it does
// not pass the automatic honesty gate above (same precedent as verdict
// overrides: the operator saw the image and vouched for it). Root-aware:
// a run pinned to another project must write into THAT repo's page YAML,
// never the actively selected one.
//
// No fingerprint: run evidence carries no observe() parts (run-seeded states
// ship fingerprint-less too; matchByFingerprint guards on `s.fingerprint`).
export async function createStateFromRunEvidence(
  pageId,
  { label, screenshotPath, assertion = null, reachPath = [], referenceSource = null } = {},
  root = undefined
) {
  const page = await getPage(pageId, root);
  if (!page) throw new Error(`page not found: ${pageId}`);
  if (!screenshotPath) throw new Error("screenshotPath required");
  const id = slugifyStateId(label);
  // A slug collision is "retake this state's reference", not "author a new
  // state": merge over the existing entry so a planner-authored reachPath,
  // matcher assertion, or fingerprint is never silently wiped by a label the
  // operator happened to type (same never-silently-rewrite principle as the
  // automatic seeding path).
  const existing = (page.states ?? []).find((s) => s.id === id) ?? null;
  const state = {
    ...(existing ?? {}),
    id,
    label: label || existing?.label || id,
    matcher: existing?.matcher ?? { assertion },
    reachPath: existing?.reachPath ?? reachPath,
    screenshotPath,
    ...(referenceSource ? { referenceSource } : {})
  };
  const states = (page.states ?? []).filter((s) => s.id !== id);
  states.push(state);
  const saved = await savePage(pageId, { states }, root);
  return saved.states.find((s) => s.id === id);
}

export async function promoteSnapshotToState(pageId, snapshotId, { label, reachPath = [] } = {}) {
  const page = await getPage(pageId);
  if (!page) throw new Error(`page not found: ${pageId}`);
  const snapshot = await getSnapshot(pageId, snapshotId);
  if (!snapshot) throw new Error(`snapshot not found: ${snapshotId}`);

  const id = slugifyStateId(label || snapshot.headingText || snapshot.title);
  const state = {
    id,
    label: label || id,
    fingerprint: { url: snapshot.url, headingText: snapshot.headingText, shapeSketch: snapshot.shapeSketch },
    matcher: { assertion: null },
    reachPath,
    screenshotPath: snapshot.screenshotPath
  };
  const states = (page.states ?? []).filter((s) => s.id !== id);
  states.push(state);
  const saved = await savePage(pageId, { states });
  return saved.states.find((s) => s.id === id);
}
