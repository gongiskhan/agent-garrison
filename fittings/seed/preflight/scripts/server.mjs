#!/usr/bin/env node
// Preflight Fitting backend — the composition doctor. Serves the report UI
// and a JSON API. Repairs and stopped-composition verify sweeps share one
// mutation lane; the repair registry revalidates each action before applying it.

import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { assessSweepResults, summarize } from "../lib/preflight-core.mjs";

const HOME = os.homedir();
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const STATUS_FILE = path.join(GARRISON_HOME, "ui-fittings", "preflight.json");
const FITTING_ID = "preflight";

// The runner projects composition config as GARRISON_<ID>_<KEY> (ownPortConfigEnv);
// the projected name must win or the composition's `config:` block is decorative.
// No hardcoded port fallback: port 0 (ephemeral) is the standalone default and
// the composition/runner always provides the real one.
function parseArgs(argv) {
  const out = {
    port: Number(process.env.GARRISON_PREFLIGHT_PORT ?? process.env.PREFLIGHT_PORT ?? process.env.PORT ?? 0),
    host: process.env.GARRISON_PREFLIGHT_BIND_HOST || process.env.GARRISON_BIND_HOST || "127.0.0.1"
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--host") out.host = argv[++i];
  }
  return out;
}

function jsonRes(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) return res.destroy();
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

const MAX_BODY_BYTES = 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function trustedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".ts.net")) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return isIP(host) === 6 && /^(?:f[cd]|fe[89ab])/i.test(host);
}

function validateMutationRequest(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") throw new RequestError(403, "cross-site request refused");
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const source = new URL(origin);
      const target = new URL(`http://${req.headers.host || ""}`);
      if (!/^https?:$/.test(source.protocol) || source.origin !== origin ||
          source.host.toLowerCase() !== target.host.toLowerCase() || !trustedHost(target.hostname)) throw new Error();
    } catch { throw new RequestError(403, "same-host Origin required"); }
  }
  if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "application/json required");
  }
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
    throw new RequestError(415, "encoded request bodies are not supported");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw new RequestError(413, "request body too large");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks = [];
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", data); req.off("end", end); req.off("aborted", aborted); req.off("error", error);
      chunks = [];
      if (err) {
        // A rejected/aborted body must settle the handler and must not retain
        // its buffers or turn a later socket error into an unhandled event.
        req.once("error", () => {});
        req.resume();
        reject(err);
      } else resolve(value);
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) return finish(new RequestError(413, "request body too large"));
      chunks.push(chunk);
    };
    const end = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        finish(null, value);
      } catch { finish(new RequestError(400, "JSON object required")); }
    };
    const aborted = () => finish(new RequestError(400, "request aborted"));
    const error = () => finish(new RequestError(400, "request body failed"));
    const timer = setTimeout(() => finish(new RequestError(408, "request body timed out")), BODY_TIMEOUT_MS);
    timer.unref();
    req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", error);
    if (req.aborted || req.destroyed) aborted();
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

async function serveStatic(req, res, distDir) {
  let pathname;
  try { pathname = decodeURIComponent(url.parse(req.url || "/").pathname || "/"); }
  catch { throw new RequestError(400, "invalid path"); }
  if (pathname.includes("\0")) throw new RequestError(400, "invalid path");
  const root = await realpath(distDir);
  const requested = path.resolve(root, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!requested.startsWith(root + path.sep)) throw new RequestError(404, "not found");
  let filePath;
  try { filePath = await realpath(requested); } catch { throw new RequestError(404, "not found"); }
  if (!filePath.startsWith(root + path.sep) || !(await stat(filePath)).isFile()) throw new RequestError(404, "not found");
  res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(filePath);
  stream.once("error", () => res.destroy());
  res.once("close", () => stream.destroy());
  stream.pipe(res);
}

const DEFAULT_DEPS = {
  buildReport: async (...args) => (await import("../lib/report.mjs")).buildReport(...args),
  runFix: async (...args) => (await import("../lib/fixers.mjs")).runFix(...args),
  runVerifySweep: async (...args) => (await import("../lib/app-client.mjs")).runVerifySweep(...args),
  isAppUp: async (...args) => (await import("../lib/app-client.mjs")).isAppUp(...args),
  fetchRunnerState: async (...args) => (await import("../lib/app-client.mjs")).fetchRunnerState(...args)
};

