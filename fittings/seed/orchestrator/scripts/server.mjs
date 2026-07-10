#!/usr/bin/env node
// Model Router own-port server (BRIEF v4 MR2). Serves the router view (dist/) and
// OWNS the routing config API:
//   GET  /health    → {ok, port, pid}
//   GET  /routing   → {config, baselineSha}                 (read-fresh)
//   PUT  /routing   → {config} body w/ ?baseline=<sha> guard → write, 409 on mismatch
//   POST /simulate  → {prompt, profile?, taskType?, tier?, matchedException?}
//                     → {classification, route, compiled?}  (Stage A: pure resolve;
//                       live classify only when no manual taskType/tier supplied)
//   GET  /telemetry → recent decisions.jsonl rows + per-target hit counts
// Self-registers at ~/.garrison/ui-fittings/orchestrator.json on listen.
//
// The view and the Improver both go through this API (whole-document, baseline-
// hash guarded). Config path is composition-scoped so the runner's
// resolveRoutingSection reads the same bytes (pending-restart = compiled != loaded).

import { createServer as createNetServer } from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile, unlink, stat } from "node:fs/promises";
import {
  compileRouting,
  validateRoutingConfig,
  resolveRoute,
  buildClassifierPrompt,
  parseClassification,
  compilePolicy,
  stableStringify,
  railFor,
  classifyExecution,
  isV2
} from "../lib/routing-core.mjs";
import { readDecisions } from "../lib/routing-telemetry.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FITTING_DIR = path.resolve(HERE, "..");
const DIST_DIR = path.join(FITTING_DIR, "dist");
const SEED_CONFIG = path.join(FITTING_DIR, "config", "routing.seed.json");
const HOME = os.homedir();
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const FITTING_ID = "orchestrator";
const STATUS_FILE = path.join(GARRISON_HOME, "ui-fittings", `${FITTING_ID}.json`);
// State home for off-composition config (the fitting was renamed from
// model-router in GARRISON-UNIFY-V1 S2; a one-shot migration moves the old dir).
const STATE_DIR = path.join(GARRISON_HOME, FITTING_ID);
const LEGACY_STATE_DIR = path.join(GARRISON_HOME, "model-router");

// One-shot state migration: if the legacy ~/.garrison/model-router dir exists
// and the new one does not, move it. Env var names accept the MODEL_ROUTER_*
// spellings for back-compat with an already-running composition's env.
function migrateLegacyState() {
  try {
    if (existsSync(LEGACY_STATE_DIR) && !existsSync(STATE_DIR)) renameSync(LEGACY_STATE_DIR, STATE_DIR);
    const legacyStatus = path.join(GARRISON_HOME, "ui-fittings", "model-router.json");
    if (existsSync(legacyStatus)) rmSync(legacyStatus, { force: true });
  } catch {
    /* best-effort; a fresh box has neither */
  }
}

function configPath() {
  if (process.env.ORCHESTRATOR_CONFIG || process.env.MODEL_ROUTER_CONFIG)
    return process.env.ORCHESTRATOR_CONFIG || process.env.MODEL_ROUTER_CONFIG;
  if (process.env.GARRISON_COMPOSITION_DIR)
    return path.join(process.env.GARRISON_COMPOSITION_DIR, ".garrison", "routing.json");
  return path.join(STATE_DIR, "routing.json");
}

function decisionsPath() {
  if (process.env.ORCHESTRATOR_DECISIONS || process.env.MODEL_ROUTER_DECISIONS)
    return process.env.ORCHESTRATOR_DECISIONS || process.env.MODEL_ROUTER_DECISIONS;
  return path.join(path.dirname(configPath()), "decisions.jsonl");
}

// D4: the one consumption interface for the run engine + every phase skill.
function policyPath() {
  if (process.env.GARRISON_POLICY_PATH) return process.env.GARRISON_POLICY_PATH;
  return path.join(GARRISON_HOME, "orchestrator", "policy.json");
}

// Compile the active profile into policy.json — atomic (temp+rename),
// byte-stable. Called on startup and on every accepted PUT. Failures are
// reported, never silent (a stale policy.json must not masquerade as fresh).
async function writeCompiledPolicy(config) {
  const target = policyPath();
  const bytes = stableStringify(compilePolicy(config));
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, bytes, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, target);
  return target;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

