import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = "http://127.0.0.1:27083";
const BOARD = "http://127.0.0.1:27089";
const TASK = "Implement a medium-sized JavaScript TTL cache package in /tmp/garrison-mixed-runtime-proof-20260716. Provide get/set/delete/clear, injectable clock, lazy expiry, LRU eviction with configurable max entries, Node built-in tests, package.json, and README. Run the tests. This is a normal bounded feature; use the configured workflow and do not skip review or test.";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VISION = path.join(HERE, "vision");

function donePayload(sse) {
  let found = null;
  for (const frame of sse.split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (event === "done" && data) found = JSON.parse(data);
  }
  if (!found) throw new Error(`SSE response had no done event: ${sse.slice(-1000)}`);
  return found;
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.setDefaultTimeout(120_000);

try {
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("textarea.cc-input");

  const threadResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url() === `${WEB}/api/threads`
  );
  await page.locator("button.wc-new").click();
  const createdThread = await threadResponse;
  if (!createdThread.ok()) throw new Error(`new thread failed: ${createdThread.status()} ${await createdThread.text()}`);
  const thread = await createdThread.json();
  await page.screenshot({ path: path.join(VISION, "07-web-new-thread.png"), fullPage: true });

  await page.locator("textarea.cc-input").fill(TASK);
  const chatResponse = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.url() === `${WEB}/api/chat`,
    { timeout: 180_000 }
  );
  await page.locator("button.cc-send").click();
  const streamed = await chatResponse;
  if (!streamed.ok()) throw new Error(`Web chat failed: ${streamed.status()} ${await streamed.text()}`);
  const sse = await streamed.text();
  const done = donePayload(sse);
  const cardId = done.card;
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(cardId ?? "")) {
    throw new Error(`done event did not carry a card ULID: ${JSON.stringify(done)}`);
  }
  if (done.cardUrl !== `${BOARD}/#/cards/${cardId}`) {
    throw new Error(`unexpected card URL: ${JSON.stringify(done)}`);
  }

  const cardResponse = await page.request.get(`${BOARD}/cards/${cardId}`);
  if (!cardResponse.ok()) throw new Error(`card lookup failed: ${cardResponse.status()}`);
  const cardDocument = await cardResponse.json();
  const card = cardDocument.card;
  const sequence = card.sequence?.map((step) => typeof step === "string" ? step : step.duty ?? step.phase);
  if (card.duty !== "develop" || card.level !== 2) {
    throw new Error(`dispatcher registered the wrong workflow: ${JSON.stringify({ duty: card.duty, level: card.level })}`);
  }
  if (JSON.stringify(sequence) !== JSON.stringify(["plan", "implement", "review", "test"])) {
    throw new Error(`registered the wrong sequence: ${JSON.stringify(card.sequence)}`);
  }

  await page.locator(".cc-turn").last().locator(".cc-assistant").waitFor();
  await page.screenshot({ path: path.join(VISION, "08-web-card-registered.png"), fullPage: true });
  console.log(JSON.stringify({
    thread,
    request: { task: TASK },
    done,
    card: {
      id: card.id,
      title: card.title,
      list: card.list,
      status: card.status,
      duty: card.duty,
      level: card.level,
      sequence: card.sequence,
      steps: card.steps
    }
  }, null, 2));
} finally {
  await browser.close();
}