// Importing this handler neither writes a live status record nor starts a
// process. Real HTTP tests inject all side-effecting dependencies.
export function createRequestHandler(deps = {}) {
  const api = { ...DEFAULT_DEPS, ...deps };
  const distDir = api.distDir || path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "dist");
  let mutationTail = Promise.resolve();
  const mutate = (req, res, operation) => {
    const pending = mutationTail.then(() => {
      if (req.aborted || res.destroyed) throw new RequestError(400, "request aborted");
      return operation();
    });
    mutationTail = pending.catch(() => {});
    return pending;
  };

  return async (req, res) => {
    try {
      const pathname = url.parse(req.url || "/").pathname || "/";
      const method = req.method || "GET";
      if (pathname === "/health" && (method === "GET" || method === "HEAD")) {
        return jsonRes(res, 200, { ok: true, port: api.port ?? req.socket.localPort, pid: process.pid });
      }
      if (pathname === "/api/report" && method === "GET") {
        const query = url.parse(req.url || "/", true).query;
        const checks = typeof query.checks === "string" && query.checks ? query.checks.split(",") : null;
        return jsonRes(res, 200, await api.buildReport({ checks }));
      }
      if ((pathname === "/api/fix" || pathname === "/api/verify-sweep") && method === "POST") {
        validateMutationRequest(req);
        const body = await readBody(req);
        if (pathname === "/api/fix") {
          if (typeof body.actionId !== "string" || !body.actionId.trim() ||
              (body.params !== undefined && (!body.params || typeof body.params !== "object" || Array.isArray(body.params)))) {
            throw new RequestError(400, "actionId and object params required");
          }
          const result = await mutate(req, res, () => api.runFix(body.actionId, body.params ?? {}));
          return jsonRes(res, result.ok ? 200 : 400, result);
        }
        const compositionId = body.compositionId;
        if (typeof compositionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(compositionId)) {
          throw new RequestError(400, "compositionId required");
        }
        return await mutate(req, res, async () => {
          if (!(await api.isAppUp())) throw new RequestError(503, "Garrison app unreachable");
          // Check immediately before the sweep, after any queued repair. Verify
          // rewrites runner status and must never interrupt a live composition.
          const state = await api.fetchRunnerState(compositionId);
          if (!state || !["idle", "failed"].includes(state.status)) {
            throw new RequestError(409, "verify requires a confirmed idle or failed composition");
          }
          const sweep = await api.runVerifySweep(compositionId);
          if (!sweep.ok) return jsonRes(res, 502, { error: sweep.error });
          const findings = assessSweepResults(compositionId, sweep.results);
          return jsonRes(res, 200, { findings, summary: summarize(findings), compositionId });
        });
      }
      if (pathname.startsWith("/api/") || !["GET", "HEAD"].includes(method)) {
        throw new RequestError(405, "method or endpoint not supported");
      }
      return await serveStatic(req, res, distDir);
    } catch (err) {
      req.resume();
      if (!(err instanceof RequestError)) console.error("[preflight] handler error:", err);
      jsonRes(res, err instanceof RequestError ? err.status : 500, { error: err?.message ?? String(err) });
    }
  };
}

export async function writeStatusFile(opts, { statusFile = STATUS_FILE, pid = process.pid } = {}) {
  await mkdir(path.dirname(statusFile), { recursive: true });
  const temporary = `${statusFile}.${pid}.${randomUUID()}.tmp`;
  const record = {
    fittingId: FITTING_ID,
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid,
    startedAt: new Date().toISOString(),
    route: "/",
    views: [{ id: "preflight", title: "Preflight", route: "/" }]
  };
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, statusFile);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function clearStatusFile({ statusFile = STATUS_FILE, pid = process.pid } = {}) {
  try {
    const record = JSON.parse(await readFile(statusFile, "utf8"));
    // A replacement process may have claimed the same fitting during shutdown.
    // Its live discovery record must survive this old process's cleanup.
    if (record?.pid === pid) await unlink(statusFile);
  } catch { /* Missing, unreadable or unowned records are left untouched. */ }
}

export async function startServer(opts = parseArgs(process.argv.slice(2)), { statusFile = STATUS_FILE, ...deps } = {}) {
  const liveOpts = { ...opts };
  const server = http.createServer(createRequestHandler(deps));
  // Bind first. A failed duplicate must not write or clear the existing slot,
  // nor leave behind signal handlers that can later erase it.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(liveOpts.port, liveOpts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address();
  if (bound && typeof bound === "object" && bound.port) liveOpts.port = bound.port;
  try { await writeStatusFile(liveOpts, { statusFile }); }
  catch (err) { await new Promise((resolve) => server.close(resolve)); throw err; }

  const shutdown = async (signal) => {
    await clearStatusFile({ statusFile });
    process.exit(signal === "SIGINT" ? 130 : 0);
  };
  const onTerm = () => { void shutdown("SIGTERM"); };
  const onInt = () => { void shutdown("SIGINT"); };
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  server.once("close", () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
    void clearStatusFile({ statusFile });
  });
  console.log(`[preflight] listening on http://${liveOpts.host}:${liveOpts.port}`);

  return server;
}
