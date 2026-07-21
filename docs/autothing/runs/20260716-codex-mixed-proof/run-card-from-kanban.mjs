import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOARD = "http://127.0.0.1:27089";
const CARD_ID = process.argv[2];
const LIST = process.argv[3];
const SHOT = process.argv[4] ?? `${LIST}-run.png`;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VISION = path.join(HERE, "vision");

if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(CARD_ID ?? "") || !LIST) {
  throw new Error("usage: run-card-from-kanban.mjs <card-ulid> <list-id> [screenshot-name]");
}

const beforeResponse = await fetch(`${BOARD}/cards/${CARD_ID}`);
if (!beforeResponse.ok) throw new Error(`card lookup failed: ${beforeResponse.status}`);
const beforeDocument = await beforeResponse.json();
const expectedTitle = beforeDocument.card.title;
if (beforeDocument.card.list !== LIST) {
  throw new Error(`card is on ${beforeDocument.card.list}, not requested ${LIST}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
page.setDefaultTimeout(120_000);

try {
  await page.goto(BOARD, { waitUntil: "domcontentloaded" });
  const listTitle = LIST.replaceAll("-", " ").replace(/^./, (ch) => ch.toUpperCase());
  const column = page.locator("section.list").filter({
    has: page.locator(".lname-text", { hasText: new RegExp(`^${listTitle}$`) })
  });
  const card = column.locator(".card").filter({
    has: page.locator(".title", { hasText: expectedTitle })
  });
  await card.waitFor();
  await page.screenshot({ path: path.join(VISION, SHOT.replace(/\.png$/, "-queued.png")), fullPage: true });

  const startResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url() === `${BOARD}/cards/${CARD_ID}/start`
  );
  await card.getByRole("button", { name: /^(Run|Retry|Advance)$/ }).click();
  const started = await startResponse;
  const body = await started.json();
  if (!started.ok() || (body.dispatched !== true && typeof body.advanced !== "string")) {
    throw new Error(`start failed: ${started.status()} ${JSON.stringify(body)}`);
  }
  await page.locator(".banner.info").filter({ hasText: /Dispatched|Moved to/ }).waitFor();
  await page.screenshot({ path: path.join(VISION, SHOT), fullPage: true });

  const afterResponse = await page.request.get(`${BOARD}/cards/${CARD_ID}`);
  const afterDocument = await afterResponse.json();
  console.log(JSON.stringify({
    action: "Kanban Run",
    before: {
      list: beforeDocument.card.list,
      status: beforeDocument.card.status,
      title: expectedTitle
    },
    response: body,
    after: {
      list: afterDocument.card.list,
      status: afterDocument.card.status,
      lastRoute: afterDocument.card.lastRoute,
      newestEvent: afterDocument.events?.[0]
    }
  }, null, 2));
} finally {
  await browser.close();
}
