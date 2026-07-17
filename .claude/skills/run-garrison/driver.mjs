#!/usr/bin/env node
// Run-driver for Agent Garrison — smoke-tests routes and screenshots them.
//
// Garrison is a Next.js 14 web app on 127.0.0.1:27777. There is no chromium-cli
// on this machine, but `playwright` is a dev dependency with a cached Chromium,
// so this script IS the browser driver. It must live inside the repo tree (so
// `import 'playwright'` resolves the project's node_modules) — keep it here.
//
// Usage:
//   node .claude/skills/run-garrison/driver.mjs                # default 6 routes
//   node .claude/skills/run-garrison/driver.mjs /quarters /vault
// Env:
//   GARRISON_URL   base URL            (default http://127.0.0.1:27777)
//   SHOT_DIR       screenshot out dir  (default /tmp)
//
// Exit 0 = every route served < 400 and screenshotted. Exit 1 = something is wrong.
import { chromium } from 'playwright';

const BASE = process.env.GARRISON_URL || 'http://127.0.0.1:27777';
const SHOT_DIR = process.env.SHOT_DIR || '/tmp';
const argRoutes = process.argv.slice(2);
const ROUTES = argRoutes.length
  ? argRoutes
  : ['/', '/compose', '/armory', '/quarters', '/vault', '/run'];

const slug = (r) => (r === '/' ? 'home' : r.replace(/^\//, '').replace(/\//g, '-'));
const bad = [];

// 1) Fast HTTP sweep first — catches the corrupt-.next 500 BEFORE we pay for a browser.
//    A stale build cache shows up as `Cannot find module './<n>.js'` on SOME routes.
console.log(`-- HTTP sweep @ ${BASE}`);
for (const r of ROUTES) {
  try {
    const res = await fetch(BASE + r, { redirect: 'manual' });
    const body = res.status >= 500 ? await res.text() : '';
    const corrupt = /Cannot find module '\.\/\d+\.js'/.test(body);
    console.log(
      `  ${String(res.status).padEnd(3)} ${r}` +
      (corrupt ? '   <-- corrupt .next: rm -rf .next && restart dev server' : '')
    );
    if (res.status >= 400) bad.push(r);
  } catch (e) {
    console.log(`  ERR ${r}  ${e.message}   <-- dev server up on ${BASE}?`);
    bad.push(r);
  }
}

// 2) Screenshot each route. waitUntil MUST be 'domcontentloaded', never 'networkidle':
//    Garrison holds long-lived SSE/polling connections (Run-tab live log) so the network
//    never goes idle and networkidle times out.
console.log(`-- screenshots -> ${SHOT_DIR}`);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
for (const r of ROUTES) {
  try {
    const resp = await page.goto(BASE + r, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500); // let client components hydrate
    const out = `${SHOT_DIR}/garrison-${slug(r)}.png`;
    await page.screenshot({ path: out });
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 110);
    console.log(`  ${String(resp.status()).padEnd(3)} ${r} -> ${out}  | ${text}`);
  } catch (e) {
    console.log(`  ERR ${r}  ${e.message}`);
    bad.push(r);
  }
}
await browser.close();

if (bad.length) {
  console.error(`\nFAIL: ${[...new Set(bad)].length} route(s) not OK: ${[...new Set(bad)].join(', ')}`);
  process.exit(1);
}
console.log('\nOK: all routes served and screenshotted.');
