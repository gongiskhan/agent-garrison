#!/usr/bin/env node
// Spike: does Omi expose a WEB surface where an app can be created / managed,
// and is the Browser Fitting's Chrome profile signed in? Drives the live
// browser-default Chrome over CDP (read-only navigation + screenshots).
//
// Usage: node scripts/spike/omi-web-probe.mjs [url ...]

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const statusFile = path.join(os.homedir(), ".garrison", "ui-fittings", "browser-default.json");
const cdp = JSON.parse(readFileSync(statusFile, "utf8")).cdpHttpEndpoint;
if (!cdp) throw new Error(`no cdpHttpEndpoint in ${statusFile}`);

const urls = process.argv.slice(2);
if (urls.length === 0) {
  urls.push("https://h.omi.me/apps", "https://h.omi.me/");
}

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

const results = [];
for (const url of urls) {
  const slug = url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "");
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3500);
    const info = await page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      return {
        title: document.title,
        signedIn: /sign\s*out|log\s*out|my apps|my account/i.test(text),
        loginUi: /sign\s*in|log\s*in|continue with google|get started/i.test(text),
        createApp: /create an app|create app|new app|submit an app/i.test(text),
        text: text.slice(0, 900)
      };
    });
    const shot = `/tmp/omi-shots/${slug}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    results.push({ url, status: res?.status() ?? null, shot, ...info });
  } catch (err) {
    results.push({ url, error: String(err?.message ?? err).slice(0, 300) });
  }
}
console.log(JSON.stringify(results, null, 2));
await page.close();
