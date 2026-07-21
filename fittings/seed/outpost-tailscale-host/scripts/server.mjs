#!/usr/bin/env node
// outpost-tailscale-host backend — UI server on port 7082 that proxies to the
// outpost-host daemon (default 127.0.0.1:23702). Lists registered outposts, forwards
// register / pair / unregister / RPC / invocation-log reads, and owns the SSH
// provisioning flow (spawns ssh, streams the provision script output over SSE).

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HOME = os.homedir();
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const STATUS_ROOT = path.join(GARRISON_HOME, "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "outpost-tailscale-host.json");
// FILES-FIT-V2 checkout registry — feature-detected. Absent today; we render nothing
// (return {}) when it does not exist rather than inventing a shape.
const CHECKOUTS_FILE = path.join(GARRISON_HOME, "outpost-checkouts.json");

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PROVISION_SCRIPT = path.resolve(HERE, "provision-outpost.sh");

function parseArgs(argv) {
  const out = {
    // GARRISON_* names are what the runner projects from composition config
    // (ownPortConfigEnv); the bare names remain for standalone use.
    port: Number(process.env.GARRISON_OUTPOSTTAILSCALEHOST_PORT || process.env.OUTPOST_UI_PORT || 7082),
    host:
      process.env.GARRISON_OUTPOSTTAILSCALEHOST_BIND_HOST || process.env.OUTPOST_UI_HOST || "127.0.0.1",
    outpostHostUrl:
      process.env.GARRISON_OUTPOSTTAILSCALEHOST_OUTPOST_HOST_URL ||
      process.env.OUTPOST_HOST_URL ||
      "http://127.0.0.1:23702"
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--outpost-host-url") out.outpostHostUrl = argv[++i];
  }
  return out;
}

function jsonRes(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// Local-origin guard for state-changing requests (provision/register/pair/rpc/
// unregister). Unauthenticated + loopback-bound, so without this a page the user
// visits could POST /provision (trigger SSH) or /outposts/<x>/rpc (run a command
// on a paired Mac), or DNS-rebind to reach any of them. Reject a non-loopback
// Host (rebinding) and a cross-site Origin (CSRF). True when blocked (answered).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
function crossSiteBlocked(req, res) {
  const hostName = String(req.headers["host"] || "").replace(/:\d+$/, "").toLowerCase();
  if (hostName && !LOOPBACK_HOSTS.has(hostName)) {
    jsonRes(res, 403, { error: "forbidden", reason: `non-loopback Host '${hostName}' (DNS-rebinding guard)` });
    return true;
  }
  const origin = req.headers["origin"];
  if (origin) {
    let ok = false;
    try { ok = LOOPBACK_HOSTS.has(new URL(origin).hostname.toLowerCase()); } catch { ok = false; }
    if (!ok) { jsonRes(res, 403, { error: "forbidden", reason: "cross-site Origin (CSRF guard)" }); return true; }
  }
  return false;
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { return null; }
}

async function proxyJson(targetUrl, init = {}) {
  try {
    const res = await fetch(targetUrl, init);
    let data;
    try { data = await res.json(); } catch { data = { error: `non-JSON response from outpost-host` }; }
    return { status: res.status, data };
  } catch (err) {
    return { status: 503, data: { error: "outpost-host unreachable", details: err instanceof Error ? err.message : String(err) } };
  }
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
}

async function handleListOutposts(req, res, opts) {
  const result = await proxyJson(`${opts.outpostHostUrl}/outposts`, { cache: "no-store" });
  jsonRes(res, result.status, result.data);
}

async function handleRegisterOutpost(req, res, opts) {
  const body = await readBody(req);
  if (!body || typeof body.name !== "string" || typeof body.token !== "string") {
    return jsonRes(res, 400, { error: "name and token (strings) required" });
  }
  const result = await proxyJson(`${opts.outpostHostUrl}/registry/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: body.name, token: body.token })
  });
  jsonRes(res, result.status, result.data);
}

async function handlePair(req, res, opts) {
  const body = await readBody(req);
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return jsonRes(res, 400, { error: "name (string) required" });
  }
  const result = await proxyJson(`${opts.outpostHostUrl}/registry/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: body.name.trim() })
  });
  jsonRes(res, result.status, result.data);
}

async function handleUnregisterOutpost(req, res, opts, name) {
  const result = await proxyJson(`${opts.outpostHostUrl}/registry/${encodeURIComponent(name)}`, { method: "DELETE" });
  jsonRes(res, result.status, result.data);
}

