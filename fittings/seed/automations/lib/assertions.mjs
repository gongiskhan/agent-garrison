// Deterministic assertion vocabulary (engine delta 5, ships to Ekoa per F6).
// Pure kind-routing + comparison logic, unit-testable without a browser: the
// I/O (fetching an observation, or asking the Browser fitting to resolve a
// locator-based probe) lives in browser-client.mjs / the engine's default
// executeAssertion. Widening this list graduates more vision steps to e2e
// (B12) without touching the fixer's step-type fence.

export const ASSERTION_KINDS = ["text-contains", "count", "visible", "url-matches", "attribute-equals"];

export function isAssertionKind(kind) {
  return ASSERTION_KINDS.includes(kind);
}

// count/visible/attribute-equals need a live Playwright locator, which only the
// Browser fitting (holder of the Page) can resolve — POST /tabs/:id/assert.
export function needsRemoteProbe(kind) {
  return kind === "count" || kind === "visible" || kind === "attribute-equals";
}

export function compareCount(actual, op = "eq", value) {
  const n = Number(value);
  switch (op) {
    case "eq": return actual === n;
    case "gte": return actual >= n;
    case "lte": return actual <= n;
    case "gt": return actual > n;
    case "lt": return actual < n;
    default: throw new Error(`unknown count op: ${op}`);
  }
}

// text-contains: case-insensitive substring over title + heading + a11y names
// (the original, sole assertion kind — unchanged for backward compatibility).
export function evaluateTextContains(assertion, observation) {
  const text = (assertion?.text ?? "").toLowerCase();
  if (!text) return false;
  const hay = `${observation?.title ?? ""} ${observation?.headingText ?? ""} ${(observation?.a11y ?? []).map((n) => n.name).join(" ")}`.toLowerCase();
  return hay.includes(text);
}

export function evaluateUrlMatches(assertion, observation) {
  const url = observation?.url ?? "";
  if (!assertion?.pattern) return false;
  if (assertion.mode === "regex") return new RegExp(assertion.pattern).test(url);
  return url.includes(assertion.pattern);
}
