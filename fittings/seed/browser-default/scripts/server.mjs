#!/usr/bin/env node
// browser-default backend. Playwright-managed headless Chromium with raw CDP
// exposed via --remote-debugging-port. Serves:
//   - per-tab JPEG screencast over WS /viewport/:tabId
//   - per-tab input dispatch over WS /input/:tabId
//   - per-tab raw CDP passthrough over WS /cdp/:tabId
//   - reverse-proxy of Chromium's built-in DevTools at HTTP /devtools/*
//   - tabs list + canvas page UI at HTTP / and /canvas/:tabId

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright";

const HOME = os.homedir();
const STATUS_ROOT = path.join(HOME, ".garrison", "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "browser-default.json");

/** @type {Map<string, TabState>} */
const tabs = new Map();
let browser = null;
let context = null;
let chromiumChild = null;
// The temp user-data-dir for a NON-persistent launch — removed on shutdown so the
// default really is ephemeral (no cookies/session left under /tmp).
let ephemeralProfileDir = null;
let cdpPort = 0;
let cdpHttpEndpoint = "";
let cdpWsEndpoint = "";
// Last opts launchChromium was called with, so a self-heal relaunch can reuse
// the same viewport. Set on first launch and never cleared.
let launchOpts = null;
// In-flight relaunch promise — guards ensureChromium against double-launching
// when concurrent requests race after the headless process dies.
let chromiumLaunching = null;

/**
 * @typedef {{
 *   ts: number, level: string, text: string,
 *   url?: string, line?: number, col?: number,
 *   args?: any[], stackTrace?: any
 * }} ConsoleEntry
 *
 * @typedef {{
 *   requestId: string, ts: number,
 *   method: string, url: string, resourceType: string,
 *   status?: number, statusText?: string, mimeType?: string,
 *   encodedDataLength?: number, duration?: number,
 *   failed?: boolean, failureText?: string,
 *   fromCache?: boolean
 * }} NetworkEntry
 *
 * @typedef {{
 *   tabId: string,
 *   page: import("playwright").Page,
 *   cdpSession: import("playwright").CDPSession | null,
 *   requestedUrl: string,
 *   lastActivityAt: number,
 *   console: ConsoleEntry[],
 *   network: NetworkEntry[],
 *   networkById: Map<string, NetworkEntry>,
 *   viewportClient: import("ws").WebSocket | null,
 *   viewportCdp: import("playwright").CDPSession | null,
 *   viewportTeardownTimer: NodeJS.Timeout | null,
 *   pendingAck: { sessionId: number, ts: number } | null,
 *   qualityLevel: "low" | "med" | "high" | "ultra",
 *   inputClients: Set<import("ws").WebSocket>,
 *   focusedEditable: boolean,
 *   focusWatcher: NodeJS.Timeout | null,
 *   selection: object | null
 * }} TabState
 */

const BUFFER_LIMIT = 500;

// Screencast presets — the per-tab qualityLevel can be changed at runtime via
// an input-WS {type:"quality", level} message. everyNthFrame stays at 1:
// throttle by JPEG size, not by skipping paints. (Skipping paints starves
// first-frame on static pages — there's nothing to skip if the page only
// paints once on load.)
//
// viewportWidth/viewportHeight here are the screencast maxWidth/maxHeight — the
// cap CDP downscales the rendered surface to fit. The rendered surface is the
// client's CSS display area × its devicePixelRatio (up to ~2×), so a cap below
// that forces a downscale-then-upscale round-trip on the client canvas — the
// "granular/pixelized" look. ULTRA's cap sits above any realistic surface, so
// frames arrive at native device resolution and read as crisp as native Chrome
// (at the cost of ~3–4× the bytes — hence HIGH, not ULTRA, is the default).
const QUALITY_PRESETS = {
  low:   { jpegQuality: 40, viewportWidth: 800,  viewportHeight: 800,  everyNthFrame: 1 },
  med:   { jpegQuality: 55, viewportWidth: 1024, viewportHeight: 1024, everyNthFrame: 1 },
  high:  { jpegQuality: 80, viewportWidth: 1600, viewportHeight: 1600, everyNthFrame: 1 },
  ultra: { jpegQuality: 92, viewportWidth: 3840, viewportHeight: 3840, everyNthFrame: 1 }
};

// Keep the CDP screencast alive for this long after a viewer disconnects, so a
// quick reconnect (Safari refresh, network blip, tab swap) doesn't pay the
// full re-attach round-trip.
const VIEWPORT_GRACE_MS = 10_000;

// Per-WS heartbeat. Two missed pongs (30s) → terminate.
const HEARTBEAT_MS = 15_000;

function pushBounded(arr, entry) {
  arr.push(entry);
  if (arr.length > BUFFER_LIMIT) arr.splice(0, arr.length - BUFFER_LIMIT);
}

// Hand a popup destination off to the user's REAL Chrome (the desktop app),
// not the headless Chromium we screencast. A "new tab" opened from page content
// (window.open / target=_blank) would otherwise spawn an invisible headless tab
// nobody is viewing. Only http(s) is honoured — never file:, data:, javascript:,
// chrome:, or custom app schemes, which `open` would route to arbitrary
// registered handlers.
function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.unref();
  return child;
}

