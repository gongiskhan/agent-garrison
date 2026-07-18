import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// The Muster Standing Fittings section (S5b): slot cards for the standing
// (non-duty) faculty slots, each with its current fitting(s), config form, a
// swap picker, health, and — for the runtimes slot — the create-runtime flow.
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
            { id: "agent-sdk-runtime", config: {} }
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
          orchestrator: ".garrison/prompts/orchestrator.md",
          soul: ".garrison/prompts/soul.md"
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

  // The eight standing slot cards are present, and stationed fittings show.
  await expect(page.getByTestId("standing-slot-gateway")).toBeVisible();
  await expect(page.getByTestId("standing-slot-runtimes")).toBeVisible();
  await expect(page.getByTestId("standing-slot-channels")).toBeVisible();
  await expect(page.getByTestId("standing-fitting-http-gateway")).toBeVisible();
  await expect(page.getByTestId("standing-fitting-agent-sdk-runtime")).toBeVisible();

  // The runtimes slot exposes the create-runtime entry point.
  await expect(page.getByTestId("standing-new-runtime")).toBeVisible();

  expect(appErrors(errors)).toEqual([]);
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
  await page.getByTestId("section-nav-fittings").click();
  await page.getByTestId("standing-new-runtime").click();

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

test("the primary control writes the composition routing policy", async ({ page }) => {
  await page.goto(`/muster?composition=${FIXTURE_ID}`);
  await page.getByTestId("section-nav-fittings").click();
  const primary = page.getByTestId("standing-primary-agent-sdk-runtime");
  await expect(primary).toHaveText(/make primary/i);
  await primary.click();
  await expect(primary).toHaveText(/primary runtime/i);

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
