#!/usr/bin/env node
// Evidence check: does the h.omi.me frontend target a localhost backend instead of
// api.omi.me? Loads the create-app page in the Browser Fitting's Chrome, records
// every network request, and greps the loaded JS bundles for API base URLs.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const cdp = JSON.parse(
  readFileSync(path.join(os.homedir(), ".garrison", "ui-fittings", "browser-default.json"), "utf8")
).cdpHttpEndpoint;

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();

const requests = [];
const scripts = [];
page.on("request", (r) => requests.push(r.url()));
page.on("response", (r) => {
  if (/\.js(\?|$)/.test(r.url())) scripts.push(r.url());
});

await page.goto("https://h.omi.me/create-app", { waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(4000);

console.log("final url:", page.url());
const localhostReqs = requests.filter((u) => /localhost|127\.0\.0\.1/.test(u));
console.log("\nrequests to localhost/127.0.0.1:", localhostReqs.length);
localhostReqs.slice(0, 10).forEach((u) => console.log("  ", u));

// Grep the JS bundles for hardcoded API bases.
const hits = { "localhost:8000": [], "api.omi.me": [], other: [] };
for (const src of scripts.slice(0, 60)) {
  let body = "";
  try {
    const res = await page.request.get(src, { timeout: 20000 });
    body = await res.text();
  } catch {
    continue;
  }
  if (body.includes("localhost:8000")) hits["localhost:8000"].push(src);
  if (body.includes("api.omi.me")) hits["api.omi.me"].push(src);
  const m = body.match(/https?:\/\/[a-z0-9.\-]*(?:omi\.me|localhost)(?::\d+)?/gi);
  if (m) for (const u of new Set(m)) if (!hits.other.includes(u)) hits.other.push(u);
}
console.log("\nbundles scanned:", scripts.length);
console.log("bundles containing 'localhost:8000':", hits["localhost:8000"].length);
console.log("bundles containing 'api.omi.me':", hits["api.omi.me"].length);
console.log("\ndistinct origins found in bundle source:");
hits.other.slice(0, 30).forEach((u) => console.log("  ", u));
await page.close();
