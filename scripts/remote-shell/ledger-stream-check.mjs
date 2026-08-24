// Delegate-lane feedback check: a turn dispatched to the remote agent must show
// its output in the web channel's DISPATCH ledger WHILE it runs, not only once
// the stop hook settles it.
//
// Drives the real web channel: opens the CSG thread, sends one read-only
// instruction, and samples the assistant bubble while the turn is still marked
// running. Passing means text arrived before settlement — i.e. the adapter's
// progress reads reached the browser through the gateway's chunk frames.
//
//   node scripts/remote-shell/ledger-stream-check.mjs [webChannelUrl]

import { chromium } from "@playwright/test";

const URL_BASE = process.argv[2] || "http://127.0.0.1:8083";
const INSTRUCTION =
  "Print the numbers 1 to 15, one per line, pausing about a second between them, " +
  "then stop. Do not read, run or change anything else.";
const DEADLINE_MS = 180_000;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(URL_BASE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await page.locator(".wc-rsh-entry", { hasText: "CSG work" }).first().click();
await page.waitForSelector('[data-testid="remote-shell-pane"] .xterm-screen', { timeout: 30000 });
await page.waitForTimeout(2500);

const composer = page.locator(".wc-wb-delegate textarea").first();
await composer.click();
await composer.fill(INSTRUCTION);
await composer.press("Enter");

// Sample the last assistant bubble and whether the turn still reports running.
const sample = () =>
  page.evaluate(() => {
    const ledger = document.querySelector(".wc-wb-delegate");
    const turns = [...(ledger?.querySelectorAll(".cc-turn") ?? [])];
    const last = turns[turns.length - 1];
    // The streamed transcript renders as the turn's code block; the working dots
    // are the ledger's own "this turn has not settled" marker.
    return {
      text: (last?.querySelector("pre code")?.textContent ?? "").trim(),
      working: !!ledger?.querySelector(".cc-working-dots"),
      state: document.querySelector(".wc-workbench")?.getAttribute("data-state") ?? null
    };
  });

const started = Date.now();
let streamedWhileRunning = "";
let growth = 0;
let previous = "";
let settled = null;
while (Date.now() - started < DEADLINE_MS) {
  await page.waitForTimeout(2000);
  const s = await sample();
  if (s.text && s.text !== previous) {
    growth++;
    previous = s.text;
    if (s.working) streamedWhileRunning = s.text;
    console.log(`  +${Math.round((Date.now() - started) / 1000)}s working=${s.working} chars=${s.text.length}`);
  }
  if (!s.working && s.text) { settled = s.text; break; }
}

const ok = Boolean(streamedWhileRunning);
console.log(`\nstreamed-before-settlement: ${ok ? "YES" : "NO"} (${growth} distinct updates)`);
if (settled) console.log(`settled reply (${settled.length} chars): ${settled.slice(0, 160).replace(/\s+/g, " ")}…`);
await page.screenshot({ path: "/tmp/claude-1001/-home-ggomes-dev-garrison/0238cc95-bde3-4410-aa30-a07cdca204e9/scratchpad/ledger-stream.png", fullPage: false });
await browser.close();
console.log(ok ? "\nLEDGER STREAM OK" : "\nLEDGER STREAM FAILED");
process.exit(ok ? 0 : 1);
