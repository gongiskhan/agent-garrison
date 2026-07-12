#!/usr/bin/env node
// server.mjs — the Garrison Assistant own-port server. Three modes over HTTP:
//   POST /answer          {question}          -> {answer, sources[]}
//   GET  /guide?topic=…                       -> {steps[]}
//   POST /guide/launch-tour {name}            -> {launch,...}
//   POST /interview/next  {answers:[{id,text}]} -> {done:false, question} | {done:true, proposals}
//   GET  /health                              -> ok   (and `--probe` on argv)
// Answer is grounded (index-store); Build files proposals into the Improver
// review queue with provenance `assistant` (proposals.mjs) — never edits an
// artifact directly. Local-only; no Anthropic endpoint.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, answer as answerFrom } from "../lib/index-store.mjs";
import { nextStep } from "../lib/interview.mjs";
import { fileProposals } from "../lib/proposals.mjs";
import { launchTour, listTours } from "../lib/tours.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FITTING_DIR = path.resolve(__dirname, "..");
const TOURS_DIR = path.join(FITTING_DIR, "tours");

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const FITTING_ID = "garrison-assistant";
const DEFAULT_PORT = 7095;
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
const STATUS_DIR = path.join(GARRISON_HOME, "ui-fittings");
const STATUS_FILE = path.join(STATUS_DIR, `${FITTING_ID}.json`);
let SERVER_PORT = DEFAULT_PORT;

// Repo root: walk up from the installed dir to the first dir containing both
// docs/ and fittings/ (works from fittings/seed/<id> and apm_modules/_local/<id>).
function repoRoot() {
  if (process.env.GARRISON_REPO_ROOT) return process.env.GARRISON_REPO_ROOT;
  let dir = FITTING_DIR;
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "docs")) && existsSync(path.join(dir, "fittings"))) return dir;
    const up = path.resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

let INDEX = null;
export function ensureIndex(force = false) {
  if (!INDEX || force) INDEX = buildIndex({ repoRoot: repoRoot() });
  return INDEX;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
        return send(res, 200, { ok: true, port: SERVER_PORT, pid: process.pid, modes: ["answer", "guide", "build"], index: ensureIndex().size });
      }
      if (req.method === "POST" && url.pathname === "/answer") {
        const { question } = await readBody(req);
        const a = answerFrom(ensureIndex(), String(question || ""));
        return send(res, 200, a);
      }
      if (req.method === "POST" && url.pathname === "/reindex") {
        return send(res, 200, { reindexed: ensureIndex(true).size });
      }
      if (req.method === "GET" && url.pathname === "/guide") {
        const topic = url.searchParams.get("topic") || "";
        const a = answerFrom(ensureIndex(), `how do I use ${topic}`);
        return send(res, 200, {
          steps: a.hits.map((h, i) => `${i + 1}. See ${h.source}: ${h.heading}`),
          sources: a.sources,
          tours: Object.keys(listTours(TOURS_DIR))
        });
      }
      if (req.method === "POST" && url.pathname === "/guide/launch-tour") {
        const { name } = await readBody(req);
        try {
          return send(res, 200, launchTour(String(name || ""), TOURS_DIR));
        } catch (e) {
          return send(res, 404, { error: e.message, known: e.known ?? [] });
        }
      }
      if (req.method === "POST" && url.pathname === "/interview/next") {
        const { answers } = await readBody(req);
        const step = nextStep(Array.isArray(answers) ? answers : []);
        if (!step.done) return send(res, 200, { done: false, question: step.question });
        const at = new Date(Date.parse(url.searchParams.get("at") || "") || 0).toISOString();
        const filed = fileProposals(step.proposals, process.env.GARRISON_NOW || at);
        return send(res, 200, { done: true, proposals: filed });
      }
      return send(res, 404, { error: `no route ${req.method} ${url.pathname}` });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });
}

// --probe: build the index (proves grounding is available) and exit ok.
if (process.argv.includes("--probe")) {
  try {
    const size = ensureIndex().size;
    process.stdout.write(size >= 0 ? "ok\n" : "empty\n");
    process.exit(0);
  } catch (e) {
    process.stderr.write(`probe failed: ${e.message}\n`);
    process.exit(1);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return Boolean(err && err.code === "EPERM"); }
}

// Register at ~/.garrison/ui-fittings/<id>.json so the sidebar Views live-link
// and the runner's lifecycle stop can find this instance. Never steal the slot
// from a live sibling (the Monitor/file-browser status-file contract).
function claimStatusFile(port, host) {
  try {
    const tracked = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
    const pid = Number(tracked?.pid);
    if (pid !== process.pid && pidAlive(pid)) {
      process.stderr.write(`[garrison-assistant] ${STATUS_FILE} tracks live pid ${pid}; running untracked\n`);
      return false;
    }
  } catch { /* absent or unreadable status file is claimable */ }
  mkdirSync(STATUS_DIR, { recursive: true });
  writeFileSync(
    STATUS_FILE,
    JSON.stringify(
      {
        fittingId: FITTING_ID,
        port,
        url: `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        route: "/",
        views: [{ id: FITTING_ID, title: "Assistant", route: "/" }]
      },
      null,
      2
    )
  );
  return true;
}

// Bind the CONFIGURED port or exit non-zero. No findFreePort auto-shift: a
// collision must fail loud (a shifted port orphans the status-file slot and
// hides the collision) — the own-port canonical-port contract. The config
// port/host arrive as GARRISON_GARRISONASSISTANT_PORT / _BIND_HOST (the runner's
// ownPortConfigEnv projection, same as ports-default/power-default).
export function startServer() {
  const port = Number(
    process.env.GARRISON_GARRISONASSISTANT_PORT ||
      process.env.GARRISON_ASSISTANT_PORT ||
      process.env.PORT ||
      DEFAULT_PORT
  );
  const host = process.env.GARRISON_GARRISONASSISTANT_BIND_HOST || process.env.BIND_HOST || "127.0.0.1";
  SERVER_PORT = port;
  const size = ensureIndex().size; // build the grounding index up front
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE") {
        process.stderr.write(`[garrison-assistant] port ${port} is in use — refusing to start (no auto-shift)\n`);
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port, host, () => {
      const owns = claimStatusFile(port, host);
      const shutdown = () => {
        if (owns) { try { unlinkSync(STATUS_FILE); } catch { /* already gone */ } }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      process.stdout.write(`garrison-assistant listening on http://${host}:${port} (indexed ${size} sections)\n`);
      resolve(server);
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && !process.argv.includes("--probe")) {
  startServer().catch((err) => {
    process.stderr.write(`[garrison-assistant] start failed: ${err.message}\n`);
    process.exit(1);
  });
}
