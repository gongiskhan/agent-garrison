// Live DoD drive: the real web channel -> the real Cursor agent on the CSG VM.
// Temporary driver, removed after the run. Evidence lands in
// evidence/remote-shell-csg-live/.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const WC = "http://127.0.0.1:8083";
const RSH = "http://127.0.0.1:8098";
const EV = "evidence/remote-shell-csg-live";
mkdirSync(EV, { recursive: true });

const out = { steps: [] };
const note = (k, v) => { out.steps.push({ [k]: v }); console.log(k, "=", JSON.stringify(v).slice(0, 200)); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 1. Open the web channel and enter via the "CSG work" one-tap entry.
await page.goto(WC, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".wc-rsh-entry", { timeout: 20000 });
await page.screenshot({ path: `${EV}/1-entry.png` });
await page.click(".wc-rsh-entry");
await page.waitForSelector('[data-testid="remote-shell-pane"] .xterm', { timeout: 30000 });
await page.waitForTimeout(2500); // replay + first paint
await page.screenshot({ path: `${EV}/2-attached.png` });
note("attached", true);

const sessions = await (await fetch(`${RSH}/sessions`)).json();
const sid = sessions.sessions[0].id;
note("sessionId", sid);

// 2. Real instruction typed INTO the terminal pane (the Cursor TUI input box).
await page.click('[data-testid="remote-shell-pane"]');
await page.keyboard.type("List the top-level folders of this repo, briefly. Do not modify anything.", { delay: 12 });
await page.waitForTimeout(300);
await page.keyboard.press("Enter");
note("typedInstruction", true);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${EV}/3-typed.png` });

// 3. Hook-driven running: the beforeSubmitPrompt hook should flip the session
// to running, and the web-channel thread list should mark the thread live.
let sawRunning = false;
let sawThreadSpin = false;
for (let i = 0; i < 30; i++) {
  const s = await (await fetch(`${RSH}/sessions/${sid}`)).json();
  if (s.session.state === "running") sawRunning = true;
  const t = await (await fetch(`${WC}/api/threads`)).json();
  const row = t.threads.find((x) => x.id === "remote-shell-csg");
  if (row?.runningSince) sawThreadSpin = true;
  if (sawRunning && sawThreadSpin) break;
  await new Promise((r) => setTimeout(r, 1000));
}
note("hookDrivenRunning", sawRunning);
note("threadListSpinning", sawThreadSpin);
await page.screenshot({ path: `${EV}/4-working.png` });

// 4. Stop hook -> idle. The agent may work for a while.
let idleAgain = false;
for (let i = 0; i < 150; i++) {
  const s = await (await fetch(`${RSH}/sessions/${sid}`)).json();
  if (sawRunning && s.session.state === "idle") { idleAgain = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}
note("stopHookIdle", idleAgain);
await page.waitForTimeout(1000);
await page.screenshot({ path: `${EV}/5-answered.png` });
const screen = await (await fetch(`${RSH}/sessions/${sid}/screen?lines=50`)).json();
note("paneTail", screen.text.trim().split("\n").slice(-12).join(" | ").slice(0, 500));

// 5. Detach/reattach: full reload, reopen the thread, pane replays history.
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".wc-thread-open", { timeout: 20000 });
const threadBtn = page.locator(".wc-thread-open", { hasText: "CSG work" }).first();
await threadBtn.click();
await page.waitForSelector('[data-testid="remote-shell-pane"] .xterm', { timeout: 30000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${EV}/6-reattached.png` });
note("reattached", true);

console.log("RESULT", JSON.stringify(out));
await browser.close();
