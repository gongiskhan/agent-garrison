// Page fingerprint — the cache key for a browser step's resolved action. Ported
// from ekoa's fingerprint.ts. A fingerprint discriminates SPA content (title +
// first-heading hash separate /doc/A from /doc/B) while staying stable across
// A/B layout variants (the DOM-shape hash is tag/role/landmark COUNTS only — no
// text, no attributes). The browser fitting supplies the raw parts; fingerprint
// computation is host-side + pure so it is deterministically testable.

import { createHash } from "node:crypto";

function sha1(input) {
  return createHash("sha1").update(input).digest("hex");
}

export function fingerprintFromParts(parts) {
  let parsed;
  try {
    parsed = new URL(parts.url);
  } catch {
    parsed = new URL("about:blank");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const pathSuffix = segments.length > 0 ? segments[segments.length - 1] : "";
  return {
    origin: parsed.origin,
    pathname: parsed.pathname,
    pathSuffix,
    titleHash: sha1((parts.title ?? "").toLowerCase().trim()),
    headingHash: sha1((parts.headingText ?? "").toLowerCase().trim()),
    domShapeHash: sha1(parts.shapeSketch ?? ""),
    viewport: parts.viewport ?? { w: 0, h: 0 }
  };
}

export function fingerprintKey(fp) {
  return [
    fp.origin,
    fp.pathname,
    fp.pathSuffix,
    fp.titleHash,
    fp.headingHash,
    fp.domShapeHash,
    `${fp.viewport.w}x${fp.viewport.h}`
  ].join("|");
}

// Build the DOM-shape sketch (counts only) from an a11y/role tally, so two pages
// with the same structure but different content fingerprint identically.
export function shapeSketchFromCounts(counts) {
  return Object.entries(counts || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}
