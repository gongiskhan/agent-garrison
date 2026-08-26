// Live drive of multi-session shells on the prod web channel (:8083).
//
// Proves the two things the feature claims: a project folder can hold MORE THAN
// ONE agent (each with its own tmux session and its own thread), and every one
// of them is an ordinary row in the sessions rail carrying its own live state -
// so switching between them is the normal gesture, not a trip through the modal.
//
// Cleans up after itself: the sessions it starts are stopped and their threads
// deleted, so a run leaves the box exactly as it found it.

import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const WC = process.env.WC_URL ?? "http://127.0.0.1:8083";
const RSH = process.env.RSH_URL ?? "http://127.0.0.1:8098";
const PROJECT = process.env.PROJECT ?? "csg-spec";
const EV = "evidence/remote-shell-multisession";
mkdirSync(EV, { recursive: true });

const out = [];
const note = (k, v) => { out.push([k, v]); console.log(String(k).padEnd(30), "=", JSON.stringify(v)); };
const sessions = async () => (await (await fetch(`${RSH}/sessions`)).json()).sessions ?? [];
const mine = async () => (await sessions()).filter((s) => (s.cwd ?? "").endsWith(`/${PROJECT}`));

const before = await mine();
if (before.length) {
  console.error(`refusing to run: ${PROJECT} already has ${before.length} session(s) - pick an idle project`);
  process.exit(2);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
await page.goto(WC, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".wc-sidebar-collapse", { timeout: 30000 });
// The wide-layout session list is collapsed by default (a per-browser
// preference, and this profile is always fresh); the rail is the surface under
// test, so open it.
const railVisible = async () =>
  page.locator(".wc-sidebar .wc-side-scroll").first().isVisible().catch(() => false);
if (!(await railVisible())) {
  await page.locator(".wc-sidebar-collapse").click();
  await page.waitForTimeout(600);
}
note("railOpen", await railVisible());

const openShells = async () => {
  await page.locator(".wc-shells-btn").click();
  await page.waitForSelector(".wc-shells", { timeout: 15000 });
  await page.waitForSelector(".wc-shells-list--projects .wc-shells-row", { timeout: 30000 });
};
const projectRow = () =>
  page.locator(".wc-shells-project").filter({ has: page.locator(`.wc-shells-name:text-is("${PROJECT}")`) });

// 1. A folder that already holds several agents lists them all.
await openShells();
const multi = page.locator(".wc-shells-project").filter({ has: page.locator(".wc-shells-row--sub") });
note("aFolderListsItsSessions", (await multi.count()) > 0);
await page.locator(".wc-shells").screenshot({ path: `${EV}/1-modal.png` });

// 2. First agent in the project.
await projectRow().locator(".wc-shells-open").click();
await page.waitForSelector(".wc-workbench", { timeout: 40000 });
await page.waitForTimeout(2500);
const one = await mine();
note("firstSession", one.map((s) => s.tmuxSession));
note("firstThreadTitle", (await page.locator(".wc-wb-title").innerText()).trim());

// 3. A SECOND agent in the SAME folder.
await openShells();
await projectRow().locator(".wc-shells-add").click();
await page.waitForTimeout(4000);
const two = await mine();
note("bothSessions", two.map((s) => s.tmuxSession).sort());
note("distinctTmuxSessions", new Set(two.map((s) => s.tmuxSession)).size === 2);
note("sameFolder", new Set(two.map((s) => s.cwd)).size === 1);
note("secondThreadTitle", (await page.locator(".wc-wb-title").innerText()).trim());

// 4. Both are ordinary rows in the rail, switchable.
// A collapsed section still shows the ACTIVE and the WORKING rows; expand
// everything so the assertion is about membership, not about peeking.
for (const head of await page.locator(".wc-sidebar .wc-group-head").all()) {
  if ((await head.getAttribute("aria-expanded")) === "false") {
    await head.click();
    await page.waitForTimeout(200);
  }
}
const rail = page.locator(".wc-sidebar .wc-thread");
const titles = (await rail.locator(".wc-thread-title").allInnerTexts()).map((t) => t.trim());
note("railHasBoth", titles.includes(PROJECT) && titles.includes(`${PROJECT} #2`));
note("railMachineChip", (await page.locator(".wc-thread-src").filter({ hasText: "csg" }).count()) > 0);
await page.locator(".wc-sidebar, .wc-rail").first().screenshot({ path: `${EV}/2-rail.png` }).catch(() => {});
await page.screenshot({ path: `${EV}/3-page.png` });

// Switching to the first row re-opens ITS terminal, not the other one's.
// Match the TITLE exactly: a row's text also carries the machine chip and the
// timestamp, so "csg-spec" as a substring would also match "csg-spec #2".
await rail.filter({ has: page.locator(`.wc-thread-title:text-is("${PROJECT}")`) }).first().click();
await page.waitForTimeout(2500);
const crumb = (await page.locator(".wc-wb-crumb").innerText()).trim();
note("switchedBackCrumb", crumb);
note("crumbNamesFirstSession", crumb.endsWith(`TMUX:${PROJECT.toUpperCase()}`));

// 5. Each thread is joined to ITS OWN session, which is what stops a busy
//    sibling from lighting up every shell on the machine.
const [first, second] = two.sort((a, b) => a.tmuxSession.localeCompare(b.tmuxSession));
const stateProbe = await (await fetch(`${WC}/api/threads`)).json();
const rowOf = (tmux) => (stateProbe.threads ?? []).find((t) => t.remoteShell?.tmuxSession === tmux);
note("firstThreadSeesItsSession", rowOf(first.tmuxSession)?.remoteShell?.sessionId === first.id);
note("secondThreadSeesItsSession", rowOf(second.tmuxSession)?.remoteShell?.sessionId === second.id);
note("liveStateRidesEachThread", [rowOf(first.tmuxSession), rowOf(second.tmuxSession)]
  .every((t) => typeof t?.remoteShell?.state === "string"));
// The standing session's thread still resolves without naming a tmux session.
const standing = (await sessions()).find((s) => s.standing);
const standingThread = (stateProbe.threads ?? []).find(
  (t) => t.remoteShell && !t.remoteShell.tmuxSession && t.remoteShell.transport === standing?.transport
);
note("legacyBindingStillResolves", !standingThread || standingThread.remoteShell.sessionId === standing.id);

// Cleanup: stop both sessions on the remote and delete both threads.
for (const s of two) {
  await fetch(`${RSH}/sessions/${s.id}?kill=1`, { method: "DELETE" }).catch(() => {});
}
for (const t of stateProbe.threads ?? []) {
  if (two.some((s) => s.tmuxSession === t.remoteShell?.tmuxSession)) {
    await fetch(`${WC}/api/threads/${encodeURIComponent(t.id)}`, { method: "DELETE" }).catch(() => {});
  }
}
note("cleanedUp", (await mine()).length === 0);

await browser.close();
const failures = out.filter(([, v]) => v === false);
console.log(failures.length ? `\nFAILED: ${failures.map(([k]) => k).join(", ")}` : "\nALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
