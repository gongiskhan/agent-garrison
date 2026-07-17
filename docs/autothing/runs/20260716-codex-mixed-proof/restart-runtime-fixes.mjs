import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = "http://127.0.0.1:27777";
const BOARD = "http://127.0.0.1:27089";
const GATEWAY = "http://127.0.0.1:24777";
const COMPOSITION_ID = "codex-mixed-proof-20260716";
const CARD_ID = "01KXMWJ11Y5CC38F0NJ0K6SGT1";
const TITLE = "Implement a medium-sized JavaScript TTL cache package";
const EXPECTED_LIST = process.argv[2] || "review";
const EXPECTED_STATUS = EXPECTED_LIST === "needs-attention" ? "needs-attention" : "ok";
const STAGE = process.argv[3] || "";
const shots = STAGE === "freshness"
  ? {
      operative: "29-gate-freshness-operative-restarted.png",
      kanban: "30-gate-freshness-kanban-restarted.png",
      card: "31-integrity-park-preserved.png"
    }
  : EXPECTED_LIST === "test"
  ? {
      operative: "22-test-migration-operative-restarted.png",
      kanban: "23-test-migration-kanban-restarted.png",
      card: "24-test-ready-after-migration.png"
    }
  : EXPECTED_LIST === "done"
    ? {
        operative: "24-terminal-invariant-operative-restarted.png",
        kanban: "25-terminal-invariant-kanban-restarted.png",
        card: "26-done-safe-before-rerun.png"
      }
  : {
      operative: "18-runtime-fixes-operative-restarted.png",
      kanban: "19-runtime-fixes-kanban-restarted.png",
      card: "20-review-retry-ready.png"
    };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VISION = path.join(HERE, "vision");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(180_000);
page.setDefaultNavigationTimeout(900_000);

try {
  const runnerBeforeResponse = await page.request.get(`${APP}/api/runner/${COMPOSITION_ID}/state`);
  if (!runnerBeforeResponse.ok()) throw new Error(`runner state failed: ${runnerBeforeResponse.status()}`);
  const runnerBefore = await runnerBeforeResponse.json();
  const operativeBeforePid = runnerBefore.state?.pid;
  const boardInitial = await (await page.request.get(`${BOARD}/health`)).json();

  // Restarting the operative through the product UI runs the normal install,
  // setup, verify, policy projection, and gateway launch path.
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  const restartOperative = page.getByRole("button", { name: "Restart Operative", exact: true }).first();
  await restartOperative.waitFor();
  const upResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url().includes(`/api/runner/${COMPOSITION_ID}/up`),
    { timeout: 900_000 }
  );
  await restartOperative.click();
  const upResponse = await upResponsePromise;
  if (!upResponse.ok()) throw new Error(`operative restart failed: ${upResponse.status()} ${await upResponse.text()}`);
  await upResponse.finished();
  await page.waitForFunction(async ({ id, prior }) => {
    const response = await fetch(`/api/runner/${id}/state`, { cache: "no-store" });
    if (!response.ok) return false;
    const state = (await response.json()).state;
    return state?.status === "running" && state?.pid && state.pid !== prior;
  }, { id: COMPOSITION_ID, prior: operativeBeforePid }, { timeout: 900_000 });
  await page.waitForFunction(async (url) => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      return response.ok && (await response.json()).ok === true;
    } catch {
      return false;
    }
  }, `${GATEWAY}/health`, { timeout: 180_000 });
  await page.screenshot({ path: path.join(VISION, shots.operative), fullPage: true });

  // The eager Kanban process intentionally survives operative restarts, so
  // explicitly restart that fitting through its own UI to load the new engine.
  await page.goto(`${APP}/fitting/kanban-loop`, { waitUntil: "domcontentloaded" });
  const restartKanban = page.getByRole("button", { name: "Restart", exact: true });
  await restartKanban.waitFor();
  // Operative restart may itself heal/restart an eager fitting. Capture the
  // baseline immediately before this click; comparing to the script's initial
  // PID can otherwise accept that earlier replacement while this restart is
  // still between stop and start.
  const boardBeforeRestart = await (await page.request.get(`${BOARD}/health`)).json();
  const fittingResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url().includes("/api/fittings/kanban-loop/restart")
  );
  await restartKanban.click();
  const fittingResponse = await fittingResponsePromise;
  if (!fittingResponse.ok()) throw new Error(`Kanban restart failed: ${fittingResponse.status()} ${await fittingResponse.text()}`);
  await page.waitForFunction(async ({ url, prior }) => {
    try {
      const response = await fetch(`${url}/health`, { cache: "no-store" });
      if (!response.ok) return false;
      const body = await response.json();
      return body.ok === true && body.pid && body.pid !== prior;
    } catch {
      return false;
    }
  }, { url: BOARD, prior: boardBeforeRestart.pid }, { timeout: 180_000 });
  await page.screenshot({ path: path.join(VISION, shots.kanban), fullPage: true });

  // Startup recovery must preserve the exact card's phase, run directory, and
  // prior logs (and clear an interrupted running state when applicable).
  await page.waitForFunction(async ({ board, id }) => {
    try {
      const response = await fetch(`${board}/cards/${id}`, { cache: "no-store" });
      return response.ok;
    } catch {
      return false;
    }
  }, { board: BOARD, id: CARD_ID }, { timeout: 180_000 });
  const cardResponse = await page.request.get(`${BOARD}/cards/${CARD_ID}`);
  if (!cardResponse.ok()) throw new Error(`card lookup failed: ${cardResponse.status()}`);
  const cardDocument = await cardResponse.json();
  if (cardDocument.card.list !== EXPECTED_LIST || cardDocument.card.status !== EXPECTED_STATUS) {
    throw new Error(`card was not preserved on ${EXPECTED_LIST}/${EXPECTED_STATUS}: ${JSON.stringify(cardDocument.card)}`);
  }

  await page.goto(BOARD, { waitUntil: "domcontentloaded" });
  const card = page.locator(".card").filter({ has: page.locator(".title", { hasText: TITLE }) });
  await card.waitFor();
  await card.getByRole("button", { name: "Open", exact: true }).click();
  await page.screenshot({ path: path.join(VISION, shots.card), fullPage: true });

  const runnerAfter = await (await page.request.get(`${APP}/api/runner/${COMPOSITION_ID}/state`)).json();
  const boardAfter = await (await page.request.get(`${BOARD}/health`)).json();
  const gatewayAfter = await (await page.request.get(`${GATEWAY}/health`)).json();
  console.log(JSON.stringify({
    action: `Restart operative and Kanban through their UIs; preserve card on ${EXPECTED_LIST}${STAGE ? ` (${STAGE})` : ""}`,
    operative: { beforePid: operativeBeforePid, afterPid: runnerAfter.state?.pid },
    kanban: {
      initialPid: boardInitial.pid,
      beforeExplicitRestartPid: boardBeforeRestart.pid,
      afterPid: boardAfter.pid
    },
    gateway: gatewayAfter,
    card: {
      id: CARD_ID,
      list: cardDocument.card.list,
      status: cardDocument.card.status,
      rev: cardDocument.card.rev,
      runId: cardDocument.card.runId,
      lastDispatchError: cardDocument.card.lastDispatchError
    }
  }, null, 2));
} finally {
  await browser.close();
}
