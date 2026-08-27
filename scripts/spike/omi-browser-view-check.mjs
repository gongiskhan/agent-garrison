#!/usr/bin/env node
// Confirm the Browser Fitting's canvas actually renders the Omi tab, as seen
// through the Garrison shell route the user will open from their phone/Mac.
// Screenshot lands in ~/.garrison/omi-evidence (served by the shell's /file route).

import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const OUT = path.join(os.homedir(), ".garrison", "omi-evidence");
mkdirSync(OUT, { recursive: true });

const cdp = JSON.parse(
  readFileSync(path.join(os.homedir(), ".garrison", "ui-fittings", "browser-default.json"), "utf8")
).cdpHttpEndpoint;

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

const url = "http://127.0.0.1:8084/canvas/511C0C2B63DCC82FA086DBB0BFF4816B";
const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(6000);
const file = path.join(OUT, "06-canvas-live-omi.png");
await page.screenshot({ path: file, fullPage: false });
console.log(`http=${res?.status()} -> ${file}`);
await page.close();
