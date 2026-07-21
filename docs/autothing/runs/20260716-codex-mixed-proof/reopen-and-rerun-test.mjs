import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOARD = "http://127.0.0.1:27089";
const CARD_ID = "01KXMWJ11Y5CC38F0NJ0K6SGT1";
const TITLE = "Implement a medium-sized JavaScript TTL cache package";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VISION = path.join(HERE, "vision");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(180_000);

try {
  await page.goto(BOARD, { waitUntil: "domcontentloaded" });

  // Done is operator-owned, so reopen only this card with the normal optimistic
  // revision guard. Test remains engine-owned and is started from its visible UI.
  const reopened = await page.evaluate(async (cardId) => {
    const currentResponse = await fetch(`/cards/${cardId}`, { cache: "no-store" });
    const current = await currentResponse.json();
    if (!currentResponse.ok) throw new Error(`card lookup failed: ${currentResponse.status} ${JSON.stringify(current)}`);
    if (current.card.list !== "done" || current.card.status !== "ok") {
      throw new Error(`expected an idle Done card, got ${current.card.list}/${current.card.status}`);
    }
    const response = await fetch(`/cards/${cardId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ list: "test", rev: current.card.rev })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`reopen failed: ${response.status} ${JSON.stringify(body)}`);
    return body.card;
  }, CARD_ID);

  await page.waitForFunction(async (cardId) => {
    const response = await fetch(`/cards/${cardId}`, { cache: "no-store" });
    if (!response.ok) return false;
    const body = await response.json();
    return body.card?.list === "test" && body.card?.status === "ok";
  }, CARD_ID);
  await page.reload({ waitUntil: "domcontentloaded" });

  const testColumn = page.locator("section.list").filter({
    has: page.locator(".lname-text", { hasText: /^Test$/ })
  });
  const card = testColumn.locator(".card").filter({
    has: page.locator(".title", { hasText: TITLE })
  });
  await card.waitFor();
  await page.screenshot({ path: path.join(VISION, "27-test-reopened.png"), fullPage: true });

  const startResponsePromise = page.waitForResponse(
    (response) => response.request().method() === "POST"
      && response.url() === `${BOARD}/cards/${CARD_ID}/start`
  );
  await card.getByRole("button", { name: /^Run$/ }).click();
  const startResponse = await startResponsePromise;
  const startBody = await startResponse.json();
  if (!startResponse.ok() || startBody.dispatched !== true) {
    throw new Error(`Test start failed: ${startResponse.status()} ${JSON.stringify(startBody)}`);
  }
  await page.locator(".banner.info").filter({ hasText: /Dispatched/ }).waitFor();
  await page.screenshot({ path: path.join(VISION, "28-test-rerun-running.png"), fullPage: true });

  const afterResponse = await page.request.get(`${BOARD}/cards/${CARD_ID}`);
  const after = await afterResponse.json();
  if (!afterResponse.ok() || after.card.list !== "test" || after.card.status !== "running") {
    throw new Error(`Test did not enter running state: ${afterResponse.status()} ${JSON.stringify(after.card)}`);
  }
  console.log(JSON.stringify({
    action: "Reopen Done to Test, then Run Test from the Kanban UI",
    reopened: { list: reopened.list, status: reopened.status, rev: reopened.rev },
    start: startBody,
    running: {
      list: after.card.list,
      status: after.card.status,
      iterations: after.card.iterations,
      runId: after.card.runId
    }
  }, null, 2));
} finally {
  await browser.close();
}