async function loadConfigRaw() {
  const p = configPath();
  if (existsSync(p)) return readFileSync(p, "utf8");
  // seed on first touch
  const seed = readFileSync(SEED_CONFIG, "utf8");
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, seed, "utf8");
  return seed;
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleGetRouting(_req, res) {
  const raw = await loadConfigRaw();
  json(res, 200, { config: JSON.parse(raw), baselineSha: sha(raw) });
}

async function handlePutRouting(req, res, query) {
  const raw = await loadConfigRaw();
  const currentSha = sha(raw);
  const baseline = query.get("baseline");
  if (baseline && baseline !== currentSha) {
    return json(res, 409, { error: "conflict", message: "routing.json changed since baseline", currentSha });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "invalid-json" });
  }
  const next = body.config ?? body;
  const errors = validateRoutingConfig(next);
  if (errors.length) return json(res, 422, { error: "invalid-config", errors });
  // Compile the policy FIRST (D4/D12): a config that validates but cannot
  // compile must not be persisted — otherwise routing.json and policy.json
  // diverge silently. Only persist once both succeed.
  let policyBytes;
  try {
    policyBytes = stableStringify(compilePolicy(next));
  } catch (err) {
    return json(res, 422, { error: "policy-compile-failed", message: String(err?.message || err) });
  }
  const serialized = JSON.stringify(next, null, 2) + "\n";
  const configTarget = configPath();
  const policyTarget = policyPath();
  await mkdir(path.dirname(configTarget), { recursive: true });
  await mkdir(path.dirname(policyTarget), { recursive: true });
  const { rename } = await import("node:fs/promises");
  // BOTH files are written atomically (tmp + rename): a plain writeFile on
  // routing.json could leave it truncated/corrupt on a crash mid-write — and
  // routing.json is the config SOURCE OF TRUTH, not a cache. Write both temp
  // files fully first (either can fail harmlessly, nothing committed), then
  // commit routing.json FIRST and policy.json (the derived cache) second: a
  // crash between the two renames leaves new-config + old-policy, which the
  // server's startup recompile (D4) heals to new-policy, preserving the edit.
  const cfgTmp = `${configTarget}.tmp-${process.pid}`;
  const polTmp = `${policyTarget}.tmp-${process.pid}`;
  await writeFile(cfgTmp, serialized, "utf8");
  await writeFile(polTmp, policyBytes, "utf8");
  await rename(cfgTmp, configTarget);
  await rename(polTmp, policyTarget);
  json(res, 200, { ok: true, baselineSha: sha(serialized), policyPath: policyTarget });
}

// Deterministic keyword heuristic for the composer dry-run strip — pure, no I/O,
// no model. routing-core exports no classifyByKeywords, so this local heuristic
// stands in; it degrades to {code, T1-standard} (the brief's stated default) when
// nothing matches. The live classifier still runs at the gateway for real turns.
function heuristicClassify(prompt) {
  const p = String(prompt || "").toLowerCase();
  const has = (...ws) => ws.some((w) => p.includes(w));
  let taskType = "code";
  if (has("research", "investigate", "compare", "find out", "look into")) taskType = "research";
  else if (has("review", "audit")) taskType = "review";
  else if (has("unit test", "e2e", "add a test", "write tests", "test coverage")) taskType = "test";
  else if (has("logo", "icon", "image", "picture", "diagram")) taskType = "image";
  else if (has("video", "screencast", "record a demo")) taskType = "video";
  else if (has("readme", "documentation", " docs", "blog", "draft", "write up")) taskType = "writing";
  else if (has("deploy", "infra", "pipeline", "provision", " ops")) taskType = "ops";
  else if (has("plan ", "design a", "architecture")) taskType = "plan";
  else if (has("implement", "build", "add ", "create", "feature", "fix", "bug", "page", "endpoint", "api")) taskType = "implement";
  let tier = "T1-standard";
  if (has("trivial", "rename", "typo", "one-line", "quick tweak", "small fix")) tier = "T0-trivial";
  else if (has("architecture", "migration", "security", "redesign", "overhaul", "whole system", "tricky", "complex"))
    tier = "T2-deep";
  return { taskType, tier, matchedException: null };
}

