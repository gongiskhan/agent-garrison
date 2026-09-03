// The board's phone layout, pinned in a real browser with touch emulation (the
// `pointer: coarse` media query is what the stylesheet keys on, and only a
// browser evaluates it). What is pinned is the 2026-09-03 phone sweep:
//
//   - the coarse-pointer 44px floor is for controls a finger presses on their
//     own; a checklist box, a native checkbox and an inline icon control are
//     exempt (live on the phone: "the checkboxes are too tall");
//   - under 640px a sheet is the whole screen, its body scrolls on its own,
//     and the detail sheet's Conversation page hides every other section so
//     the conversation fills the viewport with its composer at the bottom.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const REPO = path.resolve(__dirname, "..");
const chat = readFileSync(path.join(REPO, "packages/claude-chat/src/claude-chat.css"), "utf8");
const skin = readFileSync(path.join(REPO, "fittings/seed/kanban-loop/ui/styles.css"), "utf8");
const css = `${chat}\n${skin}`.replace(/<\/style/gi, "<\\/style");

let browser: Browser;
let phone: BrowserContext;
let desktop: BrowserContext;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  desktop = await browser.newContext({ viewport: { width: 1200, height: 800 } });
}, 60_000);

afterAll(async () => {
  await phone?.close();
  await desktop?.close();
  await browser?.close();
});

const SHEET = `
<div class="sheet-backdrop">
  <div class="sheet mid phone-conv" id="sheet">
    <div class="sh-head"><h3>A card</h3><button class="btn small sh-close" aria-label="Close">x</button></div>
    <div class="sheet-tabs"><button class="sheet-tab">Card</button><button class="sheet-tab is-active">Conversation</button></div>
    <div class="sh-body">
      <div class="detail-desc" id="desc"><p>${"description ".repeat(200)}</p></div>
      <div class="detail-desc checklist" id="checklist">
        <ul class="cl-items">
          <li><button type="button" role="checkbox" aria-checked="false" class="cl-box" id="box"></button><button type="button" class="cl-text cl-text-button" id="text">Ship it</button><button type="button" class="cl-del" id="del">x</button></li>
        </ul>
      </div>
      <label class="row"><input type="checkbox" id="native" /> Personal task</label>
      <div class="conv-block" id="conv"><div class="kanban-conversation"><div class="cc-root" style="height:100%;display:flex;flex-direction:column"><div style="flex:1 1 auto">stream</div><div class="cc-composer" id="composer">composer</div></div></div></div>
    </div>
  </div>
</div>`;

async function open(context: BrowserContext, body: string): Promise<Page> {
  const page = await context.newPage();
  // The viewport meta the board's own index.html carries: without it a
  // mobile-emulated Chromium lays the page out at 980px and no phone query
  // ever matches.
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%}${css}</style>${body}`);
  return page;
}

const box = (page: Page, sel: string) => page.locator(sel).evaluate((el) => {
  const r = (el as HTMLElement).getBoundingClientRect();
  const cs = getComputedStyle(el as HTMLElement);
  return { w: r.width, h: r.height, display: cs.display };
});

describe("the board on a phone", () => {
  it("keeps checklist boxes and checkboxes box-shaped under the coarse-pointer floor", async () => {
    // The Card page, where the checklist is on screen.
    const page = await open(phone, SHEET.replace("phone-conv", "phone-card"));
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    // A real button still gets the 44px floor...
    expect((await box(page, ".sh-close")).h).toBeGreaterThanOrEqual(40);
    // ...but a checklist box is a box, a native checkbox is a checkbox, and
    // the inline delete control is a compact square, not a 44px-tall bar.
    const cl = await box(page, "#box");
    expect(cl.h).toBe(22);
    expect(cl.w).toBe(22);
    const native = await box(page, "#native");
    expect(native.h).toBe(20);
    expect(native.w).toBe(20);
    const del = await box(page, "#del");
    expect(del.h).toBeLessThanOrEqual(36);
    expect(del.h).toBeGreaterThanOrEqual(28);
    // The checklist text sits on the row, not on a tall button of its own.
    expect((await box(page, "#text")).h).toBeLessThan(40);
    await page.close();
  });

  it("the sheet is the whole screen and the Conversation page is the conversation alone", async () => {
    const page = await open(phone, SHEET);
    const sheet = await box(page, "#sheet");
    expect(sheet.w).toBe(390);
    expect(sheet.h).toBe(844);
    // Every section but the conversation is hidden on this page, and the
    // conversation fills what is left under the header and the tabs.
    expect((await box(page, "#desc")).display).toBe("none");
    expect((await box(page, "#checklist")).display).toBe("none");
    const conv = await box(page, "#conv");
    const head = await box(page, ".sh-head");
    const tabs = await box(page, ".sheet-tabs");
    expect(conv.display).not.toBe("none");
    expect(Math.round(conv.h)).toBe(Math.round(844 - head.h - tabs.h));
    // The conversation reaches the bottom edge of the screen, and so does the
    // composer pinned inside it (the chat is a flex column; the fixture's
    // stand-in mirrors that one property).
    const convBottom = await page.locator(".kanban-conversation").evaluate((el) => (el as HTMLElement).getBoundingClientRect().bottom);
    expect(Math.round(convBottom)).toBe(844);
    const composerBottom = await page.locator("#composer").evaluate((el) => (el as HTMLElement).getBoundingClientRect().bottom);
    expect(Math.round(composerBottom)).toBe(844);
    // The tabs are thumb-sized.
    expect((await box(page, ".sheet-tab.is-active")).h).toBeGreaterThanOrEqual(44);
    await page.close();
  });

  it("the Card page hides the conversation box and scrolls the rest", async () => {
    const page = await open(phone, SHEET.replace("phone-conv", "phone-card"));
    expect((await box(page, "#conv")).display).toBe("none");
    expect((await box(page, "#desc")).display).not.toBe("none");
    const scrolls = await page.locator(".sh-body").evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto");
    expect(scrolls).toBe(true);
    await page.close();
  });

  it("leaves the desktop sheet alone", async () => {
    const page = await open(desktop, SHEET);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
    const sheet = await box(page, "#sheet");
    expect(sheet.w).toBeLessThanOrEqual(720);
    expect(sheet.h).toBeLessThan(800);
    // No phone pages on a desktop: the conversation is a box among the
    // sections, and the tabs never mount there (here the fixture forces them
    // into the DOM; the stylesheet gives them no phone layout).
    expect((await box(page, "#desc")).display).not.toBe("none");
    expect((await box(page, "#conv")).display).not.toBe("none");
    expect((await box(page, "#box")).h).toBe(15);
    await page.close();
  });
});
