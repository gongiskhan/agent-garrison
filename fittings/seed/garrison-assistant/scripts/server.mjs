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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, answer as answerFrom } from "../lib/index-store.mjs";
import { nextStep } from "../lib/interview.mjs";
import { fileProposals } from "../lib/proposals.mjs";
import { launchTour, listTours } from "../lib/tours.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FITTING_DIR = path.resolve(__dirname, "..");
const TOURS_DIR = path.join(FITTING_DIR, "tours");

import { existsSync } from "node:fs";
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
        return send(res, 200, { ok: true, modes: ["answer", "guide", "build"], index: ensureIndex().size });
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && !process.argv.includes("--probe")) {
  const port = Number(process.env.PORT || process.env.GARRISON_ASSISTANT_PORT || 7095);
  const host = process.env.BIND_HOST || "127.0.0.1";
  createServer().listen(port, host, () => {
    process.stdout.write(`garrison-assistant listening on http://${host}:${port}\n`);
  });
}
