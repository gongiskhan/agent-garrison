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

const statusOf = (id) =>
  JSON.parse(readFileSync(path.join(os.homedir(), ".garrison", "ui-fittings", `${id}.json`), "utf8"));

const cdp = statusOf("browser-default").cdpHttpEndpoint;
const omiPort = statusOf("omi-channel").port;
const kanbanPort = statusOf("kanban-loop").port;

const shots = [
  ["10-omi-live-status", `http://127.0.0.1:${omiPort}/`],
  ["11-kanban-board", `http://127.0.0.1:${kanbanPort}/`]
];

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width: 1440, height: 950 });

for (const [name, url] of shots) {
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3500);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`${name}: http=${res?.status()} -> ${file}`);
  } catch (err) {
    console.log(`${name}: FAILED ${String(err?.message ?? err).slice(0, 160)}`);
  }
}
await page.close();
