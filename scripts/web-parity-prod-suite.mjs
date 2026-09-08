#!/usr/bin/env node
// Thorough production verification of the Conversations (web channel)
// session-parity work, run against the DEPLOYED node over its real tailnet HTTPS
// origin. Each check is a path a user actually takes, and each asserts durable
// state as well as what the page shows.
//
// Conversations is a shell route: the browser opens /talk on the app itself
// (a thread deep link is /talk/<threadId>) and the talk API answers under the
// app's /api/*. There is no fitting port on either side of this suite.
//
//   1  shell surface        - Conversations mounts at /talk inside the app shell
//                             and hands the client no machine-local URL
//   2  desktop full turn    - stream, durable reply, completed terminal
//   3  permission + reload  - a pending prompt survives F5 and is answerable after
//   4  restart continuity   - restart the app mid-conversation, reload, assert
//                             full backfill and a resumed session chain. The
//                             restart is the operator's command (see below);
//                             without one the check is recorded as skipped.
//   5  two tabs, one thread - a second viewer sees the same turn settle
//   6  error surfacing      - a bogus target pin renders a typed failure and the
//                             composer recovers
//   7  phone viewport       - the whole flow at 390x844 with the notice up
//
// Usage: node scripts/web-parity-prod-suite.mjs
//   APP_ORIGIN           (default: this node's tailnet host) - every browser navigation
//   LOCAL_APP            (default: GARRISON_APP_URL, else the node profile's loopback
//                        port from scripts/garrison-instance.sh) - control-plane calls only
//   GARRISON_RESTART_CMD (optional) - shell command that restarts the app for check 4,
//                        e.g. "npm run node:reload"; unset = check 4 is skipped

import fs, { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "evidence", "web-parity-prod-suite");

// This node's tailnet host - node.json first, then tailscale itself. The old
// hardcoded dev-madrid literal is exactly the main-instance assumption the
// mesh removes: parity runs against THIS node unless told otherwise.
function nodeTailnetHost() {
  try {
    const id = JSON.parse(readFileSync(path.join(os.homedir(), ".garrison", "node.json"), "utf8"));
    if (id?.tailnetHost) return id.tailnetHost;
  } catch {}
  try {
    const st = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" }));
    return st?.Self?.DNSName?.replace(/\.$/, "") ?? "127.0.0.1";
  } catch {
    return "127.0.0.1";
  }
}

// The app's loopback base, the way the runner projects it to every fitting.
// Outside a runner-spawned shell the launcher is the one place the node
// profile's port is defined, so ask it rather than repeat the number here.
function localAppBase() {
  const projected = (process.env.GARRISON_APP_URL ?? process.env.GARRISON_BASE_URL ?? "").trim();
  if (projected) return projected.replace(/\/+$/, "");
  const env = execFileSync("bash", [path.join(REPO, "scripts", "garrison-instance.sh"), "node", "env"], { encoding: "utf8" });
  const port = env.match(/^GARRISON_APP_PORT=(\d+)$/m)?.[1];
  if (!port) throw new Error("could not resolve the node app port from scripts/garrison-instance.sh; set LOCAL_APP");
  return `http://127.0.0.1:${port}`;
}

