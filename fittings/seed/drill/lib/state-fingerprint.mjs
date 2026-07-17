// Cheap state-discrimination layer (C2, R11). Reuses the SAME observe() parts
// automations' fingerprint.mjs hashes (route/heading/shape-sketch/viewport),
// but keeps them RAW (not hashed) — R11's fingerprint pre-filter needs actual
// Jaccard shape similarity, which a SHA1 digest cannot provide. Kept local to
// Drill per house convention (no cross-fitting lib import path; mirrors
// automations/lib/fingerprint.mjs's shape, different purpose).

// Crude numeric-id normalization so /kb/entry/482 and /kb/entry/930 are the
// "same route pattern" (R11: "same route pattern plus equal heading hash").
export function routePattern(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/\d+(?=\/|$)/g, "/:id");
  } catch {
    return String(url ?? "");
  }
}

export function sameRouteAndHeading(a, b) {
  return routePattern(a?.url) === routePattern(b?.url) && (a?.headingText ?? "") === (b?.headingText ?? "");
}

// Parse a "tag:count,role:x:count" sketch string into a set of "key:count"
// tokens — each token is one element of the Jaccard set (R11: "Jaccard over
// tag and role counts").
function tokenize(shapeSketch) {
  return new Set(String(shapeSketch ?? "").split(",").filter(Boolean));
}

export function shapeSimilarity(sketchA, sketchB) {
  const a = tokenize(sketchA);
  const b = tokenize(sketchB);
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

export const SHAPE_THRESHOLD = 0.85;

// R11's fingerprint pre-filter: same route pattern + equal heading hash, OR
// DOM-shape Jaccard similarity >= 0.85.
export function fingerprintPreFilterMatch(candidate, reference, threshold = SHAPE_THRESHOLD) {
  if (sameRouteAndHeading(candidate, reference)) return true;
  return shapeSimilarity(candidate?.shapeSketch, reference?.shapeSketch) >= threshold;
}