async function handleRpc(req, res, opts, name) {
  const body = await readBody(req);
  if (!body || typeof body.type !== "string") {
    return jsonRes(res, 400, { error: "{type, payload} required" });
  }
  const result = await proxyJson(`${opts.outpostHostUrl}/outposts/${encodeURIComponent(name)}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-garrison-caller": "outpost-ui" },
    body: JSON.stringify(body)
  });
  jsonRes(res, result.status, result.data);
}

async function handleLog(req, res, opts, name, limit) {
  const q = limit ? `?limit=${encodeURIComponent(limit)}` : "";
  const result = await proxyJson(`${opts.outpostHostUrl}/outposts/${encodeURIComponent(name)}/log${q}`, { cache: "no-store" });
  jsonRes(res, result.status, result.data);
}

// Feature-detect the FILES-FIT-V2 checkout registry. It does not exist yet; when absent
// we return {} so the UI renders nothing rather than a fabricated shape.
function handleCheckouts(req, res) {
  if (!existsSync(CHECKOUTS_FILE)) return jsonRes(res, 200, {});
  try {
    return jsonRes(res, 200, JSON.parse(readFileSync(CHECKOUTS_FILE, "utf8")));
  } catch {
    return jsonRes(res, 200, {});
  }
}

// ---------------------------------------------------------------------------
// SSH provisioning — spawn ssh, stream provision-outpost.sh output over SSE
// ---------------------------------------------------------------------------

// In-memory jobs: Map<jobId, { lines: string[], done: boolean, exitCode: number|null, subs: Set<res> }>
const provisionJobs = new Map();
const PROVISION_RING = 2000;

function pushLine(job, line) {
  job.lines.push(line);
  if (job.lines.length > PROVISION_RING) job.lines.shift();
  const payload = `data: ${JSON.stringify({ line })}\n\n`;
  for (const sub of job.subs) { try { sub.write(payload); } catch { /* client gone */ } }
}

function finishJob(job, exitCode) {
  job.done = true;
  job.exitCode = exitCode;
  const payload = `event: done\ndata: ${JSON.stringify({ exitCode })}\n\n`;
  for (const sub of job.subs) {
    try { sub.write(payload); sub.end(); } catch { /* client gone */ }
  }
  job.subs.clear();
}

// SSH target validation (security-critical). `sshUser`/`sshHost` are placed as
// a single `user@host` argv token AFTER ssh's -o flags. spawn() uses no shell,
// so shell metacharacters can't execute — BUT a value beginning with "-" is
// parsed by ssh's OWN getopt as an option, and `-oProxyCommand=<cmd>` runs
// <cmd> locally. This endpoint is loopback-bound but unauthenticated, so a
// drive-by cross-site POST could reach it; validate strictly and never let a
// dash-leading or metacharacter-bearing value through.
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/i;                 // POSIX-ish username, no leading dash
const SSH_HOST_RE = /^(?!-)[A-Za-z0-9._-]{1,253}$|^[0-9a-fA-F:]{2,45}$/; // hostname/IPv4/MagicDNS or IPv6, no leading dash
// Exported for the regression suite (see tests/outposts-fitting.test.ts).
export const isValidSshTarget = (user, host) => SSH_USER_RE.test(String(user || "")) && SSH_HOST_RE.test(String(host || ""));

async function handleProvision(req, res, opts) {
  const body = await readBody(req);
  const sshHost = (body?.host || "").trim();
  const sshUser = (body?.user || "").trim();
  const rawName = (body?.name || sshHost).trim();
  if (!sshHost || !sshUser) {
    return jsonRes(res, 400, { error: "host and user (strings) required" });
  }
  if (!SSH_USER_RE.test(sshUser) || !SSH_HOST_RE.test(sshHost)) {
    // Reject before ssh ever sees it: a leading "-" or an out-of-charset value
    // could be parsed by ssh as an option (ProxyCommand -> local RCE).
    return jsonRes(res, 400, { error: "invalid ssh user or host (expected a plain username and hostname/IP)" });
  }
  // Machine name: a filesystem/registry-safe slug derived from the requested name/host.
  const machine = rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "outpost";

  // Mint a pairing token so the remote agent can authenticate back to this host.
  const pair = await proxyJson(`${opts.outpostHostUrl}/registry/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: machine })
  });
  if (pair.status !== 200 || !pair.data?.token || !pair.data?.host) {
    return jsonRes(res, 502, { error: "could not mint a pairing token from outpost-host", details: pair.data });
  }

  let script;
  try {
    script = readFileSync(PROVISION_SCRIPT, "utf8");
  } catch (err) {
    return jsonRes(res, 500, { error: `provision script unavailable: ${err instanceof Error ? err.message : String(err)}` });
  }

  const jobId = randomBytes(6).toString("hex");
  const job = { lines: [], done: false, exitCode: null, subs: new Set() };
  provisionJobs.set(jobId, job);

  // The env the provision script needs, prepended to the streamed script so nothing
  // secret ever lands on the ssh argv (it goes over stdin).
  const header =
    `export GARRISON_HOST=${JSON.stringify(pair.data.host)}\n` +
    `export GARRISON_TOKEN=${JSON.stringify(pair.data.token)}\n` +
    `export GARRISON_MACHINE=${JSON.stringify(machine)}\n`;

  pushLine(job, `==> Provisioning ${machine} on ${sshUser}@${sshHost}`);
  pushLine(job, `==> Connecting over SSH (BatchMode; key auth required)…`);

  const target = `${sshUser}@${sshHost}`;
  const child = spawn(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", target, "bash -s"],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  child.on("error", (err) => {
    pushLine(job, `ssh error: ${err.message}`);
    finishJob(job, 1);
  });

  const relay = (buf) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line.length) pushLine(job, line);
    }
  };
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);
  child.on("close", (code) => {
    pushLine(job, code === 0 ? "==> Provisioning finished (exit 0)." : `==> Provisioning exited with code ${code}.`);
    finishJob(job, code ?? 1);
  });

  // Stream the env header + the provision script into the remote shell, then EOF.
  try {
    child.stdin.write(header + script);
    child.stdin.end();
  } catch (err) {
    pushLine(job, `failed to send provision script: ${err instanceof Error ? err.message : String(err)}`);
    finishJob(job, 1);
  }

  jsonRes(res, 200, { ok: true, jobId, machine });
}

