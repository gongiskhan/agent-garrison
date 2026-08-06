import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// The Muster Standing Fittings section (S5b): slot cards for the standing
// (non-duty) faculty slots, each with its current fitting(s), config form, a
// swap picker, and health. Runtimes are NOT on this tab: they have their own
// first-class Muster tab (RuntimesPanel — featured primary card, secondary
// grid, set-primary/create/swap/test flows), covered below.
// A dedicated fixture composition seeds real, registered fittings so the slots
// have content and the swap picker has faculty-scoped candidates. COMPOSITIONS_DIR
// is the repo's compositions/ (cwd-relative), shared with the dev server.

const FIXTURE_ID = "muster-standing-e2e";
const FIXTURE_DIR = path.join(process.cwd(), "compositions", FIXTURE_ID);

function writeFixture(): void {
  fs.rmSync(path.join(FIXTURE_DIR, ".garrison"), { recursive: true, force: true });
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
        name: "Muster Standing E2E",
        selections: {
          gateway: [{ id: "http-gateway", config: { port: 24777, bind_host: "127.0.0.1" } }],
          channels: [{ id: "web-channel-default", config: { port: 27083 } }],
          runtimes: [
            { id: "claude-code-runtime", config: {} },
            { id: "agent-sdk-runtime", config: {} },
            // garrison-call sits in the runtimes slot but provides no engine —
            // it must render as a "support" card with no Set-as-primary/Test.
            { id: "garrison-call", config: {} }
          ]
        },
        duties: ["plan", "implement", "review", "test"].map((id) => ({
          id,
          title: id[0].toUpperCase() + id.slice(1),
          description: `${id} a change`,
          levels: [{ description: "standard", cell: { effort: "medium" } }]
        })),
        selected_duties: [],
        targets: [],
        prompt_sources: {
          orchestrator: ".garrison/prompts/orchestrator.md"
        }
      }
    }
  };
  fs.writeFileSync(path.join(FIXTURE_DIR, "apm.yml"), yaml.dump(manifest), "utf8");
}

test.beforeEach(() => writeFixture());
test.afterAll(() => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !/favicon|React DevTools|hydrat|Fast Refresh|\[HMR\]/i.test(e));
}

test("(a) the Standing Fittings section renders slot cards with the current fittings", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-fittings").click();
  // The section renders after a client fetch to /api/muster/standing; on a fresh
  // dev server that route compiles lazily on first hit, so allow for the compile.
  await expect(page.getByTestId("standing-section")).toBeVisible({ timeout: 15000 });

  // The standing slot cards are present, and stationed fittings show.
  await expect(page.getByTestId("standing-slot-gateway")).toBeVisible();
  await expect(page.getByTestId("standing-slot-channels")).toBeVisible();
  await expect(page.getByTestId("standing-fitting-http-gateway")).toBeVisible();

  // Runtimes are NOT rendered here — they live on their own Muster tab.
  await expect(page.getByTestId("standing-slot-runtimes")).toHaveCount(0);
  await expect(page.getByTestId("standing-fitting-agent-sdk-runtime")).toHaveCount(0);
  await expect(page.getByTestId("standing-new-runtime")).toHaveCount(0);

  expect(appErrors(errors)).toEqual([]);
});

test("the Runtimes tab features the primary card and a secondary grid", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-runtimes").click();
  await expect(page.getByTestId("runtimes-panel")).toBeVisible({ timeout: 15000 });

  // No policy file in the fixture → the default primary (claude-code-runtime)
  // is the featured card, wearing the primary badge; the other runtime sits in
  // the secondary grid with a Set-as-primary action.
  await expect(page.getByTestId("rt-primary-claude-code-runtime")).toBeVisible();
  await expect(page.getByTestId("rt-primary-badge-claude-code-runtime")).toBeVisible();
  await expect(page.getByTestId("rt-set-primary-agent-sdk-runtime")).toBeVisible();

  // Spec chips summarise config without unfolding the form (claude-code-runtime
  // carries provider/model defaults).
  await expect(page.getByTestId("rt-specs-claude-code-runtime")).toBeVisible();

  // garrison-call is stationed under runtimes but provides no engine: it renders
  // as a "support" card and is NOT offered Set-as-primary or Test.
  await expect(page.getByTestId("rt-support-garrison-call")).toBeVisible();
  await expect(page.getByTestId("rt-set-primary-garrison-call")).toHaveCount(0);
  await expect(page.getByTestId("rt-test-garrison-call")).toHaveCount(0);

  // Config folds by default on runtime cards; add/create entry points show.
  await expect(page.getByTestId("rt-cfg-toggle-claude-code-runtime")).toBeVisible();
  await expect(page.getByTestId("runtimes-add-fitting")).toBeVisible();
  await expect(page.getByTestId("runtimes-new-runtime")).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
});

