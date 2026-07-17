import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "http://127.0.0.1:27777";
const BOARD = "http://127.0.0.1:27089";
const COMPOSITION_ID = "codex-mixed-proof-20260716";
const CARD_ID = "01KXMWJ11Y5CC38F0NJ0K6SGT1";
const WORKSPACE = "/tmp/garrison-mixed-runtime-proof-20260716";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VISION = path.join(HERE, "vision");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(180_000);
page.setDefaultNavigationTimeout(900_000);

try {
  const before = await page.request.get(`${APP}/api/runner/${COMPOSITION_ID}/state`);
  if (!before.ok()) throw new Error(`runner state failed: ${before.status()}`);
  const beforePid = (await before.json()).state?.pid;

  await page.goto(APP, { waitUntil: "domcontentloaded" });
  const restart = page.getByRole("button", { name: "Restart Operative", exact: true }).first();
  await restart.waitFor();
  const upResponse = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url().includes(`/api/runner/${COMPOSITION_ID}/up`),
    { timeout: 900_000 }
  );
  await restart.click();
  const up = await upResponse;
  if (!up.ok()) throw new Error(`runner restart failed: ${up.status()} ${await up.text()}`);
  await up.finished();

  await page.waitForFunction(async ({ id, prior }) => {
    const response = await fetch(`/api/runner/${id}/state`, { cache: "no-store" });
    if (!response.ok) return false;
    const state = (await response.json()).state;
    return state?.status === "running" && state?.pid && state.pid !== prior;
  }, { id: COMPOSITION_ID, prior: beforePid }, { timeout: 900_000 });
  await page.screenshot({ path: path.join(VISION, "13-restarted-scope-evidence-fix.png"), fullPage: true });

  await page.goto(BOARD, { waitUntil: "domcontentloaded" });
  const title = "Implement a medium-sized JavaScript TTL cache package";
  const card = page.locator(".card").filter({ has: page.locator(".title", { hasText: title }) });
  await card.waitFor();
  await card.getByRole("button", { name: "Open", exact: true }).click();
  const scope = page.getByRole("textbox", { name: "Project or workspace scope" });
  await scope.waitFor();
  await scope.fill(WORKSPACE);
  const patchResponse = page.waitForResponse(
    (response) => response.request().method() === "PATCH" && response.url() === `${BOARD}/cards/${CARD_ID}`
  );
  await page.getByRole("button", { name: "Save scope", exact: true }).click();
  const patched = await patchResponse;
  if (!patched.ok()) throw new Error(`scope patch failed: ${patched.status()} ${await patched.text()}`);
  const patchedBody = await patched.json();
  if (patchedBody.card?.project !== WORKSPACE) {
    throw new Error(`scope did not persist: ${JSON.stringify(patchedBody)}`);
  }
  await page.screenshot({ path: path.join(VISION, "14-card-scope-repaired.png"), fullPage: true });

  console.log(JSON.stringify({
    action: "Restart Operative + repair parked card scope through Kanban UI",
    beforePid,
    afterPid: (await (await page.request.get(`${APP}/api/runner/${COMPOSITION_ID}/state`)).json()).state?.pid,
    cardId: CARD_ID,
    project: patchedBody.card.project,
    rev: patchedBody.card.rev
  }, null, 2));
} finally {
  await browser.close();
}
