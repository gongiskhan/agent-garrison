#!/usr/bin/env node
// Thorough production verification of the Web Channel session-parity work, run
// against the DEPLOYED prod instance over the real tailnet HTTPS origins. Each
// check is a path a user actually takes, and each asserts durable state as well
// as what the page shows.
//
//   1  embedded surface     - the web channel inside the Garrison app shell
//                             (the surface in the original bug report)
//   2  desktop full turn    - stream, durable reply, completed terminal
//   3  permission + reload  - a pending prompt survives F5 and is answerable after
//   4  restart continuity   - restart the live fitting mid-conversation, reload,
//                             assert full backfill and a resumed session chain
//   5  two tabs, one thread - a second viewer sees the same turn settle
//   6  error surfacing      - a bogus target pin renders a typed failure and the
//                             composer recovers
//   7  phone viewport       - the whole flow at 390x844 with the notice up
//
// Usage: node scripts/web-parity-prod-suite.mjs
//   WEB_ORIGIN  (default https://dev-madrid.tail31efa.ts.net:8483)
//   APP_ORIGIN  (default https://dev-madrid.tail31efa.ts.net)
//   LOCAL_WEB   (default http://127.0.0.1:8083)  - control-plane calls only

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "evidence", "web-parity-prod-suite");
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "https://dev-madrid.tail31efa.ts.net:8483";
const APP_ORIGIN = process.env.APP_ORIGIN ?? "https://dev-madrid.tail31efa.ts.net";
const LOCAL_WEB = process.env.LOCAL_WEB ?? "http://127.0.0.1:8083";
const LOCAL_APP = process.env.LOCAL_APP ?? "http://127.0.0.1:8777";
const PIN = { target: "fable", duty: "discuss", level: 1 };

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail).slice(0, 240)}`);
};

const api = (p, init) => fetch(`${LOCAL_WEB}${p}`, init).then((r) => r.json());
const threadOf = (id) => api(`/api/threads/${encodeURIComponent(id)}`);

async function newThread(title, pin = PIN) {
  const created = await api("/api/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, source: "web-parity-prod-suite" }),
  });
  const id = created.thread.id;
  if (pin) {
    await api(`/api/threads/${encodeURIComponent(id)}/routing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routing: pin }),
    });
  }
  return id;
}

/** Wait for the thread to be idle AND to have grown past `minMessages`.
 *  Without the growth floor this returns during the gap between clicking Send
 *  and the durable admission landing - the thread is momentarily idle and the
 *  caller reads the PREVIOUS turn's reply as if it were the new one. */
async function settled(threadId, { minMessages = 1, timeoutMs = 300_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let saw = null;
  while (Date.now() < deadline) {
    const t = await threadOf(threadId);
    const pending = t?.pendingInputs ?? t?.thread?.pendingInputs ?? [];
    const messages = (t?.thread?.messages ?? []).length;
    saw = { pending: pending.length, messages };
    if (pending.length === 0 && messages >= minMessages) return t;
    await sleep(1_000);
  }
  throw new Error(`thread ${threadId} did not settle (${JSON.stringify(saw)}, wanted >= ${minMessages} messages)`);
}

/** Message count right now — the baseline a following turn must beat. */
async function messageCount(threadId) {
  const t = await threadOf(threadId);
  return (t?.thread?.messages ?? []).length;
}

const terminalsOf = (thread) => (thread.thread.sessionEvents ?? [])
  .filter((e) => e.id.startsWith("terminal:"))
  .map((e) => (e.blocks.find((b) => b.type === "turn_end") ?? {}).status);

const lastAssistant = (thread) =>
  ((thread.thread.messages ?? []).filter((m) => m.role === "assistant").pop() ?? {}).text ?? "";

const { chromium } = await import("playwright");
const browser = await chromium.launch();

const desktop = () => browser.newContext({ viewport: { width: 1280, height: 1000 }, ignoreHTTPSErrors: true });
const phone = () => browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ignoreHTTPSErrors: true,
});

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) })
  .then(() => console.log(`      evidence/web-parity-prod-suite/${name}.png`));

