#!/usr/bin/env node
// outpost-tailscale-host backend — UI server on port 27082 that proxies to the
// outpost-host daemon (base 127.0.0.1:3702). Lists registered outposts, forwards
// register / pair / unregister / RPC / invocation-log reads, and owns the SSH
// provisioning flow (spawns ssh, streams the provision script output over SSE).

import { createReadStream, existsSync, readFileSync, watch as fsWatch } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import {
  CLAUDE_DIR,
  PORTABLE_DIRS,
  PORTABLE_FILES,
  readTargets,
  upsertTarget,
  removeTarget,
  syncAll,
  syncOne,
  syncTarget,
} from "./lib/config-sync.mjs";

const HOME = os.homedir();
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const STATUS_ROOT = path.join(GARRISON_HOME, "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "outpost-tailscale-host.json");
// FILES-FIT-V2 checkout registry — feature-detected. Absent today; we render nothing
// (return {}) when it does not exist rather than inventing a shape.
const CHECKOUTS_FILE = path.join(GARRISON_HOME, "outpost-checkouts.json");

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PROVISION_SCRIPT = path.resolve(HERE, "provision-outpost.sh");
const INSTALL_WORKER_SCRIPT = path.resolve(HERE, "install-worker.sh");
const WORKER_ROOT = path.resolve(HERE, "..", "..", "outpost-worker");
const WORKER_ASSETS = new Map([
  ["worker.mjs", path.join(WORKER_ROOT, "scripts", "worker.mjs")],
  ["materialize.mjs", path.join(WORKER_ROOT, "scripts", "materialize.mjs")],
  ["personal-workspace.mjs", path.join(WORKER_ROOT, "scripts", "personal-workspace.mjs")],
  ["runtime-adapters.mjs", path.join(WORKER_ROOT, "scripts", "runtime-adapters.mjs")],
  ["package.json", path.join(WORKER_ROOT, "package.json")],
  ["package-lock.json", path.join(WORKER_ROOT, "package-lock.json")]
]);

function parseArgs(argv) {
  const out = {
    // GARRISON_* names are what the runner projects from composition config
    // (ownPortConfigEnv); the bare names remain for standalone use.
    port: Number(process.env.GARRISON_OUTPOSTTAILSCALEHOST_PORT || process.env.OUTPOST_UI_PORT || 7082),
    host:
      process.env.GARRISON_OUTPOSTTAILSCALEHOST_BIND_HOST || process.env.OUTPOST_UI_HOST || process.env.GARRISON_BIND_HOST || "127.0.0.1",
    outpostHostUrl:
      process.env.GARRISON_OUTPOSTTAILSCALEHOST_OUTPOST_HOST_URL ||
      process.env.OUTPOST_HOST_URL ||
      "http://127.0.0.1:3702",
    appUrl: process.env.GARRISON_APP_URL || "",
    dispatchPublicUrl:
      process.env.GARRISON_OUTPOSTTAILSCALEHOST_DISPATCH_PUBLIC_URL ||
      process.env.GARRISON_DISPATCH_PUBLIC_URL ||
      "",
    workerAssetBase:
      process.env.GARRISON_OUTPOSTTAILSCALEHOST_WORKER_ASSET_BASE ||
      process.env.GARRISON_WORKER_ASSET_BASE ||
      ""
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--outpost-host-url") out.outpostHostUrl = argv[++i];
    else if (a === "--app-url") out.appUrl = argv[++i];
    else if (a === "--dispatch-public-url") out.dispatchPublicUrl = argv[++i];
    else if (a === "--worker-asset-base") out.workerAssetBase = argv[++i];
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
// on a paired Mac), or DNS-rebind to reach any of them.
//
// DNS-rebinding: guard on the TCP socket's remoteAddress (always loopback when
// tailscale serve proxies to 127.0.0.1, and when the browser is on the same
// machine). Checking the Host header alone would block legitimate tailnet
// requests because tailscale forwards the original tailnet Host.
//
// CSRF: require the Origin to be same-host as the Host header. This blocks
// third-party pages regardless of whether the server is reached via loopback or
// tailnet, while allowing same-origin tailnet fetches.
//
// True when blocked (answered).
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);
// A connecting IP is TRUSTED when it is loopback, an RFC1918 private address, a
// tailnet CGNAT address (100.64.0.0/10), or an IPv6 ULA / link-local literal.
// When the fitting is bound beyond loopback (GARRISON_BIND_HOST=0.0.0.0) a direct
// hit at the box's tailnet IP arrives from the client's tailnet IP, which is
// trusted; a public source is still rejected. Kept identical across the guarded
// fittings (ports-default, power-default, outpost-tailscale-host).
function isTrustedHost(value) {
  const h = String(value || "").replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "").toLowerCase();
  if (!h) return true;
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (h === "::1" || h.endsWith(".ts.net")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // tailnet CGNAT
    return false;
  }
  if (h.includes(":") && (h.startsWith("fd") || h.startsWith("fc") || h.startsWith("fe80"))) return true;
  return false;
}
function crossSiteBlocked(req, res) {
  // Source-IP guard: the TCP connection must arrive from a trusted (loopback or
  // private/tailnet) source, not a public one.
  const remoteIp = (req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (remoteIp && !isTrustedHost(remoteIp)) {
    jsonRes(res, 403, { error: "forbidden", reason: `untrusted connection from '${remoteIp}' (DNS-rebinding guard)` });
    return true;
  }
  // DNS-rebinding guard: the HOST HEADER must also be trusted. This check is the
  // one that actually stops rebinding and it was missing here, unlike in
  // ports-default/power-default. The source-IP check above cannot stand in for
  // it: in a rebinding attack the victim's own browser makes the request, so the
  // source IP is the victim's (trusted), while Host carries the attacker's
  // domain. The Origin check below cannot either - the attacker page's Origin
  // and Host are BOTH evil.example, so they match each other and pass. Widening
  // the source check without adding this left the whole guard satisfiable by a
  // hostile page, on a server that runs rsync-over-ssh and writes host config
  // unauthenticated.
  const hostName = String(req.headers["host"] || "").replace(/:\d+$/, "").toLowerCase();
  if (hostName && !isTrustedHost(hostName)) {
    jsonRes(res, 403, { error: "forbidden", reason: `untrusted Host '${hostName}' (DNS-rebinding guard)` });
    return true;
  }
  // CSRF guard: if an Origin is present it must be same-host as the Host header
  // (covers both loopback and tailnet same-origin requests) OR a bare loopback
  // origin (backward-compat for direct loopback access without a Host header).
  const origin = req.headers["origin"];
  if (origin) {
    const hostHeader = String(req.headers["host"] || "").toLowerCase();
    let ok = false;
    try {
      const originUrl = new URL(origin);
      ok = originUrl.host.toLowerCase() === hostHeader || LOOPBACK_HOSTS.has(originUrl.hostname.toLowerCase());
    } catch { ok = false; }
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

function shellWord(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function validatedPublicBase(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (parsed.protocol !== "https:" || !isTrustedHost(parsed.hostname)) return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function commandOutput(command, args, timeoutMs = 4000) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { if (stdout.length < 1024 * 1024) stdout += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => { clearTimeout(timer); resolve(stdout); });
  });
}

async function tailnetUrlForLoopback(baseUrl) {
  let localPort = null;
  try {
    const parsed = new URL(baseUrl);
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) return validatedPublicBase(baseUrl);
    localPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  } catch { return null; }
  if (!Number.isInteger(localPort) || localPort < 1) return null;
  const candidates = [
    "tailscale",
    "/usr/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  ];
  for (const bin of candidates) {
    const raw = await commandOutput(bin, ["serve", "status", "--json"]);
    if (!raw.trim().startsWith("{")) continue;
    try {
      const status = JSON.parse(raw);
      for (const [hostPort, web] of Object.entries(status.Web || {})) {
        for (const handler of Object.values(web?.Handlers || {})) {
          let proxy;
          try { proxy = new URL(handler?.Proxy || ""); } catch { continue; }
          if (Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)) !== localPort) continue;
          const found = validatedPublicBase(`https://${hostPort}`);
          if (found) return found;
        }
      }
    } catch { /* try another candidate */ }
  }
  return null;
}

async function resolveWorkerUrls(req, opts, body = {}) {
  const explicitDispatch = validatedPublicBase(body.dispatchUrl || opts.dispatchPublicUrl);
  const dispatchUrl = explicitDispatch || await tailnetUrlForLoopback(opts.appUrl);
  const explicitAssets = validatedPublicBase(body.workerAssetBase || opts.workerAssetBase);
  let ownPublicUrl = explicitAssets || await tailnetUrlForLoopback(`http://127.0.0.1:${opts.port}`);
  if (!ownPublicUrl) {
    const origin = validatedPublicBase(req.headers.origin || "");
    const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const viaProxy = validatedPublicBase(`${forwarded || "https"}://${req.headers.host || ""}`);
    ownPublicUrl = origin || viaProxy;
  }
  if (!dispatchUrl || !ownPublicUrl) {
    return {
      ok: false,
      error: "Task runner needs public HTTPS tailnet URLs",
      requirement: !dispatchUrl
        ? "Expose the Garrison app with tailscale serve, or configure dispatch_public_url."
        : "Expose this Outposts view with tailscale serve, or configure worker_asset_base."
    };
  }
  return {
    ok: true,
    dispatchUrl,
    assetBase: `${ownPublicUrl}/worker/assets`,
    installUrl: `${ownPublicUrl}/worker/install.sh`
  };
}

// The bridge's public v1 contract names the executable `command`, takes argv in
// `args`, and returns stdout/stderr as base64. A human command line is not an
// executable path, so route it through an explicit shell without asking the
// external provider to special-case Garrison.
export function normaliseExecRpc(body) {
  if (body?.type !== "exec.run" || typeof body?.payload?.command !== "string") return body;
  return {
    ...body,
    payload: {
      ...body.payload,
      command: "/bin/sh",
      args: ["-lc", body.payload.command]
    }
  };
}

export function buildWorkerInstaller({ installUrl, dispatchUrl, token, machine, assetBase }) {
  return `curl -fsSL ${shellWord(installUrl)} | ` +
    `GARRISON_DISPATCH_URL=${shellWord(dispatchUrl)} ` +
    `GARRISON_TOKEN=${shellWord(token)} ` +
    `GARRISON_MACHINE=${shellWord(machine)} ` +
    `GARRISON_WORKER_ASSET_BASE=${shellWord(assetBase)} bash`;
}

function handleHealth(req, res, opts) {
  jsonRes(res, 200, { ok: true, port: opts.port, pid: process.pid, host: opts.host });
}

async function handleListOutposts(req, res, opts) {
  const result = await proxyJson(`${opts.outpostHostUrl}/outposts`, { cache: "no-store" });
  if (result.status !== 200 || !Array.isArray(result.data?.outposts) || !opts.appUrl) {
    return jsonRes(res, result.status, result.data);
  }
  const workers = await proxyJson(`${opts.appUrl.replace(/\/+$/, "")}/api/dispatch/machines`, {
    cache: "no-store",
    signal: AbortSignal.timeout(3000)
  });
  const byName = new Map((workers.data?.machines || []).map((machine) => [machine.name, machine.worker]));
  const targets = readTargets();
  jsonRes(res, 200, {
    ...result.data,
    protocol: workers.data?.protocol || "outpost-dispatch/1.1",
    outposts: result.data.outposts.map((outpost) => ({
      ...outpost,
      bridge: outpost.connected ? "connected" : "offline",
      repairAvailable: Boolean(targets[outpost.name]?.sshHost && targets[outpost.name]?.sshUser),
      repairRequirement: targets[outpost.name]
        ? null
        : "Add this machine under Claude config sync with its SSH user and tailnet host to enable one-click repair.",
      worker: byName.get(outpost.name) || {
        state: "offline",
        ready: false,
        stale: true,
        detail: "Task runner has not checked in",
        lastSeenAt: null,
        workerVersion: null,
        protocolVersion: null,
        runtimes: [],
        currentCardId: null,
        error: null
      }
    }))
  });
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
  const workerUrls = await resolveWorkerUrls(req, opts, body);
  if (!workerUrls.ok) return jsonRes(res, 503, workerUrls);
  const result = await proxyJson(`${opts.outpostHostUrl}/registry/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: body.name.trim() })
  });
  if (result.status !== 200 || !result.data?.token || !result.data?.installer) {
    return jsonRes(res, result.status, result.data);
  }
  // Environment assignments belong on the command AFTER the pipe, not as pipe
  // segments. Keep the expanded form explicit so the copyable command is valid.
  const workerCommand = buildWorkerInstaller({
    installUrl: workerUrls.installUrl,
    dispatchUrl: workerUrls.dispatchUrl,
    token: result.data.token,
    machine: body.name.trim(),
    assetBase: workerUrls.assetBase
  });
  jsonRes(res, 200, {
    ...result.data,
    dispatchUrl: workerUrls.dispatchUrl,
    workerInstaller: workerCommand,
    installer: `${String(result.data.installer).trim()} && ${workerCommand}`
  });
}

async function handleUnregisterOutpost(req, res, opts, name) {
  const result = await proxyJson(`${opts.outpostHostUrl}/registry/${encodeURIComponent(name)}`, { method: "DELETE" });
  // Also drop the config-sync target so the healer stops pushing to a
  // decommissioned outpost (the two stores are otherwise independent).
  try { removeTarget(name); } catch { /* best effort */ }
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
    body: JSON.stringify(normaliseExecRpc(body))
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
  if (job.done) return; // a spawn "error" + "close" can both fire; finish once
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

const sshArgs = (target, remoteCommand) => [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=15",
  target,
  remoteCommand
];

// Establish a real, read-only SSH session before asking the host broker for any
// pairing credential. In particular, an offline Mac must fail here while its
// existing bridge token and registry entry are still untouched.
export async function sshProvisionPreflight(sshUser, sshHost, {
  spawnImpl = spawn,
  timeoutMs = 18_000
} = {}) {
  if (!isValidSshTarget(sshUser, sshHost)) {
    return { ok: false, error: "invalid ssh user or host" };
  }
  const target = `${sshUser}@${sshHost}`;
  return await new Promise((resolve) => {
    let child;
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch {}
      finish({ ok: false, error: `SSH preflight timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    try {
      child = spawnImpl("ssh", sshArgs(target, "/usr/bin/true"), {
        stdio: ["ignore", "ignore", "pipe"]
      });
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    child.once("close", (code) => {
      if (code === 0) finish({ ok: true });
      else finish({
        ok: false,
        error: (stderr.trim() || `SSH preflight exited with code ${code ?? "unknown"}`).slice(0, 500)
      });
    });
  });
}

// Testable credential boundary: when preflight fails, proxyJsonImpl is never
// invoked, which proves /registry/pair cannot rotate the machine token.
export async function requestProvisionPair({
  outpostHostUrl,
  machine,
  sshUser,
  sshHost,
  reuseExisting = false
}, {
  spawnImpl = spawn,
  proxyJsonImpl = proxyJson
} = {}) {
  if (reuseExisting) {
    const preflight = await sshProvisionPreflight(sshUser, sshHost, { spawnImpl });
    if (!preflight.ok) {
      return {
        status: 502,
        data: {
          error: "SSH preflight failed; the existing bridge pairing was left unchanged",
          details: preflight.error
        }
      };
    }
  }
  return await proxyJsonImpl(`${outpostHostUrl}/registry/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: machine, ...(reuseExisting ? { reuseExisting: true } : {}) })
  });
}

async function handleProvision(req, res, opts, bodyOverride = null, {
  reuseExistingPair = false,
  workerOnly = false
} = {}) {
  const body = bodyOverride || await readBody(req);
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

  const workerUrls = await resolveWorkerUrls(req, opts, body);
  if (!workerUrls.ok) return jsonRes(res, 503, workerUrls);

  // New provisioning mints normally. Repair first proves SSH connectivity, then
  // reuses the existing token so neither an unreachable Mac nor a later install
  // failure can invalidate the external bridge's live credential.
  const pair = await requestProvisionPair({
    outpostHostUrl: opts.outpostHostUrl,
    machine,
    sshUser,
    sshHost,
    reuseExisting: reuseExistingPair
  });
  if (pair.status !== 200 || !pair.data?.token || !pair.data?.host) {
    return jsonRes(res, pair.status >= 400 && pair.status < 600 ? pair.status : 502, {
      error: reuseExistingPair
        ? "could not safely reuse the existing pairing from outpost-host"
        : "could not mint a pairing token from outpost-host",
      details: pair.data
    });
  }

  let script;
  try {
    // Repair is intentionally worker-only: it must not rewrite, restart, or
    // otherwise perturb the external bridge that is already connected.
    script = readFileSync(workerOnly ? INSTALL_WORKER_SCRIPT : PROVISION_SCRIPT, "utf8");
  } catch (err) {
    return jsonRes(res, 500, { error: `${workerOnly ? "worker repair" : "provision"} script unavailable: ${err instanceof Error ? err.message : String(err)}` });
  }

  const jobId = randomBytes(6).toString("hex");
  const job = { lines: [], done: false, exitCode: null, subs: new Set() };
  provisionJobs.set(jobId, job);

  // The env the provision script needs, prepended to the streamed script so nothing
  // secret ever lands on the ssh argv (it goes over stdin).
  const header =
    `export GARRISON_HOST=${JSON.stringify(pair.data.host)}\n` +
    `export GARRISON_TOKEN=${JSON.stringify(pair.data.token)}\n` +
    `export GARRISON_MACHINE=${JSON.stringify(machine)}\n` +
    `export GARRISON_DISPATCH_URL=${JSON.stringify(workerUrls.dispatchUrl)}\n` +
    `export GARRISON_WORKER_ASSET_BASE=${JSON.stringify(workerUrls.assetBase)}\n`;

  pushLine(job, `==> ${workerOnly ? "Repairing task runner for" : "Provisioning"} ${machine} on ${sshUser}@${sshHost}`);
  pushLine(job, `==> Connecting over SSH (BatchMode; key auth required)…`);

  const target = `${sshUser}@${sshHost}`;
  // `ssh host "bash -s"` is a NON-LOGIN, non-interactive shell: it sources no
  // profile, so PATH is the bare /usr/bin:/bin:/usr/sbin:/sbin. Every way a Mac
  // actually gets node is invisible there - nvm (~/.nvm/versions/node/*/bin) and
  // Homebrew (/opt/homebrew/bin) are both added by the login profile. Verified
  // on all three Macs: `node NOT FOUND`, so provision-outpost.sh's node check
  // failed on every one of them and provisioning could never succeed.
  // Wrap in a LOGIN shell so the user's real PATH is present, then hand the
  // script to bash on stdin exactly as before. `exec` avoids an extra process
  // in the chain, and $SHELL is honoured with a zsh fallback (macOS default).
  //
  // A login shell alone is NOT enough: nvm is commonly sourced from .zshrc,
  // which a non-interactive login shell does not read. Verified - the login
  // shell finds node on the MacBook Pro and the mini but not the Air, whose
  // node lives only under ~/.nvm. So also probe the three places a Mac actually
  // keeps node (Homebrew arm64, Intel/manual, and the newest nvm version, sorted
  // -V so v22 beats v9) rather than trusting the profile. Verified on all three.
  // Single-quoted outer string: nothing here is interpolated locally, every $ is
  // expanded by the REMOTE shell. Keep it that way - a template literal would
  // expand $HOME/$SHELL on the Garrison host and send the wrong paths.
  const loginWrap =
    'exec "${SHELL:-/bin/zsh}" -lc ' +
    '\'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:' +
    '$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"; exec bash -s\'';
  const child = spawn(
    "ssh",
    sshArgs(target, loginWrap),
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
  child.on("close", async (code) => {
    pushLine(job, code === 0
      ? `==> ${workerOnly ? "Task runner repair" : "Provisioning"} finished (exit 0).`
      : `==> ${workerOnly ? "Task runner repair" : "Provisioning"} exited with code ${code}.`);
    if (code === 0 && !workerOnly) {
      // Register this Mac as a config-sync target and push the portable
      // ~/.claude subset now (the "skills bundle" provision-outpost.sh leaves
      // as a TODO). Ongoing sync is driven by the file watcher.
      try {
        upsertTarget({ name: machine, sshUser, sshHost });
        pushLine(job, "==> Syncing Claude config to the outpost (skills, commands, agents, rules, CLAUDE.md)…");
        const r = await syncOne(machine);
        for (const it of r.items || []) {
          pushLine(job, `    ${it.ok ? "ok  " : "FAIL"} ${it.name}${it.ok ? "" : " — " + (it.error || "error")}`);
        }
        pushLine(job, r.ok ? "==> Config sync complete." : "==> Config sync had errors (will retry on the next change).");
      } catch (e) {
        pushLine(job, `==> Config sync skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
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

async function handleRepairWorker(req, res, opts, name) {
  const target = readTargets()[name];
  if (!target?.sshHost || !target?.sshUser) {
    return jsonRes(res, 409, {
      error: "Cannot repair this task runner without an SSH target",
      requirement: "Add this machine under Claude config sync with its SSH user and tailnet host, then retry Enable/Repair task runner."
    });
  }
  return await handleProvision(req, res, opts, {
    name,
    host: target.sshHost,
    user: target.sshUser
  }, { reuseExistingPair: true, workerOnly: true });
}

function serveWorkerFile(res, filePath) {
  if (!existsSync(filePath)) return jsonRes(res, 404, { error: "worker asset unavailable" });
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  createReadStream(filePath).pipe(res);
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

// ---------------------------------------------------------------------------
// Config sync — mirror the portable ~/.claude subset onto the outposts.
// State-changing routes are guarded by crossSiteBlocked (they drive rsync/ssh).
// ---------------------------------------------------------------------------

function handleListSyncTargets(req, res) {
  jsonRes(res, 200, { claudeDir: CLAUDE_DIR, portable: { dirs: PORTABLE_DIRS, files: PORTABLE_FILES }, targets: readTargets() });
}

async function handleAddSyncTarget(req, res) {
  const body = await readBody(req);
  const sshHost = String(body?.sshHost || body?.host || "").trim();
  const sshUser = String(body?.sshUser || body?.user || "").trim();
  const name = String(body?.name || sshHost).trim();
  if (!sshHost || !sshUser) return jsonRes(res, 400, { error: "sshUser and sshHost (strings) required" });
  try {
    const target = upsertTarget({ name, sshUser, sshHost });
    jsonRes(res, 200, { ok: true, target });
  } catch (e) {
    jsonRes(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

function handleRemoveSyncTarget(req, res, name) {
  const removed = removeTarget(name);
  jsonRes(res, removed ? 200 : 404, removed ? { ok: true } : { error: "no such sync target" });
}

async function handleSyncAll(req, res) {
  const summary = await syncAll();
  jsonRes(res, 200, summary);
}

async function handleSyncOne(req, res, name) {
  const r = await syncOne(name);
  jsonRes(res, r.ok ? 200 : (r.error === "no such target" ? 404 : 200), r);
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

// ---------------------------------------------------------------------------
// Config-sync watcher — keep every configured outpost reflecting this host's
// portable ~/.claude config "always". Debounced push on change + a periodic
// healer so an outpost that was offline during a change catches up.
// ---------------------------------------------------------------------------

let syncDebounce = null;
function scheduleSync(reason) {
  if (syncDebounce) clearTimeout(syncDebounce);
  syncDebounce = setTimeout(async () => {
    syncDebounce = null;
    if (!Object.keys(readTargets()).length) return;
    try {
      const r = await syncAll();
      const ok = r.results.filter((x) => x.ok).length;
      // Name what came BACK from an outpost: adoption writes into this host's
      // ~/.claude (Quarters), so it must never be a silent mutation.
      const adopted = r.results.flatMap((x) => x.adopted ?? []);
      const suffix = adopted.length ? ` · adopted from outposts: ${adopted.join(", ")}` : "";
      console.log(`[outpost] config sync (${reason}): ${ok}/${r.count} outposts ok${suffix}`);
    } catch (e) {
      console.error("[outpost] config sync failed:", e instanceof Error ? e.message : String(e));
    }
  }, 4000);
}

function startConfigWatcher() {
  const watchers = [];
  // Recursive watch on each portable dir (Node 20+ supports recursive on Linux).
  for (const dir of PORTABLE_DIRS) {
    const abs = path.join(CLAUDE_DIR, dir);
    if (!existsSync(abs)) continue;
    try {
      watchers.push(fsWatch(abs, { recursive: true, persistent: false }, () => scheduleSync(`change:${dir}`)));
    } catch (e) {
      console.error(`[outpost] cannot watch ${abs}:`, e instanceof Error ? e.message : String(e));
    }
  }
  // Non-recursive watch on ~/.claude for the top-level CLAUDE.md only (avoids the
  // churn of projects/, sessions/, todos/ that live alongside it).
  try {
    watchers.push(fsWatch(CLAUDE_DIR, { persistent: false }, (_ev, fname) => {
      if (fname === "CLAUDE.md") scheduleSync("change:CLAUDE.md");
    }));
  } catch { /* CLAUDE_DIR may not exist yet */ }
  const HEAL_MS = Number(process.env.GARRISON_OUTPOST_SYNC_HEAL_MS || 10 * 60 * 1000);
  const heal = setInterval(() => { if (Object.keys(readTargets()).length) scheduleSync("heal"); }, HEAL_MS);
  heal.unref?.();
  // Initial catch-up at boot so a config that changed while the fitting was down
  // is pushed as soon as it comes up.
  if (Object.keys(readTargets()).length) scheduleSync("boot");
  console.log(`[outpost] config watcher armed on ${CLAUDE_DIR} (dirs: ${PORTABLE_DIRS.join(", ")})`);
  return { watchers, heal };
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
      if (pathname === "/worker/install.sh" && method === "GET") return serveWorkerFile(res, INSTALL_WORKER_SCRIPT);

      const workerAssetMatch = pathname.match(/^\/worker\/assets\/([^/]+)$/);
      if (workerAssetMatch && method === "GET") {
        const name = decodeURIComponent(workerAssetMatch[1]);
        const asset = WORKER_ASSETS.get(name);
        if (!asset) return jsonRes(res, 404, { error: "unknown worker asset" });
        return serveWorkerFile(res, asset);
      }

      const provStreamMatch = pathname.match(/^\/provision\/([^/]+)\/stream$/);
      if (provStreamMatch && method === "GET") return await handleProvisionStream(req, res, decodeURIComponent(provStreamMatch[1]));

      if (pathname === "/sync/targets" && method === "GET") return handleListSyncTargets(req, res);
      if (pathname === "/sync/targets" && method === "POST") { if (crossSiteBlocked(req, res)) return; return await handleAddSyncTarget(req, res); }
      if (pathname === "/sync" && method === "POST") { if (crossSiteBlocked(req, res)) return; return await handleSyncAll(req, res); }
      const syncTargetMatch = pathname.match(/^\/sync\/targets\/([^/]+)$/);
      if (syncTargetMatch && method === "DELETE") { if (crossSiteBlocked(req, res)) return; return handleRemoveSyncTarget(req, res, decodeURIComponent(syncTargetMatch[1])); }
      const syncOneMatch = pathname.match(/^\/outposts\/([^/]+)\/sync$/);
      if (syncOneMatch && method === "POST") { if (crossSiteBlocked(req, res)) return; return await handleSyncOne(req, res, decodeURIComponent(syncOneMatch[1])); }

      const repairWorkerMatch = pathname.match(/^\/outposts\/([^/]+)\/worker\/repair$/);
      if (repairWorkerMatch && method === "POST") { if (crossSiteBlocked(req, res)) return; return await handleRepairWorker(req, res, liveOpts, decodeURIComponent(repairWorkerMatch[1])); }

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
      try { startConfigWatcher(); } catch (e) { console.error("[outpost] config watcher failed to start:", e instanceof Error ? e.message : String(e)); }
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