const APP_ORIGIN = (process.env.APP_ORIGIN ?? `https://${nodeTailnetHost()}`).replace(/\/+$/, "");
const LOCAL_APP = process.env.LOCAL_APP ?? localAppBase();
const RESTART_CMD = process.env.GARRISON_RESTART_CMD?.trim() || null;
const PIN = { target: "fable", duty: "discuss", level: 1 };

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail).slice(0, 240)}`);
};
// A check the environment cannot exercise is neither a pass nor a failure; it
// is reported as such so the summary never claims coverage it did not have.
const skip = (name, reason) => {
  results.push({ name, ok: null, skipped: true, reason });
  console.log(`SKIP  ${name}  ${reason}`);
};

const api = (p, init) => fetch(`${LOCAL_APP}${p}`, init).then((r) => r.json());
const threadOf = (id) => api(`/api/threads/${encodeURIComponent(id)}`);
const healthOf = () => fetch(`${LOCAL_APP}/api/health`, { signal: AbortSignal.timeout(2_000) })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);

// The deep-link shape notifications and Discuss links carry.
const talkUrl = (threadId) => `${APP_ORIGIN}/talk/${encodeURIComponent(threadId)}`;

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

/** Message count right now - the baseline a following turn must beat. */
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

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i;
// A loopback url is a leak only when it is not the origin the client itself
// reached the page on; an operator running the suite against a loopback
// APP_ORIGIN must not have every same-origin request counted against the page.
const isOwnOrigin = (url, origin) => url === origin || url.startsWith(`${origin}/`);
const leaksLoopback = (url, origin) => LOOPBACK.test(url) && !isOwnOrigin(url, origin);

const createdThreads = [];

try {
  // ── 1. the Conversations surface inside the Garrison app shell ──────────
  {
    const threadId = await newThread("prod suite · shell");
    createdThreads.push(threadId);
    const ctx = await desktop();
    const page = await ctx.newPage();
    const errors = [];
    const loopbackRequests = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
    // Every request the page makes must be reachable from the CLIENT: a
    // loopback fetch is a blank pane or a dead link for every device that is
    // not this machine.
    page.on("request", (r) => { if (leaksLoopback(r.url(), APP_ORIGIN)) loopbackRequests.push(r.url().slice(0, 160)); });
    await page.goto(talkUrl(threadId), { waitUntil: "domcontentloaded" });
    // waitFor(), never isVisible() - the latter does NOT auto-wait, so a cold
    // route reads as "broken" when it is merely still rendering.
    const chatVisible = await page.locator(".cc-input")
      .waitFor({ state: "visible", timeout: 90_000 })
      .then(() => true).catch(() => false);
    // The shell's own nav entry proves the chat rendered INSIDE the shell, not
    // on a bare page that happens to share the origin. The menu group holding
    // it expands only after the pin list has loaded, so wait for it.
    const inShell = await page.locator('a[href="/talk"]').first()
      .waitFor({ state: "attached", timeout: 30_000 })
      .then(() => true).catch(() => false);
    // Mixed content is dropped before a request event fires, so also read the
    // DOM for anything already pointed at a loopback host.
    const loopbackRefs = await page.evaluate(({ src, origin }) => {
      const re = new RegExp(src, "i");
      return Array.from(document.querySelectorAll("[src], [href]"))
        .map((el) => el.getAttribute("src") ?? el.getAttribute("href") ?? "")
        .filter((v) => re.test(v) && v !== origin && !v.startsWith(`${origin}/`))
        .slice(0, 5);
    }, { src: LOOPBACK.source, origin: APP_ORIGIN });
    await shot(page, "1-app-shell");
    const clientReachable = loopbackRequests.length === 0 && loopbackRefs.length === 0;
    record("Conversations mounts inside the app shell without handing the client a loopback url", chatVisible && inShell && clientReachable, {
      url: talkUrl(threadId),
      chatVisible,
      inShell,
      clientReachable,
      loopbackRequests: loopbackRequests.slice(0, 3),
      loopbackRefs,
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
    await page.goto(talkUrl(mainThread), { waitUntil: "domcontentloaded" });
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
    await page.goto(talkUrl(mainThread), { waitUntil: "domcontentloaded" });
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

  // ── 4. restart continuity: the app dies mid-conversation ─────────────────
  {
    const name = "history backfills after a real app restart and the session continues";
    if (!RESTART_CMD) {
      skip(name, "GARRISON_RESTART_CMD unset - Conversations runs inside the app, so restarting it is an operator command this suite will not guess");
    } else {
      const before = await threadOf(mainThread);
      const messagesBefore = (before.thread.messages ?? []).length;
      const eventsBefore = (before.thread.sessionEvents ?? []).length;
      const sessionsBefore = before.thread.sessionIds ?? [];
      const pidBefore = (await healthOf())?.pid ?? null;

      // The command owns the restart end to end (a reload script waits for the
      // port itself; a service manager returns once the unit is up). Its output
      // streams to this terminal because a redeploy can run for minutes.
      const startedAt = Date.now();
      const run = spawnSync(RESTART_CMD, {
        shell: true,
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "inherit", "pipe"],
        timeout: 15 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      const restartExit = run.status;
      const restartStderr = restartExit === 0 ? undefined : (run.error?.message ?? run.stderr ?? "").slice(-400);
      // Wait for the app to answer again on its loopback port.
      let health = null;
      for (let i = 0; i < 240; i += 1) {
        health = await healthOf();
        if (health) break;
        await sleep(500);
      }
      const healthy = Boolean(health);
      // A restart that did not replace the process proves nothing about
      // continuity - the health pid is the one fact that says it happened.
      const pidChanged = pidBefore !== null && typeof health?.pid === "number" && health.pid !== pidBefore;

      const ctx = await desktop();
      const page = await ctx.newPage();
      await page.goto(talkUrl(mainThread), { waitUntil: "domcontentloaded" });
      await page.locator(".cc-input").waitFor({ state: "visible", timeout: 60_000 });
      const backfilled = await page.locator(".cc-scroll").textContent();
      await shot(page, "4a-after-restart-backfill");

      await send(page, "In one sentence: what did I ask you first in this conversation?");
      const thread = await settled(mainThread, { minMessages: messagesBefore + 2 });
      await shot(page, "4b-after-restart-continued");
      const after = await threadOf(mainThread);
      record(name, Boolean(
        restartExit === 0 &&
        healthy &&
        pidChanged &&
        backfilled?.includes("desktop turn ok") &&
        (after.thread.messages ?? []).length > messagesBefore &&
        /desktop turn ok/i.test(lastAssistant(thread)) &&
        terminalsOf(thread).at(-1) === "completed"
      ), {
        restartCmd: RESTART_CMD,
        restartExit,
        restartStderr,
        restartMs: Date.now() - startedAt,
        healthy,
        pidBefore,
        pidAfter: health?.pid ?? null,
        pidChanged,
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
      await p.goto(talkUrl(threadId), { waitUntil: "domcontentloaded" });
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
    await page.goto(talkUrl(threadId), { waitUntil: "domcontentloaded" });
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
    await page.goto(talkUrl(threadId), { waitUntil: "domcontentloaded" });
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
  appOrigin: APP_ORIGIN,
  localApp: LOCAL_APP,
  restartCmd: RESTART_CMD,
  threads: createdThreads,
  passed: results.filter((r) => r.ok === true).length,
  failed: results.filter((r) => r.ok === false).length,
  skipped: results.filter((r) => r.skipped).length,
  results,
};
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
console.log(`threads to clean up: ${createdThreads.join(" ")}`);
if (summary.failed > 0) process.exitCode = 1;
