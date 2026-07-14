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

import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { createHash, randomBytes } from "node:crypto";
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
  isV2,
  migrateRoutingConfig,
  applyDutyCells,
  DEFAULT_PRIMARY_RUNTIME_ID
} from "../lib/routing-core.mjs";
import jsYaml from "js-yaml";
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

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

// One-shot state migration: if the legacy ~/.garrison/model-router dir exists
// and the new one does not, move it. Env var names accept the MODEL_ROUTER_*
// spellings for back-compat with an already-running composition's env.
// The legacy status file names the pre-rename model-router process this fitting
// supersedes: stop that process (SIGTERM, then SIGKILL) and only drop the file
// once it is confirmed dead - removing the file while the pid lives would leave
// an untracked orphan squatting the configured port.
async function migrateLegacyState() {
  try {
    if (existsSync(LEGACY_STATE_DIR) && !existsSync(STATE_DIR)) renameSync(LEGACY_STATE_DIR, STATE_DIR);
    const legacyStatus = path.join(GARRISON_HOME, "ui-fittings", "model-router.json");
    if (!existsSync(legacyStatus)) return;
    let legacyPid = null;
    try { legacyPid = Number(JSON.parse(readFileSync(legacyStatus, "utf8")).pid); } catch { /* unreadable slot */ }
    if (Number.isInteger(legacyPid) && legacyPid > 0 && legacyPid !== process.pid && pidAlive(legacyPid)) {
      try { process.kill(legacyPid, "SIGTERM"); } catch { /* raced exit */ }
      let gone = await waitForExit(legacyPid, 5000);
      if (!gone) {
        try { process.kill(legacyPid, "SIGKILL"); } catch { /* raced exit */ }
        gone = await waitForExit(legacyPid, 2000);
      }
      if (!gone) {
        console.error(`[orchestrator] legacy model-router pid ${legacyPid} survived SIGKILL - keeping ${legacyStatus}`);
        return;
      }
      console.log(`[orchestrator] stopped superseded model-router pid ${legacyPid}`);
    }
    rmSync(legacyStatus, { force: true });
  } catch {
    /* best-effort; a fresh box has neither */
  }
}

