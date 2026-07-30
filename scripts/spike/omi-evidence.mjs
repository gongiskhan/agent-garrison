#!/usr/bin/env node
// Capture visible evidence of the omi-channel state into ~/.garrison/omi-evidence/,
// which the shell's /file route serves over the tailnet origin (so the screenshots
// are viewable from the phone/Mac, not just on the box).

import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const OUT = path.join(os.homedir(), ".garrison", "omi-evidence");
mkdirSync(OUT, { recursive: true });

const cdp = JSON.parse(
  readFileSync(path.join(os.homedir(), ".garrison", "ui-fittings", "browser-default.json"), "utf8")
).cdpHttpEndpoint;

const omiPort = JSON.parse(
  readFileSync(path.join(os.homedir(), ".garrison", "ui-fittings", "omi-channel.json"), "utf8")
).port;

const shots = [
  ["01-fitting-status-page", `http://127.0.0.1:${omiPort}/`],
  ["02-fitting-health-json", `http://127.0.0.1:${omiPort}/health`],
  ["03-garrison-fitting-view", "http://127.0.0.1:8777/fitting/omi-channel"]
];

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

for (const [name, url] of shots) {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`${name}: http=${res?.status()} -> ${file}`);
  } catch (err) {
    console.log(`${name}: FAILED ${String(err?.message ?? err).slice(0, 160)}`);
  }
}
await page.close();
