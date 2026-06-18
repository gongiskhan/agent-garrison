// Proves the chromium self-heal: when the headless process dies, the next
// tab operation must relaunch instead of throwing
//   "browserContext.newPage: Target page, context or browser has been closed".
// Self-contained — starts its own server on a high port with an isolated HOME
// so it never touches the real ~/.garrison status file. Run: node selfheal.e2e.mjs
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { execSync } from "node:child_process";

// Resolve the real chromium binary BEFORE isolating HOME (Playwright's browser
// cache lives under HOME), then pin it so the server doesn't re-resolve.
const { chromium } = await import("playwright");
process.env.BROWSER_CHROMIUM_PATH = chromium.executablePath();

const tmpHome = await mkdtemp(path.join(os.tmpdir(), "selfheal-home-"));
process.env.HOME = tmpHome; // isolate STATUS_FILE writes

const { startServer } = await import("./server.mjs");

const failures = [];
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!cond) failures.push(name);
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let BASE;
async function createTab(url) {
  const res = await fetch(`${BASE}/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url })
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const { options } = await startServer({
  port: 17084, host: "127.0.0.1",
  viewportWidth: 800, viewportHeight: 800, jpegQuality: 40, everyNthFrame: 1
});
BASE = `http://127.0.0.1:${options.port}`;
console.log(`server up on ${BASE}\n`);

// 1. Baseline: a tab opens against the freshly-launched chromium.
const first = await createTab("about:blank");
check("first tab opens (chromium up)", first.status === 201, `status=${first.status} ${first.body.error || ""}`);

// 2. Simulate a chromium crash: kill the headless child of this node process.
//    chromiumChild is a direct child, so pkill -P targets exactly it.
try { execSync(`pkill -P ${process.pid}`); } catch {}
await delay(1500); // let the 'exit' handler fire + discardChromium run

// 3. The exact screenshot scenario: open a tab against the now-dead browser.
//    Pre-fix this returns 500 "...has been closed". Post-fix it self-heals.
const recovered = await createTab("about:blank");
check("tab opens after chromium death (self-heal relaunch)",
  recovered.status === 201,
  `status=${recovered.status} ${recovered.body.error || ""}`);

// 4. And it keeps working on the relaunched instance.
const third = await createTab("about:blank");
check("subsequent tab still opens", third.status === 201,
  `status=${third.status} ${third.body.error || ""}`);

try { execSync(`pkill -P ${process.pid}`); } catch {}
if (failures.length) { console.log(`\n${failures.length} failure(s):`, failures); process.exit(1); }
console.log("\nAll self-heal checks passed.");
process.exit(0);
