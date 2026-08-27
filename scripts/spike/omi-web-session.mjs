#!/usr/bin/env node
// Spike: reuse the box's signed-in Chrome session in a THROWAWAY profile copy so
// we can reach h.omi.me's authenticated app-management surface without driving
// (or mutating) the user's live browser. Read-only w.r.t. the real profile: we
// copy the cookie/keyring files out, never write back.
//
// Usage: node scripts/spike/omi-web-session.mjs [url ...]

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const SRC = path.join(os.homedir(), ".config", "google-chrome");
const DST = "/tmp/omi-chrome-session";
const PORT = 9333;
const SHOTS = "/tmp/omi-shots";

rmSync(DST, { recursive: true, force: true });
mkdirSync(path.join(DST, "Default"), { recursive: true });
mkdirSync(SHOTS, { recursive: true });

// Local State carries the cookie-encryption key; without it the copied Cookies
// DB is undecryptable and every session silently reads as logged out.
for (const rel of [
  "Local State",
  "Default/Cookies",
  "Default/Cookies-journal",
  "Default/Preferences",
  "Default/Secure Preferences",
  "Default/Login Data",
  "Default/Web Data"
]) {
  const from = path.join(SRC, rel);
  if (existsSync(from)) {
    try {
      copyFileSync(from, path.join(DST, rel));
    } catch (err) {
      console.error(`[copy skipped] ${rel}: ${err.message}`);
    }
  }
}

const chromeBin = "/opt/google/chrome/chrome";
const child = execFileSync("bash", [
  "-c",
  `nohup ${chromeBin} --headless=new --no-sandbox --disable-gpu ` +
    `--remote-debugging-port=${PORT} --user-data-dir=${DST} ` +
    `--password-store=basic --no-first-run --no-default-browser-check ` +
    `about:blank > /tmp/omi-chrome-session.log 2>&1 & echo started`
]);
console.log(String(child).trim());

// Wait for the debugging port.
let ok = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) {
      ok = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
if (!ok) throw new Error(`chrome did not expose :${PORT} - see /tmp/omi-chrome-session.log`);

const urls = process.argv.slice(2);
if (urls.length === 0) urls.push("https://h.omi.me/apps");

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

for (const url of urls) {
  const slug = url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/-+$/, "");
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(4000);
  const info = await page.evaluate(() => {
    const text = document.body?.innerText ?? "";
    return {
      title: document.title,
      url: location.href,
      signedInHint: /sign\s*out|log\s*out|my apps|create an app|my account/i.test(text),
      signInWall: /sign in to create app|continue with google|sign in$/im.test(text),
      text: text.slice(0, 700)
    };
  });
  await page.screenshot({ path: path.join(SHOTS, `${slug}-session.png`) });
  console.log(JSON.stringify({ url, status: res?.status() ?? null, ...info }, null, 2));
}
await page.close();
