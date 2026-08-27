// Live drive of the routing modal on the prod web channel.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const WC = "http://127.0.0.1:8083";
const EV = "evidence/routing-modal-live";
mkdirSync(EV, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const out = [];
const note = (k, v) => { out.push([k, v]); console.log(k, "=", v); };

await page.goto(WC, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".cc-routebtn, .cc-rbadge", { timeout: 30000 });
await page.screenshot({ path: `${EV}/1-rail.png` });

// The composer route button (or any interactive rail badge) opens the modal.
const routeBtn = page.locator(".cc-routebtn");
if (await routeBtn.count()) await routeBtn.click();
else await page.locator(".cc-rbadge").first().click();
await page.waitForSelector(".cc-rm", { timeout: 10000 });
note("modalOpens", true);
await page.screenshot({ path: `${EV}/2-modal.png` });

// Sections present.
for (const id of ["work", "tier", "execution", "account", "project", "flow", "phases"]) {
  const n = await page.locator(`[data-section="${id}"]`).count();
  note(`section:${id}`, n === 1);
}

// The execution section groups by runtime and carries the remote-shell target.
const csg = await page.locator('[data-section="execution"]').getByText("csg-work").count();
note("csgWorkVisible", csg > 0);

// Tier gating: pin T1-standard, execution section disables.
await page.locator('[data-section="tier"]').getByText("T1-standard", { exact: true }).click();
await page.waitForTimeout(600);
const gated = await page.locator(".cc-rm-section-off[data-section='execution']").count();
note("tierGatesExecution", gated === 1);
await page.screenshot({ path: `${EV}/3-tier-gated.png` });

// Phases: plan checkboxes + a beyond-the-plan group.
const beyond = await page.locator('[data-section="phases"]').getByText("beyond the plan").count();
note("beyondPlanOffered", beyond > 0);
if (!beyond) {
  note("phasesSectionText", (await page.locator('[data-section="phases"]').innerText()).slice(0, 300).replace(/\n/g, " | "));
}

// Clear all pins; modal closes cleanly on Done.
await page.locator(".cc-rm-clear").click();
await page.waitForTimeout(400);
await page.locator(".cc-rm-done").click();
await page.waitForTimeout(300);
note("modalCloses", (await page.locator(".cc-rm").count()) === 0);

// Pin persistence: reopen, pin a duty, reload the page, verify the badge shows.
const btn1 = page.locator(".cc-routebtn");
if (await btn1.count()) await btn1.click();
else await page.locator(".cc-rbadge").first().click();
await page.waitForSelector(".cc-rm");
await page.locator('[data-section="work"]').getByRole("radio", { name: /Research|Implement/ }).first().click();
await page.waitForTimeout(800);
await page.locator(".cc-rm-done").click();
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".cc-routebtn, .cc-rbadge", { timeout: 30000 });
await page.waitForTimeout(1500);
// The web channel has no inline chip row (route button mode) - persistence
// shows in the reopened modal's "pinned:" note on the work section.
const btnR = page.locator(".cc-routebtn");
if (await btnR.count()) await btnR.click();
else await page.locator(".cc-rbadge").first().click();
await page.waitForSelector(".cc-rm");
const workNote = (await page.locator('[data-section="work"] .cc-rm-pinned').allTextContents()).join(" ").toLowerCase();
note("pinSurvivesReload", workNote.includes("research") || workNote.includes("implement"));
await page.screenshot({ path: `${EV}/4-pinned-after-reload.png` });
await page.locator(".cc-rm-done").click();
await page.waitForTimeout(300);

// Clean up: clear the pin again.
const btn2 = page.locator(".cc-routebtn");
if (await btn2.count()) await btn2.click();
else await page.locator(".cc-rbadge").first().click();
await page.waitForSelector(".cc-rm");
await page.locator(".cc-rm-clear").click();
await page.waitForTimeout(600);
await page.locator(".cc-rm-done").click();

console.log("RESULT", JSON.stringify(out));
await browser.close();