test("a runtime card text-config edit autosaves to the manifest (debounced)", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-runtimes").click();
  await expect(page.getByTestId("rt-primary-claude-code-runtime")).toBeVisible({ timeout: 15000 });

  // Unfold the primary runtime's config and edit its base_url (a debounced text
  // field — the code path that previously dropped edits on tab-away).
  await page.getByTestId("rt-cfg-toggle-claude-code-runtime").click();
  const urlField = page.getByTestId("standing-config-runtimes-claude-code-runtime-base_url");
  await expect(urlField).toBeVisible();
  await urlField.fill("http://127.0.0.1:11434");

  // Debounced autosave (no Save button) lands in the composition manifest.
  await expect(async () => {
    const manifest = yaml.load(fs.readFileSync(path.join(FIXTURE_DIR, "apm.yml"), "utf8")) as {
      "x-garrison": { composition: { selections: { runtimes: Array<{ id: string; config?: Record<string, unknown> }> } } };
    };
    const cc = manifest["x-garrison"].composition.selections.runtimes.find((r) => r.id === "claude-code-runtime");
    expect(cc?.config?.base_url).toBe("http://127.0.0.1:11434");
  }).toPass({ timeout: 10000 });
});

test("Test runs a runtime connection check and renders the result", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-runtimes").click();
  await expect(page.getByTestId("rt-primary-claude-code-runtime")).toBeVisible({ timeout: 15000 });

  await page.getByTestId("rt-test-claude-code-runtime").click();
  const result = page.getByTestId("rt-test-result-claude-code-runtime");
  await expect(result).toBeVisible({ timeout: 15000 });
  // At least one check row rendered inside the result (accessible status region).
  await expect(result).toHaveAttribute("role", "status");
  await expect(result.locator("div").first()).toBeVisible();
});

test("Remove drops a secondary runtime and persists", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-runtimes").click();
  await expect(page.getByTestId("rt-set-primary-agent-sdk-runtime")).toBeVisible({ timeout: 15000 });

  await page.getByTestId("rt-remove-agent-sdk-runtime").click();

  // The card disappears and the removal is durable across a reload.
  await expect(page.getByTestId("rt-set-primary-agent-sdk-runtime")).toHaveCount(0);
  await page.reload();
  await page.getByTestId("section-nav-runtimes").click();
  await expect(page.getByTestId("rt-primary-claude-code-runtime")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("rt-set-primary-agent-sdk-runtime")).toHaveCount(0);

  const manifest = yaml.load(fs.readFileSync(path.join(FIXTURE_DIR, "apm.yml"), "utf8")) as {
    "x-garrison": { composition: { selections: { runtimes: Array<{ id: string }> } } };
  };
  expect(manifest["x-garrison"].composition.selections.runtimes.map((r) => r.id)).not.toContain("agent-sdk-runtime");
});

test("(b) the swap picker opens and lists faculty-scoped candidates", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-fittings").click();
  await expect(page.getByTestId("standing-fitting-http-gateway")).toBeVisible();

  await page.getByTestId("standing-swap-gateway-http-gateway").click();

  const modal = page.getByTestId("standing-swap-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("standing-picker-search")).toBeVisible();
  // The picker is scoped to the gateway faculty — mcp-gateway is a candidate.
  await expect(page.getByTestId("standing-picker-item-mcp-gateway")).toBeVisible();
});

test("(c) picking a candidate swaps the fitting and persists", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-fittings").click();
  await page.getByTestId("standing-swap-gateway-http-gateway").click();
  await page.getByTestId("standing-picker-item-mcp-gateway").click();

  // Modal closes, the slot now shows the swapped-in fitting.
  await expect(page.getByTestId("standing-swap-modal")).toHaveCount(0);
  await expect(page.getByTestId("standing-fitting-mcp-gateway")).toBeVisible();
  await expect(page.getByTestId("standing-fitting-http-gateway")).toHaveCount(0);

  // The swap is durable across a reload (persisted to the manifest). A reload lands
  // on the default (Duties) tab, so re-open the Fittings section before asserting.
  await page.reload();
  await page.getByTestId("section-nav-fittings").click();
  await expect(page.getByTestId("standing-fitting-mcp-gateway")).toBeVisible();
});

