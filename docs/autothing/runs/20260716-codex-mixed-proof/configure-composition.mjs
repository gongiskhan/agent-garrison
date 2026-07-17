import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "http://127.0.0.1:27777";
const COMPOSITION_NAME = "Codex Mixed Proof 20260716";
const COMPOSITION_ID = "codex-mixed-proof-20260716";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VISION = path.join(HERE, "vision");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.setDefaultTimeout(60_000);
page.setDefaultNavigationTimeout(900_000);

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

async function shot(name, fullPage = true) {
  await page.screenshot({ path: path.join(VISION, name), fullPage });
}

async function waitForMuster(id) {
  await page.waitForSelector('[data-testid="muster-page"]');
  await page.waitForFunction(
    (expected) => document.querySelector('select[aria-label="Switch composition"]')?.value === expected,
    id,
    { timeout: 120_000 }
  );
}

async function clickAndRequirePost(locator, urlSuffix, timeout = 120_000) {
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes(urlSuffix),
    { timeout }
  );
  await locator.click();
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error(`${urlSuffix} returned ${response.status()}: ${await response.text()}`);
  }
  await response.finished();
  return response;
}

async function switchWithMusterSelect(id) {
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url().includes("/api/composition/switch"),
    { timeout: 900_000 }
  );
  const navigationPromise = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 900_000 })
    .then(() => true, () => false);
  await page.locator('select[aria-label="Switch composition"]').selectOption(id);
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error(`switch to ${id} returned ${response.status()}: ${await response.text()}`);
  }
  if (!(await navigationPromise)) throw new Error(`switch to ${id} returned success without remounting Muster`);
  await waitForMuster(id);
}

async function ensureTarget({ id, runtime, provider, model, promptMode = "", maxTurns = "" }) {
  const edit = page.locator(`[data-testid="edit-target-${id}"]`);
  if (await edit.count()) await edit.click();
  else await page.locator('[data-testid="add-target"]').click();
  await page.waitForSelector('[data-testid="target-editor"]');
  if (!(await edit.count())) await page.locator('[data-testid="target-id"]').fill(id);
  await page.locator('[data-testid="target-runtime"]').selectOption(runtime);
  await page.locator('[data-testid="target-provider"]').fill(provider);
  await page.locator('[data-testid="target-model"]').fill(model);
  await page.locator('[data-testid="target-prompt-mode"]').selectOption(promptMode);
  await page.locator('[data-testid="target-max-turns"]').fill(maxTurns);
  await clickAndRequirePost(page.locator('[data-testid="target-submit"]'), "/api/muster/target");
  await page.waitForSelector('[data-testid="target-editor"]', { state: "detached" });
}

async function expandDuty(id) {
  const toggle = page.locator(`[data-testid="duty-toggle-${id}"]`);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.waitForSelector(`[data-testid="duty-levels-${id}"]`);
}

async function assignCell(duty, level, target, effort) {
  const current = await fetchJson("/api/muster");
  const cell = current.duties?.[duty]?.levels?.[level - 1]?.cell;
  if (cell?.target === target && cell?.effort === effort) return;
  await expandDuty(duty);
  const chip = page.locator(`[data-testid="target-chip-${target}"]`);
  if ((await chip.getAttribute("data-armed")) !== "true") await chip.click();
  await clickAndRequirePost(
    page.locator(`[data-testid="cell-target-${duty}-${level}"]`),
    "/api/muster/cell"
  );
  await page.waitForFunction(
    ({ duty, level, target }) =>
      document.querySelector(`[data-testid="cell-target-${duty}-${level}"]`)?.getAttribute("data-target") === target,
    { duty, level, target }
  );
  await clickAndRequirePost(
    page.locator(`[data-testid="cell-effort-${duty}-${level}-${effort}"]`),
    "/api/muster/cell"
  );
  await page.waitForFunction(
    ({ duty, level, effort }) =>
      document.querySelector(`[data-testid="cell-effort-${duty}-${level}-${effort}"]`)?.getAttribute("aria-pressed") === "true",
    { duty, level, effort }
  );
}

async function fetchJson(url) {
  return page.evaluate(async (target) => {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`${target} -> ${response.status}`);
    return response.json();
  }, url);
}

