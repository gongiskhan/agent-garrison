// Scroll check for the remote-shell pane: a wheel tick and a touch pan over the
// terminal must move the REMOTE pane's history (tmux copy-mode), not type into
// the remote agent's prompt and not sit dead.
//
// Asserts against tmux itself over ssh — `#{pane_in_mode}` / `#{scroll_position}`
// are the ground truth for "the output actually scrolled".
//
//   node scripts/remote-shell/scroll-check.mjs [webChannelUrl]

import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
const URL_BASE = process.argv[2] || "http://127.0.0.1:8083";
const SSH = [
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new",
  "-i", path.join(os.homedir(), ".ssh", "garrison-remote-shell"),
  "-p", "2222", "ggomes@127.0.0.1"
];

async function tmux(cmd) {
  const { stdout } = await execFileAsync("ssh", [...SSH, cmd]);
  return stdout.trim();
}

const paneState = () =>
  tmux(`tmux display-message -p -t csg '#{pane_in_mode} #{scroll_position} #{history_size}'`)
    .then((s) => {
      const [inMode, scroll, history] = s.split(/\s+/);
      return { inMode: inMode === "1", scroll: Number(scroll) || 0, history: Number(history) || 0 };
    });

const exitCopyMode = () => tmux(`tmux send-keys -t csg -X cancel 2>/dev/null || true`).catch(() => {});

async function openPane(page) {
  await page.goto(URL_BASE, { waitUntil: "domcontentloaded" });
  // Wide: the sessions list is collapsed to a rail, and the remote-shell entry
  // is the one-step way in. Narrow: the drawer lists the thread itself.
  const rail = page.locator(".wc-rsh-entry", { hasText: "CSG work" }).first();
  const thread = page.locator(".wc-thread-open", { hasText: "CSG work" }).first();
  await page.waitForTimeout(1500);
  const wide = (page.viewportSize()?.width ?? 0) >= 900;
  if (wide) {
    await rail.click({ timeout: 30000 });
  } else {
    // The narrow drawer is off-canvas until its toggle opens it.
    await page.locator(".wc-sidebar-toggle").first().click({ timeout: 15000 });
    await page.waitForTimeout(500);
    await thread.click({ timeout: 30000 });
  }
  await page.waitForSelector('[data-testid="remote-shell-pane"] .xterm-screen', { timeout: 30000 });
  await page.waitForTimeout(2500); // attach + first paint
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

const browser = await chromium.launch();

// ── Desktop: wheel over the terminal ────────────────────────────────────────
{
  await exitCopyMode();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await openPane(page);
  const before = await paneState();
  const box = await page.locator('[data-testid="remote-shell-pane"] .xterm-screen').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // tmux's own wheel binding spends the first tick ENTERING copy-mode; the ones
  // after it scroll. Six ticks is what any real flick sends.
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
  const after = await paneState();
  record(
    "desktop wheel scrolls the remote pane",
    after.inMode && after.scroll > 0,
    `in_mode ${before.inMode}→${after.inMode}, scrolled ${after.scroll} lines on 6 ticks`
  );

  // And back down again returns to the live tail: tmux's `copy-mode -e` exits
  // by itself once the scroll reaches the bottom. One report per wheel event, so
  // this is a count of ticks, not one big delta.
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(800);
  const back = await paneState();
  record(
    "desktop wheel down returns to the live tail",
    !back.inMode || back.scroll === 0,
    `in_mode=${back.inMode} scroll=${back.scroll}`
  );
  await page.screenshot({ path: "/tmp/claude-1001/-home-ggomes-dev-garrison/0238cc95-bde3-4410-aa30-a07cdca204e9/scratchpad/scroll-desktop.png" });
  await page.close();
}

// ── Mobile: one-finger pan over the terminal ────────────────────────────────
{
  await exitCopyMode();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  });
  const page = await context.newPage();
  await openPane(page);
  const before = await paneState();
  const box = await page.locator('[data-testid="remote-shell-pane"] .xterm-screen').boundingBox();
  const cdp = await context.newCDPSession(page);
  const x = box.x + box.width / 2;
  const startY = box.y + box.height * 0.35;
  const touch = (type, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ id: 1, x, y, radiusX: 6, radiusY: 6, force: 1 }]
    });
  const pan = async (moves) => {
    await touch("touchStart", startY);
    for (let i = 1; i <= moves; i++) {
      await touch("touchMove", startY + i * 20); // finger down = read backwards
      await page.waitForTimeout(80);
    }
    await touch("touchEnd", startY + moves * 20);
    await page.waitForTimeout(900);
  };
  await pan(12);
  const after = await paneState();
  record(
    "mobile touch pan scrolls the remote pane",
    after.inMode && after.scroll >= 8,
    `in_mode ${before.inMode}\u2192${after.inMode}, scrolled ${after.scroll} lines on a 240px pan`
  );
  // A second pan must keep going, so a pass cannot come from tmux's drag-select
  // nudging the view once and stopping.
  await pan(12);
  const further = await paneState();
  record(
    "mobile keeps scrolling on the next pan",
    further.inMode && further.scroll > after.scroll,
    `scroll ${after.scroll}\u2192${further.scroll}`
  );
  // A tap must still focus the terminal for typing — the pointer capture and
  // `touch-action: none` must not have eaten the ordinary tap.
  await touch("touchStart", startY);
  await touch("touchEnd", startY);
  await page.waitForTimeout(400);
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return !!el && el.classList.contains("xterm-helper-textarea");
  });
  record("mobile tap still focuses the terminal", focused, `activeElement is ${focused ? "the xterm input" : "something else"}`);
  await page.screenshot({ path: "/tmp/claude-1001/-home-ggomes-dev-garrison/0238cc95-bde3-4410-aa30-a07cdca204e9/scratchpad/scroll-mobile.png" });
  await context.close();
}

await exitCopyMode();
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "\nSCROLL OK" : `\nSCROLL FAILED (${failed.length})`);
process.exit(failed.length === 0 ? 0 : 1);