async function handleSimulate(req, res) {
  const raw = await loadConfigRaw();
  const config = JSON.parse(raw);
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "invalid-json" });
  }
  const profile = body.profile || config.activeProfile;

  // Composer dry-run strip (S3 D12): deterministic heuristic classification — NO
  // live model call — plus the fully-resolved phase rail for the chosen work kind.
  // Every ON chip is enriched with the target it resolves to at the classified
  // tier; OFF chips stay in the rail (on:false) so the strip reads honestly.
  if (body.tryIt) {
    const classification = heuristicClassify(body.prompt);
    const execution = classifyExecution({ message: String(body.prompt || ""), classification });
    const route = resolveRoute(config, profile, classification);
    const workKind = body.workKind || config.defaultWorkKind || null;
    let rail;
    try {
      const base = railFor(config, workKind);
      rail = {
        ...base,
        phases: base.phases.map((ph) => {
          if (!ph.on) return ph;
          const r = resolveRoute(config, profile, { taskType: ph.id, tier: classification.tier });
          const t = r.target || {};
          return {
            ...ph,
            target: { targetId: r.targetId, model: t.model ?? null, effort: t.effort ?? null, runtime: t.runtime ?? null }
          };
        })
      };
    } catch (err) {
      rail = { error: String(err?.message || err) };
    }
    return json(res, 200, { classification: { ...classification, execution }, route, profile, workKind, rail, dryRun: true });
  }

  let classification;
  if (body.taskType && body.tier) {
    // manual / deterministic mode (pins, Playwright) — pure resolve, no model.
    classification = { taskType: body.taskType, tier: body.tier, matchedException: body.matchedException ?? null };
  } else if (body.prompt) {
    // live Stage A: classify via a pooled haiku session (the same path the gateway uses).
    classification = await liveClassify(config, body.prompt);
  } else {
    return json(res, 400, { error: "need prompt or {taskType,tier}" });
  }
  const route = resolveRoute(config, profile, classification);
  const compiled = body.includeCompiled ? compileRouting(config, profile) : undefined;
  json(res, 200, { classification, route, profile, compiled });
}

let _pool = null;
async function liveClassify(config, prompt) {
  try {
    const { WarmPtySessionPool, OperativePtySession } = await import("@garrison/claude-pty");
    if (!_pool) {
      const cwd = path.join(STATE_DIR, "classifier-cwd");
      await mkdir(cwd, { recursive: true });
      _pool = new WarmPtySessionPool({
        size: 1,
        spawnFn: (opts = {}) =>
          OperativePtySession.spawn({ compositionDir: cwd, model: "haiku", permissionMode: "bypassPermissions", readinessTimeoutMs: 45000, ...opts })
      });
      await _pool.start();
    }
    const co = await _pool.checkout();
    const r = await co.session.runTurn({ message: buildClassifierPrompt(config, prompt), timeoutMs: 60000 });
    co.release();
    return parseClassification(r.reply || "", config) || { taskType: "other", tier: "T1-standard", matchedException: null };
  } catch (err) {
    // dry-run safety: if no live model, fall back to a neutral classification.
    return { taskType: "other", tier: "T1-standard", matchedException: null, _classifyError: String(err?.message || err) };
  }
}

async function handleTelemetry(_req, res) {
  const rows = await readDecisions(decisionsPath());
  const byTarget = {};
  const byRule = {};
  for (const r of rows) {
    if (r.targetId) byTarget[r.targetId] = (byTarget[r.targetId] || 0) + 1;
    if (r.ruleId) byRule[r.ruleId] = (byRule[r.ruleId] || 0) + 1;
  }
  json(res, 200, { count: rows.length, recent: rows.slice(-50).reverse(), byTarget, byRule });
}

// ── D38 ghost edits (Improver proposals proxy) ──────────────────────────────
// The Improver self-registers at ~/.garrison/ui-fittings/improver.json with a
// {url}. Resolve it fresh each request (the Improver may (re)start independently).
function improverBaseUrl() {
  // Resolve the Garrison home lazily (not the frozen module const) so a live
  // GARRISON_HOME override is honored and the Improver's registration is read fresh.
  const home = process.env.GARRISON_HOME || GARRISON_HOME;
  const p = path.join(home, "ui-fittings", "improver.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j.url || (j.port ? `http://127.0.0.1:${j.port}` : null);
  } catch {
    return null;
  }
}