test("(d) the create-runtime flow opens a clone-from-template picker", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-runtimes").click();
  await page.getByTestId("runtimes-new-runtime").click();

  const modal = page.getByTestId("standing-create-modal");
  await expect(modal).toBeVisible();
  // Runtime templates are listed (agent-sdk-runtime is a clonable runtime).
  await expect(page.getByTestId("standing-template-agent-sdk-runtime")).toBeVisible();
});

test("(f) config folds by default and the fitting files editor opens", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-fittings").click();
  await expect(page.getByTestId("standing-fitting-http-gateway")).toBeVisible();

  // Config is FOLDED by default: the toggle shows, the form fields do not.
  await expect(page.getByTestId("standing-config-toggle-http-gateway")).toBeVisible();
  await expect(page.getByTestId("standing-config-gateway-http-gateway-port")).toHaveCount(0);
  await page.getByTestId("standing-config-toggle-http-gateway").click();
  await expect(page.getByTestId("standing-config-gateway-http-gateway-port")).toBeVisible();

  // Edit files opens the shell's Monaco editor on the fitting's directory.
  await page.getByTestId("standing-edit-http-gateway").click();
  const editor = page.getByRole("dialog", { name: /edit files/i });
  await expect(editor).toBeVisible();
  await expect(editor.getByText("apm.yml")).toBeVisible({ timeout: 15000 });
});

test("Set as primary promotes the runtime and writes the routing policy", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-runtimes").click();
  await expect(page.getByTestId("rt-primary-claude-code-runtime")).toBeVisible();

  await page.getByTestId("rt-set-primary-agent-sdk-runtime").click();

  // The promoted runtime becomes the featured primary card (badge and all);
  // the former primary drops into the secondary grid with its own promote action.
  await expect(page.getByTestId("rt-primary-agent-sdk-runtime")).toBeVisible();
  await expect(page.getByTestId("rt-primary-badge-agent-sdk-runtime")).toBeVisible();
  await expect(page.getByTestId("rt-set-primary-claude-code-runtime")).toBeVisible();

  const policy = JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, ".garrison", "routing.json"), "utf8")
  ) as { primaryRuntime?: string };
  expect(policy.primaryRuntime).toBe("agent-sdk-runtime");
});

test("Add duty can station an unstationed composite duty fitting", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("add-duty").click();
  const option = page.getByTestId("add-duty-option-develop");
  await expect(option).toContainText("stations duty-develop");
  await option.click();

  await expect(page.getByTestId("duty-row-develop")).toBeVisible();
  await page.getByTestId("duty-toggle-develop").click();
  await expect(page.getByTestId("duty-levels-develop")).toContainText(/plan/i);

  const manifest = fs.readFileSync(path.join(FIXTURE_DIR, "apm.yml"), "utf8");
  expect(manifest).toContain("duty-develop");
});

test("Targets tray creates a full-harness Agent SDK target", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("add-target").click();
  await expect(page.getByTestId("target-editor")).toBeVisible();
  await page.getByTestId("target-id").fill("sdk-haiku-full");
  await page.getByTestId("target-runtime").selectOption("agent-sdk");
  await page.getByTestId("target-provider").fill("anthropic");
  await page.getByTestId("target-model").fill("claude-haiku-4-5");
  await page.getByTestId("target-prompt-mode").selectOption("full");
  await page.getByTestId("target-max-turns").fill("8");
  await page.getByTestId("target-submit").click();

  await expect(page.getByTestId("target-editor")).toHaveCount(0);
  await expect(page.getByTestId("target-chip-sdk-haiku-full")).toBeVisible();
  const manifest = yaml.load(fs.readFileSync(path.join(FIXTURE_DIR, "apm.yml"), "utf8")) as {
    "x-garrison": { composition: { targets: Array<{ id: string; params?: Record<string, unknown> }> } };
  };
  expect(manifest["x-garrison"].composition.targets).toContainEqual(
    expect.objectContaining({ id: "sdk-haiku-full", params: { promptMode: "full", maxTurns: 8 } })
  );
});

test("(e) no horizontal overflow at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-fittings").click();
  await expect(page.getByTestId("standing-section")).toBeVisible();

  // Open the swap picker (the widest surface) before measuring.
  await page.getByTestId("standing-swap-gateway-http-gateway").click();
  await expect(page.getByTestId("standing-swap-modal")).toBeVisible();

  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});

test("(e2) the Runtimes tab has no horizontal overflow at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-runtimes").click();
  await expect(page.getByTestId("runtimes-panel")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("rt-primary-claude-code-runtime")).toBeVisible();

  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
});