function handleProvisionStream(req, res, jobId) {
  const job = provisionJobs.get(jobId);
  if (!job) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "no such provision job" }));
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write(": stream open\n\n");
  // Replay buffered lines so a late subscriber sees the whole run.
  for (const line of job.lines) res.write(`data: ${JSON.stringify({ line })}\n\n`);
  if (job.done) {
    res.write(`event: done\ndata: ${JSON.stringify({ exitCode: job.exitCode })}\n\n`);
    return res.end();
  }
  job.subs.add(res);
  req.on("close", () => { job.subs.delete(res); });
}

function serveStatic(req, res, distDir) {
  let pathname = url.parse(req.url).pathname || "/";
  if (pathname === "/") pathname = "/index.html";
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
  const ct = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
  res.statusCode = 200;
  res.setHeader("Content-Type", ct[ext] ?? "application/octet-stream");
  createReadStream(filePath).pipe(res);
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: "outpost-tailscale-host",
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString()
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch {}
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const distDir = path.resolve(here, "..", "dist");

  const liveOpts = { ...opts };

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url || "/", true);
      const pathname = parsed.pathname || "/";
      const method = req.method || "GET";

      if (pathname === "/health") return await handleHealth(req, res, liveOpts);
      if (pathname === "/checkouts" && method === "GET") return await handleCheckouts(req, res);
      if (pathname === "/outposts" && method === "GET") return await handleListOutposts(req, res, liveOpts);
      if (pathname === "/outposts" && method === "POST") { if (crossSiteBlocked(req, res)) return; return await handleRegisterOutpost(req, res, liveOpts); }
      if (pathname === "/registry/pair" && method === "POST") { if (crossSiteBlocked(req, res)) return; return await handlePair(req, res, liveOpts); }
      if (pathname === "/provision" && method === "POST") { if (crossSiteBlocked(req, res)) return; return await handleProvision(req, res, liveOpts); }

      const provStreamMatch = pathname.match(/^\/provision\/([^/]+)\/stream$/);
      if (provStreamMatch && method === "GET") return await handleProvisionStream(req, res, decodeURIComponent(provStreamMatch[1]));

      const logMatch = pathname.match(/^\/outposts\/([^/]+)\/log$/);
      if (logMatch && method === "GET") return await handleLog(req, res, liveOpts, decodeURIComponent(logMatch[1]), parsed.query?.limit);

      const rpcMatch = pathname.match(/^\/outposts\/([^/]+)\/rpc$/);
      if (rpcMatch && method === "POST") { if (crossSiteBlocked(req, res)) return; return await handleRpc(req, res, liveOpts, decodeURIComponent(rpcMatch[1])); }

      const unregMatch = pathname.match(/^\/outposts\/([^/]+)$/);
      if (unregMatch && method === "DELETE") { if (crossSiteBlocked(req, res)) return; return await handleUnregisterOutpost(req, res, liveOpts, decodeURIComponent(unregMatch[1])); }

      return await serveStatic(req, res, distDir);
    } catch (err) {
      if (!res.headersSent) jsonRes(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(
        `[outpost] port ${liveOpts.port} is already in use - refusing to start on a shifted port (the configured port is canonical)`
      );
      process.exit(1);
    }
    throw err;
  });
  await new Promise((resolve) => {
    server.listen(liveOpts.port, liveOpts.host, async () => {
      await writeStatusFile(liveOpts);
      console.log(`[outpost] listening on http://${liveOpts.host}:${liveOpts.port} (outpost-host=${liveOpts.outpostHostUrl})`);
      resolve();
    });
  });

  const shutdown = async (signal) => {
    console.log(`[outpost] shutdown (${signal})`);
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
  startServer().catch((err) => { console.error("[outpost] failed:", err); process.exit(1); });
}
