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
page.setDefaultTimeout(120_000);

try {
  const response = await page.request.get(`${BOARD}/cards/${CARD_ID}`);
  const document = await response.json();
  if (!response.ok()
    || document.card.list !== "needs-attention"
    || document.card.lastEvent?.kind !== "parked"
    || !/durable gate verdict disagreed/i.test(document.card.lastEvent?.message ?? "")) {
    throw new Error(`expected the mismatched Test gate to be parked: ${response.status()} ${JSON.stringify(document.card)}`);
  }
  if (!(document.links.evidence ?? []).some((item) => item.name === "evidence.md")) {
    throw new Error("Test evidence was not preserved on the integrity park");
  }

  await page.goto(BOARD, { waitUntil: "domcontentloaded" });
  const attentionColumn = page.locator("section.list").filter({
    has: page.locator(".lname-text", { hasText: /^Needs attention$/ })
  });
  const card = attentionColumn.locator(".card").filter({
    has: page.locator(".title", { hasText: TITLE })
  });
  await card.waitFor();
  await card.getByRole("button", { name: "Open", exact: true }).click();
  await page.locator(".state-callout.parked").filter({ hasText: /durable gate/i }).waitFor();
  await page.screenshot({ path: path.join(VISION, "28b-test-mismatch-caught.png"), fullPage: true });
  console.log(JSON.stringify({
    action: "Assert the terminal integrity invariant caught the stale Test gate",
    card: {
      list: document.card.list,
      status: document.card.status,
      iterations: document.card.iterations,
      event: document.card.lastEvent
    },
    evidence: document.links.evidence.map((item) => item.name)
  }, null, 2));
} finally {
  await browser.close();
}