const send = async (page, text) => {
  await page.locator(".cc-input").fill(text);
  await page.locator(".cc-send").click();
};

const createdThreads = [];

try {
  // ── 1. the embedded surface inside the Garrison app shell ────────────────
  {
    const ctx = await desktop();
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    await page.goto(`${APP_ORIGIN}/embed/web-channel-default`, { waitUntil: "domcontentloaded" });
    // The embed is the fitting's own page inside the shell; the chat must mount
    // and be usable from the app origin, not just from the fitting's own port.
    // waitFor(), never isVisible() - the latter does NOT auto-wait, so a cold
    // route reads as "broken" when it is merely still rendering.
    const iframe = page.locator("iframe");
    await iframe.first().waitFor({ state: "attached", timeout: 90_000 }).catch(() => {});
    const src = await iframe.first().getAttribute("src").catch(() => null);
    // frameLocator, not page.frames(): the latter is a SNAPSHOT, so an iframe
    // that is attached but has not navigated to its src yet is missed entirely
    // and the check reports a working embed as broken.
    const chatVisible = await page.frameLocator("iframe").first().locator(".cc-input")
      .waitFor({ state: "visible", timeout: 90_000 })
      .then(() => true).catch(() => false);
    const frame = chatVisible;
    await shot(page, "1-app-embed");
    // The embedded URL must be reachable from the CLIENT: a loopback src is a
    // blank pane for every device that is not this machine.
    const clientReachable = Boolean(src && !/127\.0\.0\.1|localhost/.test(src));
    record("embedded surface mounts inside the app shell over a client-reachable url", Boolean(frame) && chatVisible && clientReachable, {
      src,
      clientReachable,
      chatVisible,
      consoleErrors: errors.filter((e) => !e.startsWith("REQFAIL")).slice(0, 3),
    });
    await ctx.close();
  }

  // ── 2. desktop: a full streamed turn ─────────────────────────────────────
  const mainThread = await newThread("prod suite · main");
  createdThreads.push(mainThread);
  {
    const ctx = await desktop();
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    await page.goto(`${WEB_ORIGIN}/?thread=${encodeURIComponent(mainThread)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".cc-input").waitFor({ state: "visible", timeout: 30_000 });
    const baseTwo = await messageCount(mainThread);
    await send(page, "Reply with exactly: desktop turn ok");
    await sleep(2_500);
    const workingVisible = (await page.locator(".cc-session-notice, .cc-lifecycle-label, .cc-working").count()) > 0;
    const thread = await settled(mainThread, { minMessages: baseTwo + 2 });
    await shot(page, "2-desktop-turn");
    record("desktop streamed turn completes and persists", terminalsOf(thread).at(-1) === "completed" && lastAssistant(thread).trim().length > 0, {
      terminals: terminalsOf(thread),
      workingVisible,
      reply: lastAssistant(thread).split("\n")[0].slice(0, 80),
      consoleErrors: errors.slice(0, 3),
    });
    await ctx.close();
  }

  // ── 3. a pending permission prompt survives a reload ─────────────────────
  {
    const ctx = await desktop();
    const page = await ctx.newPage();
    await page.goto(`${WEB_ORIGIN}/?thread=${encodeURIComponent(mainThread)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".cc-input").waitFor({ state: "visible", timeout: 30_000 });
    const baseThree = await messageCount(mainThread);
    await send(page, "Run `cksum /etc/os-release` in the shell and tell me the number.");
    const pending = page.locator(".cc-session-permission.is-pending");
    await pending.first().waitFor({ state: "visible", timeout: 240_000 });
    await shot(page, "3a-permission-pending");

    await page.reload({ waitUntil: "domcontentloaded" });
    const afterReload = page.locator(".cc-session-permission.is-pending");
    // isVisible() returns immediately and does not wait, which read as "the
    // prompt did not survive" when it simply had not re-rendered yet.
    const survived = await afterReload.first().waitFor({ state: "visible", timeout: 90_000 })
      .then(() => true).catch(() => false);
    const answerable = survived && (await afterReload.first().getByRole("button", { name: "Allow once" }).count()) > 0;
    await shot(page, "3b-permission-after-reload");

    let answered = false;
    if (answerable) {
      await afterReload.first().getByRole("button", { name: "Allow once" }).click();
      answered = true;
    }
    // Answer any follow-up prompt so the turn can finish.
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const more = page.locator(".cc-session-permission.is-pending");
      if (await more.count()) {
        const allow = more.first().getByRole("button", { name: "Allow once" });
        if (await allow.count()) await allow.click().catch(() => {});
      }
      const t = await threadOf(mainThread);
      if ((t?.pendingInputs ?? []).length === 0) break;
      await sleep(1_500);
    }
    const thread = await settled(mainThread, { minMessages: baseThree + 2 });
    await shot(page, "3c-permission-resolved");
    record("pending permission survives reload and is answerable after it", survived && answerable && answered && terminalsOf(thread).at(-1) === "completed", {
      survived, answerable, answered, terminals: terminalsOf(thread).slice(-2),
    });
    await ctx.close();
  }

  // ── 4. restart continuity: the fitting dies mid-conversation ─────────────
  {
    const before = await threadOf(mainThread);
    const messagesBefore = (before.thread.messages ?? []).length;
    const eventsBefore = (before.thread.sessionEvents ?? []).length;
    const sessionsBefore = before.thread.sessionIds ?? [];

    const restart = await fetch(`${LOCAL_APP}/api/fittings/web-channel-default/restart`, { method: "POST" })
      .then((r) => r.json()).catch((e) => ({ error: String(e) }));
    // Wait for the fitting to answer again on its own port.
    let healthy = false;
    for (let i = 0; i < 120; i += 1) {
      try {
        const r = await fetch(`${LOCAL_WEB}/api/health`);
        if (r.ok) { healthy = true; break; }
      } catch { /* still down */ }
      await sleep(500);
    }

    const ctx = await desktop();
    const page = await ctx.newPage();
    await page.goto(`${WEB_ORIGIN}/?thread=${encodeURIComponent(mainThread)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".cc-input").waitFor({ state: "visible", timeout: 60_000 });
    const backfilled = await page.locator(".cc-scroll").textContent();
    await shot(page, "4a-after-restart-backfill");

    await send(page, "In one sentence: what did I ask you first in this conversation?");
    const thread = await settled(mainThread, { minMessages: messagesBefore + 2 });
    await shot(page, "4b-after-restart-continued");
    const after = await threadOf(mainThread);
    record("history backfills after a real fitting restart and the session continues", Boolean(
      healthy &&
      backfilled?.includes("desktop turn ok") &&
      (after.thread.messages ?? []).length > messagesBefore &&
      /desktop turn ok/i.test(lastAssistant(thread)) &&
      terminalsOf(thread).at(-1) === "completed"
    ), {
      restartOk: Boolean(restart?.ok ?? restart?.status ?? healthy),
      healthy,
      messagesBefore,
      messagesAfter: (after.thread.messages ?? []).length,
      eventsBefore,
      eventsAfter: (after.thread.sessionEvents ?? []).length,
      sessionsBefore: sessionsBefore.length,
      sessionsAfter: (after.thread.sessionIds ?? []).length,
      recalled: lastAssistant(thread).slice(0, 120),
      recalledTheFirstAsk: /desktop turn ok/i.test(lastAssistant(thread)),
    });
    await ctx.close();
  }

  // ── 5. two tabs on one thread ────────────────────────────────────────────
  {
    const threadId = await newThread("prod suite · two tabs");
    createdThreads.push(threadId);
    const ctxA = await desktop();
    const ctxB = await desktop();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    for (const p of [pageA, pageB]) {
      await p.goto(`${WEB_ORIGIN}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "domcontentloaded" });
      await p.locator(".cc-input").waitFor({ state: "visible", timeout: 30_000 });
    }
    await send(pageA, "Reply with exactly: two tab ok");
    await settled(threadId, { minMessages: 2 });
    // The second viewer must converge on the same durable turn without a manual
    // reload - the thread, not the tab, owns the conversation.
    let seen = false;
    for (let i = 0; i < 60; i += 1) {
      const text = (await pageB.locator(".cc-scroll").textContent()) ?? "";
      if (text.includes("two tab ok")) { seen = true; break; }
      await sleep(1_000);
    }
    await shot(pageB, "5-second-tab");
    record("a second tab on the same thread converges on the turn", seen, { seen });
    await ctxA.close();
    await ctxB.close();
  }

  // ── 6. a bad route pin surfaces a typed failure ──────────────────────────
  {
    const threadId = await newThread("prod suite · error", { target: "no-such-target-xyz" });
    createdThreads.push(threadId);
    const ctx = await desktop();
    const page = await ctx.newPage();
    await page.goto(`${WEB_ORIGIN}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".cc-input").waitFor({ state: "visible", timeout: 30_000 });
    await send(page, "This should fail to route.");
    // The gateway refuses an unknown target and falls back to the composition's
    // routing. That is correct - but it MUST say so, and say so where the eye
    // lands, not off the right-hand edge of a scrolling rail.
    const rejected = page.getByText(/override rejected/i).first();
    const rejectedShown = await rejected.waitFor({ state: "visible", timeout: 240_000 })
      .then(() => true).catch(() => false);
    const geometry = rejectedShown
      ? await rejected.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return { x: Math.round(box.x), right: Math.round(box.right), viewport: window.innerWidth, inViewport: box.x >= 0 && box.right <= window.innerWidth };
        })
      : null;
    await shot(page, "6-route-rejected-pin");
    // Send is disabled on an empty composer by design, so type first.
    await page.locator(".cc-input").fill("still usable");
    const composerBack = await page.locator(".cc-send").isEnabled().catch(() => false);
    const thread = await threadOf(threadId);
    record("a refused pin is reported in the rail, on screen, and the composer still works", Boolean(
      rejectedShown && geometry?.inViewport && composerBack
    ), {
      rejectedShown,
      geometry,
      composerBack,
      terminals: terminalsOf(thread),
    });
    await ctx.close();
  }

  // ── 7. the whole flow at phone size ──────────────────────────────────────
  {
    const threadId = await newThread("prod suite · phone");
    createdThreads.push(threadId);
    const ctx = await phone();
    const page = await ctx.newPage();
    await page.goto(`${WEB_ORIGIN}/?thread=${encodeURIComponent(threadId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".cc-input").waitFor({ state: "visible", timeout: 30_000 });
    const hittable = await page.evaluate(() => {
      const at = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return "missing";
        const b = el.getBoundingClientRect();
        const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return el.contains(top) || top === el ? "self" : (top?.className || top?.tagName || "unknown");
      };
      return { send: at(".cc-send"), input: at(".cc-input"), notice: Boolean(document.querySelector(".wc-push-notice")) };
    });
    await send(page, "Reply with exactly: phone turn ok");
    const thread = await settled(threadId, { minMessages: 2 });
    // Nothing may scroll the page sideways at 390px.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await shot(page, "7-phone-turn");
    record("phone viewport: composer reachable, turn completes, no horizontal overflow", Boolean(
      hittable.send === "self" && hittable.input === "self" && terminalsOf(thread).at(-1) === "completed" && overflow <= 0
    ), { hittable, overflow, terminals: terminalsOf(thread) });
    await ctx.close();
  }
} finally {
  await browser.close();
}

const summary = {
  webOrigin: WEB_ORIGIN,
  appOrigin: APP_ORIGIN,
  threads: createdThreads,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
console.log(`threads to clean up: ${createdThreads.join(" ")}`);
if (summary.failed > 0) process.exitCode = 1;
