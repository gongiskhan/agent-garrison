#!/usr/bin/env node
// Spike: attempt the h.omi.me sign-in flow in the throwaway profile started by
// omi-web-session.mjs, relying on the copied Google session cookie to auto-approve
// OAuth (no password typed, none available). Screenshots every step so the outcome
// is inspectable either way. Non-destructive: throwaway profile only.
//
// Usage: node scripts/spike/omi-web-login.mjs   (requires chrome on :9333)

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PORT = 9333;
const SHOTS = "/tmp/omi-shots";
const PROFILE = "/tmp/omi-chrome-session";
mkdirSync(SHOTS, { recursive: true });

// The throwaway chrome does not outlive the spike that started it, so start it
// here when the port is cold (profile is already populated by omi-web-session).
async function portUp() {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok;
  } catch {
    return false;
  }
}
if (!(await portUp())) {
  execFileSync("bash", [
    "-c",
    `nohup /opt/google/chrome/chrome --headless=new --no-sandbox --disable-gpu ` +
      `--remote-debugging-port=${PORT} --user-data-dir=${PROFILE} --password-store=basic ` +
      `--no-first-run --no-default-browser-check about:blank > /tmp/omi-chrome-session.log 2>&1 &`
  ]);
  for (let i = 0; i < 60 && !(await portUp()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await portUp())) throw new Error("chrome did not come up on :" + PORT);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
await page.setViewportSize({ width: 1440, height: 900 });

let step = 0;
const snap = async (label) => {
  step += 1;
  const file = path.join(SHOTS, `login-${String(step).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file });
  const text = (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, 500);
  console.log(`\n--- ${step} ${label} :: ${page.url()}`);
  console.log(text.replace(/\n{2,}/g, "\n"));
  return file;
};

await page.goto("https://h.omi.me/apps", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3000);
await snap("marketplace");

// The sign-in affordance is rendered as "Sign in to Create App".
const trigger = page
  .getByRole("button", { name: /sign in/i })
  .or(page.getByRole("link", { name: /sign in/i }))
  .first();
try {
  await trigger.click({ timeout: 15000 });
} catch {
  // Fall back to any element carrying the label.
  await page.getByText(/sign in to create app/i).first().click({ timeout: 15000 });
}
await page.waitForTimeout(4000);
await snap("after-signin-click");

// A Google account chooser may open in this tab or a popup.
const pages = ctx.pages();
const googlePage = pages.find((p) => /accounts\.google\.com/.test(p.url()));
const target = googlePage ?? page;
if (/accounts\.google\.com/.test(target.url())) {
  const chooser = target.getByText(/goncalo\.p\.gomes@gmail\.com/i).first();
  if (await chooser.count().catch(() => 0)) {
    await chooser.click({ timeout: 15000 });
    await target.waitForTimeout(6000);
  }
}
await page.waitForTimeout(3000);
await snap("final");

const finalState = await page.evaluate(() => {
  const text = document.body?.innerText ?? "";
  return {
    url: location.href,
    signedIn: /sign\s*out|log\s*out|my apps|my account/i.test(text),
    stillWalled: /sign in to create app/i.test(text),
    googleBlocked: /couldn't sign you in|this browser or app may not be secure/i.test(text)
  };
});
console.log("\nFINAL:", JSON.stringify(finalState, null, 2));
await page.close();