const withTimeout = (ms) => (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

// GET /ghost-edits → the Improver's orchestrator-policy proposals, or {available:false}
// when the Improver is absent/unreachable (the composer skips the overlay silently).
async function handleGhostEdits(res) {
  const baseUrl = improverBaseUrl();
  if (!baseUrl) return json(res, 200, { available: false, proposals: [] });
  try {
    const r = await fetch(`${baseUrl}/api/queue`, { signal: withTimeout(4000) });
    if (!r.ok) return json(res, 200, { available: false, proposals: [], error: `improver ${r.status}` });
    const q = await r.json();
    const proposals = (q.queue || [])
      .filter((p) => p && p.rule === "orchestrator-policy")
      .map((p) => ({ id: p.id, rule: p.rule, claim: p.claim, diff: p.diff, decision: p.decision, status: p.status, at: p.at }));
    return json(res, 200, { available: true, improverUrl: baseUrl, proposals });
  } catch (err) {
    return json(res, 200, { available: false, proposals: [], error: String(err?.message || err) });
  }
}

// POST /ghost-edits/:id/(apply|reject) → proxy to the Improver. NEVER auto-applies:
// only a user click on Accept/Dismiss reaches here. The Improver owns the actual
// apply (applyWithRetry → reconcile) so policy.json is recompiled on its side.
async function handleGhostAction(res, id, action) {
  const baseUrl = improverBaseUrl();
  if (!baseUrl) return json(res, 503, { error: "improver-unavailable" });
  try {
    const r = await fetch(`${baseUrl}/api/proposals/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      signal: withTimeout(20000)
    });
    const body = await r.json().catch(() => ({}));
    return json(res, r.status, body);
  } catch (err) {
    return json(res, 502, { error: "improver-proxy-failed", message: String(err?.message || err) });
  }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json", ".svg": "image/svg+xml" };
async function serveStatic(req, res, pathname) {
  let rel = pathname.replace(/^\/+/, "");
  if (rel === "" || rel === "/") rel = "index.html";
  let filePath = path.join(DIST_DIR, rel);
  if (!filePath.startsWith(DIST_DIR)) return json(res, 403, { error: "forbidden" });
  try {
    await stat(filePath);
  } catch {
    filePath = path.join(DIST_DIR, "index.html"); // SPA fallback
  }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    json(res, 404, { error: "not-found" });
  }
}

async function findFreePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const srv = createNetServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
  for (let p = preferred; p < preferred + 50; p++) if (await tryPort(p)) return p;
  return preferred;
}

export async function startServer(opts = {}) {
  const host = opts.host || process.env.ORCHESTRATOR_HOST || process.env.MODEL_ROUTER_HOST || "127.0.0.1";
  const preferred = Number(opts.port || process.env.ORCHESTRATOR_PORT || process.env.MODEL_ROUTER_PORT || 7087);
  migrateLegacyState();
  const port = await findFreePort(preferred);

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url, true);
      const pathname = parsed.pathname;
      const query = new URLSearchParams(parsed.query);
      if (pathname === "/health") return json(res, 200, { ok: true, port, pid: process.pid });
      if (pathname === "/routing" && req.method === "GET") return handleGetRouting(req, res);
      if (pathname === "/routing" && req.method === "PUT") return handlePutRouting(req, res, query);
      if (pathname === "/simulate" && req.method === "POST") return handleSimulate(req, res);
      if (pathname === "/telemetry" && req.method === "GET") return handleTelemetry(req, res);
      // D38 ghost edits: same-origin proxy to the Improver's review queue. The
      // browser can neither read ~/.garrison/ui-fittings/improver.json nor POST
      // cross-origin to the Improver's port, so the composer goes through here.
      if (pathname === "/ghost-edits" && req.method === "GET") return handleGhostEdits(res);
      {
        const m = pathname.match(/^\/ghost-edits\/([^/]+)\/(apply|reject)$/);
        if (m && req.method === "POST") return handleGhostAction(res, decodeURIComponent(m[1]), m[2]);
      }
      return serveStatic(req, res, pathname);
    } catch (err) {
      json(res, 500, { error: "server-error", message: String(err?.message || err) });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  await writeStatusFile({ port, host });
  // Composition start (D4): compile the current config into policy.json so
  // consumers never read a stale policy after a config change made off-server.
  try {
    await writeCompiledPolicy(JSON.parse(await loadConfigRaw()));
  } catch (err) {
    console.error("[orchestrator] policy compile at startup failed:", err?.message || err);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return { server, port, host, close: () => new Promise((r) => server.close(r)) };

  async function writeStatusFile({ port, host }) {
    await mkdir(path.dirname(STATUS_FILE), { recursive: true });
    await writeFile(
      STATUS_FILE,
      JSON.stringify({ fittingId: FITTING_ID, port, url: `http://${host}:${port}`, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
  }
  async function shutdown() {
    try {
      await unlink(STATUS_FILE);
    } catch {
      /* ignore */
    }
    try {
      _pool?.shutdown();
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then((s) => console.log(`[orchestrator] listening on ${s.host}:${s.port}`)).catch((e) => {
    console.error("[orchestrator] start failed:", e);
    process.exit(1);
  });
}
