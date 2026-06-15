// gateway-routing.mjs — Stage-A live routing for the PTY gateway (BRIEF U1).
//
// The gateway pre-routes EVERY inbound message: the warm classifier (a pooled
// runtime session) returns {taskType, tier}; pure code in the model-router
// fitting resolves a ROLE then the active Profile's role-map resolves a concrete
// TARGET; the gateway logs the decision to decisions.jsonl AT RESOLUTION TIME
// (it is the source of truth — no transcript scraping) and moves the live
// operative session onto the target (slash-inject /model+/effort, or
// respawn-resume on a provider/soul change). The operative ends its reply with a
// [route: …] token; the gateway diff-checks it and logs honored:false on a miss.
//
// This module is the ROUTING layer only — it owns no HTTP and does not run the
// operative turn (gateway-pty.mjs owns the session + streaming). That split keeps
// the routing logic deterministic and unit-testable: a test drives preRoute →
// (its own fake session runTurn) → postTurn with NO live model. The same module
// the gateway wires is the module the test exercises.
//
// The model-router fitting's pure cores (routing-core / routing-telemetry /
// stage-b) are the single source of truth; we dynamic-import them by resolved
// path so this runs identically from the repo (fittings/seed/*) and from an
// installed composition (apm_modules/_local/*).

