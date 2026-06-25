// Runtime-feature UI verification (S1/S4/S5) against the running app.
// Lives in the repo tree so `import 'playwright'` resolves the project node_modules.
import { chromium } from "playwright";

const URL = process.env.GARRISON_URL ?? "http://127.0.0.1:7777";
const SHOT = process.env.SHOT_DIR ?? "/tmp";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const results = [];

function check(name, cond) {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
}

try {
  // S5 — primary_runtime selector in the Orchestrator global config.
  await page.goto(`${URL}/compose/orchestrator`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT}/garrison-orchestrator-full.png`, fullPage: true });
  const primaryLabel = await page.locator("label", { hasText: "primary_runtime" }).count();
  check("S5: primary_runtime label present on /compose/orchestrator", primaryLabel > 0);
  const defaultOpt = await page
    .locator("option", { hasText: "Default — Claude Code runtime" })
    .count();
  check("S5: primary_runtime select offers the Default — Claude Code option", defaultOpt > 0);

  // S4 — runtimes in the essential "Every agent needs these" group on the grid.
  await page.goto(`${URL}/compose`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT}/garrison-compose-full.png`, fullPage: true });
  const bodyText = await page.locator("body").innerText();
  // NOTE: a concurrent session (f45c7c61) reworked the grid to group by Agent/Dev
  // *tier* (the old essential "Every agent needs these" heading is gone). The S4
  // deliverable is the data flag `essential: true` (asserted by the unit test
  // tests/runtimes-essential.test.ts); here we assert the faculty surfaces in the
  // (now tier-grouped) Compose grid. The grid groups by tier, where runtimes is
  // currently Dev-tier per f45c7c61.
  const tierHeadings = await page.locator("h2", { hasText: /faculties/i }).count();
  const runtimesIdx = bodyText.search(/\bRuntimes\b/i);
  check("S4: tier-grouped grid renders (Agent/Dev faculties sections)", tierHeadings >= 1);
  check("S4: Runtimes faculty is listed in the Compose grid", runtimesIdx >= 0);

  // S1 — the Claude Code runtime fitting is selectable under the Runtimes faculty.
  await page.goto(`${URL}/compose/runtimes`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT}/garrison-runtimes-full.png`, fullPage: true });
  const runtimesBody = await page.locator("body").innerText();
  check("S1: 'Claude Code runtime' fitting appears on /compose/runtimes", /claude code runtime/i.test(runtimesBody));
  check("S1: a provider option (anthropic-plan/ollama/deepseek/zai) is offered", /anthropic-plan|ollama-local|deepseek|zai-glm/i.test(runtimesBody));
  // The full runtime peer set is selectable (Codex pw-test r1 caught agent-sdk missing).
  check("S1: the Agent SDK runtime peer is also listed", /agent sdk runtime/i.test(runtimesBody));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error("verify error:", err.message);
  process.exit(2);
} finally {
  await browser.close();
}
