#!/usr/bin/env node
// browser-default backend. Playwright-managed headless Chromium with raw CDP
// exposed via --remote-debugging-port. Serves:
//   - per-tab JPEG screencast over WS /viewport/:tabId
//   - per-tab input dispatch over WS /input/:tabId
//   - per-tab raw CDP passthrough over WS /cdp/:tabId
//   - reverse-proxy of Chromium's built-in DevTools at HTTP /devtools/*
//   - tabs list + canvas page UI at HTTP / and /canvas/:tabId

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
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
let cdpPort = 0;
let cdpHttpEndpoint = "";
let cdpWsEndpoint = "";

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
 *   qualityLevel: "low" | "med" | "high",
 *   inputClients: Set<import("ws").WebSocket>,
 *   focusedEditable: boolean,
 *   focusWatcher: NodeJS.Timeout | null
 * }} TabState
 */

const BUFFER_LIMIT = 500;

// Screencast presets — LOW is the new default. The per-tab qualityLevel can
// be changed at runtime via an input-WS {type:"quality", level} message.
// everyNthFrame stays at 1: throttle by JPEG size, not by skipping paints.
// (Skipping paints starves first-frame on static pages — there's nothing to
// skip if the page only paints once on load.)
const QUALITY_PRESETS = {
  low:  { jpegQuality: 40, viewportWidth: 800,  viewportHeight: 800,  everyNthFrame: 1 },
  med:  { jpegQuality: 55, viewportWidth: 1024, viewportHeight: 1024, everyNthFrame: 1 },
  high: { jpegQuality: 75, viewportWidth: 1280, viewportHeight: 1280, everyNthFrame: 1 }
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
  } catch (err) {
    console.warn(`[browser] enable domains failed: ${err.message}`);
    return;
  }

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
  cdpPort = await findFreePort(9222);
  if (cdpPort === null) throw new Error("no free CDP port available");
  cdpHttpEndpoint = `http://127.0.0.1:${cdpPort}`;
  cdpWsEndpoint = `ws://127.0.0.1:${cdpPort}`;

  const exe = resolveFullChromiumBinary();
  const userDataDir = await mkdtemp(path.join(tmpdir(), "garrison-browser-"));

  chromiumChild = spawn(exe, [
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
    "--no-startup-window"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  chromiumChild.stdout.on("data", () => {});
  chromiumChild.stderr.on("data", (d) => {
    const line = d.toString();
    // Quiet routine Chromium chatter; surface anything that looks like an error.
    if (/error|fatal|fail/i.test(line)) console.error(`[chromium] ${line.trimEnd()}`);
  });
  chromiumChild.on("exit", (code, signal) => {
    console.error(`[chromium] exited code=${code} signal=${signal}`);
    chromiumChild = null;
  });

  await waitForCdpReady(cdpPort);

  browser = await chromium.connectOverCDP(cdpHttpEndpoint);
  context = browser.contexts()[0] || (await browser.newContext({
    viewport: { width: opts.viewportWidth, height: opts.viewportHeight }
  }));

  console.log(`[browser] chromium up on rdp port ${cdpPort} (exe=${exe})`);
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
  if (!context) throw new Error("browser not ready");
  const page = await context.newPage();
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
    focusWatcher: null
  };
  tabs.set(tabId, tab);
  await attachInstrumentation(tab);

  if (initialUrl) {
    try { await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (err) { console.warn(`[browser] goto failed: ${err.message}`); }
  }

  page.on("close", () => { void cleanupTab(tab); });

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
  const out = [];
  for (const tab of tabs.values()) {
    let title = "";
    let pageUrl = "";
    try { pageUrl = tab.page.url(); } catch {}
    try { title = await tab.page.title(); } catch {}
    out.push({ tabId: tab.tabId, url: pageUrl, title, requestedUrl: tab.requestedUrl });
  }
  return out;
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

async function handleListTabs(_req, res) {
  jsonRes(res, 200, { tabs: await listTabs() });
}

async function handleCreateTab(req, res) {
  const body = (await readBody(req)) || {};
  const initialUrl = typeof body.url === "string" ? body.url : "about:blank";
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
  // SPA fallback: route /canvas/:tabId and / to index.html
  if (pathname === "/" || pathname.startsWith("/canvas/")) pathname = "/index.html";
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
function setupHeartbeat(ws) {
  ws._alive = true;
  ws.on("pong", () => { ws._alive = true; });
  ws._hbTimer = setInterval(() => {
    if (!ws._alive) { try { ws.terminate(); } catch {} return; }
    ws._alive = false;
    try { ws.ping(); } catch {}
  }, HEARTBEAT_MS);
  ws.on("close", () => {
    if (ws._hbTimer) { clearInterval(ws._hbTimer); ws._hbTimer = null; }
  });
}

function bindViewportClient(ws, tab) {
  tab.viewportClient = ws;
  setupHeartbeat(ws);
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
  // Connecting a viewport means a user is now LOOKING at this tab — bump
  // activity so /active-tab and `garrison-browser` default to it.
  tab.lastActivityAt = Date.now();

  // Replace an existing live viewer (rare — usually only one client at a time).
  if (tab.viewportClient && tab.viewportClient !== ws) {
    try { tab.viewportClient.close(); } catch {}
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
    // Frame listener: send binary JPEG bytes; stash the ACK for the client to
    // confirm via the input WS. This is the backpressure spine — Chromium
    // pauses encoding until the client says it drew the frame.
    cdp.on("Page.screencastFrame", (params) => {
      const sock = tab.viewportClient;
      if (sock && sock.readyState === WebSocket.OPEN) {
        try { sock.send(Buffer.from(params.data, "base64")); } catch {}
      }
      tab.pendingAck = { sessionId: params.sessionId, ts: Date.now() };
    });
  }

  bindViewportClient(ws, tab);
  // Start (or restart) the screencast — guarantees Chromium pushes a fresh
  // first-frame from the current page state, so static-page reattach doesn't
  // sit blank. Idempotent: on a CDP session that already had a screencast,
  // Chromium resets and re-emits.
  await restartScreencast(tab);
}

async function restartScreencast(tab) {
  if (!tab.viewportCdp) return;
  // Any stale ACK held from a prior session is for a sessionId Chromium no
  // longer knows — drop it before restarting.
  tab.pendingAck = null;
  const preset = QUALITY_PRESETS[tab.qualityLevel] || QUALITY_PRESETS.low;
  try {
    // Best-effort stop; ignored if not currently running. Stop+start is the
    // cleanest way to nudge Chromium to emit a fresh first-frame without
    // touching device metrics (which would race with the client's viewport
    // push and squish the rendered page).
    try { await tab.viewportCdp.send("Page.stopScreencast"); } catch {}
    await tab.viewportCdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: preset.jpegQuality,
      maxWidth: preset.viewportWidth,
      maxHeight: preset.viewportHeight,
      everyNthFrame: preset.everyNthFrame
    });
  } catch (err) {
    console.warn(`[browser] startScreencast failed: ${err.message}`);
  }
}

async function applyQuality(tab, level) {
  const preset = QUALITY_PRESETS[level];
  if (!preset) return;
  tab.qualityLevel = level;
  await restartScreencast(tab);
}

async function attachInput(ws, tab) {
  tab.inputClients.add(ws);
  setupHeartbeat(ws);
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
      res.setHeader("Access-Control-Allow-Origin", "*");
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

      const evalMatch = pathname.match(/^\/tabs\/([^/]+)\/eval$/);
      if (evalMatch && method === "POST") return await handleEval(req, res, decodeURIComponent(evalMatch[1]));

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
    wss.handleUpgrade(request, socket, head, (ws) => {
      const tab = tabs.get(decodeURIComponent(route.tabId));
      if (!tab) {
        try { ws.send(JSON.stringify({ type: "error", message: "tab not found" })); } catch {}
        ws.close();
        return;
      }
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
