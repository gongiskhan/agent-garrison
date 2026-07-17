// Spec emission (B8/B12/Q3): turn a page's graduated steps into a committed,
// re-runnable Playwright spec at tests/drills/<page>.spec.ts in the target
// app repo. Pure string generation — no I/O — so it's unit-testable without a
// browser or a filesystem. Deterministic-assertion steps emit REAL Playwright
// expect() calls (zero model calls when re-run); judgment steps emit a
// drillJudge() call (Q3) — those legitimately still call the Model Router.
//
// Loaded-machine waits (F9): every emitted test navigates with a 90s timeout
// and a best-effort networkidle wait — a batch failure that is a pure timeout
// should widen THIS wait, not be treated as a slice defect.

function locatorExpr(anchor) {
  if (anchor.testId) return `page.getByTestId(${JSON.stringify(anchor.testId)})`;
  if (anchor.selector) return `page.locator(${JSON.stringify(anchor.selector)})`;
  if (anchor.role && anchor.name) return `page.getByRole(${JSON.stringify(anchor.role)}, { name: ${JSON.stringify(anchor.name)} })`;
  if (anchor.label) return `page.getByLabel(${JSON.stringify(anchor.label)})`;
  if (anchor.placeholder) return `page.getByPlaceholder(${JSON.stringify(anchor.placeholder)})`;
  if (anchor.role) return `page.getByRole(${JSON.stringify(anchor.role)})`;
  if (anchor.text) return `page.getByText(${JSON.stringify(anchor.text)})`;
  throw new Error("assertion has no locator hint (testId/selector/role+name/label/placeholder/role/text)");
}

// Escape a plain string for safe use inside a RegExp constructed at runtime
// (url-matches' "contains" mode is implemented as an escaped-substring regex
// so it composes with Playwright's toHaveURL(RegExp) matcher either way).
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COUNT_MATCHERS = { gte: "toBeGreaterThanOrEqual", lte: "toBeLessThanOrEqual", gt: "toBeGreaterThan", lt: "toBeLessThan" };

export function emitAssertionCode(assertion) {
  const kind = assertion?.kind || "text-contains";
  if (kind === "text-contains") {
    return `await expect(page.locator("body")).toContainText(${JSON.stringify(assertion.text)});`;
  }
  if (kind === "url-matches") {
    const pattern = assertion.mode === "regex" ? assertion.pattern : escapeRegExp(assertion.pattern);
    return `await expect(page).toHaveURL(new RegExp(${JSON.stringify(pattern)}));`;
  }
  if (kind !== "visible" && kind !== "count" && kind !== "attribute-equals") {
    throw new Error(`cannot emit assertion kind: ${kind}`);
  }
  const loc = locatorExpr(assertion);
  if (kind === "visible") return `await expect(${loc}).toBeVisible();`;
  if (kind === "count") {
    const op = assertion.op ?? "eq";
    if (op === "eq") return `await expect(${loc}).toHaveCount(${Number(assertion.value)});`;
    const matcher = COUNT_MATCHERS[op];
    if (!matcher) throw new Error(`unknown count op: ${op}`);
    return `expect(await (${loc}).count()).${matcher}(${Number(assertion.value)});`;
  }
  return `await expect(${loc}).toHaveAttribute(${JSON.stringify(assertion.attribute)}, ${JSON.stringify(assertion.value)});`;
}

function emitTestBlock(step, targetUrl) {
  const body = step.judgment
    ? `    const ok = await drillJudge(page, ${JSON.stringify(step.description)});\n    expect(ok, ${JSON.stringify("drillJudge: " + step.description)}).toBe(true);`
    : `    ${emitAssertionCode(step.assertion)}`;
  return `  test(${JSON.stringify(`${step.id}: ${step.description}`)}, async ({ page }) => {
    // Loaded-machine wait (F9): a batch run shares the machine with other
    // parallel work — a pure timeout here should widen this wait, not be
    // treated as a step defect.
    await page.goto(${JSON.stringify(targetUrl)}, { timeout: 90000, waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 90000 }).catch(() => {});
${body}
  });`;
}

// Only steps with mode "e2e" AND (a graduated deterministic assertion OR the
// judgment flag) are emittable — an ungraduated vision step has nothing to
// emit yet.
export function emittableSteps(page) {
  return page.steps.filter((s) => s.mode === "e2e" && (s.assertion || s.judgment));
}

export function emitPageSpec(page, targetUrl) {
  const steps = emittableSteps(page);
  const needsJudge = steps.some((s) => s.judgment);
  const header = `// AUTO-EMITTED by Drill (B8) from a passing vision run. Hand-edit at your
// own risk — the next graduation of any step on this page rewrites this file.
import { test, expect } from "@playwright/test";
${needsJudge ? 'import { drillJudge } from "./support/drill-judge";\n' : ""}
test.describe(${JSON.stringify(page.title ?? page.id)}, () => {
`;
  const body = steps.map((s) => emitTestBlock(s, targetUrl)).join("\n\n");
  return `${header}${body}\n});\n`;
}