function openInRealChrome(rawUrl) {
  let parsed;
  try { parsed = new URL(String(rawUrl)); } catch { return; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  const target = parsed.toString();
  try {
    // Escape hatch: point BROWSER_OPEN_CMD at any executable to override the
    // host browser (e.g. a Firefox/Brave binary). It receives the URL as its
    // sole argument. Also the seam the popup-handoff test drives.
    if (process.env.BROWSER_OPEN_CMD) {
      spawnDetached(process.env.BROWSER_OPEN_CMD, [target]);
      console.log(`[browser] popup -> ${process.env.BROWSER_OPEN_CMD}: ${target}`);
      return;
    }
    if (process.platform === "darwin") {
      // `open` always spawns (it's a system binary); it exits non-zero when
      // "Google Chrome" isn't installed — fall back to the default browser then.
      const child = spawnDetached("open", ["-a", "Google Chrome", target]);
      child.on("exit", (code) => { if (code) { try { spawnDetached("open", [target]); } catch {} } });
      child.on("error", () => { try { spawnDetached("open", [target]); } catch {} });
    } else if (process.platform === "win32") {
      spawnDetached("cmd", ["/c", "start", "", target]);
    } else {
      spawnDetached("xdg-open", [target]);
    }
    console.log(`[browser] popup -> real Chrome: ${target}`);
  } catch (err) {
    console.warn(`[browser] open-in-real-chrome failed: ${err.message}`);
  }
}

function formatConsoleArgs(args) {
  if (!Array.isArray(args)) return "";
  return args.map((a) => {
    if (a == null) return String(a);
    if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
    if (a.description) return a.description;
    if (a.unserializableValue) return String(a.unserializableValue);
    return JSON.stringify(a);
  }).join(" ");
}

async function attachInstrumentation(tab) {
  const cdp = tab.cdpSession;
  if (!cdp) return;
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable", { maxResourceBufferSize: 8 * 1024 * 1024 });
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
  } catch (err) {
    console.warn(`[browser] enable domains failed: ${err.message}`);
    return;
  }

  // Suppress the native file-upload picker: with interception on, clicking an
  // <input type=file> emits Page.fileChooserOpened instead of opening an OS
  // dialog (which a CDP-driven, viewer-less browser can't service anyway). We
  // intentionally don't supply files — the chooser is simply dismissed.
  try {
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
  } catch (err) {
    console.warn(`[browser] file-chooser interception failed: ${err.message}`);
  }
  cdp.on("Page.fileChooserOpened", () => {
    // No-op: interception alone keeps the native dialog from appearing.
  });

  // A user opening a new tab/window from page content (clicking a target=_blank
  // link, window.open) should land in their real desktop Chrome, not a hidden
  // headless tab we never screencast. Page.windowOpen carries the destination
  // URL at request time — before any navigation — so we hand it off without the
  // popup ever needing to load. The headless popup Chromium still spawns is
  // closed by the page.on("popup") handler in openTab. Gate on userGesture so
  // programmatic ad/tracking popunders are suppressed (closed) rather than
  // flooding real Chrome with tabs.
  cdp.on("Page.windowOpen", (e) => {
    if (e?.userGesture && e?.url) openInRealChrome(e.url);
  });

  // A real main-frame navigation makes any prior pick/region stale — drop it so
  // the Operative never resolves "this" against a page that's gone.
  cdp.on("Page.frameNavigated", (e) => {
    if (e.frame && !e.frame.parentId && tab.selection) {
      tab.selection = null;
      broadcastToInput(tab, { type: "selection", selection: null });
    }
  });

  // Console: console.log/warn/error/info/debug
  cdp.on("Runtime.consoleAPICalled", (e) => {
    pushBounded(tab.console, {
      ts: Date.now(),
      level: e.type || "log",
      text: formatConsoleArgs(e.args),
      url: e.stackTrace?.callFrames?.[0]?.url,
      line: e.stackTrace?.callFrames?.[0]?.lineNumber,
      col: e.stackTrace?.callFrames?.[0]?.columnNumber,
      stackTrace: e.stackTrace
    });
  });

  // Console: uncaught exceptions
  cdp.on("Runtime.exceptionThrown", (e) => {
    const ex = e.exceptionDetails;
    pushBounded(tab.console, {
      ts: Date.now(),
      level: "error",
      text: ex?.exception?.description || ex?.text || "exception",
      url: ex?.url,
      line: ex?.lineNumber,
      col: ex?.columnNumber,
      stackTrace: ex?.stackTrace
    });
  });

  // Browser-level log entries (CSP violations, deprecations, …)
  cdp.on("Log.entryAdded", (e) => {
    const en = e.entry;
    if (!en) return;
    pushBounded(tab.console, {
      ts: Date.now(),
      level: en.level || "log",
      text: `[${en.source || "browser"}] ${en.text}`,
      url: en.url,
      line: en.lineNumber
    });
  });

  // Network
  cdp.on("Network.requestWillBeSent", (e) => {
    const entry = {
      requestId: e.requestId,
      ts: Date.now(),
      method: e.request?.method || "GET",
      url: e.request?.url || "",
      resourceType: e.type || "Other"
    };
    tab.networkById.set(e.requestId, entry);
    pushBounded(tab.network, entry);
    // Drop the head off networkById too if we trimmed the array.
    if (tab.network.length === BUFFER_LIMIT && tab.networkById.size > BUFFER_LIMIT * 2) {
      const cutoff = tab.network[0].requestId;
      for (const [k] of tab.networkById) {
        if (k === cutoff) break;
        tab.networkById.delete(k);
      }
    }
  });
  cdp.on("Network.responseReceived", (e) => {
    const entry = tab.networkById.get(e.requestId);
    if (!entry) return;
    entry.status = e.response?.status;
    entry.statusText = e.response?.statusText;
    entry.mimeType = e.response?.mimeType;
    entry.fromCache = Boolean(e.response?.fromDiskCache || e.response?.fromServiceWorker);
  });
  cdp.on("Network.loadingFinished", (e) => {
    const entry = tab.networkById.get(e.requestId);
    if (!entry) return;
    entry.encodedDataLength = e.encodedDataLength;
    entry.duration = Date.now() - entry.ts;
  });
  cdp.on("Network.loadingFailed", (e) => {
    const entry = tab.networkById.get(e.requestId);
    if (!entry) return;
    entry.failed = true;
    entry.failureText = e.errorText;
    entry.duration = Date.now() - entry.ts;
  });
}

