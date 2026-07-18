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
