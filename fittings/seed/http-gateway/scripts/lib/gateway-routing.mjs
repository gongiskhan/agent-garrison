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
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { MultiRuntimePool, ClaudeCodeAdapter } from "@garrison/claude-pty";
import * as cards from "./autonomous-cards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── locate the model-router fitting (repo seed OR installed composition) ──────
export function resolveModelRouterDir(compositionDir) {
  const candidates = [
    process.env.GARRISON_ORCHESTRATOR_DIR,
    process.env.GARRISON_MODEL_ROUTER_DIR,
    // orchestrator fitting (renamed from model-router in GARRISON-UNIFY-V1 S2)
    compositionDir && path.join(compositionDir, "apm_modules", "_local", "orchestrator"),
    path.resolve(HERE, "..", "..", "..", "orchestrator"),
    // legacy fallback for a not-yet-migrated composition
    compositionDir && path.join(compositionDir, "apm_modules", "_local", "model-router"),
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

// Locate the agent-sdk-runtime fitting (for routing a turn to a {runtime:agent-sdk}
// target — any model via the Claude Agent SDK, incl. the Anthropic endpoint).
// Same resolution shape as the model-router: env override, installed composition,
// or repo seed.
export function resolveAgentSdkDir(compositionDir) {
  const candidates = [
    process.env.GARRISON_AGENT_SDK_DIR,
    compositionDir && path.join(compositionDir, "apm_modules", "_local", "agent-sdk-runtime"),
    path.resolve(HERE, "..", "..", "..", "agent-sdk-runtime"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "lib", "agent-sdk-adapter.mjs"))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Locate a SECONDARY runtime fitting (codex-runtime / gemini-runtime) so the
// gateway can execute a {type:secondary} target directly (review → gpt/codex,
// fixes → gemini), same resolution shape as the others.
export function resolveSecondaryDir(compositionDir, runtime) {
  const fitting = `${runtime}-runtime`;
  const candidates = [
    process.env[`GARRISON_${runtime.toUpperCase()}_DIR`],
    compositionDir && path.join(compositionDir, "apm_modules", "_local", fitting),
    path.resolve(HERE, "..", "..", "..", fitting),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "lib", `${runtime}-adapter.mjs`))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// BUILD MODE helper: commit a locally-generated file verbatim. The local model
// (ollama via the agent-sdk runtime) can't drive file-edit tools over ollama's
// Anthropic-compat endpoint, so it generates the code in chat mode and the
// orchestrator commits it. Extracts the target path named in the TASK text (e.g.
// `src/id.mjs`) and the code from the REPLY (first fenced block, else the whole
// reply if it looks like code), writes it under the workspace, returns a record
// or null when there is nothing safe to commit.
export function commitGeneratedFile(workspace, taskText, replyText) {
  const reply = String(replyText || "");
  const taskPath = (String(taskText || "").match(/\b((?:src|test|tests|lib)\/[\w.\-/]+\.\w+)\b/) || [])[1] || null;
  let code = null;
  let jsonPath = null;
  // (a) tool-call-shaped JSON the local model emits even in chat mode:
  //     {"name":"writeFile","arguments":{"path":"src/x.mjs","content":"<code>"}}
  // The model often emits INVALID JSON escapes (e.g. \` before backticks), so we
  // extract the "content"/"path" string values directly and unescape them with a
  // sanitizing fallback rather than parsing the whole (possibly invalid) object.
  if (/"content"\s*:/.test(reply)) {
    const unescape = (s) => {
      try {
        return JSON.parse('"' + s + '"');
      } catch {
        return JSON.parse('"' + s.replace(/\\([^"\\/bfnrtu])/g, "$1") + '"'); // drop invalid escapes
      }
    };
    const cm = reply.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (cm) {
      try {
        code = unescape(cm[1]);
      } catch {
        /* leave null → fall through */
      }
    }
    const pm = reply.match(/"(?:path|file_path|file)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (pm) {
      try {
        jsonPath = unescape(pm[1]);
      } catch {
        /* ignore */
      }
    }
  }
  // (b) a fenced code block
  if (!code) {
    const f = reply.match(/```[\w.+-]*\n([\s\S]*?)```/);
    if (f) code = f[1];
  }
  // (c) raw code, but never a bare JSON blob
  if (!code && !/^\s*\{/.test(reply) && /\b(export|function|const|class|=>|import)\b/.test(reply)) {
    code = reply.trim();
  }
  if (!code || !code.trim()) return null;
  // reject tool-call JSON garbage some local models emit instead of code (e.g.
  // {"name":"agent","arguments":...}) — only commit something that reads as code
  const trimmed = code.trim();
  if (/^\{[\s\S]*"(?:name|arguments|parameters|phase|schema|label)"\s*:/.test(trimmed)) return null;
  // target path: the task's named path wins; else the model's; must be project-local
  const rel = taskPath || jsonPath;
  if (!rel || !/^(src|test|tests|lib)\//.test(rel)) return null;
  const abs = path.join(workspace, rel);
  if (!abs.startsWith(path.resolve(workspace) + path.sep)) return null; // confine to workspace
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const out = code.endsWith("\n") ? code : code + "\n";
  fs.writeFileSync(abs, out);
  return { rel, abs, bytes: Buffer.byteLength(out), code: out };
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

// Deterministic keyword classifier: when an exception declares `keywords`, a
// message containing ALL of them classifies straight to that exception — fast,
// and immune to LLM-classifier drift across a rapid multi-step session. Returns
// null (fall back to the LLM classifier) when nothing matches.
export function classifyByKeywords(message, config) {
  const m = String(message || "").toLowerCase();
  for (const ex of config?.exceptions || []) {
    const kws = ex.keywords;
    if (Array.isArray(kws) && kws.length && kws.every((k) => m.includes(String(k).toLowerCase()))) {
      return { taskType: ex.taskType || "code", tier: ex.tier || "T1-standard", matchedException: ex.id };
    }
  }
  return null;
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
    // D19: per-conversation card memory. A task-shaped turn registers a card; a
    // follow-up turn about the SAME task (same session key + task type) attaches
    // to it instead of registering a duplicate. Quick cards are forgotten the
    // moment they auto-advance to Done, so the next task starts a fresh card.
    this._sessionCards = new Map(); // sessionKey -> { cardId, quick, taskType }
    this.operative = null;
    this.classifier = null;
    this.switchLog = [];
    this.lastClassification = null;
    this._lastTurns = []; // recent {role,text} for context carryover on respawn
    this._respawned = false; // set when the last switch respawned the operative
    this._lastUserMessage = null;
    // agent-sdk runtime (any model via the Claude Agent SDK, incl. Anthropic).
    // Lazily constructed; one warm session per {provider,model,promptMode}.
    this._agentSdkAdapter = opts.agentSdkAdapter ?? null;
    this._agentSdkSessions = new Map();
    // secondary runtimes (codex/gpt, gemini) executed directly by the gateway.
    this._secondaryAdapters = opts.secondaryAdapters ?? new Map();
    // Optional shared BUILD WORKSPACE. When set, the routed agent-sdk + secondary
    // turns run with this dir as cwd, so every model (ollama via the SDK, codex,
    // gemini) reads and edits the SAME real project files — a genuine cross-model
    // build on disk, not isolated scratch dirs. Unset → unchanged (scratch).
    this.buildWorkspace = opts.buildWorkspace ?? process.env.GARRISON_BUILD_WORKSPACE ?? null;
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

  // True when the resolved route runs on the agent-sdk runtime (any model via the
  // Claude Agent SDK, incl. Anthropic), not the claude-code PTY operative.
  isAgentSdkTarget(route) {
    return route?.target?.runtime === "agent-sdk";
  }

  // Lazily construct the AgentSdkAdapter from the resolved agent-sdk-runtime
  // fitting (dynamic import by path, like the routing cores).
  async getAgentSdkAdapter() {
    if (this._agentSdkAdapter) return this._agentSdkAdapter;
    const dir = resolveAgentSdkDir(this.compositionDir);
    if (!dir) throw new Error("gateway-routing: agent-sdk-runtime fitting not found on disk");
    const mod = await import(pathToFileURL(path.join(dir, "lib", "agent-sdk-adapter.mjs")).href);
    this._agentSdkAdapter = new mod.AgentSdkAdapter();
    return this._agentSdkAdapter;
  }

  // Run one turn on the agent-sdk runtime. THE HARNESS picks the preset (full) or
  // lean (chat, tools off) per the target's promptMode. The runtime is first-class
  // routable to any provider incl. the Anthropic endpoint (D29). One warm session
  // per {provider,model,promptMode}, reused across turns (SDK resume).
  async runAgentSdkTurn(route, message, onChunk) {
    const adapter = await this.getAgentSdkAdapter();
    const t = route.target;
    const promptMode = t.promptMode ?? "lean";
    const key = `${t.provider}:${t.model}:${promptMode}`;
    const spawnArgs = {
      provider: t.provider,
      model: t.model,
      promptMode,
      leanPrompt: t.leanPrompt,
      baseUrl: t.baseUrl,
      // cwd: the shared build workspace when set (so file ops hit the real project)
      compositionDir: this.buildWorkspace ?? this.compositionDir,
      disallowedTools: t.disallowedTools,
      allowedTools: t.allowedTools,
      maxTurns: t.maxTurns ?? 4,
      budgetTokens: t.budgetTokens ?? null,
      secrets: this.secrets ?? null,
      permissionMode: "bypassPermissions",
    };
    let session = this._agentSdkSessions.get(key);
    if (!session || session.alive === false) {
      session = await adapter.spawn(spawnArgs);
      this._agentSdkSessions.set(key, session);
    }
    this.logFn({
      kind: "runtime-turn",
      runtime: "agent-sdk",
      provider: t.provider,
      model: t.model,
      promptMode: session.harness?.promptMode,
      authMode: t.authMode ?? null,
      target: route.targetId,
    });
    await adapter.awaitReady(session);
    await adapter.sendTurn(session, message);
    let resp = await adapter.awaitResponse(session);
    // BUILD MODE (buildWorkspace set): local models can't drive file-edit tools
    // over ollama's Anthropic-compat endpoint (tool_use is not surfaced), so the
    // local model GENERATES the code in chat mode and the orchestrator COMMITS it
    // verbatim to the file named in the task — a faithful "generate → commit".
    // Small local models are inconsistent (they sometimes emit tool-call JSON
    // instead of code), so regenerate on a FRESH session until the output is
    // committable — bounded attempts.
    let committed = null;
    if (this.buildWorkspace) {
      committed = commitGeneratedFile(this.buildWorkspace, message, resp.text ?? "");
      for (let attempt = 2; !committed && attempt <= 6; attempt++) {
        this.logFn({ kind: "agent-sdk-regenerate", attempt, provider: t.provider, model: t.model });
        session = await adapter.spawn(spawnArgs);
        await adapter.awaitReady(session);
        await adapter.sendTurn(session, message);
        resp = await adapter.awaitResponse(session);
        committed = commitGeneratedFile(this.buildWorkspace, message, resp.text ?? "");
      }
      this._agentSdkSessions.set(key, session);
      if (committed) {
        this.logFn({ kind: "agent-sdk-commit", file: committed.rel, bytes: committed.bytes, provider: t.provider, model: t.model });
      }
    }
    const replyText = committed
      ? `\`\`\`js\n${committed.code.trim()}\n\`\`\`\n\n[local model (${t.model}) generated this → orchestrator committed it verbatim to ${committed.rel}]`
      : (resp.text ?? "");
    if (onChunk && replyText) onChunk(replyText, true); // non-streaming: emit the full reply once
    return {
      reply: replyText,
      session_id: session.sessionId ?? null,
      cost_usd: null,
      route: route.targetId,
      runtime: "agent-sdk",
      provider: t.provider,
      model: t.model,
      toolUses: resp.toolUses ?? [],
      stoppedReason: resp.stoppedReason ?? null,
    };
  }

  // True when the resolved route runs on a SECONDARY runtime (codex/gpt or
  // gemini) the gateway executes directly via its adapter (one-shot CLI exec).
  isSecondaryTarget(route) {
    const t = route?.target;
    return !!t && (t.type === "secondary" || t.runtime === "codex" || t.runtime === "gemini");
  }

  // A `workflow` routing target names a saved Claude Code workflow. We do NOT run a
  // parallel workflow engine ("compose, don't own") — the operative IS a Claude Code
  // session that runs workflows via its Workflow tool. We just route the turn to it
  // with an instruction to invoke the named workflow (workflowTurnPrefix), so a
  // resolved workflow target actually runs instead of falling through as a plain turn.
  isWorkflowTarget(route) {
    const t = route?.target;
    return !!t && t.type === "workflow";
  }

  workflowTurnPrefix(route) {
    const raw =
      route?.target?.workflow ||
      (route?.targetId || "").replace(/^workflow:/, "") ||
      "the resolved workflow";
    // The workflow id is route/config-derived but still untrusted for prompt
    // embedding: a name with backticks / newlines / control chars could break the
    // `[workflow: …]` marker or inject extra instructions into the routed turn. Strip
    // control chars + backticks and clamp length to a safe identifier-ish string.
    const name = String(raw).replace(/[^a-zA-Z0-9 _.\/-]/g, "").trim().slice(0, 120) || "the resolved workflow";
    return `[workflow: ${name}] Handle this request by running the saved Claude Code workflow \`${name}\` — invoke it via the Workflow tool, then report the result.\n\n`;
  }

  async getSecondaryAdapter(runtime) {
    if (this._secondaryAdapters.has(runtime)) return this._secondaryAdapters.get(runtime);
    const dir = resolveSecondaryDir(this.compositionDir, runtime);
    if (!dir) throw new Error(`gateway-routing: ${runtime}-runtime fitting not found on disk`);
    const cls = runtime === "codex" ? "CodexAdapter" : "GeminiAdapter";
    const mod = await import(pathToFileURL(path.join(dir, "lib", `${runtime}-adapter.mjs`)).href);
    const adapter = new mod[cls]();
    this._secondaryAdapters.set(runtime, adapter);
    return adapter;
  }

  // Run one turn on a secondary runtime (the orchestrator delegating a step to
  // gpt/codex or gemini). One-shot exec; the reply is returned + (by gateway-pty)
  // injected into the rich channel stream.
  async runSecondaryTurn(route, message) {
    const rt = route.target.runtime;
    const provider = route.target.provider ?? (rt === "codex" ? "openai" : "google");
    const model = route.target.model ?? (rt === "codex" ? "gpt-5-codex" : "gemini-2.5-flash");
    const adapter = await this.getSecondaryAdapter(rt);
    // cwd: the shared BUILD WORKSPACE when set (so codex reads + gemini edits the
    // REAL project files), else a clean scratch cwd (default — keep the agentic CLI
    // out of the repo). codex on a ChatGPT account rejects an explicit model
    // override, so use its default; gemini accepts -m.
    const cwd = this.buildWorkspace ?? (this._secondaryScratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "garrison-secondary-")));
    const spawnModel = rt === "gemini" ? model : undefined;
    // Trust the cwd for gemini 0.46 (else it downgrades yolo + blocks); harmless for codex.
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" };
    const session = await adapter.spawn({ compositionDir: cwd, model: spawnModel, env });
    this.logFn({ kind: "runtime-turn", runtime: rt, provider, model, target: route.targetId });
    await adapter.awaitReady(session);
    await adapter.sendTurn(session, message);
    let resp;
    try {
      resp = await adapter.awaitResponse(session);
    } finally {
      try {
        await adapter.teardown(session);
      } catch {
        /* ignore */
      }
    }
    return { reply: resp?.text ?? "", session_id: null, route: route.targetId, runtime: rt, provider, model };
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

  // Resolve the board's base URL from the kanban-loop status file (URL-link
  // contract, never a hardcoded port — the same discovery the gateway uses for
  // every fitting). Returns the base URL or null (board down / not installed).
  // Implementation shared with souls mode: lib/autonomous-cards.mjs.
  _boardBase() {
    return cards.boardBase();
  }

  // D19: register a turn as a card on the board. Thin wrapper over the shared
  // implementation (lib/autonomous-cards.mjs) — deps resolve at CALL time from
  // this.core/this.logFn so prototype-created receivers (tests) keep working.
  async createAutonomousCard(message, classification, opts = {}) {
    return cards.createAutonomousCard({
      message,
      classification,
      opts,
      buildPayload: this.core?.buildAutonomousCardPayload ?? null,
      logFn: (e) => this.logFn(e)
    });
  }

  // D19: advance a quick card Implement → Done at turn completion (shared impl).
  async completeQuickCard(id) {
    return cards.completeQuickCard({ id, logFn: (e) => this.logFn(e) });
  }

  // D19: a turn is "task-shaped" (worth a card) when its task type names real
  // work — code / research / writing / image / video / ops. Plain conversation
  // (`other`) and the engine's own pipeline verbs are NOT carded here (the latter
  // arrive card-originated). Matches RUN_SPEC A14.
  static TASK_SHAPED = cards.TASK_SHAPED;
  isTaskShaped(classification) {
    return cards.isTaskShaped(classification);
  }

  // D19 session→card memory. A follow-up turn about the same task (same session
  // key AND task type) attaches to the live card instead of registering a
  // duplicate. The attach is LIVENESS-GATED against the board: a stale card
  // (done / parked / abandoned / absent) is forgotten so a genuinely new
  // same-type turn registers + dispatches FRESH rather than running inline and
  // bypassing the engine pipeline (S7 review F1). Poll at attach-time — no timer.
  // Returns the entry to attach, or null (caller registers a new card).
  async attachedCard(sessionKey, classification) {
    if (!sessionKey) return null; // no conversation identity → never attach (F1c)
    const entry = this._sessionCards.get(sessionKey);
    if (!entry) return null;
    if (classification && entry.taskType && entry.taskType !== classification.taskType) return null;
    if (!(await this._cardIsLive(entry.cardId))) {
      this.forgetCard(sessionKey);
      return null;
    }
    return entry;
  }

  // True only when the card is STILL an active engine run: it exists and sits on
  // a non-terminal, non-parked pipeline list with no abandonment revert prepared.
  // A fetch failure counts as NOT live (safe: the caller registers fresh).
  // Implementation shared with souls mode: lib/autonomous-cards.mjs.
  async _cardIsLive(cardId) {
    return cards.cardIsLive(cardId);
  }

  rememberCard(sessionKey, entry) {
    if (sessionKey) this._sessionCards.set(sessionKey, entry);
  }
  forgetCard(sessionKey) {
    if (sessionKey) this._sessionCards.delete(sessionKey);
  }

  // Stage A: ask the pinned warm classifier ONE question; code resolves.
  async classify(message) {
    // Deterministic keyword fast-path first (skips the LLM classifier + its drift).
    const det = classifyByKeywords(message, this.config);
    if (det) {
      this.lastClassification = det;
      this.logFn({ kind: "classify-deterministic", matchedException: det.matchedException, taskType: det.taskType, tier: det.tier });
      return det;
    }
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
  async preRoute(message, opts = {}) {
    this._lastUserMessage = message;
    // Honor an EXPLICIT {taskType,tier} classification from the caller (the Kanban Loop
    // §10 contract: each agent-list carries its own classification) instead of
    // re-classifying from scratch — but ONLY when both values are in the router's
    // vocabulary. A malformed/out-of-vocab/absent hint is NOT trusted; it falls back to
    // the message classifier so a bad hint can never silently misroute a turn.
    const explicit = opts.classification;
    const validTask = Array.isArray(this.config.taskTypes) ? this.config.taskTypes : [];
    const validTier = Array.isArray(this.config.tiers) ? this.config.tiers : [];
    const honored = !!(
      explicit &&
      typeof explicit.taskType === "string" &&
      typeof explicit.tier === "string" &&
      validTask.includes(explicit.taskType) &&
      validTier.includes(explicit.tier)
    );
    const raw = honored ? explicit : await this.classify(message);
    // D18: `execution` is no longer a classification axis. Where work runs is
    // derived from the resolved phase plan — a multi-phase or cross-model plan is
    // engine-dispatched, a trivial plan runs inline (see the D19 carding in
    // gateway-pty) — never from a per-turn execution flag. The classifier parser
    // still attaches a legacy `execution`; drop it here so it never re-enters the
    // routed decision, the decisions.jsonl record, or the preRoute output.
    const { execution: _legacyExecution, ...classification } = raw;
    if (honored) {
      this.logFn({ kind: "classification-honored", taskType: classification.taskType, tier: classification.tier, skill: opts.skill ?? null });
    }
    const route = this.core.resolveRoute(this.config, this.config.activeProfile, classification);
    const decision = this.core.decisionRecord({ prompt: message, classification, route, at: this.nowFn() });
    // Enrich the logged decision with the RUNTIME/provider/model so the log shows
    // exactly what handled the turn (claude-code/anthropic vs agent-sdk/ollama).
    decision.runtime = route.target?.runtime ?? null;
    decision.provider = route.target?.provider ?? null;
    decision.model = route.target?.model ?? null;
    await this.core.appendDecision(this.decisionsFile, decision);
    this.logFn({
      kind: "route-resolved",
      taskType: classification.taskType,
      tier: classification.tier,
      role: route.role,
      target: route.targetId,
      runtime: decision.runtime,
      model: decision.model,
      via: route.via,
    });
    // An agent-sdk target runs on its OWN adapter session (gateway-pty calls
    // runAgentSdkTurn) — do NOT switch the PTY operative for it.
    const plan = !route.target
      ? { path: "noop", reasons: ["no target"] }
      : route.target.runtime === "agent-sdk"
        ? { path: "agent-sdk", reasons: [`agent-sdk runtime ${route.target.provider}/${route.target.model}`] }
        : this.isSecondaryTarget(route)
          ? { path: "secondary", reasons: [`secondary runtime ${route.target.runtime}`] }
          : await this.applySwitch(route);
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
      // Providers are policy data (P2): resolve the section from the loaded
      // routing config (ensureProviders seeds the historical four for a
      // pre-migration file) so buildLaunchEnv never falls back silently.
      providers: this.core.ensureProviders(this.config)?.providers,
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

// ── Primary-runtime warm seam (GARRISON-RUNTIMES-V1 P4/D4) ──────────────────
// The pool warms the adapter named by the policy's primaryRuntime as the
// operative session. The runner resolves fitting-id → engine at up() (the one
// resolution point, loud there) and hands the engine down via
// GARRISON_PRIMARY_ENGINE; tests may pass opts.primaryEngine directly. A
// missing fitting or a failed CLI probe at warm time is a LOUD startup error
// naming the fix — never a silent fall back to claude-code.
const KNOWN_PRIMARY_ENGINES = ["claude-code", "agent-sdk", "codex", "gemini"];

// Probe an exec-engine's CLI via the fitting's own bridge (`--probe` prints
// "ok") — the same contract the fitting's verify hook uses.
export async function probeRuntimeBridge(dir, engine, opts = {}) {
  const { spawn } = await import("node:child_process");
  const script = path.join(dir, "scripts", "bridge.mjs");
  const timeoutMs = opts.timeoutMs ?? 20000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--probe"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    // On timeout: kill, then let the close event do the single reject — the
    // child is reaped before the failure returns, and the message carries the
    // captured stderr plus the remediation (same loudness as a failed exit).
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`${engine} bridge probe failed to start: ${String(e?.message || e)}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!timedOut && code === 0 && out.trim().includes("ok")) return resolve(true);
      const cause = timedOut ? `timed out after ${timeoutMs}ms` : `exit ${code}`;
      reject(
        new Error(
          `${engine} runtime probe FAILED (${cause}): ${(err || out).trim().slice(0, 300) || "(no output)"} — install/authenticate the ${engine} CLI, or switch primaryRuntime back to claude-code-runtime in the composer`
        )
      );
    });
  });
}

// Resolve the adapter + spawn config that back the OPERATIVE pool entry for a
// primary engine. claude-code returns exactly the historical construction.
export async function resolvePrimaryAdapter(engine, ctx) {
  const { compositionDir, spawnFn, operativeSpawnConfig, opts } = ctx;
  if (engine === "claude-code") {
    return {
      adapter: new ClaudeCodeAdapter(spawnFn ? { spawnFn } : {}),
      spawnConfig: operativeSpawnConfig,
      claude: true
    };
  }
  if (engine === "agent-sdk") {
    let adapter = opts.agentSdkAdapter ?? null;
    if (!adapter) {
      const dir = resolveAgentSdkDir(compositionDir);
      if (!dir) {
        throw new Error(
          "primaryRuntime names the agent-sdk engine but the agent-sdk-runtime fitting is not installed — compose it under the runtimes faculty (apm install), or switch primaryRuntime back to claude-code-runtime"
        );
      }
      const mod = await import(pathToFileURL(path.join(dir, "lib", "agent-sdk-adapter.mjs")).href);
      adapter = new mod.AgentSdkAdapter();
    }
    // The SDK consumes the prompt as an in-memory STRING (systemPrompt.append),
    // not a file path — read the assembled prompt bytes here (P8 wires the
    // per-primary projection; this is the warm-seam plumbing for it).
    let appendSystemPrompt;
    const promptFile = operativeSpawnConfig.appendSystemPromptFile;
    if (promptFile) {
      try {
        appendSystemPrompt = fs.readFileSync(promptFile, "utf8");
      } catch (err) {
        throw new Error(
          `agent-sdk primary: assembled system prompt unreadable at ${promptFile}: ${String(err?.message || err)}`
        );
      }
    }
    return {
      adapter,
      spawnConfig: {
        provider: "anthropic",
        model: operativeSpawnConfig.model,
        promptMode: "full",
        compositionDir,
        ...(appendSystemPrompt ? { appendSystemPrompt } : {})
      },
      claude: false
    };
  }
  if (engine === "codex" || engine === "gemini") {
    let adapter = opts.secondaryAdapters?.get?.(engine) ?? null;
    let dir = null;
    if (!adapter) {
      dir = resolveSecondaryDir(compositionDir, engine);
      if (!dir) {
        throw new Error(
          `primaryRuntime names the ${engine} engine but the ${engine}-runtime fitting is not installed — compose it under the runtimes faculty (apm install), or switch primaryRuntime back to claude-code-runtime`
        );
      }
      const cls = engine === "codex" ? "CodexAdapter" : "GeminiAdapter";
      const mod = await import(pathToFileURL(path.join(dir, "lib", `${engine}-adapter.mjs`)).href);
      adapter = new mod[cls]();
      // Warm-time CLI probe — fail the startup loudly, not the first turn.
      if (opts.probeExecPrimaries !== false) await probeRuntimeBridge(dir, engine);
    }
    return {
      adapter,
      spawnConfig: { compositionDir, env: process.env },
      claude: false
    };
  }
  throw new Error(
    `unknown primary engine "${engine}" — expected one of ${KNOWN_PRIMARY_ENGINES.join(", ")}. Fix primaryRuntime in the composer (policy file).`
  );
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

  // P4: which engine hosts the operative. Default (unset/claude-code) is
  // byte-for-byte the historical path. The CLASSIFIER always stays on the
  // cheap claude-code haiku session regardless of primary.
  const primaryEngine =
    (opts.primaryEngine ?? process.env.GARRISON_PRIMARY_ENGINE ?? "claude-code").trim() || "claude-code";
  const primary = await resolvePrimaryAdapter(primaryEngine, {
    compositionDir,
    spawnFn,
    operativeSpawnConfig,
    opts
  });
  const claudeAdapter = primary.claude ? primary.adapter : new ClaudeCodeAdapter(spawnFn ? { spawnFn } : {});
  const pool =
    opts.pool ??
    new MultiRuntimePool({
      maxTotal: opts.maxTotal ?? 4,
      runtimes: [
        { id: "operative", adapter: primary.adapter, role: "primary", size: 1, spawnConfig: primary.spawnConfig },
        { id: "classifier", adapter: claudeAdapter, role: "secondary", size: 1, spawnConfig: classifierSpawnConfig },
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
    agentSdkAdapter: opts.agentSdkAdapter, // injectable (tests); production lazy-loads from disk
  });
  gw.secrets = opts.secrets ?? null;
  return gw;
}