function parseArgs(argv) {
  const out = {
    port: Number(process.env.BROWSER_PORT || 7084),
    host: process.env.BROWSER_HOST || "127.0.0.1",
    // Defaults match the LOW quality preset — responsive over Tailscale beats
    // sharpness for the common case. The canvas's quality toggle bumps it.
    viewportWidth: Number(process.env.BROWSER_VIEWPORT_WIDTH || 800),
    viewportHeight: Number(process.env.BROWSER_VIEWPORT_HEIGHT || 800),
    jpegQuality: Number(process.env.BROWSER_JPEG_QUALITY || 40),
    everyNthFrame: Number(process.env.BROWSER_EVERY_NTH_FRAME || 1)
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--viewport-width") out.viewportWidth = Number(argv[++i]);
    else if (a === "--viewport-height") out.viewportHeight = Number(argv[++i]);
    else if (a === "--jpeg-quality") out.jpegQuality = Number(argv[++i]);
    else if (a === "--every-nth-frame") out.everyNthFrame = Number(argv[++i]);
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

async function findFreePort(startPort) {
  const net = await import("node:net");
  for (let port = startPort; port < startPort + 200; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return null;
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: "browser-default",
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cdpHttpEndpoint,
    cdpWsEndpoint
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

// ─── Chromium lifecycle ──────────────────────────────────────────────────

function resolveFullChromiumBinary() {
  // Playwright's chromium.executablePath() returns the full Chrome-for-Testing
  // binary (not the headless-shell). The headless-shell that Playwright uses
  // internally for headless: true doesn't expose --remote-debugging-port — we
  // bypass Playwright's launch entirely and spawn the full binary ourselves.
  if (process.env.BROWSER_CHROMIUM_PATH) return process.env.BROWSER_CHROMIUM_PATH;
  const exe = chromium.executablePath();
  if (!existsSync(exe)) {
    throw new Error(
      `Chromium binary missing at ${exe}. ` +
      `Run 'npx playwright install chromium' or set BROWSER_CHROMIUM_PATH.`
    );
  }
  return exe;
}

async function waitForCdpReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/json/version", timeout: 1000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chromium CDP did not respond on port ${port} within ${timeoutMs}ms`);
}

async function launchChromium(opts) {
  launchOpts = opts;
  cdpPort = await findFreePort(9222);
  if (cdpPort === null) throw new Error("no free CDP port available");
  cdpHttpEndpoint = `http://127.0.0.1:${cdpPort}`;
  cdpWsEndpoint = `ws://127.0.0.1:${cdpPort}`;

  const exe = resolveFullChromiumBinary();
  // Opt-in PERSISTENT PROFILE: reuse a stable user-data-dir so cookies/consent
  // survive across runs (set GARRISON_BROWSER_PERSISTENT=1, dir overridable via
  // GARRISON_BROWSER_PROFILE_DIR). Default stays an ephemeral temp profile.
  const persistent = process.env.GARRISON_BROWSER_PERSISTENT === "1";
  const userDataDir = persistent
    ? (process.env.GARRISON_BROWSER_PROFILE_DIR
        || path.join(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"), "browser-profile"))
    : await mkdtemp(path.join(tmpdir(), "garrison-browser-"));
  if (persistent) await mkdir(userDataDir, { recursive: true });
  ephemeralProfileDir = persistent ? null : userDataDir;
  // Opt-in STEALTH: reduce headless/automation fingerprints (GARRISON_BROWSER_STEALTH=1).
  const stealth = process.env.GARRISON_BROWSER_STEALTH === "1";

  // Headless-gap fix (GARRISON-UNIFY-V1 S16/E11-adjacent): Ubuntu 23.10+ (and
  // this GCP box) restricts unprivileged user namespaces via AppArmor, so
  // Chromium's sandbox is UNUSABLE and the launch dies with a FATAL "No usable
  // sandbox!". Detect the sandbox-death and retry ONCE with --no-sandbox —
  // an accepted tradeoff for a single-user dev box driving local/dev content
  // (Playwright uses the same flag in containers). Logged loudly.
  const baseArgs = [
    "--headless=new",
    `--remote-debugging-port=${cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--disable-features=IsolateOrigins,site-per-process,TranslateUI",
    "--disable-component-update",
    "--disable-background-networking",
    "--no-startup-window",
    ...(stealth ? ["--disable-blink-features=AutomationControlled"] : [])
  ];

  const launchOnce = (extraArgs) => {
    let sandboxDeath = false;
    const child = spawn(exe, [...baseArgs, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => {
      const line = d.toString();
      if (/No usable sandbox/i.test(line)) sandboxDeath = true;
      // Quiet routine Chromium chatter; surface anything that looks like an error.
      if (/error|fatal|fail/i.test(line)) console.error(`[chromium] ${line.trimEnd()}`);
    });
    child.on("exit", (code, signal) => {
      console.error(`[chromium] exited code=${code} signal=${signal}`);
      if (chromiumChild === child) {
        chromiumChild = null;
        // The browser/context handles are now dead. Drop them so the next openTab
        // relaunches instead of throwing "Target ... has been closed".
        discardChromium();
      }
    });
    return { child, sandboxDied: () => sandboxDeath };
  };

  // Race CDP readiness against child death, so a sandbox FATAL (immediate)
  // fails fast instead of burning the full CDP timeout before the retry.
  const readyOrDead = (child) =>
    Promise.race([
      waitForCdpReady(cdpPort),
      new Promise((_, reject) => child.once("exit", () => reject(new Error("chromium exited before CDP became ready"))))
    ]);

  let attempt = launchOnce(process.env.GARRISON_BROWSER_NO_SANDBOX === "1" ? ["--no-sandbox"] : []);
  chromiumChild = attempt.child;
  try {
    await readyOrDead(attempt.child);
  } catch (err) {
    if (attempt.sandboxDied()) {
      console.error("[chromium] sandbox unusable on this host (AppArmor userns restriction) — relaunching with --no-sandbox (single-user dev box tradeoff)");
      attempt = launchOnce(["--no-sandbox"]);
      chromiumChild = attempt.child;
      await readyOrDead(attempt.child);
    } else {
      throw err;
    }
  }

  browser = await chromium.connectOverCDP(cdpHttpEndpoint);
  browser.on("disconnected", () => {
    console.error("[chromium] CDP connection lost");
    discardChromium();
  });
  context = browser.contexts()[0] || (await browser.newContext({
    viewport: { width: opts.viewportWidth, height: opts.viewportHeight }
  }));

  if (stealth && context) {
    // Mask the most common automation tell (navigator.webdriver) on every page.
    try {
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });
    } catch (err) {
      console.error(`[browser] stealth init failed: ${err.message}`);
    }
  }

  console.log(`[browser] chromium up on rdp port ${cdpPort} (exe=${exe})${persistent ? " [persistent]" : ""}${stealth ? " [stealth]" : ""}`);
}

// Drop all references to a dead/disconnected chromium so the next openTab
// relaunches. Closes any WS clients on the now-defunct tabs so the canvas
// reconnects against the fresh browser instead of streaming a black frame.
function discardChromium() {
  for (const tab of tabs.values()) {
    try { tab.viewportClient?.close(); } catch {}
    for (const ws of tab.inputClients) { try { ws.close(); } catch {} }
  }
  tabs.clear();
  browser = null;
  context = null;
}

// Guarantee a live, connected chromium + context before a tab operation.
// Relaunches if the headless process died (crash, OOM, OS reclaim) or the CDP
// connection dropped — the root cause of "browserContext.newPage: Target page,
// context or browser has been closed".
async function ensureChromium() {
  if (browser && browser.isConnected() && context) return;
  if (!chromiumLaunching) {
    if (chromiumChild) { try { chromiumChild.kill("SIGTERM"); } catch {} chromiumChild = null; }
    discardChromium();
    if (!launchOpts) throw new Error("chromium not initialized");
    chromiumLaunching = launchChromium(launchOpts).finally(() => { chromiumLaunching = null; });
  }
  await chromiumLaunching;
}

async function shutdownChromium() {
  for (const tab of tabs.values()) await cleanupTab(tab).catch(() => {});
  tabs.clear();
  try { await browser?.close(); } catch {}
  if (chromiumChild) {
    try { chromiumChild.kill("SIGTERM"); } catch {}
    chromiumChild = null;
  }
}

// ─── Tab lifecycle ──────────────────────────────────────────────────────

async function openTab(initialUrl) {
  await ensureChromium();
  let page;
  try {
    page = await context.newPage();
  } catch (err) {
    // The CDP connection can drop between ensureChromium and newPage (the
    // headless process gets reaped). Relaunch once and retry before failing.
    if (/has been closed|disconnected|Target closed|Target page/i.test(String(err))) {
      discardChromium();
      await ensureChromium();
      page = await context.newPage();
    } else {
      throw err;
    }
  }
  // Create the CDP session + attach instrumentation BEFORE the initial
  // navigation so first-load console/network events get captured too.
  const cdpSession = await context.newCDPSession(page);
  const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
  const tabId = targetInfo.targetId;

  /** @type {TabState} */
  const tab = {
    tabId,
    page,
    cdpSession,
    requestedUrl: initialUrl || "about:blank",
    lastActivityAt: Date.now(),
    console: [],
    network: [],
    networkById: new Map(),
    viewportClient: null,
    viewportCdp: null,
    viewportTeardownTimer: null,
    pendingAck: null,
    qualityLevel: "low",
    inputClients: new Set(),
    focusedEditable: false,
    focusWatcher: null,
    // Most recent user "pointing" — an element pick or a drawn region — that the
    // Operative session can read via GET /selection (the garrison-browser CLI),
    // so "remove this" resolves to whatever the user marked on the canvas.
    selection: null
  };
  tabs.set(tabId, tab);
  await attachInstrumentation(tab);

  if (initialUrl) {
    try { await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (err) { console.warn(`[browser] goto failed: ${err.message}`); }
  }

  page.on("close", () => { void cleanupTab(tab); });

  // Popups (window.open / target=_blank) are handed to the host's real Chrome by
  // the Page.windowOpen handler. Close the headless popup Chromium spawns so the
  // context doesn't accumulate invisible, un-screencast tabs. This page was not
  // created by openTab, so it's never registered in `tabs` and closing it does
  // not trip cleanupTab for a real tab.
  page.on("popup", async (popup) => {
    try { await popup.close({ runBeforeUnload: false }); } catch {}
  });

  return tab;
}

async function cleanupTab(tab) {
  tabs.delete(tab.tabId);
  if (tab.focusWatcher) clearInterval(tab.focusWatcher);
  if (tab.viewportTeardownTimer) {
    clearTimeout(tab.viewportTeardownTimer);
    tab.viewportTeardownTimer = null;
  }
  if (tab.viewportCdp) {
    try { await tab.viewportCdp.send("Page.stopScreencast"); } catch {}
    try { await tab.viewportCdp.detach(); } catch {}
    tab.viewportCdp = null;
  }
  tab.pendingAck = null;
  try { tab.viewportClient?.close(); } catch {}
  for (const ws of tab.inputClients) { try { ws.close(); } catch {} }
  tab.inputClients.clear();
  try { await tab.cdpSession?.detach(); } catch {}
  try { if (!tab.page.isClosed()) await tab.page.close(); } catch {}
}

async function listTabs() {
  // Parallelize and bound each title() — a page with a jammed main thread
  // (e.g. an app showing a Next.js dev error overlay whose instrumentation
  // is stuck) makes page.title() hang via CDP, which would otherwise block
  // /tabs for every consumer (notably the canvas URL bar polling).
  const titleWithTimeout = async (tab) => {
    try {
      return await Promise.race([
        tab.page.title(),
        new Promise((resolve) => setTimeout(() => resolve(tab.lastKnownTitle || ""), 500))
      ]);
    } catch { return tab.lastKnownTitle || ""; }
  };
  const entries = [...tabs.values()];
  const titles = await Promise.all(entries.map(titleWithTimeout));
  return entries.map((tab, i) => {
    let pageUrl = "";
    try { pageUrl = tab.page.url(); } catch {}
    // Cache the most recent successful title so a subsequently-jammed tab
    // still shows something useful instead of falling back to empty.
    if (titles[i]) tab.lastKnownTitle = titles[i];
    return { tabId: tab.tabId, url: pageUrl, title: titles[i], requestedUrl: tab.requestedUrl };
  });
}

// ─── HTTP handlers ──────────────────────────────────────────────────────

function handleHealth(_req, res, opts) {
  jsonRes(res, 200, {
    ok: true,
    port: opts.port,
    pid: process.pid,
    host: opts.host,
    tabs: tabs.size,
    cdpHttpEndpoint,
    cdpWsEndpoint
  });
}

// Confine navigation to web schemes so a caller cannot pivot the browser to
// file:/chrome:/view-source: and read local files/internal pages back.
function isAllowedNavScheme(u) {
  if (!u || u === "about:blank") return true;
  try {
    const proto = new URL(u).protocol.replace(":", "").toLowerCase();
    return ["http", "https", "about", "data"].includes(proto);
  } catch {
    return false;
  }
}

async function handleListTabs(_req, res) {
  jsonRes(res, 200, { tabs: await listTabs() });
}

async function handleCreateTab(req, res) {
  const body = (await readBody(req)) || {};
  const initialUrl = typeof body.url === "string" ? body.url : "about:blank";
  if (!isAllowedNavScheme(initialUrl)) return jsonRes(res, 400, { error: "navigation scheme not allowed" });
  try {
    const tab = await openTab(initialUrl);
    jsonRes(res, 201, { tabId: tab.tabId, url: tab.page.url() });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleNavigateTab(req, res, tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return jsonRes(res, 404, { error: "tab not found" });
  const body = (await readBody(req)) || {};
  const target = typeof body.url === "string" ? body.url : "";
  if (!target) return jsonRes(res, 400, { error: "url required" });
  if (!isAllowedNavScheme(target)) return jsonRes(res, 400, { error: "navigation scheme not allowed" });
  tab.requestedUrl = target;
  tab.lastActivityAt = Date.now();
  try {
    await tab.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
    jsonRes(res, 200, { ok: true, url: tab.page.url() });
  } catch (err) {
    // Goto can fail (DNS, connection refused, etc.). The page still loads
    // chrome-error://chromewebdata/, but that's a user-visible state — we
    // surface the error message and let the canvas overlay it.
    jsonRes(res, 200, {
      ok: false,
      url: tab.page.url(),
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function handleDeleteTab(_req, res, tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return jsonRes(res, 404, { ok: false });
  await cleanupTab(tab);
  jsonRes(res, 200, { ok: true });
}

async function handleNavAction(_req, res, tabId, action) {
  const tab = tabs.get(tabId);
  if (!tab) return jsonRes(res, 404, { error: "tab not found" });
  tab.lastActivityAt = Date.now();
  try {
    if (action === "back") await tab.page.goBack({ timeout: 5000 }).catch(() => {});
    else if (action === "forward") await tab.page.goForward({ timeout: 5000 }).catch(() => {});
    else if (action === "reload") await tab.page.reload({ timeout: 10000 }).catch(() => {});
    jsonRes(res, 200, { ok: true, url: tab.page.url() });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ─── Inspection endpoints (for the garrison-browser CLI) ─────────────────

function pickActiveTab() {
  let active = null;
  for (const tab of tabs.values()) {
    if (!active || tab.lastActivityAt > active.lastActivityAt) active = tab;
  }
  return active;
}

async function handleActiveTab(_req, res) {
  const tab = pickActiveTab();
  if (!tab) return jsonRes(res, 404, { error: "no tabs open" });
  let pageUrl = "", title = "";
  try { pageUrl = tab.page.url(); } catch {}
  try { title = await tab.page.title(); } catch {}
  jsonRes(res, 200, {
    tabId: tab.tabId,
    url: pageUrl,
    title,
    requestedUrl: tab.requestedUrl,
    lastActivityAt: tab.lastActivityAt
  });
}

async function handleScreenshot(req, res, tabId, query) {
  const tab = tabs.get(tabId);
  if (!tab) return jsonRes(res, 404, { error: "tab not found" });
  const fullPage = query.full === "1" || query.full === "true";
  try {
    const buf = await tab.page.screenshot({ type: "png", fullPage });
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(buf.length));
    res.end(buf);
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function filterBySince(arr, since) {
  if (!since) return arr;
  const t = Number(since);
  if (!Number.isFinite(t)) return arr;
  return arr.filter((e) => e.ts >= t);
}

function handleConsole(_req, res, tabId, query) {
  const tab = tabs.get(tabId);
  if (!tab) return jsonRes(res, 404, { error: "tab not found" });
  let entries = filterBySince(tab.console, query.since);
  if (query.limit) {
    const n = Math.max(1, Math.min(BUFFER_LIMIT, Number(query.limit) || 0));
    entries = entries.slice(-n);
  }
  jsonRes(res, 200, { entries });
}

function handleNetwork(_req, res, tabId, query) {
  const tab = tabs.get(tabId);
  if (!tab) return jsonRes(res, 404, { error: "tab not found" });
  let entries = filterBySince(tab.network, query.since);
  if (query.filter) {
    const f = String(query.filter).toLowerCase();
    entries = entries.filter((e) =>
      e.url.toLowerCase().includes(f) ||
      (e.resourceType || "").toLowerCase().includes(f) ||
      (e.method || "").toLowerCase() === f
    );
  }
  if (query.status === "error") {
    entries = entries.filter((e) => e.failed || (e.status && e.status >= 400));
  }
  if (query.limit) {
    const n = Math.max(1, Math.min(BUFFER_LIMIT, Number(query.limit) || 0));
    entries = entries.slice(-n);
  }
  jsonRes(res, 200, { entries });
}

async function handleNetworkBody(_req, res, tabId, requestId) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.cdpSession) return jsonRes(res, 404, { error: "tab not found" });
  try {
    const { body, base64Encoded } = await tab.cdpSession.send(
      "Network.getResponseBody", { requestId }
    );
    jsonRes(res, 200, { body, base64Encoded });
  } catch (err) {
    jsonRes(res, 404, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleDom(_req, res, tabId, query) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.cdpSession) return jsonRes(res, 404, { error: "tab not found" });
  const selector = typeof query.selector === "string" ? query.selector : "";
  const expr = selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : null; })()`
    : `document.documentElement.outerHTML`;
  try {
    const { result } = await tab.cdpSession.send("Runtime.evaluate", {
      expression: expr, returnByValue: true
    });
    if (result?.value == null) return jsonRes(res, 404, { error: "selector matched nothing" });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(String(result.value));
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Post-action OBSERVATION envelope: the fingerprint inputs (url/title/heading +
// DOM-shape counts + viewport) the Automations orchestration layer keys its
// action cache on, plus optional a11y snapshot + screenshot for vision. ?a11y=1
// includes the accessibility tree; ?screenshot=1 includes a base64 JPEG.
async function handleObserve(_req, res, tabId, query) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.page) return jsonRes(res, 404, { error: "tab not found" });
  try {
    const page = tab.page;
    const pageUrl = page.url();
    const title = await page.title();
    const parts = await page.evaluate(() => {
      const h = document.querySelector("h1,h2");
      const headingText = h ? (h.textContent || "").trim().slice(0, 300) : "";
      const counts = {};
      for (const el of document.querySelectorAll("*")) {
        const t = el.tagName.toLowerCase();
        counts[t] = (counts[t] || 0) + 1;
        const r = el.getAttribute && el.getAttribute("role");
        if (r) counts["role:" + r] = (counts["role:" + r] || 0) + 1;
      }
      counts["__landmarks"] = document.querySelectorAll("main,nav,header,footer,aside,form").length;
      return { headingText, counts };
    });
    const shapeSketch = Object.entries(parts.counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
    const vp = page.viewportSize() || { width: 0, height: 0 };
    const observation = { url: pageUrl, title, headingText: parts.headingText, shapeSketch, viewport: { w: vp.width, h: vp.height } };
    if (query && query.a11y === "1") {
      observation.a11y = await accessibilityTree(tab);
    }
    if (query && query.screenshot === "1") {
      const buf = await page.screenshot({ type: "jpeg", quality: 50 });
      observation.screenshotB64 = buf.toString("base64");
    }
    jsonRes(res, 200, observation);
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Accessibility tree via CDP (page.accessibility was removed in modern
// Playwright). Returns a compact [{role,name}] list — enough for vision/fixer
// grounding without dumping the whole tree.
async function accessibilityTree(tab) {
  if (!tab.cdpSession) return [];
  try {
    await tab.cdpSession.send("Accessibility.enable");
    const { nodes } = await tab.cdpSession.send("Accessibility.getFullAXTree");
    return (nodes || [])
      .map((n) => ({ role: n.role?.value, name: n.name?.value }))
      .filter((n) => n.role && n.role !== "none" && n.role !== "generic")
      .slice(0, 200);
  } catch {
    return [];
  }
}

async function handleA11y(_req, res, tabId) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.cdpSession) return jsonRes(res, 404, { error: "tab not found" });
  jsonRes(res, 200, { a11y: await accessibilityTree(tab) });
}

// Locator fallback ladder (ported from ekoa's executor): resolve a vision/cache
// action to a Playwright locator by the strongest available hint.
function resolveActionLocator(page, a) {
  if (a.selector) return page.locator(a.selector).first();
  if (a.role && a.name) return page.getByRole(a.role, { name: a.name }).first();
  if (a.testId) return page.getByTestId(a.testId).first();
  if (a.label) return page.getByLabel(a.label).first();
  if (a.placeholder) return page.getByPlaceholder(a.placeholder).first();
  if (a.text) return page.getByText(a.text).first();
  if (a.role) return page.getByRole(a.role).first();
  throw new Error("action has no locator hint (selector/role+name/testId/label/placeholder/text)");
}

// Execute a resolved Playwright action — the orchestration layer's cache/vision
// decides WHAT; the Browser fitting (which holds the Page) runs it.
async function handleExecute(req, res, tabId) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.page) return jsonRes(res, 404, { error: "tab not found" });
  const body = (await readBody(req)) || {};
  const action = body.action ?? body;
  const page = tab.page;
  try {
    const kind = action.kind || "click";
    if (kind === "press") {
      await page.keyboard.press(action.value ?? "Enter");
    } else {
      const loc = resolveActionLocator(page, action);
      if (kind === "click") await loc.click({ timeout: action.timeoutMs ?? 8000 });
      else if (kind === "fill") await loc.fill(String(action.value ?? ""), { timeout: action.timeoutMs ?? 8000 });
      else if (kind === "select") await loc.selectOption(action.value);
      else if (kind === "check") await loc.check({ timeout: action.timeoutMs ?? 8000 });
      else if (kind === "hover") await loc.hover({ timeout: action.timeoutMs ?? 8000 });
      else throw new Error(`unknown action kind: ${kind}`);
    }
    jsonRes(res, 200, { ok: true });
  } catch (err) {
    jsonRes(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function handleGetSelection(_req, res, tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return jsonRes(res, 404, { error: "tab not found" });
  jsonRes(res, 200, { selection: tab.selection });
}

function handleClearSelection(_req, res, tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return jsonRes(res, 404, { error: "tab not found" });
  tab.selection = null;
  broadcastToInput(tab, { type: "selection", selection: null });
  jsonRes(res, 200, { ok: true });
}

async function handleEval(req, res, tabId) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.cdpSession) return jsonRes(res, 404, { error: "tab not found" });
  const body = (await readBody(req)) || {};
  const js = typeof body.js === "string" ? body.js : "";
  if (!js) return jsonRes(res, 400, { error: "js required" });
  try {
    // Pass JS through unmodified. CDP's Runtime.evaluate returns the value of
    // the last expression statement — same semantics as Chrome DevTools console.
    // For multi-statement JS use `;`-separated input; for async work wrap in
    // an IIFE returning a Promise.
    const { result, exceptionDetails } = await tab.cdpSession.send("Runtime.evaluate", {
      expression: js,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      replMode: true  // makes the input behave like the console (top-level await OK)
    });
    if (exceptionDetails) {
      return jsonRes(res, 200, {
        ok: false,
        error: exceptionDetails.text || exceptionDetails.exception?.description || "eval failed"
      });
    }
    jsonRes(res, 200, { ok: true, value: result?.value, type: result?.type });
  } catch (err) {
    jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

// Reverse-proxy /devtools/* to Chromium's rdp HTTP server. This serves the
// official Chrome DevTools frontend (inspector.html and all its asset bundles)
// from our origin so clients on the Tailnet can load it without bypassing the
// Fitting.
function proxyDevtools(req, res) {
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: cdpPort,
    path: req.url || "/",
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${cdpPort}` }
  }, (upRes) => {
    if (res.headersSent) return;
    // writeHead after CORS setHeader() merges; passing upstream headers wholesale
    // would clobber our CORS headers, so re-apply them on top.
    const merged = { ...upRes.headers };
    merged["access-control-allow-origin"] = "*";
    merged["access-control-allow-methods"] = "GET, POST, DELETE, OPTIONS";
    merged["access-control-allow-headers"] = "Content-Type";
    res.writeHead(upRes.statusCode || 502, merged);
    upRes.pipe(res);
  });
  upstream.on("error", (err) => {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain");
    res.end(`devtools proxy error: ${err.message}`);
  });
  req.on("error", () => { try { upstream.destroy(); } catch {} });
  req.pipe(upstream);
}

function serveStatic(req, res, distDir) {
  let pathname = url.parse(req.url || "/").pathname || "/";
  // SPA fallback: route /canvas/:tabId, /devtools-shell/:tabId and / to
  // index.html. (/devtools-shell/ does not collide with the /devtools/ CDP
  // proxy — that branch matches "/devtools/" with the trailing slash.)
  if (pathname === "/" || pathname.startsWith("/canvas/") || pathname.startsWith("/devtools-shell/")) pathname = "/index.html";
  const filePath = path.join(distDir, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(distDir)) { res.statusCode = 403; return res.end("forbidden"); }
  if (!existsSync(filePath)) {
    const idx = path.join(distDir, "index.html");
    if (existsSync(idx)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      return res.end(readFileSync(idx));
    }
    res.statusCode = 404;
    return res.end("not found");
  }
  const ext = path.extname(filePath).toLowerCase();
  const ct = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".map": "application/json"
  };
  res.statusCode = 200;
  res.setHeader("Content-Type", ct[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
}

// ─── WebSocket handlers ─────────────────────────────────────────────────

// 15s ping; two missed pongs → terminate. Survives iOS Safari's habit of
// silently killing idle WS without close events.
function setupHeartbeat(ws, label) {
  ws._alive = true;
  ws.on("pong", () => { ws._alive = true; });
  ws._hbTimer = setInterval(() => {
    if (!ws._alive) {
      // TEMP: swap-timing — attribute heartbeat terminates to a label.
      console.log(`[swap-timing] heartbeat timeout, terminating ${label || "(unlabeled)"}`);
      // Self-clear the interval here — if terminate() doesn't fire a close
      // event (which can happen when a server-initiated close() leaves the
      // ws stuck in CLOSING), the interval would otherwise keep firing
      // every HEARTBEAT_MS forever.
      if (ws._hbTimer) { clearInterval(ws._hbTimer); ws._hbTimer = null; }
      try { ws.terminate(); } catch {}
      return;
    }
    ws._alive = false;
    try { ws.ping(); } catch {}
  }, HEARTBEAT_MS);
  ws.on("close", () => {
    if (ws._hbTimer) { clearInterval(ws._hbTimer); ws._hbTimer = null; }
  });
}

function bindViewportClient(ws, tab) {
  tab.viewportClient = ws;
  setupHeartbeat(ws, `viewport tabId=${tab.tabId}`);
  ws.on("close", () => {
    if (tab.viewportClient !== ws) return;
    tab.viewportClient = null;
    // Defer CDP teardown by VIEWPORT_GRACE_MS — a quick reconnect (Safari
    // refresh, tab swap, network blip) cancels the timer and reuses the
    // existing screencast session.
    if (tab.viewportTeardownTimer) clearTimeout(tab.viewportTeardownTimer);
    tab.viewportTeardownTimer = setTimeout(async () => {
      tab.viewportTeardownTimer = null;
      if (tab.viewportClient) return; // someone reconnected in time
      if (tab.viewportCdp) {
        try { await tab.viewportCdp.send("Page.stopScreencast"); } catch {}
        try { await tab.viewportCdp.detach(); } catch {}
        tab.viewportCdp = null;
      }
      tab.pendingAck = null;
    }, VIEWPORT_GRACE_MS);
  });
}

async function attachViewport(ws, tab, _opts) {
  // TEMP: swap-timing instrumentation.
  const t0 = Date.now();
  const warm = !!tab.viewportCdp;
  console.log(`[swap-timing] attachViewport tabId=${tab.tabId} ${warm ? "WARM (cdp reused)" : "COLD (new cdp)"}`);

  // Connecting a viewport means a user is now LOOKING at this tab — bump
  // activity so /active-tab and `garrison-browser` default to it.
  tab.lastActivityAt = Date.now();

  // Replace an existing live viewer (rare — usually only one client at a time).
  // Use terminate() not close() — close() waits for a peer ack that may never
  // arrive if the old client already navigated away, leaving the ws stuck in
  // CLOSING with its heartbeat timer still firing every 15s.
  if (tab.viewportClient && tab.viewportClient !== ws) {
    const old = tab.viewportClient;
    if (old._hbTimer) { clearInterval(old._hbTimer); old._hbTimer = null; }
    try { old.terminate(); } catch {}
    tab.viewportClient = null;
  }

  // Cancel any pending grace teardown — the CDP session is still alive.
  if (tab.viewportTeardownTimer) {
    clearTimeout(tab.viewportTeardownTimer);
    tab.viewportTeardownTimer = null;
  }

  if (!tab.viewportCdp) {
    // Fresh attach: create the CDP session and wire the frame listener.
    const cdp = await context.newCDPSession(tab.page);
    tab.viewportCdp = cdp;
    // TEMP: swap-timing — first frame after every (re)start. Reset on restart.
    tab.firstFrameLogged = false;
    // Frame listener: send binary JPEG bytes; stash the ACK for the client to
    // confirm via the input WS. This is the backpressure spine — Chromium
    // pauses encoding until the client says it drew the frame.
    cdp.on("Page.screencastFrame", (params) => {
      const sock = tab.viewportClient;
      if (sock && sock.readyState === WebSocket.OPEN) {
        try { sock.send(Buffer.from(params.data, "base64")); } catch {}
      }
      tab.pendingAck = { sessionId: params.sessionId, ts: Date.now() };
      // TEMP: swap-timing — first frame after most recent restart.
      if (!tab.firstFrameLogged) {
        tab.firstFrameLogged = true;
        const elapsed = tab.lastRestartAt ? Date.now() - tab.lastRestartAt : -1;
        console.log(`[swap-timing] first screencastFrame tabId=${tab.tabId} +${elapsed}ms since restart, ${Buffer.byteLength(params.data, "base64")} bytes`);
      }
    });
    console.log(`[swap-timing] CDP session created tabId=${tab.tabId} +${Date.now() - t0}ms`);
  }

  bindViewportClient(ws, tab);
  // Start (or restart) the screencast — guarantees Chromium pushes a fresh
  // first-frame from the current page state, so static-page reattach doesn't
  // sit blank. Idempotent: on a CDP session that already had a screencast,
  // Chromium resets and re-emits.
  await restartScreencast(tab);
  console.log(`[swap-timing] attachViewport done tabId=${tab.tabId} total +${Date.now() - t0}ms`);
}

function restartScreencast(tab) {
  // Serialize per tab: under rapid swaps, attachViewport's restart and
  // applyQuality's restart can both fire and interleave Page.stop/start on
  // the same CDP session, stretching into multi-second outliers that jam
  // the event loop and trigger heartbeat-driven disconnects.
  const prior = tab.restartChain || Promise.resolve();
  const next = prior.then(() => doRestartScreencast(tab)).catch(() => {});
  tab.restartChain = next;
  return next;
}

async function doRestartScreencast(tab) {
  if (!tab.viewportCdp) return;
  // Any stale ACK held from a prior session is for a sessionId Chromium no
  // longer knows — drop it before restarting.
  tab.pendingAck = null;
  // TEMP: swap-timing — anchor for "first frame since restart" log.
  const t0 = Date.now();
  tab.lastRestartAt = t0;
  tab.firstFrameLogged = false;
  const preset = QUALITY_PRESETS[tab.qualityLevel] || QUALITY_PRESETS.low;
  try {
    // Best-effort stop; ignored if not currently running. Stop+start is the
    // cleanest way to nudge Chromium to emit a fresh first-frame without
    // touching device metrics (which would race with the client's viewport
    // push and squish the rendered page).
    try { await tab.viewportCdp.send("Page.stopScreencast"); } catch {}
    console.log(`[swap-timing] Page.stopScreencast done tabId=${tab.tabId} +${Date.now() - t0}ms`);
    await tab.viewportCdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: preset.jpegQuality,
      maxWidth: preset.viewportWidth,
      maxHeight: preset.viewportHeight,
      everyNthFrame: preset.everyNthFrame
    });
    console.log(`[swap-timing] Page.startScreencast done tabId=${tab.tabId} +${Date.now() - t0}ms`);
  } catch (err) {
    console.warn(`[browser] startScreencast failed: ${err.message}`);
  }
}

async function applyQuality(tab, level) {
  const preset = QUALITY_PRESETS[level];
  if (!preset) return;
  // Client sends a quality message on every input-WS open even when nothing
  // changed. Dedupe — restarting the screencast for a same-level "change"
  // doubles up with attachViewport's restart and starves the CDP under
  // rapid tab swaps.
  if (tab.qualityLevel === level && tab.viewportCdp) return;
  tab.qualityLevel = level;
  await restartScreencast(tab);
}

// ─── Selection (element pick / region draw) ─────────────────────────────
//
// The canvas can put the page into a "pick" or "region" mode. The client
// forwards the cursor; the server hit-tests the page (elementFromPoint) and
// reports a box + synthesised CSS selector so the canvas can highlight. On
// commit it captures the element/region — selector, text, outerHTML, a cropped
// PNG — into tab.selection, which the Operative reads via `garrison-browser
// selection`. This is how "remove this" resolves without the user describing it.

// In-page helpers, embedded into each Runtime.evaluate. Build a short, mostly
// stable CSS path and a human label/text for an element.
const SELECTION_HELPERS = `
  function __gEsc(s){ try { return CSS.escape(s); } catch(e){ return String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); } }
  function __gSel(e){
    if(!e||e.nodeType!==1) return '';
    if(e.id) return '#'+__gEsc(e.id);
    var s=e.tagName.toLowerCase();
    var cls=(e.getAttribute('class')||'').trim().split(/\\s+/).filter(Boolean).slice(0,3);
    if(cls.length) s+='.'+cls.map(__gEsc).join('.');
    var p=e.parentElement;
    if(p){ var same=Array.prototype.filter.call(p.children,function(c){return c.tagName===e.tagName;}); if(same.length>1){ s+=':nth-of-type('+(Array.prototype.indexOf.call(p.children,e)+1)+')'; } }
    return s;
  }
  function __gPath(e){
    var parts=[],cur=e,depth=0;
    while(cur&&cur.nodeType===1&&cur!==document.body&&cur!==document.documentElement&&depth<5){
      parts.unshift(__gSel(cur));
      if(cur.id) break;
      cur=cur.parentElement; depth++;
    }
    return parts.join(' > ');
  }
  function __gLabel(e){
    var cls=(e.getAttribute('class')||'').trim();
    return e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+(cls?'.'+cls.split(/\\s+/).slice(0,2).join('.'):'');
  }
  function __gText(e){ return (e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim(); }
`;

function elementInfoExpr(x, y) {
  return `(function(){${SELECTION_HELPERS}
    var el=document.elementFromPoint(${Number(x)},${Number(y)});
    if(!el||el===document.body||el===document.documentElement) return null;
    var r=el.getBoundingClientRect();
    return { box:{x:r.x,y:r.y,w:r.width,h:r.height}, label:__gLabel(el), text:__gText(el).slice(0,160),
      selector:__gPath(el), html:el.outerHTML.slice(0,2000), scrollX:window.scrollX, scrollY:window.scrollY };
  })()`;
}

function regionInfoExpr(x, y, w, h) {
  return `(function(){${SELECTION_HELPERS}
    var R={x:${Number(x)},y:${Number(y)},w:${Number(w)},h:${Number(h)}};
    var out=[],seen={};
    var all=document.body?document.body.querySelectorAll('*'):[];
    for(var i=0;i<all.length;i++){
      var el=all[i],r=el.getBoundingClientRect();
      if(r.width===0||r.height===0) continue;
      var ix=Math.min(r.right,R.x+R.w)-Math.max(r.left,R.x);
      var iy=Math.min(r.bottom,R.y+R.h)-Math.max(r.top,R.y);
      if(ix<=0||iy<=0) continue;
      if((ix*iy)/(r.width*r.height)<0.6) continue;
      var interactive=/^(A|BUTTON|INPUT|SELECT|TEXTAREA|IMG|SVG|LABEL|H1|H2|H3|H4|LI|TD|TH|P|SPAN)$/.test(el.tagName);
      var text=__gText(el);
      if(!interactive&&!text) continue;
      var sel=__gPath(el);
      if(seen[sel]) continue; seen[sel]=1;
      out.push({selector:sel,label:__gLabel(el),text:text.slice(0,60)});
      if(out.length>=20) break;
    }
    return { elements:out, scrollX:window.scrollX, scrollY:window.scrollY };
  })()`;
}

async function evalValue(tab, expression) {
  if (!tab.cdpSession) return null;
  try {
    const { result } = await tab.cdpSession.send("Runtime.evaluate", { expression, returnByValue: true });
    return result?.value ?? null;
  } catch (err) {
    console.warn(`[browser] selection eval failed: ${err.message}`);
    return null;
  }
}

// Crop a box (viewport CSS px + page scroll) to a PNG the Operative can Read.
// One stable path per tab so the latest selection always overwrites the last.
async function captureSelectionCrop(tab, box, scrollX = 0, scrollY = 0) {
  if (!tab.cdpSession) return null;
  const pad = 6;
  const clip = {
    x: Math.max(0, box.x + scrollX - pad),
    y: Math.max(0, box.y + scrollY - pad),
    width: Math.max(1, box.w + pad * 2),
    height: Math.max(1, box.h + pad * 2),
    scale: 1
  };
  try {
    const { data } = await tab.cdpSession.send("Page.captureScreenshot", {
      format: "png", clip, captureBeyondViewport: true
    });
    const file = path.join(tmpdir(), `garrison-browser-selection-${tab.tabId}.png`);
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  } catch (err) {
    console.warn(`[browser] selection crop failed: ${err.message}`);
    return null;
  }
}

function broadcastToInput(tab, payload) {
  const data = JSON.stringify(payload);
  for (const ws of tab.inputClients) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(data); } catch {} }
  }
}

async function commitElementSelection(tab, x, y) {
  const info = await evalValue(tab, elementInfoExpr(x, y));
  if (!info) return;
  const screenshotPath = await captureSelectionCrop(tab, info.box, info.scrollX, info.scrollY);
  let pageUrl = ""; try { pageUrl = tab.page.url(); } catch {}
  tab.selection = {
    kind: "element",
    selector: info.selector,
    label: info.label,
    text: info.text,
    html: info.html,
    box: info.box,
    url: pageUrl,
    ts: Date.now(),
    screenshotPath
  };
  tab.lastActivityAt = Date.now();
  broadcastToInput(tab, { type: "selection", selection: publicSelection(tab.selection) });
}

async function commitRegionSelection(tab, box) {
  const info = await evalValue(tab, regionInfoExpr(box.x, box.y, box.w, box.h)) || { elements: [], scrollX: 0, scrollY: 0 };
  const screenshotPath = await captureSelectionCrop(tab, box, info.scrollX, info.scrollY);
  let pageUrl = ""; try { pageUrl = tab.page.url(); } catch {}
  tab.selection = {
    kind: "region",
    box,
    elements: info.elements || [],
    url: pageUrl,
    ts: Date.now(),
    screenshotPath
  };
  tab.lastActivityAt = Date.now();
  broadcastToInput(tab, { type: "selection", selection: publicSelection(tab.selection) });
}

// Slim view pushed to the canvas (it doesn't need the full outerHTML).
function publicSelection(sel) {
  if (!sel) return null;
  return { kind: sel.kind, label: sel.label, text: sel.text, box: sel.box,
    count: sel.elements ? sel.elements.length : undefined };
}

async function attachInput(ws, tab) {
  tab.inputClients.add(ws);
  setupHeartbeat(ws, `input tabId=${tab.tabId}`);
  if (!tab.focusWatcher) startFocusWatcher(tab);

  // Send current focus state immediately.
  try {
    ws.send(JSON.stringify({ type: "focusedField", editable: tab.focusedEditable }));
  } catch {}

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    // Client-driven ACK: the client's RAF-throttled signal that the frame was
    // drawn. We hold off Page.screencastFrameAck until this arrives.
    if (msg.type === "ack") {
      if (tab.pendingAck && tab.viewportCdp) {
        const ack = tab.pendingAck;
        tab.pendingAck = null;
        try { await tab.viewportCdp.send("Page.screencastFrameAck", { sessionId: ack.sessionId }); } catch {}
      }
      return;
    }
    if (msg.type === "quality") {
      await applyQuality(tab, msg.level);
      return;
    }
    // Selection modes — pick an element or draw a region for the Operative.
    if (msg.type === "pick-hover") {
      const info = await evalValue(tab, elementInfoExpr(Number(msg.x) || 0, Number(msg.y) || 0));
      try { ws.send(JSON.stringify({ type: "pick-target", target: info && { box: info.box, label: info.label, text: info.text, selector: info.selector } })); } catch {}
      return;
    }
    if (msg.type === "pick-commit") {
      await commitElementSelection(tab, Number(msg.x) || 0, Number(msg.y) || 0);
      return;
    }
    if (msg.type === "region-commit") {
      const box = {
        x: Number(msg.x) || 0, y: Number(msg.y) || 0,
        w: Math.max(1, Number(msg.w) || 0), h: Math.max(1, Number(msg.h) || 0)
      };
      await commitRegionSelection(tab, box);
      return;
    }
    if (msg.type === "selection-clear") {
      tab.selection = null;
      broadcastToInput(tab, { type: "selection", selection: null });
      return;
    }
    await dispatchInput(tab, msg);
  });

  ws.on("close", () => {
    tab.inputClients.delete(ws);
    if (tab.inputClients.size === 0 && tab.focusWatcher) {
      clearInterval(tab.focusWatcher);
      tab.focusWatcher = null;
    }
  });
}

async function dispatchInput(tab, msg) {
  if (!tab.cdpSession) return;
  if (msg.type === "mouse" && msg.event === "mousePressed") {
    tab.lastActivityAt = Date.now();
  }
  try {
    switch (msg.type) {
      case "mouse":
        await tab.cdpSession.send("Input.dispatchMouseEvent", {
          type: msg.event, // mousePressed | mouseReleased | mouseMoved | mouseWheel
          x: msg.x, y: msg.y,
          button: msg.button || "none",
          buttons: msg.buttons || 0,
          clickCount: msg.clickCount || 0,
          modifiers: msg.modifiers || 0,
          ...(msg.event === "mouseWheel" ? { deltaX: msg.deltaX || 0, deltaY: msg.deltaY || 0 } : {})
        });
        break;
      case "key":
        await tab.cdpSession.send("Input.dispatchKeyEvent", {
          type: msg.event, // keyDown | keyUp | char | rawKeyDown
          modifiers: msg.modifiers || 0,
          text: msg.text,
          unmodifiedText: msg.unmodifiedText,
          key: msg.key,
          code: msg.code,
          windowsVirtualKeyCode: msg.windowsVirtualKeyCode,
          nativeVirtualKeyCode: msg.nativeVirtualKeyCode,
          autoRepeat: msg.autoRepeat
        });
        break;
      case "touch":
        await tab.cdpSession.send("Input.dispatchTouchEvent", {
          type: msg.event, // touchStart | touchMove | touchEnd | touchCancel
          touchPoints: msg.touchPoints || [],
          modifiers: msg.modifiers || 0
        });
        break;
      case "insertText":
        await tab.cdpSession.send("Input.insertText", { text: msg.text || "" });
        break;
      case "viewport": {
        // Resize the page viewport to match the client's display area so the
        // rendered content fits naturally (no CSS stretching). Bounded so a
        // typo doesn't allocate gigabytes.
        const w = Math.max(320, Math.min(3840, Math.round(Number(msg.width) || 0)));
        const h = Math.max(240, Math.min(2400, Math.round(Number(msg.height) || 0)));
        const dpr = Math.max(1, Math.min(3, Math.round(Number(msg.devicePixelRatio) || 1)));
        if (!w || !h) break;
        try {
          await tab.cdpSession.send("Emulation.setDeviceMetricsOverride", {
            width: w,
            height: h,
            deviceScaleFactor: dpr,
            mobile: false
          });
        } catch (err) {
          console.warn(`[browser] setDeviceMetricsOverride failed: ${err.message}`);
        }
        break;
      }
    }
  } catch (err) {
    console.warn(`[browser] input dispatch failed: ${err.message}`);
  }
}

function startFocusWatcher(tab) {
  // Poll for focused-element editability change so the iPad client can sync
  // its hidden <input> focus state. ~250ms is responsive enough for taps
  // and cheap enough to leave on while any input client is connected.
  tab.focusWatcher = setInterval(async () => {
    if (!tab.cdpSession || tab.inputClients.size === 0) return;
    try {
      const { result } = await tab.cdpSession.send("Runtime.evaluate", {
        expression: `(() => { const el = document.activeElement; if (!el) return false; const tag = el.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true; if (el.isContentEditable) return true; return false; })()`,
        returnByValue: true
      });
      const editable = Boolean(result?.value);
      if (editable !== tab.focusedEditable) {
        tab.focusedEditable = editable;
        const payload = JSON.stringify({ type: "focusedField", editable });
        for (const ws of tab.inputClients) {
          if (ws.readyState === WebSocket.OPEN) { try { ws.send(payload); } catch {} }
        }
      }
    } catch {}
  }, 250);
}

function attachRawCdp(ws, tab) {
  // Raw CDP passthrough: open our own WS to Chromium's per-page debug WS and
  // forward frames in both directions.
  const upstreamUrl = `${cdpWsEndpoint}/devtools/page/${tab.tabId}`;
  const upstream = new WebSocket(upstreamUrl, { headers: { Origin: cdpWsEndpoint } });

  const flush = () => { try { ws.close(); } catch {} try { upstream.close(); } catch {} };

  upstream.on("open", () => {
    ws.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        try { upstream.send(data, { binary: isBinary }); } catch {}
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(data, { binary: isBinary }); } catch {}
      }
    });
  });
  upstream.on("error", flush);
  upstream.on("close", flush);
  ws.on("close", flush);
  ws.on("error", flush);
}

// ─── Server bootstrap ───────────────────────────────────────────────────

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "..", "dist");
  const free = await findFreePort(opts.port);
  if (free === null) { console.error(`[browser] no free port from ${opts.port}`); process.exit(1); }
  const liveOpts = { ...opts, port: free };

  await launchChromium(liveOpts);

  const server = createServer(async (req, res) => {
    try {
      // CSRF defense: this localhost service can drive a real browser + read page
      // content, so a malicious webpage in the user's browser must NOT be able to
      // POST to it. Reject any request carrying a CROSS-ORIGIN (non-loopback)
      // Origin. Server-to-server callers (the Automations/dev-env fetch) send no
      // Origin; the same-origin canvas sends a loopback Origin — both allowed.
      const reqOrigin = req.headers.origin;
      if (reqOrigin) {
        let loopback = false;
        try {
          const h = new URL(reqOrigin).hostname;
          loopback = h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
        } catch { loopback = false; }
        if (!loopback) {
          res.statusCode = 403;
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ error: "cross-origin forbidden" }));
        }
        res.setHeader("Access-Control-Allow-Origin", reqOrigin);
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }

      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      if (pathname === "/health") return handleHealth(req, res, liveOpts);
      if (pathname === "/tabs" && method === "GET") return await handleListTabs(req, res);
      if (pathname === "/tabs" && method === "POST") return await handleCreateTab(req, res);

      const navMatch = pathname.match(/^\/tabs\/([^/]+)\/nav$/);
      if (navMatch && method === "POST") return await handleNavigateTab(req, res, decodeURIComponent(navMatch[1]));

      const actMatch = pathname.match(/^\/tabs\/([^/]+)\/(back|forward|reload)$/);
      if (actMatch && method === "POST") return await handleNavAction(req, res, decodeURIComponent(actMatch[1]), actMatch[2]);

      if (pathname === "/active-tab" && method === "GET") return await handleActiveTab(req, res);

      const shotMatch = pathname.match(/^\/tabs\/([^/]+)\/screenshot$/);
      if (shotMatch && method === "GET") return await handleScreenshot(req, res, decodeURIComponent(shotMatch[1]), parsed.query);

      const conMatch = pathname.match(/^\/tabs\/([^/]+)\/console$/);
      if (conMatch && method === "GET") return handleConsole(req, res, decodeURIComponent(conMatch[1]), parsed.query);

      const netBodyMatch = pathname.match(/^\/tabs\/([^/]+)\/network\/([^/]+)\/body$/);
      if (netBodyMatch && method === "GET") return await handleNetworkBody(req, res, decodeURIComponent(netBodyMatch[1]), decodeURIComponent(netBodyMatch[2]));

      const netMatch = pathname.match(/^\/tabs\/([^/]+)\/network$/);
      if (netMatch && method === "GET") return handleNetwork(req, res, decodeURIComponent(netMatch[1]), parsed.query);

      const domMatch = pathname.match(/^\/tabs\/([^/]+)\/dom$/);
      if (domMatch && method === "GET") return await handleDom(req, res, decodeURIComponent(domMatch[1]), parsed.query);
      const obsMatch = pathname.match(/^\/tabs\/([^/]+)\/(observe|fingerprint)$/);
      if (obsMatch && method === "GET") return await handleObserve(req, res, decodeURIComponent(obsMatch[1]), parsed.query);
      const a11yMatch = pathname.match(/^\/tabs\/([^/]+)\/a11y$/);
      if (a11yMatch && method === "GET") return await handleA11y(req, res, decodeURIComponent(a11yMatch[1]));
      const execMatch = pathname.match(/^\/tabs\/([^/]+)\/execute$/);
      if (execMatch && method === "POST") return await handleExecute(req, res, decodeURIComponent(execMatch[1]));

      const evalMatch = pathname.match(/^\/tabs\/([^/]+)\/eval$/);
      if (evalMatch && method === "POST") return await handleEval(req, res, decodeURIComponent(evalMatch[1]));

      const selMatch = pathname.match(/^\/tabs\/([^/]+)\/selection$/);
      if (selMatch && method === "GET") return handleGetSelection(req, res, decodeURIComponent(selMatch[1]));
      if (selMatch && method === "DELETE") return handleClearSelection(req, res, decodeURIComponent(selMatch[1]));

      const delMatch = pathname.match(/^\/tabs\/([^/]+)$/);
      if (delMatch && method === "DELETE") return await handleDeleteTab(req, res, decodeURIComponent(delMatch[1]));

      if (pathname.startsWith("/devtools/") || pathname === "/devtools") return proxyDevtools(req, res);

      return serveStatic(req, res, distDir);
    } catch (err) {
      jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = url.parse(request.url || "/");
    if (!pathname) { socket.destroy(); return; }
    const route =
      pathname.match(/^\/viewport\/([^/]+)$/) ? { kind: "viewport", tabId: RegExp.$1 } :
      pathname.match(/^\/input\/([^/]+)$/) ? { kind: "input", tabId: RegExp.$1 } :
      pathname.match(/^\/cdp\/([^/]+)$/) ? { kind: "cdp", tabId: RegExp.$1 } :
      null;
    if (!route) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // CSRF defense for the drivable WS surfaces (/input drives the browser): reject
    // a cross-origin (non-loopback) Origin, same as the HTTP guard.
    const wsOrigin = request.headers.origin;
    if (wsOrigin) {
      let loopback = false;
      try {
        const h = new URL(wsOrigin).hostname;
        loopback = h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
      } catch { loopback = false; }
      if (!loopback) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const tab = tabs.get(decodeURIComponent(route.tabId));
      if (!tab) {
        try { ws.send(JSON.stringify({ type: "error", message: "tab not found" })); } catch {}
        ws.close();
        return;
      }
      // TEMP: swap-timing — WS upgrade arrival.
      console.log(`[swap-timing] WS upgrade kind=${route.kind} tabId=${tab.tabId}`);
      if (route.kind === "viewport") void attachViewport(ws, tab, liveOpts);
      else if (route.kind === "input") void attachInput(ws, tab);
      else if (route.kind === "cdp") attachRawCdp(ws, tab);
    });
  });

  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[browser] listening on http://${liveOpts.host}:${liveOpts.port}`);
      console.log(`[browser]   devtools at http://${liveOpts.host}:${liveOpts.port}/devtools/inspector.html`);
      resolve();
    });
  });

  const shutdown = async (signal) => {
    console.log(`[browser] shutdown (${signal})`);
    await shutdownChromium();
    await clearStatusFile();
    // Remove the ephemeral profile so the default leaves no cookies/session behind.
    if (ephemeralProfileDir) {
      await rm(ephemeralProfileDir, { recursive: true, force: true }).catch(() => {});
      ephemeralProfileDir = null;
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { server, options: liveOpts };
}

const isDirect = (() => {
  if (!import.meta.url) return false;
  try { return path.resolve(url.fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] || ""); } catch { return false; }
})();

if (isDirect) {
  startServer().catch((err) => { console.error("[browser] failed:", err); process.exit(1); });
}