// The status file is a single tracking slot. If it names another live process,
// this boot is a duplicate - refuse instead of silently stealing the slot.
function assertStatusSlotFree() {
  let recorded;
  try { recorded = JSON.parse(readFileSync(STATUS_FILE, "utf8")); } catch { return; }
  const pid = Number(recorded?.pid);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
    console.error(`[orchestrator] ${STATUS_FILE} is held by live pid ${pid} - refusing to overwrite another instance's status file`);
    process.exit(1);
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

// The runner-projected resolved duty model (~/.garrison/kanban-loop/model.json).
// Its per-duty per-level cells REPOINT the matrix rows at the composition's
// duty ladders (applyDutyCells) — the same merge the runner applies at up() —
// so this server's recompiles (startup, PUT) never clobber the duties-derived
// policy with the raw routing.json rows. Absent/unreadable file → null.
function loadKanbanDutyModel() {
  try {
    const dir = process.env.GARRISON_KANBAN_DIR?.trim() || path.join(os.homedir(), ".garrison", "kanban-loop");
    const file = path.join(dir, "model.json");
    if (!existsSync(file)) return null;
    const model = JSON.parse(readFileSync(file, "utf8"));
    return model && typeof model === "object" && model.cells && typeof model.cells === "object" ? model : null;
  } catch {
    return null;
  }
}

// Compile the active profile into policy.json — atomic (temp+rename),
// byte-stable. Called on startup and on every accepted PUT. Failures are
// reported, never silent (a stale policy.json must not masquerade as fresh).
async function writeCompiledPolicy(config) {
  const target = policyPath();
  const dutyModel = loadKanbanDutyModel();
  const merged = dutyModel ? applyDutyCells(config, dutyModel) : config;
  const bytes = stableStringify(compilePolicy(merged));
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

// v1→v2 migrate-at-load (one-shot, at startup). The composer UI renders v2 only,
// and a hand-written or pre-pivot routing.json on disk can still be v1 (role-
// based). Migrate it ONCE here: preserve the original as <path>.v1.bak (never
// clobbering an existing backup), write the v2 shape back to the SAME path
// atomically (tmp + rename, like the PUT commit), and recompile policy.json from
// the migrated config so the derived cache matches. A fresh box has no file yet —
// loadConfigRaw seeds it from the v2 seed — so this fires only on an existing v1.
async function migrateConfigFileIfV1() {
  const p = configPath();
  if (!existsSync(p)) return;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return; // corrupt/unreadable — the startup recompile reports it loudly
  }
  if (isV2(parsed)) return;
  let migrated;
  try {
    migrated = migrateRoutingConfig(parsed);
  } catch (err) {
    console.error(`[orchestrator] routing.json at ${p} is not v2 and cannot be migrated: ${String(err?.message || err)} — leaving it untouched`);
    return;
  }
  const bak = `${p}.v1.bak`;
  if (!existsSync(bak)) await writeFile(bak, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  const serialized = JSON.stringify(migrated, null, 2) + "\n";
  const uniq = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const tmp = `${p}.tmp-${uniq}`;
  await writeFile(tmp, serialized, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, p);
  await writeCompiledPolicy(migrated);
  console.log(`[orchestrator] migrated v1 routing.json → v2 at ${p} (original preserved at ${bak}); policy.json recompiled`);
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
  const parsed = JSON.parse(raw);
  // Serve v2 even if the file drifted back to v1 externally (startup migration
  // owns the write-back; the GET path never persists). baselineSha stays over the
  // RAW bytes so the PUT baseline guard still matches what is actually on disk.
  const config = isV2(parsed) ? parsed : migrateRoutingConfig(parsed);
  json(res, 200, { config, baselineSha: sha(raw) });
}

// ── Installed runtime fittings (GARRISON-RUNTIMES-V1 P3/D3/D4) ──────────────
// Feeds the composer's primary-runtime picker and the per-mechanism target
// editor from the COMPOSITION on disk — pure file reads, works with the
// gateway/operative down. Loud, not silent: no composition dir or an
// unreadable manifest is an explicit warning in the payload, never an empty
// list masquerading as "no runtimes".
function readRuntimeFittings() {
  const dir = process.env.GARRISON_COMPOSITION_DIR || null;
  if (!dir) {
    return {
      available: false,
      warning: "GARRISON_COMPOSITION_DIR is unset — installed runtime fittings unknown; primary-runtime validation degraded",
      runtimes: []
    };
  }
  let selections = [];
  try {
    const manifest = jsYaml.load(readFileSync(path.join(dir, "apm.yml"), "utf8"));
    selections = manifest?.["x-garrison"]?.composition?.selections?.runtimes ?? [];
  } catch (err) {
    return {
      available: false,
      warning: `composition manifest unreadable at ${path.join(dir, "apm.yml")}: ${String(err?.message || err)}`,
      runtimes: []
    };
  }
  // Fitting ids are kebab-case slugs — the id comes from a user-editable
  // manifest, so it is validated BEFORE any path is built (path containment:
  // a crafted id like "../.." must never read outside the composition), with
  // a resolved-prefix backstop in case the pattern ever loosens.
  const FITTING_ID = /^[a-z][a-z0-9-]*$/;
  const modulesRoot = path.resolve(dir, "apm_modules", "_local");
  const runtimes = selections.map((sel) => {
    // Type before grammar: YAML happily yields booleans/arrays for `id:`, and
    // String() coercion would let e.g. `id: [codex-runtime]` satisfy the slug
    // regex while the payload echoes a non-string id. Only a real string may
    // even reach the grammar check.
    const rawId = typeof sel?.id === "string" ? sel.id : "";
    if (!FITTING_ID.test(rawId)) {
      const displayId = typeof sel?.id === "string" ? sel.id : JSON.stringify(sel?.id ?? null);
      return {
        id: displayId,
        engine: displayId,
        installed: false,
        providerMechanism: null,
        quartersDescriptor: null,
        warning: `invalid fitting id ${displayId} in composition selections — ids are kebab-case strings; entry ignored`
      };
    }
    const manifestPath = path.resolve(modulesRoot, rawId, "apm.yml");
    let meta = null;
    let warning;
    if (!manifestPath.startsWith(modulesRoot + path.sep)) {
      warning = `fitting id ${JSON.stringify(rawId)} resolves outside the composition modules dir — entry ignored`;
    } else {
      try {
        meta = jsYaml.load(readFileSync(manifestPath, "utf8"))?.["x-garrison"] ?? null;
        if (!meta) warning = `no x-garrison block in ${manifestPath}`;
      } catch (err) {
        warning = `fitting manifest unreadable (selected but not installed?): ${manifestPath} — ${String(err?.message || err)}`;
      }
    }
    const provides = Array.isArray(meta?.provides) ? meta.provides : [];
    const engine = provides.find((p) => p && p.kind === "runtime")?.name ?? sel.id;
    return {
      id: sel.id,
      engine,
      installed: !!meta,
      providerMechanism: meta?.provider_mechanism ?? null,
      quartersDescriptor: meta?.quarters_descriptor ?? null,
      ...(warning ? { warning } : {})
    };
  });
  return { available: true, defaultPrimary: DEFAULT_PRIMARY_RUNTIME_ID, runtimes };
}

async function handleGetRuntimeFittings(_req, res) {
  json(res, 200, readRuntimeFittings());
}

// PUT serialization (found by the S3 independent test): two concurrent PUTs
// that both read the same baseline can interleave the routing/policy rename
// pairs and transiently diverge the two files. All PUTs in this process (the
// only writers — the composer UI and the Improver both talk to THIS server)
// run through one promise-chain mutex, so the pair commits atomically per
// request. The startup recompile stays as the cross-process heal.
let putChain = Promise.resolve();

async function handlePutRouting(req, res, query) {
  const prev = putChain;
  let release;
  putChain = new Promise((r) => (release = r));
  await prev;
  try {
    return await handlePutRoutingSerialized(req, res, query);
  } finally {
    release();
  }
}

async function handlePutRoutingSerialized(req, res, query) {
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
  // Reject a v1 config on this endpoint (rev-s3 minor): a v1 doc passes validate
  // and is written to routing.json verbatim while policy.json is compiled from the
  // migrated v2 shape, so the two diverge and a later GET feeds the v2-only
  // composer a config it can't render. The composer only ever sends v2.
  if (!isV2(next)) return json(res, 422, { error: "invalid-config", errors: ["routing.json must be v2 (policyVersion 2); v1 configs are migrated at load, not accepted on PUT"] });
  const errors = validateRoutingConfig(next);
  if (errors.length) return json(res, 422, { error: "invalid-config", errors });
  // Primary-runtime guard (P3/D4): an explicit non-default primaryRuntime must
  // name an INSTALLED runtime fitting of the current composition — selecting an
  // uninstalled runtime is impossible in the UI and loud in the file. The
  // default id keeps default semantics (the claude-code engine is synthesized
  // even when its fitting is not composed). When the composition is unknown
  // (standalone server), the write is accepted and the degradation is reported.
  let primaryWarning;
  if (typeof next.primaryRuntime === "string" && next.primaryRuntime.trim().length) {
    const desired = next.primaryRuntime.trim();
    if (desired !== DEFAULT_PRIMARY_RUNTIME_ID) {
      const rf = readRuntimeFittings();
      if (rf.available) {
        const installed = new Set(rf.runtimes.filter((r) => r.installed).map((r) => r.id));
        if (!installed.has(desired)) {
          return json(res, 422, {
            error: "invalid-config",
            errors: [
              `primaryRuntime "${desired}" is not an installed runtime fitting of this composition — compose it under the runtimes faculty (installed: ${[...installed].join(", ") || "none"}), or leave primaryRuntime as ${DEFAULT_PRIMARY_RUNTIME_ID}`
            ]
          });
        }
      } else {
        primaryWarning = `primaryRuntime "${desired}" accepted WITHOUT installed-fitting validation: ${rf.warning}`;
      }
    }
  }
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
  // Unique per REQUEST (not just per process): two concurrent PUTs in the same
  // process share ${pid}, so a shared temp name would let them interleave-write
  // and rename each other's half-file. A random suffix keeps each write private.
  const uniq = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const cfgTmp = `${configTarget}.tmp-${uniq}`;
  const polTmp = `${policyTarget}.tmp-${uniq}`;
  await writeFile(cfgTmp, serialized, "utf8");
  await writeFile(polTmp, policyBytes, "utf8");
  await rename(cfgTmp, configTarget);
  await rename(polTmp, policyTarget);
  json(res, 200, {
    ok: true,
    baselineSha: sha(serialized),
    policyPath: policyTarget,
    ...(primaryWarning ? { warnings: [primaryWarning] } : {})
  });
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

// Try-it strip gate reasoning (S6 D15/D13): for a dry-run request, resolve
// whether the security-review and ux-qa phases WOULD run for this work kind +
// project, and WHY. Pure — reads the passed config + base rail, no I/O.
//
// security-review is in NO default plan (S4 made it opt-in): it runs when the
// selected work kind's plan explicitly carries it, OR the chosen project is
// marked security_sensitive (the doorway/skill adds the phase then; the
// classifier never picks it on its own). ux-qa runs iff the plan includes it
// (S5), and its findings loop back at or above uxQa.severityThreshold.
function tryItGates(config, baseRail, workKind, projectLabel) {
  const phaseOn = (id) => {
    const p = (baseRail?.phases || []).find((x) => x.id === id);
    return !!(p && p.on);
  };
  const kindLabel = workKind || config.defaultWorkKind || "the selected work kind";

  const byPlanSec = phaseOn("security-review");
  const project = projectLabel && config.projects ? config.projects[projectLabel] : null;
  const byProjectSec = !!(project && project.security_sensitive);
  let secReason;
  if (byPlanSec) secReason = `the ${kindLabel} plan explicitly includes a security-review phase`;
  else if (byProjectSec) secReason = `project "${projectLabel}" is marked security-sensitive, so the security-review phase is added`;
  else if (projectLabel) secReason = `project "${projectLabel}" is not security-sensitive and the ${kindLabel} plan omits security-review`;
  else secReason = `no project selected and the ${kindLabel} plan omits security-review (the classifier never adds it on its own)`;

  const byPlanUx = phaseOn("ux-qa");
  const severityThreshold = (config.uxQa && config.uxQa.severityThreshold) || "major";
  const uxReason = byPlanUx
    ? `the ${kindLabel} plan includes ux-qa - findings at or above "${severityThreshold}" loop the slice back; below are recorded as notes`
    : `the ${kindLabel} plan omits ux-qa`;

  return {
    securityReview: {
      included: byPlanSec || byProjectSec,
      byPlan: byPlanSec,
      byProject: byProjectSec,
      project: projectLabel || null,
      reason: secReason
    },
    uxQa: { included: byPlanUx, severityThreshold, reason: uxReason }
  };
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
  // Guard the profile before it reaches resolveRoute/railFor (rev-s3 minor): an
  // unknown profile would throw deep in resolution and surface as an opaque 500.
  // A bad request should be a clean 422 the composer can render.
  if (!config.profiles || !config.profiles[profile]) {
    return json(res, 422, { error: "unknown-profile", profile, known: Object.keys(config.profiles || {}) });
  }

  // Composer dry-run strip (S3 D12): deterministic heuristic classification — NO
  // live model call — plus the fully-resolved phase rail for the chosen work kind.
  // Every ON chip is enriched with the target it resolves to at the classified
  // tier; OFF chips stay in the rail (on:false) so the strip reads honestly.
  if (body.tryIt) {
    const classification = heuristicClassify(body.prompt);
    const execution = classifyExecution({ message: String(body.prompt || ""), classification });
    const route = resolveRoute(config, profile, classification);
    const workKind = body.workKind || config.defaultWorkKind || null;
    const project = typeof body.project === "string" && body.project ? body.project : null;
    let rail;
    let gates = null;
    try {
      const base = railFor(config, workKind);
      gates = tryItGates(config, base, workKind, project);
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
    return json(res, 200, { classification: { ...classification, execution }, route, profile, workKind, project, rail, gates, dryRun: true });
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
    // Both improver rules that target the routing policy render as composer ghost
    // edits: `orchestrator-policy` (effort/phase/binding edits, D38) and
    // `coordination` (interference-watch → threshold/lease/prediction edits, S6
    // D17). Both carry applyVia "PUT /routing", so a click routes through the
    // Improver's apply → our PUT. Filter by rule (present on thin AND full queue
    // rows) rather than applyVia (absent on the nightly's thin index rows).
    const POLICY_GHOST_RULES = new Set(["orchestrator-policy", "coordination"]);
    const proposals = (q.queue || [])
      .filter((p) => p && POLICY_GHOST_RULES.has(p.rule))
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

export async function startServer(opts = {}) {
  const host = opts.host || process.env.ORCHESTRATOR_HOST || process.env.MODEL_ROUTER_HOST || "127.0.0.1";
  // An explicit `port: 0` means an OS-assigned ephemeral port (the test
  // harness); otherwise the configured port is canonical - never auto-shift.
  const configured = Number(opts.port ?? (process.env.ORCHESTRATOR_PORT || process.env.MODEL_ROUTER_PORT || 7087));
  await migrateLegacyState();
  assertStatusSlotFree();
  let port = configured;

  const server = http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url, true);
      const pathname = parsed.pathname;
      const query = new URLSearchParams(parsed.query);
      // Every handler is async — AWAIT each dispatch so a thrown error is caught
      // by this try/catch and rendered as a 500. A bare `return handleX(...)`
      // returns the promise to the (sync) listener, so the catch is dead and any
      // rejection becomes an unhandledRejection that EXITS the process (a corrupt
      // routing.json crashing even plain GETs, an unknown /simulate profile, etc).
      if (pathname === "/health") return json(res, 200, { ok: true, port, pid: process.pid });
      if (pathname === "/routing" && req.method === "GET") return await handleGetRouting(req, res);
      if (pathname === "/routing" && req.method === "PUT") return await handlePutRouting(req, res, query);
      if (pathname === "/runtime-fittings" && req.method === "GET") return await handleGetRuntimeFittings(req, res);
      if (pathname === "/simulate" && req.method === "POST") return await handleSimulate(req, res);
      if (pathname === "/telemetry" && req.method === "GET") return await handleTelemetry(req, res);
      // D38 ghost edits: same-origin proxy to the Improver's review queue. The
      // browser can neither read ~/.garrison/ui-fittings/improver.json nor POST
      // cross-origin to the Improver's port, so the composer goes through here.
      if (pathname === "/ghost-edits" && req.method === "GET") return await handleGhostEdits(res);
      {
        const m = pathname.match(/^\/ghost-edits\/([^/]+)\/(apply|reject)$/);
        if (m && req.method === "POST") return await handleGhostAction(res, decodeURIComponent(m[1]), m[2]);
        // An unknown /ghost-edits/* action must 404, not fall through to
        // serveStatic and return the SPA index.html with 200 (rev-s3 minor).
        if (pathname.startsWith("/ghost-edits/")) return json(res, 404, { error: "not-found" });
      }
      return await serveStatic(req, res, pathname);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: "server-error", message: String(err?.message || err) });
    }
  });

  server.once("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`[orchestrator] port ${configured} is already in use - refusing to start on a shifted port (the configured port is canonical)`);
      process.exit(1);
    }
    throw err;
  });
  await new Promise((resolve) => server.listen(configured, host, resolve));
  port = server.address().port;
  await writeStatusFile({ port, host });
  // Composition start (D4): compile the current config into policy.json so
  // consumers never read a stale policy after a config change made off-server.
  try {
    // Bring a v1 routing.json up to v2 on disk FIRST (the composer renders v2
    // only), then recompile from the migrated shape below.
    await migrateConfigFileIfV1();
    const startupConfig = JSON.parse(await loadConfigRaw());
    await writeCompiledPolicy(startupConfig);
    // Loud load-path check (RUNTIMES-V1): a hand-edited routing.json can name
    // an uninstalled primary that the PUT guard never saw — flag it at the
    // single policy.json producer instead of compiling it silently.
    const desired = typeof startupConfig.primaryRuntime === "string" ? startupConfig.primaryRuntime.trim() : "";
    if (desired && desired !== DEFAULT_PRIMARY_RUNTIME_ID) {
      const rf = readRuntimeFittings();
      if (rf.available && !rf.runtimes.some((r) => r.installed && r.id === desired)) {
        console.error(
          `[orchestrator] WARNING: routing.json names primaryRuntime "${desired}" but that fitting is NOT installed in this composition — the runner will fail loud at up(); compose it under the runtimes faculty or fix primaryRuntime in the composer`
        );
      }
    }
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