import path from "node:path";
import fs from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { MultiRuntimePool, ClaudeCodeAdapter } from "@garrison/claude-pty";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── locate the model-router fitting (repo seed OR installed composition) ──────
export function resolveModelRouterDir(compositionDir) {
  const candidates = [
    process.env.GARRISON_MODEL_ROUTER_DIR,
    compositionDir && path.join(compositionDir, "apm_modules", "_local", "model-router"),
    // fittings/seed/http-gateway/scripts/lib -> fittings/seed/model-router
    path.resolve(HERE, "..", "..", "..", "model-router"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "lib", "routing-core.mjs"))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Dynamic-import the three pure cores from the resolved fitting dir, merged into
// one object (no name collisions across the three modules).
export async function loadRoutingCore(compositionDir) {
  const dir = resolveModelRouterDir(compositionDir);
  if (!dir) throw new Error("gateway-routing: model-router fitting not found on disk");
  const core = await import(pathToFileURL(path.join(dir, "lib", "routing-core.mjs")).href);
  const tele = await import(pathToFileURL(path.join(dir, "lib", "routing-telemetry.mjs")).href);
  const stageB = await import(pathToFileURL(path.join(dir, "lib", "stage-b.mjs")).href);
  return { dir, ...core, ...tele, ...stageB };
}

// Composition-scoped routing.json wins; else the fitting seed. Mirrors
// src/lib/runner.ts resolveRoutingSection so the gateway routes against the same
// config the assembled prompt was compiled from.
export function loadRoutingConfig(compositionDir, modelRouterDir) {
  const scoped = compositionDir && path.join(compositionDir, ".garrison", "routing.json");
  if (scoped && fs.existsSync(scoped)) {
    try {
      return JSON.parse(fs.readFileSync(scoped, "utf8"));
    } catch {
      /* fall through to seed */
    }
  }
  const seed = path.join(modelRouterDir, "config", "routing.seed.json");
  return JSON.parse(fs.readFileSync(seed, "utf8"));
}

// The annotation the operative reads to honor the gateway's resolved route. The
// compiled routing.md instructs it to END its reply with the matching token.
export function routeAnnotation(route) {
  return `[gateway-route: target=${route.targetId} rule=${route.ruleId} profile=${route.profile}]`;
}

export class RoutedGateway {
  constructor(opts = {}) {
    this.core = opts.core; // merged routing-core + routing-telemetry + stage-b
    this.config = opts.config;
    this.decisionsFile = opts.decisionsFile;
    this.compositionDir = opts.compositionDir;
    this.appendSystemPromptFile = opts.appendSystemPromptFile;
    this.nowFn = opts.nowFn ?? (() => new Date().toISOString());
    this.logFn = opts.logFn ?? (() => {});
    this.slashInjectWorks = opts.slashInjectWorks !== false; // MR0e verdict: works
    this.pool = opts.pool; // MultiRuntimePool
    this.operativeRuntimeId = opts.operativeRuntimeId ?? "operative";
    this.classifierRuntimeId = opts.classifierRuntimeId ?? "classifier";
    // The model/effort/provider the operative session currently sits on.
    this.currentTarget = opts.initialTarget ?? null;
    this.spawnFn = opts.spawnFn ?? null; // for off-primary respawn-resume
    this.operative = null;
    this.classifier = null;
    this.switchLog = [];
    this.lastClassification = null;
    this._lastTurns = []; // recent {role,text} for context carryover on respawn
    this._respawned = false; // set when the last switch respawned the operative
    this._lastUserMessage = null;
  }

  async start() {
    await this.pool.start();
    this.operative = await this.pool.checkout(this.operativeRuntimeId);
    this.classifier = await this.pool.checkout(this.classifierRuntimeId);
    this.logFn({ kind: "routing-started", operative: this.operative.id, classifier: this.classifier.id });
    return this;
  }

  getOperativeSession() {
    return this.operative?.session ?? null;
  }

  #alive(rec) {
    const s = rec?.session;
    if (!s) return false;
    try {
      return typeof s.isAlive === "function" ? s.isAlive() : true;
    } catch {
      return false;
    }
  }

  // Re-checkout a dead operative/classifier from the pool (long-lived sessions
  // can die between turns; the pool always serves a fresh warm one).
  async ensureOperative() {
    if (!this.#alive(this.operative)) {
      this.operative = await this.pool.checkout(this.operativeRuntimeId);
      this.logFn({ kind: "operative-recheckout", id: this.operative.id });
    }
    return this.operative.session;
  }

  async ensureClassifier() {
    if (!this.#alive(this.classifier)) {
      this.classifier = await this.pool.checkout(this.classifierRuntimeId);
      this.logFn({ kind: "classifier-recheckout", id: this.classifier.id });
    }
    return this.classifier.session;
  }

  // Stage A: ask the pinned warm classifier ONE question; code resolves.
  async classify(message) {
    const prompt = this.core.buildClassifierPrompt(this.config, message);
    let reply = "";
    try {
      await this.ensureClassifier();
      const r = await this.classifier.session.runTurn({ message: prompt, timeoutMs: 60_000 });
      reply = r.reply ?? "";
    } catch (err) {
      this.logFn({ kind: "classify-failed", error: err?.message });
    }
    const cls =
      this.core.parseClassification(reply, this.config) || {
        taskType: "other",
        tier: "T1-standard",
        matchedException: null,
      };
    this.lastClassification = cls;
    return cls;
  }

  // classify → resolve role → resolve target → LOG at resolution time → switch.
  async preRoute(message) {
    this._lastUserMessage = message;
    const classification = await this.classify(message);
    const route = this.core.resolveRoute(this.config, this.config.activeProfile, classification);
    const decision = this.core.decisionRecord({ prompt: message, classification, route, at: this.nowFn() });
    await this.core.appendDecision(this.decisionsFile, decision);
    this.logFn({
      kind: "route-resolved",
      taskType: classification.taskType,
      tier: classification.tier,
      role: route.role,
      target: route.targetId,
      via: route.via,
    });
    const plan = route.target ? await this.applySwitch(route) : { path: "noop", reasons: ["no target"] };
    let annotation = routeAnnotation(route);
    // A respawn (soul/provider change) starts a fresh process; --continue is
    // unreliable for ephemeral sessions, so re-inject a compact context summary
    // as the turn preamble (the soul-switch carryover fallback).
    if (this._respawned && this.core.buildContextCarryover) {
      const carry = this.core.buildContextCarryover(this._lastTurns);
      if (carry) annotation = `${carry}\n${annotation}`;
      this._respawned = false;
    }
    return { classification, route, decision, plan, annotation, carried: annotation.includes("context carried over") };
  }

  // Stage B: move the live operative onto the resolved target.
  async applySwitch(route) {
    const plan = this.core.planSwitch(this.currentTarget, route.target, {
      slashInjectWorks: this.slashInjectWorks,
    });
    if (plan.path === "slash-inject") {
      for (const inj of plan.injections) {
        this.operative.session.writeKeys(inj + "\r");
        await sleep(this.injectSettleMs ?? 250);
      }
      this.currentTarget = route.target;
    } else if (plan.path === "respawn-resume") {
      await this.respawnOperative(route.target);
      this.currentTarget = route.target;
      this._respawned = true; // next turn re-injects the context carryover
    }
    this.switchLog.push({ path: plan.path, injections: plan.injections ?? [], target: route.targetId, reasons: plan.reasons });
    this.logFn({ kind: "route-switch", path: plan.path, injections: plan.injections ?? [], target: route.targetId });
    return plan;
  }

  // Provider/soul change → fresh spawn with the target's launch env, context
  // preserved via --continue (buildRespawnOpts). Off the warm primary pool.
  async respawnOperative(target) {
    if (!this.spawnFn) {
      this.logFn({ kind: "respawn-skip", reason: "no spawnFn injected", target: target?.id });
      return;
    }
    const opts = this.core.buildRespawnOpts(target, {
      compositionDir: this.compositionDir,
      appendSystemPromptFile: this.appendSystemPromptFile,
      baseEnv: process.env,
      secrets: this.secrets ?? null,
      permissionMode: "bypassPermissions",
    });
    const fresh = await this.spawnFn(opts);
    try {
      this.operative.session.dispose?.();
    } catch {
      /* ignore */
    }
    // Re-wrap as a checkout-shaped record so getOperativeSession keeps working.
    this.operative = { id: `respawn:${target.id}`, session: fresh, release: () => fresh.dispose?.() };
  }

  // After gateway-pty has run the turn, diff the reply's [route:] token.
  async postTurn(route, decision, replyText) {
    // Record the turn for context carryover on a future respawn (capped ring).
    if (this._lastUserMessage) this._lastTurns.push({ role: "user", text: this._lastUserMessage });
    this._lastTurns.push({ role: "assistant", text: replyText ?? "" });
    if (this._lastTurns.length > 12) this._lastTurns = this._lastTurns.slice(-12);
    const honored = this.core.checkHonored(route, replyText ?? "");
    if (!honored.honored) {
      await this.core.appendDecision(this.decisionsFile, {
        ...decision,
        honored: false,
        honoredReason: honored.reason,
        actual: honored.actual ?? null,
      });
      this.logFn({ kind: "route-misroute", expected: honored.expected, actual: honored.actual, reason: honored.reason });
    } else {
      this.logFn({ kind: "route-honored", target: route.targetId });
    }
    return honored;
  }

  servedStatus() {
    return this.pool.status();
  }

  shutdown() {
    try {
      this.operative?.release?.();
    } catch {
      /* ignore */
    }
    try {
      this.classifier?.release?.();
    } catch {
      /* ignore */
    }
    try {
      this.pool?.shutdown?.();
    } catch {
      /* ignore */
    }
  }
}

