#!/usr/bin/env node
// garrison-browser — inspect the headless Chromium tab that the Browser
// Fitting is serving side-by-side in the terminal Fitting's split-pane.
//
// Discovers the Fitting via ~/.garrison/ui-fittings/browser-default.json.
// Defaults --tab to the most-recently-active tab (last navigated / clicked).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const STATUS_FILE = path.join(HOME, ".garrison", "ui-fittings", "browser-default.json");

function die(msg, code = 1) { process.stderr.write(`garrison-browser: ${msg}\n`); process.exit(code); }

function readFittingBase() {
  if (!existsSync(STATUS_FILE)) {
    die(`Browser Fitting not running (no ${STATUS_FILE}). Hit Run in Garrison.`);
  }
  try {
    const j = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
    if (!j || typeof j.url !== "string") die(`status file invalid`);
    return j.url.replace(/\/+$/, "");
  } catch (err) {
    die(`reading status file: ${err.message}`);
  }
}

function parseUrl(u) {
  const m = u.match(/^http:\/\/([^:/]+):(\d+)$/);
  if (!m) die(`unsupported url ${u}`);
  return { host: m[1], port: Number(m[2]) };
}

async function call(method, base, path, { json, raw } = {}) {
  const { host, port } = parseUrl(base);
  return await new Promise((resolve, reject) => {
    const opts = { host, port, path, method, headers: {} };
    let body = null;
    if (json !== undefined) {
      body = Buffer.from(JSON.stringify(json), "utf8");
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = body.length;
    }
    const req = httpRequest(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (raw) {
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        } else {
          let parsed = null;
          try { parsed = JSON.parse(buf.toString("utf8")); }
          catch { parsed = buf.toString("utf8"); }
          resolve({ status: res.statusCode, body: parsed });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function pickTab(base, override) {
  if (override) return override;
  const r = await call("GET", base, "/active-tab");
  if (r.status !== 200) die(`no active tab: ${r.body?.error || r.status}`);
  return r.body.tabId;
}

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args.flags[k] = v;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const HELP = `garrison-browser — inspect the Garrison Browser Fitting tab

Usage:
  garrison-browser tabs
  garrison-browser screenshot [--tab <id>] [--full] [--out <path>]
  garrison-browser console    [--tab <id>] [--since <ms>] [--limit <n>]
  garrison-browser network    [--tab <id>] [--since <ms>] [--limit <n>] [--filter <s>] [--errors]
  garrison-browser body       --request <requestId> [--tab <id>]
  garrison-browser dom        [--tab <id>] [--selector <css>] [--out <path>]
  garrison-browser eval       <js>  [--tab <id>]
  garrison-browser nav        <url> [--tab <id>]

Notes:
  --tab defaults to the most-recently-active tab.
  screenshot/dom output to /tmp/garrison-browser-*.{png,html} unless --out is given.
  Read the screenshot path with the Read tool to see the page.`;

async function cmdTabs(base) {
  const r = await call("GET", base, "/tabs");
  if (r.status !== 200) die(`tabs: ${r.status}`);
  const list = r.body.tabs || [];
  if (list.length === 0) return console.log("(no tabs open)");
  for (const t of list) {
    console.log(`${t.tabId.slice(0, 12)}…  ${t.url}  — ${t.title || "(no title)"}`);
  }
}

async function cmdScreenshot(base, args) {
  const tab = await pickTab(base, args.flags.tab);
  const q = args.flags.full === "true" ? "?full=1" : "";
  const r = await call("GET", base, `/tabs/${encodeURIComponent(tab)}/screenshot${q}`, { raw: true });
  if (r.status !== 200) die(`screenshot: HTTP ${r.status}`);
  const out = args.flags.out || `/tmp/garrison-browser-shot-${Date.now()}.png`;
  writeFileSync(out, r.body);
  console.log(out);
}

async function cmdConsole(base, args) {
  const tab = await pickTab(base, args.flags.tab);
  const params = new URLSearchParams();
  if (args.flags.since) params.set("since", args.flags.since);
  if (args.flags.limit) params.set("limit", args.flags.limit);
  const q = params.toString() ? `?${params}` : "";
  const r = await call("GET", base, `/tabs/${encodeURIComponent(tab)}/console${q}`);
  if (r.status !== 200) die(`console: ${r.body?.error || r.status}`);
  const entries = r.body.entries || [];
  if (entries.length === 0) return console.log("(no console entries)");
  for (const e of entries) {
    const t = new Date(e.ts).toISOString().slice(11, 23);
    const loc = e.url ? `  ${e.url}:${e.line}` : "";
    const lvl = e.level === "warning" ? "warn" : e.level;
    console.log(`[${t}] ${String(lvl).padEnd(5)} ${e.text}${loc}`);
  }
}

async function cmdNetwork(base, args) {
  const tab = await pickTab(base, args.flags.tab);
  const params = new URLSearchParams();
  if (args.flags.since) params.set("since", args.flags.since);
  if (args.flags.limit) params.set("limit", args.flags.limit);
  if (args.flags.filter) params.set("filter", args.flags.filter);
  if (args.flags.errors === "true") params.set("status", "error");
  const q = params.toString() ? `?${params}` : "";
  const r = await call("GET", base, `/tabs/${encodeURIComponent(tab)}/network${q}`);
  if (r.status !== 200) die(`network: ${r.body?.error || r.status}`);
  const entries = r.body.entries || [];
  if (entries.length === 0) return console.log("(no network entries)");
  for (const e of entries) {
    const status = e.failed ? "FAIL" : (e.status ?? "...");
    const dur = e.duration != null ? `${e.duration}ms` : "—";
    const size = e.encodedDataLength != null ? `${e.encodedDataLength}B` : "—";
    const fail = e.failureText ? `  ${e.failureText}` : "";
    console.log(`${String(status).padEnd(4)} ${e.method.padEnd(6)} ${e.resourceType.padEnd(10)} ${dur.padEnd(7)} ${size.padEnd(8)} ${e.url}${fail}  [${e.requestId}]`);
  }
}

async function cmdBody(base, args) {
  const reqId = args.flags.request;
  if (!reqId) die("--request <requestId> required");
  const tab = await pickTab(base, args.flags.tab);
  const r = await call("GET", base, `/tabs/${encodeURIComponent(tab)}/network/${encodeURIComponent(reqId)}/body`);
  if (r.status !== 200) die(`body: ${r.body?.error || r.status}`);
  const body = r.body.base64Encoded
    ? Buffer.from(r.body.body, "base64").toString("utf8")
    : r.body.body;
  process.stdout.write(body || "");
}

async function cmdDom(base, args) {
  const tab = await pickTab(base, args.flags.tab);
  const params = new URLSearchParams();
  if (args.flags.selector) params.set("selector", args.flags.selector);
  const q = params.toString() ? `?${params}` : "";
  const r = await call("GET", base, `/tabs/${encodeURIComponent(tab)}/dom${q}`, { raw: true });
  if (r.status !== 200) die(`dom: HTTP ${r.status}`);
  const html = r.body.toString("utf8");
  if (args.flags.out) {
    writeFileSync(args.flags.out, html);
    console.log(args.flags.out);
  } else {
    process.stdout.write(html);
  }
}

async function cmdEval(base, args) {
  const js = args._.slice(1).join(" ");
  if (!js) die("eval requires a JS expression");
  const tab = await pickTab(base, args.flags.tab);
  const r = await call("POST", base, `/tabs/${encodeURIComponent(tab)}/eval`, { json: { js } });
  if (r.status !== 200) die(`eval: HTTP ${r.status}`);
  if (r.body.ok === false) die(`eval: ${r.body.error}`);
  const v = r.body.value;
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

async function cmdNav(base, args) {
  const targetUrl = args._[1];
  if (!targetUrl) die("nav requires <url>");
  const tab = await pickTab(base, args.flags.tab);
  const r = await call("POST", base, `/tabs/${encodeURIComponent(tab)}/nav`, { json: { url: targetUrl } });
  if (r.status !== 200) die(`nav: HTTP ${r.status}`);
  console.log(r.body.ok ? `→ ${r.body.url}` : `failed: ${r.body.error}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }
  const base = readFittingBase();
  const handlers = {
    tabs: cmdTabs,
    screenshot: cmdScreenshot,
    shot: cmdScreenshot,
    console: cmdConsole,
    logs: cmdConsole,
    network: cmdNetwork,
    net: cmdNetwork,
    body: cmdBody,
    dom: cmdDom,
    eval: cmdEval,
    nav: cmdNav
  };
  const fn = handlers[cmd];
  if (!fn) die(`unknown command: ${cmd}\n${HELP}`);
  await fn(base, args);
}

main().catch((err) => die(err.message || String(err)));
