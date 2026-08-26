// Live drive of the shell sidebar menu on the node profile (:8777).
//
// Proves the three things the refit claims: Command is one collapsible group,
// Fittings is one flat alphabetical group, and a pin dragged into Pinned lands
// in the MESH-SHARED document (not a node-local file).
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

const APP = process.env.APP_URL ?? "http://127.0.0.1:8777";
const EV = "evidence/sidebar-menu-live";
mkdirSync(EV, { recursive: true });

const out = [];
const note = (k, v) => { out.push([k, v]); console.log(String(k).padEnd(28), "=", JSON.stringify(v)); };

const state = JSON.parse(readFileSync(`${process.env.GARRISON_HOME ?? `${process.env.HOME}/.garrison`}/state.json`, "utf8"));
const sharedPins = async () => {
  const res = await fetch(`${state.url.replace(/\/+$/, "")}/v1/config/sidebar.pins/global`, {
    headers: { authorization: `Bearer ${state.token}` }
  });
  if (res.status === 404) return null;
  const doc = await res.json();
  return doc.body?.pinned ?? null;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".pin-zone", { timeout: 30000 });
await page.waitForTimeout(1200);

const group = (name) =>
  page.locator("nav.tabs .nav-group").filter({ has: page.locator(`.nav-group-head:has-text("${name}")`) });
const head = (name) => group(name).locator("> .nav-group-head");
const ensureOpen = async (name) => {
  if ((await head(name).getAttribute("aria-expanded")) !== "true") {
    await head(name).click();
    await page.waitForTimeout(400);
  }
};
const rows = async (name) =>
  (await group(name).locator("a.item > span:first-child").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());

note("groupCount", await page.locator("nav.tabs .nav-group").count());
note("groupNames", (await page.locator("nav.tabs .nav-group > .nav-group-head").allInnerTexts()).map((t) => t.replace(/\d+$/, "").trim()));
// The dashboard is the landing route: Command must NOT spring open there.
note("commandCollapsedOnHome", (await head("Command").getAttribute("aria-expanded")) === "false");
note("fittingsCollapsedOnHome", (await head("Fittings").getAttribute("aria-expanded")) === "false");
await page.locator(".side").screenshot({ path: `${EV}/1-collapsed.png` });

await ensureOpen("Command");
const command = await rows("Command");
note("commandRows", command);
note("commandAlphabetical", JSON.stringify(command) === JSON.stringify([...command].sort((a, b) => a.localeCompare(b))));

await ensureOpen("Fittings");
const fittings = await rows("Fittings");
note("fittingCount", fittings.length);
note("fittingsAlphabetical", JSON.stringify(fittings) === JSON.stringify([...fittings].sort((a, b) => a.localeCompare(b))));
note("fittingsFirstFive", fittings.slice(0, 5));
await page.locator(".side").screenshot({ path: `${EV}/2-expanded.png`, scale: "css" });

// No category sub-heads survive anywhere in the menu.
note("categoryHeadsGone", (await page.locator("nav.tabs .nav-group .nav-group-head").count()) === 2);

// Drag a COMMAND row into Pinned — the new capability.
const before = await sharedPins();
note("sharedPinsBefore", before);
await group("Command").getByRole("link", { name: "Vault", exact: true }).dragTo(page.locator(".pin-zone"));
await page.waitForTimeout(1500);
const after = await sharedPins();
note("sharedPinsAfter", after);
note("navVaultPinnedInMesh", (after ?? []).includes("nav:vault"));
note("onlyVaultChanged", JSON.stringify((after ?? []).filter((p) => p !== "nav:vault")) === JSON.stringify(before ?? []));
note("pinnedRowVisible", (await page.locator(".pin-zone a.item").getByText("Vault", { exact: true }).count()) > 0);
note("noPinError", (await page.locator(".pin-error").count()) === 0);
await page.locator(".side").screenshot({ path: `${EV}/3-command-pinned.png` });

// Reload: the pin came from shared state, so it survives a fresh page.
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".pin-zone a.item", { timeout: 20000 });
await page.waitForTimeout(1000);
note("pinSurvivesReload", (await page.locator(".pin-zone a.item").getByText("Vault", { exact: true }).count()) > 0);

// Drag it back out — anywhere outside Pinned unpins.
await page.locator(".pin-zone a.item").filter({ hasText: /^Vault$/ }).first().dragTo(page.locator(".side-foot"));
await page.waitForTimeout(1500);
const restored = await sharedPins();
note("sharedPinsRestored", restored);
note("unpinnedInMesh", !(restored ?? []).includes("nav:vault"));
note("mesh listRestoredExactly", JSON.stringify(restored) === JSON.stringify(before));

await browser.close();
const failures = out.filter(([, v]) => v === false);
console.log(failures.length ? `\nFAILED: ${failures.map(([k]) => k).join(", ")}` : "\nALL CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