// Build a RoutedGateway wired to the real claude runtime (or an injected stub).
// spawnFn lets a test swap the leaf session factory (the documented test seam
// GARRISON_GATEWAY_RUNTIME_STUB in gateway-pty.mjs); production passes none and
// the ClaudeCodeAdapter spawns the real TUI.
export async function createRoutedGateway(opts = {}) {
  const compositionDir = opts.compositionDir;
  const core = opts.core ?? (await loadRoutingCore(compositionDir));
  const config = opts.config ?? loadRoutingConfig(compositionDir, core.dir);
  const spawnFn = opts.spawnFn ?? null;

  const operativeSpawnConfig = opts.operativeSpawnConfig ?? {
    compositionDir,
    model: opts.initialTarget?.model ?? "sonnet",
    appendSystemPromptFile: opts.appendSystemPromptFile,
    permissionMode: opts.permissionMode ?? "bypassPermissions",
  };
  const classifierSpawnConfig = opts.classifierSpawnConfig ?? {
    compositionDir,
    model: "haiku",
    permissionMode: opts.permissionMode ?? "bypassPermissions",
  };

  const adapter = new ClaudeCodeAdapter(spawnFn ? { spawnFn } : {});
  const pool =
    opts.pool ??
    new MultiRuntimePool({
      maxTotal: opts.maxTotal ?? 4,
      runtimes: [
        { id: "operative", adapter, role: "primary", size: 1, spawnConfig: operativeSpawnConfig },
        { id: "classifier", adapter, role: "secondary", size: 1, spawnConfig: classifierSpawnConfig },
      ],
    });

  const gw = new RoutedGateway({
    core,
    config,
    decisionsFile: opts.decisionsFile ?? path.join(compositionDir, ".garrison", "decisions.jsonl"),
    compositionDir,
    appendSystemPromptFile: opts.appendSystemPromptFile,
    nowFn: opts.nowFn,
    logFn: opts.logFn,
    slashInjectWorks: opts.slashInjectWorks,
    pool,
    initialTarget: opts.initialTarget ?? { provider: "anthropic-plan", model: operativeSpawnConfig.model, effort: null },
    spawnFn,
  });
  gw.secrets = opts.secrets ?? null;
  return gw;
}
