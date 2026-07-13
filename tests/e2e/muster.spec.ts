import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// The Muster page (S5a): shell + header + readiness strip + Duties section.
// (a)-(b)-(e) drive the seeded DEFAULT composition (16 real duties). (c)-(d) drive
// a dedicated fixture composition with a SKILL cell + an agentic and a
// single-shot (garrison-call) target, so tap-to-place assignment and live
// validation can be exercised deterministically. COMPOSITIONS_DIR is the repo's
// compositions/ (cwd-relative), shared with the dev server, so the fixture is
// written there and removed afterAll.

const FIXTURE_ID = "muster-e2e-fixture";
const FIXTURE_DIR = path.join(process.cwd(), "compositions", FIXTURE_ID);

function writeFixture(): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const manifest = {
    name: FIXTURE_ID,
    version: "0.1.0",
    target: "claude",
    dependencies: { apm: [] },
    "x-garrison": {
      composition: {
        schema: 4,
        id: FIXTURE_ID,
        name: "Muster E2E Fixture",
        selections: {},
        duties: [
          {
            id: "develop",
            title: "Develop",
            description: "develop a change end to end",
            levels: [
              {
                description: "standard - a bounded feature or a focused change",
                cell: { skill: "garrison-implement", target: "cc-sonnet", effort: "medium" }
              }
            ]
          }
        ],
        selected_duties: ["develop"],
        targets: [
          { id: "cc-sonnet", runtime: "claude-code", model: "sonnet" },
          { id: "sdk-haiku", runtime: "agent-sdk", model: "haiku" },
          { id: "oneshot", runtime: "garrison-call", model: "none" }
        ],
        prompt_sources: {
          orchestrator: ".garrison/prompts/orchestrator.md",
          soul: ".garrison/prompts/soul.md"
        }
      }
    }
  };
  fs.writeFileSync(path.join(FIXTURE_DIR, "apm.yml"), yaml.dump(manifest), "utf8");
}

// Fresh fixture before every test so the tap-to-place tests never inherit a
// prior test's persisted cell edit.
test.beforeEach(() => writeFixture());
test.afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

test("(a) Muster renders the header, readiness strip, and duty rows", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/muster");
  await expect(page.getByTestId("muster-page")).toBeVisible();

  // Header: the single "Muster" kicker + the composition title + the switcher.
  await expect(page.getByText("Muster", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Switch composition")).toBeVisible();

  // Readiness strip (D10): a badge + the per-rule pills.
  await expect(page.getByTestId("readiness-badge")).toBeVisible();
  await expect(page.getByTestId("readiness-rules")).toBeVisible();
  await expect(page.getByTestId("rule-orchestrator")).toBeVisible();

  // At least one duty row from the seeded default composition.
  await expect(page.getByTestId("duty-list")).toBeVisible();
  await expect(page.locator('[data-testid^="duty-row-"]').first()).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
});

test("(b) a duty row expands to its per-duty levels", async ({ page }) => {
  await page.goto("/muster");
  const toggle = page.getByTestId("duty-toggle-code");
  await expect(toggle).toBeVisible();

  // Collapsed: levels are not shown.
  await expect(page.getByTestId("duty-levels-code")).toHaveCount(0);

  await toggle.click();
  const levels = page.getByTestId("duty-levels-code");
  await expect(levels).toBeVisible();
  // The default "code" duty has three levels, each a leaf cell with a target.
  await expect(page.getByTestId("cell-target-code-1")).toBeVisible();
  await expect(page.getByTestId("cell-target-code-2")).toBeVisible();
  await expect(page.getByTestId("cell-target-code-3")).toBeVisible();
});

test("(c) tap-to-pick assigns a target to a leaf cell (no drag)", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("duty-toggle-develop").click();

  const cell = page.getByTestId("cell-target-develop-1");
  await expect(cell).toHaveAttribute("data-target", "cc-sonnet");
  await expect(page.getByTestId("cell-violation-develop-1")).toHaveCount(0);

  // Tap the agentic target to ARM it, then tap the cell to PLACE it.
  await page.getByTestId("target-chip-sdk-haiku").click();
  await expect(page.getByTestId("target-chip-sdk-haiku")).toHaveAttribute("data-armed", "true");
  await cell.click();

  await expect(cell).toHaveAttribute("data-target", "sdk-haiku");
  // sdk-haiku is agentic, so the skill cell stays valid.
  await expect(page.getByTestId("cell-violation-develop-1")).toHaveCount(0);
});

test("(d) live validation flags a garrison-call target on a skill cell", async ({ page }) => {
  // Hold the persist request pending so the optimistic edit and its inline
  // validation stay on screen deterministically. This test is about the client's
  // instant feedback; the server-side rejection of an incompatible cell (it is
  // never persisted) is covered by the setCellTarget unit tests. Without this, the
  // reject round-trip reloads the model and clears both the violation and the
  // notice within the same tick, making any post-round-trip assertion racy.
  await page.route("**/api/muster/cell", () => {
    /* intentionally left pending: the optimistic edit stays visible */
  });

  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("duty-toggle-develop").click();

  const cell = page.getByTestId("cell-target-develop-1");

  // Arm the single-shot garrison-call target, wait for the armed state to settle
  // (mirrors test (c) — clicking the cell before arm registers is a no-op), then
  // place it on the skill cell.
  await page.getByTestId("target-chip-oneshot").click();
  await expect(page.getByTestId("target-chip-oneshot")).toHaveAttribute("data-armed", "true");
  await cell.click();

  // The non-agentic target on a skill cell is flagged inline and the offending
  // target shows on the cell — never silently accepted.
  const violation = page.getByTestId("cell-violation-develop-1");
  await expect(violation).toBeVisible();
  await expect(violation).toContainText(/agentic|single-shot/i);
  await expect(cell).toHaveAttribute("data-target", "oneshot");
});

test("(e) no horizontal overflow at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/muster");
  await expect(page.getByTestId("muster-page")).toBeVisible();

  // Expand a duty so the widest content (cells, targets tray) is on screen.
  await page.getByTestId("duty-toggle-code").click();
  await expect(page.getByTestId("duty-levels-code")).toBeVisible();

  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});
