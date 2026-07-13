import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// The Muster Orchestrator + Decisions panels (S5c, D11/D12). Driven by a dedicated
// fixture composition so the layered prompt has deterministic content and the
// decisions feed has seeded records. COMPOSITIONS_DIR is the repo's compositions/
// (cwd-relative), shared with the dev server; the fixture + its .garrison log are
// written there and removed afterAll.

const FIXTURE_ID = "muster-orch-e2e-fixture";
const FIXTURE_DIR = path.join(process.cwd(), "compositions", FIXTURE_ID);

function writeFixture(): void {
  fs.mkdirSync(path.join(FIXTURE_DIR, ".garrison"), { recursive: true });
  const manifest = {
    name: FIXTURE_ID,
    version: "0.1.0",
    target: "claude",
    dependencies: { apm: [] },
    "x-garrison": {
      composition: {
        schema: 4,
        id: FIXTURE_ID,
        name: "Muster Orchestrator E2E Fixture",
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
        targets: [{ id: "cc-sonnet", runtime: "claude-code", model: "sonnet" }],
        prompt_sources: {
          orchestrator: ".garrison/prompts/orchestrator.md",
          soul: ".garrison/prompts/soul.md"
        }
      }
    }
  };
  fs.writeFileSync(path.join(FIXTURE_DIR, "apm.yml"), yaml.dump(manifest), "utf8");

  // Seed the decisions log the panel reads (dispatcher + a routed record).
  const decisions = [
    { kind: "dispatch", at: "2026-07-13T09:00:00.000Z", messageDigest: "aa11", duty: "develop", level: 1, confidence: "high", reason: "→ develop L1, confidence high" },
    { at: "2026-07-13T09:05:00.000Z", promptDigest: "bb22", taskType: "code", tier: "expert", role: "runtimes", targetId: "cc-sonnet", runtime: "claude-code", model: "sonnet" }
  ];
  fs.writeFileSync(
    path.join(FIXTURE_DIR, ".garrison", "decisions.jsonl"),
    decisions.map((d) => JSON.stringify(d)).join("\n") + "\n",
    "utf8"
  );
}

// Drop any leftover authored override between tests so the autosave test starts clean.
function clearAuthored(): void {
  fs.rmSync(path.join(FIXTURE_DIR, ".garrison", "orchestrator-authored.json"), { force: true });
}


// On mobile the Muster CollapsibleSections auto-collapse; expand every collapsed
// section so content assertions see the rendered body (S5c mobile-collapse, D12).
// The orchestrator panel loads content async from /api/orchestrator/preview, so
// WAIT for that load to settle (the loading skeleton detaches) before toggling —
// otherwise expandAll runs before the section + its toggle exist.
async function expandAll(page: import("@playwright/test").Page): Promise<void> {
  await page.getByTestId("orchestrator-panel").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.getByTestId("orchestrator-loading").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  for (let pass = 0; pass < 6; pass++) {
    const collapsed = page.locator('[data-testid$="-toggle"][aria-expanded="false"]');
    if ((await collapsed.count()) === 0) break;
    try { await collapsed.first().click({ timeout: 2000 }); } catch { break; }
  }
}

test.beforeEach(() => {
  writeFixture();
  clearAuthored();
});
test.afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

test("(a) orchestrator panel renders locked (greyed, non-editable) + authored + assembled", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await expandAll(page);
  await expect(page.getByTestId("orchestrator-panel")).toBeVisible();

  // A LOCKED block with its "regenerated from composition" badge, and NO edit control inside it.
  const locked = page.getByTestId("orchestrator-locked-readiness");
  await expect(locked).toBeVisible();
  await expect(page.getByTestId("orchestrator-locked-badge-readiness")).toBeVisible();
  await expect(locked.locator("textarea")).toHaveCount(0);

  // An AUTHORED section is an editable textarea.
  const authored = page.getByTestId("orchestrator-authored-routing-philosophy");
  await expect(authored).toBeVisible();
  await expect(authored).toBeEditable();

  // The assembled preview (locked + authored concatenated).
  const assembled = page.getByTestId("orchestrator-assembled");
  await expect(assembled).toBeVisible();
  await expect(assembled).toContainText("GARRISON-SECTION");
});

test("(b) editing an authored section autosaves and survives reload; locked stays put", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await expandAll(page);
  const authored = page.getByTestId("orchestrator-authored-routing-philosophy");
  await expect(authored).toBeVisible();

  const lockedBefore = (await page.getByTestId("orchestrator-locked-readiness").innerText()).trim();

  const custom = "E2E CUSTOM ROUTING DOCTRINE " + Date.now();
  await authored.fill(custom);
  // Debounced autosave (600ms) → the status flips to "saved".
  await expect(page.getByTestId("orchestrator-authored-status-routing-philosophy")).toHaveText(/saved/i, {
    timeout: 10_000
  });

  // Reload: the authored edit persisted, and the locked block is unchanged.
  await page.reload();
  await expandAll(page); // re-expand: reload re-collapses the section on mobile
  await expect(page.getByTestId("orchestrator-authored-routing-philosophy")).toHaveValue(custom);
  const lockedAfter = (await page.getByTestId("orchestrator-locked-readiness").innerText()).trim();
  expect(lockedAfter).toBe(lockedBefore);
});

test("(c) the decisions panel renders the evidence feed", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await expandAll(page);
  await expect(page.getByTestId("decisions-panel")).toBeVisible();

  const list = page.getByTestId("decisions-list");
  await expect(list).toBeVisible();
  // Newest first: the routed record leads, the dispatcher record follows.
  await expect(page.getByTestId("decision-row-0")).toContainText(/route/i);
  await expect(page.getByTestId("decision-row-1")).toContainText("develop");
});

test("(e) no horizontal overflow at 390px with both panels expanded", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await expandAll(page); // expands every collapsed section (orchestrator + decisions)
  await expect(page.getByTestId("muster-page")).toBeVisible();
  // Both panels are now expanded so the widest content (assembled prompt, decision
  // rows) is on screen for the overflow check.
  await expect(page.getByTestId("orchestrator-assembled")).toBeVisible();
  await expect(page.getByTestId("decisions-list")).toBeVisible();

  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});
