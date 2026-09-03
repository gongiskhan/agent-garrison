#!/usr/bin/env node
// Preflight Fitting backend — the composition doctor. Serves the report UI
// and a JSON API; read-only except the explicit verify sweep, which only
// proxies the Garrison app's own /api/runner/<id>/verify (the same code path
// up() runs, so the results can never drift from what up() would see).

import { createReadStream, existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

import { buildReport } from "../lib/report.mjs";
import { runVerifySweep, isAppUp } from "../lib/app-client.mjs";
import { assessSweepResults, summarize } from "../lib/preflight-core.mjs";

const HOME = os.homedir();
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const STATUS_ROOT = path.join(GARRISON_HOME, "ui-fittings");
const STATUS_FILE = path.join(STATUS_ROOT, "preflight.json");
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
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

function serveStatic(req, res, distDir) {
  const pathname = url.parse(req.url || "/").pathname || "/";
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.join(distDir, rel);
  if (!filePath.startsWith(distDir) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

async function writeStatusFile(opts) {
  await mkdir(STATUS_ROOT, { recursive: true });
  await writeFile(STATUS_FILE, JSON.stringify({
    fittingId: FITTING_ID,
    port: opts.port,
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    route: "/",
    views: [{ id: "preflight", title: "Preflight", route: "/" }]
  }, null, 2));
}

async function clearStatusFile() {
  try { await unlink(STATUS_FILE); } catch { /* already gone */ }
}

export async function startServer(opts = parseArgs(process.argv.slice(2))) {
  const distDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "dist");
  const liveOpts = { ...opts };
  let sweepRunning = false;

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = url.parse(req.url || "/").pathname || "/";
      const method = req.method || "GET";

      if (pathname === "/health") {
        return jsonRes(res, 200, { ok: true, port: liveOpts.port, pid: process.pid });
      }
      if (pathname === "/api/report" && method === "GET") {
        const query = url.parse(req.url || "/", true).query;
        const checks = typeof query.checks === "string" && query.checks ? query.checks.split(",") : null;
        return jsonRes(res, 200, await buildReport({ checks }));
      }
      if (pathname === "/api/verify-sweep" && method === "POST") {
        if (sweepRunning) return jsonRes(res, 409, { error: "a sweep is already running" });
        const body = await readBody(req);
        const compositionId = String(body.compositionId || "");
        if (!compositionId) return jsonRes(res, 400, { error: "compositionId required" });
        if (!(await isAppUp())) return jsonRes(res, 503, { error: "Garrison app unreachable — the sweep proxies the app's own verify endpoint" });
        sweepRunning = true;
        try {
          const sweep = await runVerifySweep(compositionId);
          if (!sweep.ok) return jsonRes(res, 502, { error: sweep.error });
          const findings = assessSweepResults(compositionId, sweep.results);
          return jsonRes(res, 200, { findings, summary: summarize(findings), compositionId });
        } finally {
          sweepRunning = false;
        }
      }
      return serveStatic(req, res, distDir);
    } catch (err) {
      console.error("[preflight] handler error:", err);
      jsonRes(res, 500, { error: err?.message ?? String(err) });
    }
  });

  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(
        `[preflight] port ${liveOpts.port} is already in use - refusing to start on a shifted port (the configured port is canonical)`
      );
      process.exit(1);
    }
    throw err;
  });

  server.listen(liveOpts.port, liveOpts.host, async () => {
    const bound = server.address();
    if (bound && typeof bound === "object" && bound.port) liveOpts.port = bound.port;
    await writeStatusFile(liveOpts);
    console.log(`[preflight] listening on http://${liveOpts.host}:${liveOpts.port}`);
  });

  const shutdown = async (signal) => {
    await clearStatusFile();
    process.exit(signal === "SIGINT" ? 130 : 0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}
