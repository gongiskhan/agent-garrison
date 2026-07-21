// End-to-end verification of the canvas reliability fixes.
// Run with the Fitting up on BROWSER_BASE (default http://127.0.0.1:27084).
import { chromium as test } from "playwright";

const BASE = process.env.BROWSER_BASE || "http://127.0.0.1:27084";

async function createTab(url) {
  const res = await fetch(`${BASE}/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  return (await res.json()).tabId;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

const failures = [];
function check(name, cond, detail = "") {
  if (cond) console.log(`PASS ${name}${detail ? ` (${detail})` : ""}`);
  else { failures.push(name); console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`); }
}

const tab1 = await createTab("https://example.com");
const tab2 = await createTab("https://news.ycombinator.com");
console.log(`tab1=${tab1.slice(0,8)}… tab2=${tab2.slice(0,8)}…\n`);

const browser = await test.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

// Mount canvas iframe at a SPECIFIC non-default size (1100x600). Then we
// verify Chromium renders at that size, NOT at the preset's 800x800. This
// catches forcePaint clobber regression.
await page.evaluate(({ tab1, base }) => {
  const cv = document.createElement("iframe");
  cv.id = "cv";
  cv.src = `${base}/canvas/${tab1}`;
  cv.style.width = "1100px";
  cv.style.height = "600px";
  cv.style.border = "0";
  cv.style.display = "block";
  document.body.style.margin = "0";
  document.body.appendChild(cv);
  window.__cv = cv;
}, { tab1, base: BASE });

await delay(4000); // settle: WS open, first frame arrives

// --- 1. Verify canvas got a frame at the right size ---
const frame = page.frames().find((f) => f.url().includes(`/canvas/${tab1}`));
if (!frame) { console.log("FAIL: no canvas frame"); process.exit(1); }

const canvasSize = await frame.evaluate(() => {
  const c = document.querySelector("canvas");
  return c ? { w: c.width, h: c.height } : null;
});
check("canvas has rendered frame", canvasSize && canvasSize.w > 0 && canvasSize.h > 0,
  canvasSize ? `${canvasSize.w}x${canvasSize.h}` : "no canvas");

// The frame should be ROUGHLY 1100 wide (matching the wrapper size after the
// client's viewport push). On LOW preset (maxWidth 800), Chromium downsamples
// to <=800. So canvas width should be exactly 800 (the LOW cap), NOT 800x800
// pinched aspect from forcePaint's setDeviceMetricsOverride.
// The KEY check: aspect ratio matches 1100:600 (≈1.83), not 1:1.
if (canvasSize) {
  const aspect = canvasSize.w / canvasSize.h;
  check("aspect ratio preserved (~1.83 not 1.0)", aspect > 1.5 && aspect < 2.2,
    `aspect=${aspect.toFixed(2)}`);
}

// --- 2. postMessage attach to tab2 → no full reload, URL bar updates ---
const loadCountBefore = await frame.evaluate(() => performance.getEntriesByType("navigation").length);
await page.evaluate((tabId) => {
  window.__cv.contentWindow.postMessage({ type: "attach", tabId }, "*");
}, tab2);
await delay(3500);

const frameAfter = page.frames().find((f) => f.url().startsWith(`${BASE}/canvas/`));
const urlBar2 = await frameAfter.locator(".urlbar input").inputValue();
const loadCountAfter = await frameAfter.evaluate(() => performance.getEntriesByType("navigation").length);
const path = await frameAfter.evaluate(() => window.location.pathname);

check("URL bar shows tab2 after attach", urlBar2.includes("ycombinator"), urlBar2);
check("no full document reload during attach", loadCountAfter === loadCountBefore,
  `before=${loadCountBefore} after=${loadCountAfter}`);
check("URL pathname rewritten", path === `/canvas/${tab2}`);

// Verify canvas still has frames flowing on tab2
const canvasSize2 = await frameAfter.evaluate(() => {
  const c = document.querySelector("canvas");
  return c ? { w: c.width, h: c.height } : null;
});
check("tab2 canvas has frames", canvasSize2 && canvasSize2.w > 0);
if (canvasSize2) {
  const aspect2 = canvasSize2.w / canvasSize2.h;
  check("tab2 aspect ratio preserved (~1.83)", aspect2 > 1.5 && aspect2 < 2.2,
    `aspect=${aspect2.toFixed(2)} w=${canvasSize2.w} h=${canvasSize2.h}`);
}

// --- 3. Quality LOW → HIGH continuity ---
const widthBefore = canvasSize2.w;
// Click HIGH via DOM dispatch (avoids Playwright iframe-coord scroll issues).
await frameAfter.evaluate(() => {
  const btns = Array.from(document.querySelectorAll(".quality-btn"));
  const high = btns.find((b) => b.textContent === "HIGH");
  if (high) high.click();
});
await delay(3000);
const canvasSize3 = await frameAfter.evaluate(() => {
  const c = document.querySelector("canvas");
  return c ? { w: c.width, h: c.height } : null;
});
const activeQ = await frameAfter.evaluate(() => {
  const active = document.querySelector(".quality-btn.active");
  return active ? active.textContent : null;
});
check("HIGH quality applied", activeQ === "HIGH");
// HIGH preset caps maxWidth at 1280, so canvas should be at least as wide
// as wrapper (1100), and Chromium may go up to 1280.
check("frames flowing on HIGH (canvas width >= LOW width)",
  canvasSize3 && canvasSize3.w >= widthBefore,
  `LOW w=${widthBefore} HIGH w=${canvasSize3?.w}`);

await browser.close();
if (failures.length) { console.log(`\n${failures.length} failure(s):`, failures); process.exit(1); }
console.log("\nAll checks passed.");
process.exit(0);