try {
  await page.goto(`${APP}/muster`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="new-composition"]');
  const existingResponse = await fetchJson("/api/compositions");
  const existing = Array.isArray(existingResponse) ? existingResponse : existingResponse.compositions ?? [];
  if (!existing.some((composition) => composition.id === COMPOSITION_ID)) {
    const initialActive = await fetchJson("/api/composition/active");
    if (initialActive.id !== "default") await switchWithMusterSelect("default");
    await waitForMuster("default");
    await shot("00-default-muster.png");
    await page.locator('[data-testid="new-composition"]').click();
    await page.locator('[data-testid="new-composition-name"]').fill(COMPOSITION_NAME);
    const switchResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/api/composition/switch"),
      { timeout: 900_000 }
    );
    const navigation = page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 900_000 })
      .then(() => true, () => false);
    await page.locator('[data-testid="new-composition-submit"]').click();
    const response = await switchResponse;
    if (!response.ok()) throw new Error(`create switch returned ${response.status()}: ${await response.text()}`);
    if (!(await navigation)) throw new Error("composition creation returned success without remounting Muster");
  } else {
    const active = await fetchJson("/api/composition/active");
    if (active.id !== COMPOSITION_ID) await switchWithMusterSelect(COMPOSITION_ID);
  }
  await waitForMuster(COMPOSITION_ID);
  await shot("01-new-composition.png");

  await ensureTarget({
    id: "sdk-sonnet-full",
    runtime: "agent-sdk",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    promptMode: "full",
    maxTurns: "24"
  });
  await ensureTarget({
    id: "codex-sol-review",
    runtime: "codex",
    provider: "openai",
    model: "gpt-5.6-sol"
  });

  await assignCell("plan", 1, "sdk-sonnet-full", "medium");
  await assignCell("implement", 1, "fable", "high");
  await assignCell("review", 1, "codex-sol-review", "xhigh");
  await assignCell("test", 1, "cc-haiku", "low");
  await shot("02-leaf-runtime-cells.png");

  if (!(await page.locator('[data-testid="duty-row-develop"]').count())) {
    await page.locator('[data-testid="add-duty"]').click();
    await clickAndRequirePost(
      page.locator('[data-testid="add-duty-option-develop"]'),
      "/api/muster/duty"
    );
  }
  const currentModel = await fetchJson("/api/muster");
  for (const duty of currentModel.selectedDuties) {
    if (duty === "dispatch" || duty === "develop") continue;
    const remove = page.locator(`[data-testid="duty-remove-${duty}"]`);
    if (await remove.count()) {
      await clickAndRequirePost(remove, "/api/muster/duty");
      await page.waitForSelector(`[data-testid="duty-row-${duty}"]`, { state: "detached" });
    }
  }
  await shot("03-composite-duty.png");

  await page.locator('[data-testid="section-nav-fittings"]').click();
  await page.waitForSelector('[data-testid="standing-section"]');
  if (!(await page.locator('[data-testid="standing-fitting-garrison-call"]').count())) {
    await page.locator('[data-testid="standing-add-runtimes"]').click();
    await clickAndRequirePost(
      page.locator('[data-testid="standing-picker-item-garrison-call"]'),
      "/api/muster/standing/swap"
    );
  }

  const codexModel = page.locator('[data-testid="standing-config-runtimes-codex-runtime-model"]');
  if ((await codexModel.inputValue()) !== "gpt-5.6-sol") {
    const saved = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/api/muster/standing/config"),
      { timeout: 120_000 }
    );
    await codexModel.fill("gpt-5.6-sol");
    const response = await saved;
    if (!response.ok()) throw new Error(`codex model save returned ${response.status()}: ${await response.text()}`);
  }
  const primary = page.locator('[data-testid="standing-primary-codex-runtime"]');
  if (!(await primary.isDisabled())) {
    await clickAndRequirePost(primary, "/api/muster/standing/runtime");
  }
  await page.waitForFunction(
    () => document.querySelector('[data-testid="standing-primary-codex-runtime"]')?.hasAttribute("disabled")
  );

  for (const runtime of ["codex-runtime", "claude-code-runtime", "agent-sdk-runtime"]) {
    const response = await clickAndRequirePost(
      page.locator(`[data-testid="standing-test-${runtime}"]`),
      "/api/muster/standing/runtime"
    );
    const result = await response.json();
    if (result.ok !== true) throw new Error(`${runtime} readiness failed: ${JSON.stringify(result.checks ?? result)}`);
    await page.waitForSelector(`[data-testid="standing-test-result-${runtime}"]`);
  }
  await shot("04-codex-primary-and-runtimes.png");

  const configured = await fetchJson("/api/muster");
  const standing = await fetchJson("/api/muster/standing");
  const compact = {
    compositionId: configured.compositionId,
    selectedDuties: configured.selectedDuties,
    targets: configured.targets.filter((target) =>
      ["sdk-sonnet-full", "codex-sol-review", "fable", "cc-haiku", "dispatch-fast"].includes(target.id)
    ),
    leafCells: Object.fromEntries(
      ["plan", "implement", "review", "test"].map((duty) => [duty, configured.duties[duty]?.levels?.[0]?.cell])
    ),
    primaryRuntime: standing.primaryRuntime,
    codexConfig: standing.slots
      .find((slot) => slot.faculty === "runtimes")
      ?.fittings.find((fitting) => fitting.id === "codex-runtime")?.config,
    garrisonCallStationed: Boolean(
      standing.slots
        .find((slot) => slot.faculty === "runtimes")
        ?.fittings.some((fitting) => fitting.id === "garrison-call")
    )
  };
  const expectedCells = {
    plan: { target: "sdk-sonnet-full", effort: "medium" },
    implement: { target: "fable", effort: "high" },
    review: { target: "codex-sol-review", effort: "xhigh" },
    test: { target: "cc-haiku", effort: "low" }
  };
  const actualDutySet = [...compact.selectedDuties].sort();
  if (compact.compositionId !== COMPOSITION_ID) throw new Error(`configured wrong composition: ${compact.compositionId}`);
  if (JSON.stringify(actualDutySet) !== JSON.stringify(["develop", "dispatch"])) {
    throw new Error(`unexpected selected duties: ${JSON.stringify(compact.selectedDuties)}`);
  }
  if (JSON.stringify(compact.leafCells) !== JSON.stringify(expectedCells)) {
    throw new Error(`unexpected leaf cells: ${JSON.stringify(compact.leafCells)}`);
  }
  if (compact.primaryRuntime !== "codex-runtime") throw new Error(`unexpected primary: ${compact.primaryRuntime}`);
  if (compact.codexConfig?.model !== "gpt-5.6-sol") throw new Error(`unexpected Codex config: ${JSON.stringify(compact.codexConfig)}`);
  if (!compact.garrisonCallStationed) throw new Error("garrison-call was not stationed");
  const sdkTarget = compact.targets.find((target) => target.id === "sdk-sonnet-full");
  const codexTarget = compact.targets.find((target) => target.id === "codex-sol-review");
  if (
    sdkTarget?.runtime !== "agent-sdk" || sdkTarget.provider !== "anthropic" ||
    sdkTarget.model !== "claude-sonnet-4-6" || sdkTarget.params?.promptMode !== "full" ||
    sdkTarget.params?.maxTurns !== 24
  ) {
    throw new Error(`unexpected Agent SDK target: ${JSON.stringify(sdkTarget)}`);
  }
  if (codexTarget?.runtime !== "codex" || codexTarget.provider !== "openai" || codexTarget.model !== "gpt-5.6-sol") {
    throw new Error(`unexpected Codex review target: ${JSON.stringify(codexTarget)}`);
  }
  console.log(JSON.stringify({ stage: "configured", ...compact }, null, 2));

  await page.locator('[data-testid="section-nav-duties"]').click();
  await switchWithMusterSelect("default");
  await switchWithMusterSelect(COMPOSITION_ID);
  await shot("05-restarted-active-composition.png");

  const active = await fetchJson("/api/composition/active");
  if (active.id !== COMPOSITION_ID) throw new Error(`restart left ${active.id} active`);
  if (consoleErrors.length) throw new Error(`browser console errors: ${JSON.stringify(consoleErrors)}`);
  console.log(JSON.stringify({ stage: "restarted", active, consoleErrors }, null, 2));
} finally {
  await browser.close();
}
