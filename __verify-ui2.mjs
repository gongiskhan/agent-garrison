import { chromium } from "playwright";
const KANBAN = "https://dev-madrid.tail31efa.ts.net:8489";
const shot = "/tmp/ui-shots";
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const log = (...a) => console.log(...a);
await page.goto(KANBAN + "/", { waitUntil: "networkidle", timeout: 20000 }).catch(e=>log("goto",e.message));
await page.waitForTimeout(1500);
// Scroll the board horizontally to load all columns/cards.
await page.mouse.wheel(2000, 0).catch(()=>{});
await page.waitForTimeout(600);
const watchBtns = page.locator("button:has-text('Watch')");
const n = await watchBtns.count();
log("watch buttons on board:", n);
let captured = false;
for (let i = 0; i < n && !captured; i++) {
  const b = watchBtns.nth(i);
  await b.scrollIntoViewIfNeeded().catch(()=>{});
  await b.click().catch(()=>{});
  await page.waitForTimeout(2200);
  const txt = (await page.locator("body").innerText().catch(()=>"" ));
  const title = (txt.match(/Watch:\s*(.+)/)||[])[1] || "";
  const hasThinking = /Thinking/.test(txt);
  const hasTool = /Bash|Read|Edit|Grep|TodoWrite|Assistant/.test(txt);
  const unavailable = /No rich transcript|transcript unavailable|no log output|No live operative/i.test(txt);
  log(`card #${i}: "${title.slice(0,32)}" thinking=${hasThinking} toolish=${hasTool} unavailable=${unavailable}`);
  if (hasThinking || (hasTool && !unavailable)) {
    await page.screenshot({ path: shot + "/5-rich-log.png" });
    log("  -> captured rich log to 5-rich-log.png");
    captured = true;
  }
  // close modal
  await page.keyboard.press("Escape").catch(()=>{});
  await page.locator("button:has-text('×'), [aria-label='Close']").first().click().catch(()=>{});
  await page.waitForTimeout(400);
}
if (!captured) log("no card surfaced rich content in the visible set");
await browser.close();
