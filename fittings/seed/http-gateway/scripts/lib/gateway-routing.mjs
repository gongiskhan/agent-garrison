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
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { MultiRuntimePool, ClaudeCodeAdapter, oneShotTurn } from "@garrison/claude-pty";
import * as cards from "./autonomous-cards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True when the TUI shows an idle empty ❯ prompt with no busy spinner.
function promptIdle(lines) {
  if (lines.some((l) => /\(esc to interrupt\)/i.test(l))) return false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*❯\s?(.*)$/.exec(lines[i]);
    if (m) return m[1].trim().length === 0;
  }
  return false;
}

// Inject a slash command and drive it to completion. Claude Code ≥2.1.181 turns
// `/model <x>` (and similar) into a confirm modal that swallows all input until
// answered — e.g.:
//   Switch model?
//   ❯ 1. Yes, switch to Haiku 4.5
//     2. No, go back
// A fixed sleep leaves the TUI stuck on that modal, so the next real message is
// never registered. Here we: send the command, then poll the screen; if a
// confirm modal is up, accept it ("1" + Enter); return once the ❯ prompt is idle
// again. Escape is the last-resort fallback for an unrecognised picker.
async function injectSlash(session, command, timeoutMs) {
  session.writeKeys(command + "\r");
  // A session without a screen reader (Garrison's routing stubs, and any caller
  // driving a non-TUI transport) can't be polled for the confirm modal. Degrade
  // to Garrison's plain behaviour — write the command and let the caller's
  // settle wait cover the re-render — instead of throwing on session.screen().
  if (typeof session.screen !== "function") return true;
  const end = Date.now() + timeoutMs;
  let escaped = false;
  while (Date.now() < end) {
    await sleep(150);
    const lines = session.screen();
    const screen = lines.join("\n");
    // Confirm modal for /model (and any future "Yes, switch/continue" prompt):
    // option 1 is the affirmative. Accept it.
    if (/Switch model\?/i.test(screen) || /\bYes,\s+(switch|continue|enable)/i.test(screen)) {
      session.writeKeys("1");
      await sleep(200);
      session.writeKeys("\r");
      await sleep(400);
      continue;
    }
    if (promptIdle(lines)) return true;
  }
  // Unknown picker still up — dismiss it so the next message can register.
  if (!escaped) {
    session.writeKeys("\x1b");
    escaped = true;
    const end2 = Date.now() + 2000;
    while (Date.now() < end2) {
      await sleep(150);
      if (promptIdle(session.screen())) return true;
    }
  }
  return false;
}

export function shouldUseEphemeralSession(channel) {
  return channel === "web" || channel === "garrison";
}

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

// Locate the kanban-loop fitting dir (repo seed OR installed composition) so the
// gateway can consult the SAME resolved model the BOARD reads (S4b / D15
// acceptance 9). Same resolution shape as the other fittings: env override,
// installed composition, or repo seed.
export function resolveKanbanLoopDir(compositionDir) {
  const candidates = [
    process.env.GARRISON_KANBAN_LOOP_DIR,
    compositionDir && path.join(compositionDir, "apm_modules", "_local", "kanban-loop"),
    path.resolve(HERE, "..", "..", "..", "kanban-loop"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "lib", "resolved-model.mjs"))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Locate the dispatcher fitting dir so the gateway can run the SAME steering
// classifier and dispatch/clarity core the composition ships. Callers that load
// a particular module pass its filename so a partial/older fitting cannot be
// selected for a core it does not contain.
export function resolveDispatcherDir(compositionDir, requiredModule = "steer-core.mjs") {
  const candidates = [
    process.env.GARRISON_DISPATCHER_DIR,
    compositionDir && path.join(compositionDir, "apm_modules", "_local", "dispatcher"),
    path.resolve(HERE, "..", "..", "..", "dispatcher"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const modules = requiredModule
        ? [requiredModule]
        : ["steer-core.mjs", "dispatch-core.mjs"];
      if (modules.some((name) => fs.existsSync(path.join(c, "lib", name)))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// Unlike pure code modules, garrison-call is an executable capability and must
// actually be composed. Do not fall back to the repo seed when a composition is
// running: an absent fitting yields an explicit failed call and the Dispatcher
// uses its deterministic fallback instead of secretly reaching an unstationed
// runtime.
export function resolveGarrisonCallScript(compositionDir) {
  const candidates = [
    process.env.GARRISON_CALL_SCRIPT,
    compositionDir && path.join(compositionDir, "apm_modules", "_local", "garrison-call", "scripts", "call.mjs"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ── Local-vision lane (Drill Evidence V2) ────────────────────────────────────
// ollama's Anthropic-compat endpoint never surfaces tool_use, so a routed
// ollama-local target cannot Read image files the way the Claude lanes do. A
// turn that carries image paths executes NATIVELY instead: the files are
// validated (absolute, confined to the garrison home, bounded), base64-inlined,
// and sent through garrison-call's image-capable ollama shape — the single
// ollama primitive. Pure builder; the gateway method performs the invocation.
export const OLLAMA_VISION_MAX_IMAGES = 16;
export const OLLAMA_VISION_MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function buildOllamaVisionSpec(target, message, imagePaths, { fsImpl = fs } = {}) {
  const home = path.resolve(process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison"));
  const paths = (Array.isArray(imagePaths) ? imagePaths : [])
    .filter((p) => typeof p === "string" && p)
    .slice(0, OLLAMA_VISION_MAX_IMAGES);
  if (!paths.length) throw new Error("ollama vision turn carried no usable image paths");
  const images = [];
  for (const p of paths) {
    if (!path.isAbsolute(p)) throw new Error(`image path not absolute: ${p.slice(0, 80)}`);
    const real = await fsImpl.promises.realpath(p);
    if (real !== home && !real.startsWith(home + path.sep)) {
      throw new Error(`image path escapes the garrison home: ${path.basename(p)}`);
    }
    const buf = await fsImpl.promises.readFile(real);
    if (!buf.length || buf.length > OLLAMA_VISION_MAX_IMAGE_BYTES) {
      throw new Error(`image empty or too large: ${path.basename(real)}`);
    }
    images.push(buf.toString("base64"));
  }
  return {
    shape: "ollama",
    provider: "ollama-local",
    ...(typeof target.baseUrl === "string" && target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    model: target.model,
    prompt: message,
    images,
    maxTokens: Number.isFinite(target.maxTokens) ? target.maxTokens : 2048,
    timeoutMs: Number.isFinite(target.timeoutMs) ? target.timeoutMs : 180000
  };
}

// Auth and provider configuration remain inside garrison-call: this wrapper only
// carries the structured spec over stdin and parses its secret-free result.
export function makeGarrisonCallInvoker(callScript, opts = {}) {
  if (!callScript) {
    return async () => ({ ok: false, error: "garrison-call fitting is not installed in this composition" });
  }
  const spawnImpl = opts.spawnImpl ?? spawn;
  return (spec) => new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(process.execPath, [callScript], {
        cwd: opts.compositionDir || process.cwd(),
        env: opts.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      resolve({ ok: false, error: `garrison-call spawn failed: ${err?.message || String(err)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout?.on?.("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on?.("data", (chunk) => (stderr += chunk.toString()));
    child.on?.("error", (err) => finish({ ok: false, error: `garrison-call error: ${err?.message || String(err)}` }));
    child.on?.("close", () => {
      try {
        finish(JSON.parse(stdout.trim()));
      } catch {
        finish({ ok: false, error: `garrison-call returned non-JSON: ${(stdout || stderr).slice(0, 200)}` });
      }
    });
    child.stdin?.end?.(JSON.stringify(spec));
  });
}

function dispatcherCallOpts(executionModel, resolvedLib) {
  const route = resolvedLib?.executionRouteFor?.({ duty: "dispatch", level: 1 }, executionModel);
  const target = route?.target ?? {};
  const provider = target.provider ?? "ollama-local";
  const shape = target.shape ?? (
    provider === "ollama-local" ? "ollama" :
      ["openai", "deepseek", "zai-glm"].includes(provider) ? "openai" : "anthropic"
  );
  return {
    shape,
    provider: provider === "anthropic-plan" ? "anthropic" : provider,
    model: target.model ?? "qwen2.5:3b",
    maxTokens: Number.isFinite(target.maxTokens) ? target.maxTokens : 256,
    timeoutMs: Number.isFinite(target.timeoutMs) ? target.timeoutMs : 30000
  };
}

export async function buildProductionDispatcher({ compositionDir, compositionId, executionModel, resolvedLib, decisionsFile, spawnImpl } = {}) {
  const model = resolvedLib?.dispatcherModelFrom?.(executionModel);
  if (!model || !model.duties?.dispatch) return null;
  const dispatcherDir = resolveDispatcherDir(compositionDir, "dispatch-core.mjs");
  if (!dispatcherDir) return null;
  const core = await import(pathToFileURL(path.join(dispatcherDir, "lib", "dispatch-core.mjs")).href);
  const callScript = resolveGarrisonCallScript(compositionDir);
  return {
    core,
    // Re-read at call time when possible so a runner projection refresh is seen
    // without restarting the gateway; the static model is the safe fallback.
    model: () =>
      resolvedLib?.dispatcherModelFrom?.(
        resolvedLib.loadResolvedModel?.(undefined, compositionId ?? null)
      ) ?? model,
    call: makeGarrisonCallInvoker(callScript, { compositionDir, spawnImpl }),
    evidenceFile: decisionsFile,
    callOpts: {
      ...dispatcherCallOpts(executionModel, resolvedLib),
      fallback: core.deterministicFallbackDispatch
    },
    configuredCall: callScript ? "garrison-call" : "deterministic-fallback"
  };
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

// The runner-projected resolved duty model (~/.garrison/kanban-loop/model.json,
// written at up() by src/lib/kanban-model.ts). Its per-duty per-level cells
// repoint the router matrix at the composition's duty ladders (applyDutyCells)
// — the same merge resolveRoutingSection applies before compiling policy.json,
// so the gateway routes against the identical duty-derived matrix. Absent or
// unreadable file → null (the config routes un-repointed, as before).
export function loadKanbanDutyModel() {
  try {
    const garrisonHome = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
    const dir = process.env.GARRISON_KANBAN_DIR?.trim() || path.join(garrisonHome, "kanban-loop");
    const file = path.join(dir, "model.json");
    if (!fs.existsSync(file)) return null;
    const model = JSON.parse(fs.readFileSync(file, "utf8"));
    return model && typeof model === "object" && model.cells && typeof model.cells === "object" ? model : null;
  } catch {
    return null;
  }
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
    this.compositionId = opts.compositionId ?? null;
    this.appendSystemPromptFile = opts.appendSystemPromptFile;
    this.nowFn = opts.nowFn ?? (() => new Date().toISOString());
    this.logFn = opts.logFn ?? (() => {});
    this.slashInjectWorks = opts.slashInjectWorks !== false; // MR0e verdict: works
    this.pool = opts.pool; // MultiRuntimePool
    this.operativeRuntimeId = opts.operativeRuntimeId ?? "operative";
    this.classifierRuntimeId = opts.classifierRuntimeId ?? "classifier";
    this.primaryEngine = opts.primaryEngine ?? "claude-code";
    // The model/effort/provider the operative session currently sits on.
    this.currentTarget = opts.initialTarget ?? null;
    this.spawnFn = opts.spawnFn ?? null; // for off-primary respawn-resume
    // The RuntimeAdapter that backs the operative session. Threaded from
    // createRoutedGateway (the resolved primary adapter); Stage-B moves + resume
    // route through it so a non-Claude primary is driven by its own adapter
    // rather than assuming a Claude PTY. Falls back to the pool's adapterFor when
    // not injected.
    this._operativeAdapter = opts.operativeAdapter ?? null;
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
    // A Claude target under a non-Claude primary is a delegate, not a mutation of
    // the primary adapter. Keep dedicated real Claude sessions keyed by the exact
    // target identity so Codex-primary → Claude-duty is executable and truthful.
    this._claudeDelegateAdapter = opts.claudeDelegateAdapter ?? null;
    this._claudeDelegateSessions = new Map();
    // Optional shared BUILD WORKSPACE. When set, the routed agent-sdk + secondary
    // turns run with this dir as cwd, so every model (ollama via the SDK, codex,
    // gemini) reads and edits the SAME real project files — a genuine cross-model
    // build on disk, not isolated scratch dirs. Unset → unchanged (scratch).
    this.buildWorkspace = opts.buildWorkspace ?? process.env.GARRISON_BUILD_WORKSPACE ?? null;
    // S3d (MARATHON-V3 D6): the OPTIONAL Dispatcher path (duties-and-levels), the
    // classifier's successor. Injected as { core (dispatch-core module), model
    // (the Resolver's resolved model), call (a garrison-call invoker), evidenceFile? }.
    // DEFAULT NULL, so classify()/preRoute() below are byte-for-byte unchanged and
    // the pinned classifier session stays the live default — parity is proven at
    // the resolution layer (tests/dispatcher-parity.test.ts) but on-box
    // classification-accuracy vs the haiku classifier is not, so retirement is not
    // forced (D6). dispatchRoute() is reachable only when a dispatcher is wired.
    this._dispatcher = opts.dispatcher ?? null;
    // S3b: the operative spawn config (cwd / model / permission / claude binary) so a
    // WEB materialized turn can run a one-shot claude WITHOUT touching the standing
    // operative session. oneShotFn is injectable (tests); default = the real oneShotTurn.
    this._operativeSpawnConfig = opts.operativeSpawnConfig ?? {};
    this._oneShotFn = opts.oneShotFn ?? null;
    // S3c: mid-run steering classifier — injectable (tests); default lazy-loads the
    // dispatcher fitting's steer-core (explicit phrasing short-circuits without a model;
    // the dispatcher's garrison-call is used for the model path when a dispatcher is wired).
    this._steerFn = opts.steer ?? null;
    // S3d: clarity judge - injectable (tests); default = phrasing short-circuit
    // (lazy-loaded from dispatch-core) then, when a dispatcher is wired, its model
    // verdict. The lazy short-circuit loader caches into this._clarityScFn.
    this._clarityFn = opts.clarity ?? null;
    this._clarityScFn = undefined;
    this._executionModel = opts.executionModel ?? null;
    this._resolvedModelLib = opts.resolvedModelLib ?? undefined;
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

  // The adapter driving the operative session. Injected reference wins (the
  // resolved primary adapter); else the pool knows which adapter backs each
  // warmed runtime id. Null when neither is available (treated as the Claude PTY
  // path by callers, the safe historical default).
  operativeAdapter() {
    if (this._operativeAdapter) return this._operativeAdapter;
    if (typeof this.pool?.adapterFor === "function") {
      return this.pool.adapterFor(this.operativeRuntimeId) ?? null;
    }
    return null;
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

  // True when this turn must take the native ollama vision lane: the caller
  // attached image paths AND the live resolved target runs on the local ollama
  // provider (the ONLY authoritative place that provider is knowable).
  isOllamaVisionTurn(route, images) {
    return Array.isArray(images) && images.length > 0 && route?.target?.provider === "ollama-local";
  }

  // Execute an image-carrying turn natively against ollama via garrison-call's
  // image-capable ollama shape. Single shot, no session, no tools — the local
  // model sees the frames inline instead of an unreadable file path.
  async runOllamaVisionTurn(route, message, imagePaths) {
    const t = route.target;
    const spec = await buildOllamaVisionSpec(t, message, imagePaths);
    this._ollamaVisionCall ??= makeGarrisonCallInvoker(
      resolveGarrisonCallScript(this.compositionDir),
      { compositionDir: this.compositionDir }
    );
    this.logFn({
      kind: "runtime-turn",
      runtime: "ollama-native",
      provider: "ollama-local",
      model: t.model,
      target: route.targetId,
      images: spec.images.length
    });
    const result = await this._ollamaVisionCall(spec);
    if (!result?.ok) {
      throw new Error(`ollama vision call failed: ${result?.error ?? "unknown error"}`);
    }
    return {
      reply: result.text ?? (result.structured ? JSON.stringify(result.structured) : ""),
      provider: "ollama-local",
      model: t.model,
      route: route.targetId
    };
  }

  // Run one turn on the agent-sdk runtime. THE HARNESS picks the preset (full) or
  // lean (chat, tools off) per the target's promptMode. The runtime is first-class
  // routable to any provider incl. the Anthropic endpoint (D29). One warm session
  // per {provider,model,promptMode}, reused across turns (SDK resume).
  async runAgentSdkTurn(route, message, onChunk) {
    const adapter = await this.getAgentSdkAdapter();
    const t = route.target;
    // Match the runtime fitting + adapter defaults when the target editor leaves
    // these controls at "runtime default". Falling back to lean/4 here silently
    // stripped CLAUDE.md, skills and tools from otherwise agentic targets even
    // though AgentSdkAdapter itself defaults to the full harness and 12 turns.
    const promptMode = t.promptMode ?? "full";
    const requestedEffort = t.effort ?? null;
    const spawnArgs = {
      provider: t.provider,
      model: t.model,
      effort: requestedEffort,
      promptMode,
      leanPrompt: t.leanPrompt,
      baseUrl: t.baseUrl,
      // cwd: the shared build workspace when set (so file ops hit the real project)
      compositionDir: this.buildWorkspace ?? this.compositionDir,
      disallowedTools: t.disallowedTools,
      allowedTools: t.allowedTools,
      maxTurns: t.maxTurns ?? 12,
      budgetTokens: t.budgetTokens ?? null,
      secrets: this.secrets ?? null,
      permissionMode: "bypassPermissions",
    };
    // Every target-owned execution knob participates in session identity. A live
    // manifest edit from lean → full (or maxTurns/tool-policy changes) must spawn
    // a session with the new harness instead of reusing an incompatible warm one.
    const key = JSON.stringify({ targetId: route.targetId, ...spawnArgs, secrets: undefined });
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
    if (requestedEffort != null && typeof adapter.setEffort === "function") {
      await adapter.setEffort(session, requestedEffort);
    }
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
      effort: requestedEffort,
      effortApplied: requestedEffort == null ? null : session.effortApplied === true,
      toolUses: resp.toolUses ?? [],
      stoppedReason: resp.stoppedReason ?? null,
    };
  }

  // True when the resolved route runs on a SECONDARY runtime (codex/gpt or
  // gemini) the gateway executes directly via its adapter (one-shot CLI exec).
  isSecondaryTarget(route) {
    const t = route?.target;
    // `type: secondary` is legacy metadata, not sufficient runtime identity: a
    // Claude-bound target under a Codex primary must take the real Claude lane.
    return !!t && (t.runtime === "codex" || t.runtime === "gemini");
  }

  isClaudeDelegateTarget(route) {
    return route?.target?.runtime === "claude-code" && this.primaryEngine !== "claude-code";
  }

  async getClaudeDelegateAdapter() {
    if (this._claudeDelegateAdapter) return this._claudeDelegateAdapter;
    this._claudeDelegateAdapter = new ClaudeCodeAdapter(this.spawnFn ? { spawnFn: this.spawnFn } : {});
    return this._claudeDelegateAdapter;
  }

  // A real Claude Code execution lane for a Claude-bound duty when another
  // runtime (Codex/Gemini/SDK/OpenCode) hosts the primary operative. This is a
  // delegate session with its own provider/model/effort, never the classifier and
  // never a reinterpretation of the non-Claude primary's session state.
  async runClaudeDelegateTurn(route, message, opts = {}) {
    const adapter = await this.getClaudeDelegateAdapter();
    const t = route.target;
    const provider = t.provider ?? "anthropic-plan";
    const model = t.model;
    const effort = t.effort ?? null;
    const key = `${provider}:${model}:${effort ?? "none"}`;
    let session = this._claudeDelegateSessions.get(key);
    if (!session || !this.#alive({ session })) {
      const spawnConfig = this.core.buildRespawnOpts(t, {
        compositionDir: this.buildWorkspace ?? this.compositionDir,
        appendSystemPromptFile: this.appendSystemPromptFile,
        baseEnv: process.env,
        secrets: this.secrets ?? null,
        providers: this.core.ensureProviders(this.config)?.providers,
        permissionMode: "bypassPermissions"
      });
      // A delegate is a fresh target session, not a resume of the primary.
      session = await adapter.spawn({ ...spawnConfig, continueSession: false });
      await adapter.awaitReady(session);
      let effortApplied = null;
      if (effort != null && typeof adapter.setEffort === "function") {
        await adapter.setEffort(session, effort);
        effortApplied = true;
        await sleep(this.injectSettleMs ?? 250);
      }
      session.__garrisonEffortApplied = effortApplied;
      this._claudeDelegateSessions.set(key, session);
    }
    this.logFn({ kind: "runtime-turn", runtime: "claude-code", provider, model, effort, target: route.targetId, delegated: true });
    let response;
    if (typeof session.runTurn === "function") {
      const out = await session.runTurn({ message, timeoutMs: opts.timeoutMs });
      response = { text: out?.reply ?? "", sessionId: out?.sessionId ?? session.getClaudeSessionId?.() ?? null };
    } else {
      await adapter.sendTurn(session, message);
      const out = await adapter.awaitResponse(session);
      response = { text: out?.text ?? "", sessionId: session.getClaudeSessionId?.() ?? null };
    }
    if (opts.onChunk && response.text) opts.onChunk(response.text, true);
    return {
      reply: response.text,
      session_id: response.sessionId,
      route: route.targetId,
      runtime: "claude-code",
      provider,
      model,
      effort,
      effortApplied: effort == null ? null : session.__garrisonEffortApplied === true
    };
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
    const effort = route.target.effort ?? null;
    const adapter = await this.getSecondaryAdapter(rt);
    // cwd: the shared BUILD WORKSPACE when set (so codex reads + gemini edits the
    // REAL project files), else a clean scratch cwd (default — keep the agentic CLI
    // out of the repo). codex on a ChatGPT account rejects an explicit model
    // override, so use its default; gemini accepts -m.
    const cwd = this.buildWorkspace ?? (this._secondaryScratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "garrison-secondary-")));
    const spawnModel = model;
    // Trust the cwd for gemini 0.46 (else it downgrades yolo + blocks); harmless for codex.
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" };
    const session = await adapter.spawn({ compositionDir: cwd, model: spawnModel, effort, env });
    this.logFn({ kind: "runtime-turn", runtime: rt, provider, model, effort, target: route.targetId });
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
    return {
      reply: resp?.text ?? "",
      session_id: null,
      route: route.targetId,
      runtime: rt,
      provider,
      model,
      effort,
      // Codex applies the reasoning-effort config at exec. Gemini currently has
      // no CLI effort control, so report the requested-but-unapplied state.
      effortApplied: effort == null ? null : rt === "codex" ? session.effortApplied === true : false
    };
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
  async completeQuickCard(id, result = null) {
    return cards.completeQuickCard({ id, result, logFn: (e) => this.logFn(e) });
  }

  // D19: route a failed/empty quick card to needs-attention instead of Done.
  async parkQuickCard(id, reason) {
    return cards.parkQuickCard({ id, reason, logFn: (e) => this.logFn(e) });
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

  // S3b: DURABLE thread→card lookup (heals gateway restarts — the in-RAM
  // _sessionCards map is memory-only). Query the board for THIS origin's cards
  // (most recent first). The most recent LIVE card -> attach (keep today's inline
  // behavior); else the most recent DONE card -> continueFrom (a post-done follow-up
  // becomes a continuation ON THE BOARD). Returns { attach } | { continueFrom } | null.
  async resolveThreadCard(origin_id) {
    const list = await cards.cardsByOrigin(origin_id);
    if (!Array.isArray(list) || list.length === 0) return null;
    const live = list.find(
      (c) => c && c.list && c.list !== "done" && c.list !== "needs-attention" && !c.preparedRevert
    );
    if (live) return { attach: live };
    const done = list.find((c) => c && c.list === "done");
    if (done) return { continueFrom: done.id };
    return null;
  }

  // S3b: run ONE web materialized turn as a one-shot (fresh disposable claude), so
  // the standing operative session holds NO web context between messages. Injectable
  // for tests via opts.oneShotFn. Returns { reply, sessionId }.
  async runWebOneShot({ message, model, onScreen, onSession } = {}) {
    const cfg = this._operativeSpawnConfig || {};
    const fn = this._oneShotFn ?? oneShotTurn;
    const outcome = await fn({
      cwd: cfg.compositionDir ?? this.compositionDir,
      appendSystemPromptFile: cfg.appendSystemPromptFile ?? this.appendSystemPromptFile,
      model: model ?? cfg.model,
      permissionMode: cfg.permissionMode ?? "bypassPermissions",
      claudeBinary: cfg.claudeBinary,
      extraArgs: cfg.extraArgs,
      message,
      onScreen,
      onSession
    });
    return { reply: outcome?.reply ?? "", sessionId: outcome?.sessionId ?? null };
  }

  // S3b introspection: no standing per-conversation session exists — the pool holds
  // ONE operative checkout (shared by kanban duties), web turns are one-shots.
  materializedStatus() {
    return {
      standingConversationSessions: 0,
      operativeCheckout: Boolean(this.operative?.session),
    };
  }

  // S3c: classify a mid-run thread message as absorb | revisit | acknowledge.
  // Injectable via opts.steer (tests); default lazy-loads the dispatcher's steer-core
  // (explicit phrasing short-circuits with no model call). Never throws.
  async runSteerClassification({ message, card } = {}) {
    if (this._steerFn) return this._steerFn({ message, card });
    try {
      const dir = resolveDispatcherDir(this.compositionDir, "steer-core.mjs");
      if (!dir) return { action: "acknowledge", reason: "no steering classifier", confidence: "low" };
      const mod = await import(pathToFileURL(path.join(dir, "lib", "steer-core.mjs")).href);
      return await mod.classifySteering({
        message,
        card,
        call: typeof this._dispatcher?.call === "function" ? this._dispatcher.call : undefined,
        evidenceFile: this.decisionsFile,
        now: this.nowFn,
      });
    } catch (err) {
      this.logFn({ kind: "steering-classify-failed", error: err?.message || String(err) });
      return { action: "acknowledge", reason: "steering classifier unavailable", confidence: "low" };
    }
  }

  // S3c-fix1: fetch a card by id from the board and return it ONLY when it is still a
  // LIVE engine run (the in-RAM attach map carries no card fields, so a same-session
  // follow-up needs this to reach steering). null when absent / terminal / abandoned.
  async getLiveCard(cardId) {
    try {
      const base = cards.boardBase();
      if (!base || !cardId) return null;
      const r = await fetch(`${base}/cards/${encodeURIComponent(cardId)}`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return null;
      const doc = await r.json();
      const card = doc.card ?? doc;
      const list = card?.list;
      if (!list || list === "done" || list === "needs-attention") return null;
      if (card.preparedRevert) return null;
      return card;
    } catch {
      return null;
    }
  }

  // S3c-fix1: classify steering for a web attach, resolving the full card from EITHER
  // the durable-lookup attach (.card) OR the in-RAM attach (.cardId → getLiveCard).
  // Returns { steer, card } for a live web card, or null (not web / not live) so the
  // caller falls through to a plain one-shot answer.
  async classifyAttachSteering({ attached, origin, message } = {}) {
    if (origin !== "web" || !attached) return null;
    const card = attached.card ?? (await this.getLiveCard(attached.cardId));
    if (!card) return null;
    const steer = await this.runSteerClassification({ message, card });
    return { steer, card };
  }

  // S3c: POST the steering directive to the board's steer endpoint. viaTurn:true so
  // the endpoint records the event but does not double-post to the thread (the
  // gateway turn's own SSE reply is the delivery). Returns { applied } or null.
  async postSteer(cardId, { message, action, revisitDuty = null, reason = null } = {}) {
    try {
      const base = cards.boardBase();
      if (!base || !cardId) return null;
      const r = await fetch(`${base}/cards/${encodeURIComponent(cardId)}/steer`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
        body: JSON.stringify({ message, action, revisitDuty, reason, viaTurn: true }),
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return null;
      return await r.json().catch(() => ({}));
    } catch {
      return null;
    }
  }

  // S3d (D9b): judge whether a task-shaped ask is CLEAR enough to plan against, or
  // NEEDS a scope discussion first. A phrasing short-circuit decides first (pure code,
  // both directions, no model - "just do it" → clear, "let's discuss first" →
  // needs-discuss); otherwise, when a Dispatcher is wired (opt-in), its clarity verdict
  // is consulted; default "clear" (never blocks a turn). Injectable via opts.clarity
  // (tests). Returns { clarity, source }. Never throws.
  async judgeClarity(message) {
    if (typeof this._clarityFn === "function") {
      try {
        const r = await this._clarityFn({ message });
        if (r && r.clarity) {
          return { clarity: r.clarity === "needs-discuss" ? "needs-discuss" : "clear", source: r.source ?? "injected" };
        }
      } catch (err) {
        this.logFn({ kind: "clarity-judge-failed", error: err?.message || String(err) });
      }
    }
    const sc = await this._clarityShortCircuit(message);
    if (sc) return { clarity: sc.clarity === "needs-discuss" ? "needs-discuss" : "clear", source: "message" };
    if (this._dispatcher?.core && typeof this._dispatcher.core.dispatch === "function") {
      try {
        const r = await this.dispatchRoute(message);
        return { clarity: r?.clarity === "needs-discuss" ? "needs-discuss" : "clear", source: "dispatch" };
      } catch (err) {
        this.logFn({ kind: "clarity-judge-failed", error: err?.message || String(err) });
      }
    }
    return { clarity: "clear", source: "default" };
  }

  // Lazy-load the dispatcher's PURE clarity phrasing short-circuit (the SAME helper
  // dispatch-core applies), so an explicit "just do it" / "let's discuss first" wins
  // on the live classifier path too - no Dispatcher required. Cached; null when the
  // dispatcher fitting isn't resolvable on disk (→ no short-circuit, default clear).
  async _clarityShortCircuit(message) {
    try {
      if (this._clarityScFn === undefined) {
        const dir = resolveDispatcherDir(this.compositionDir, "dispatch-core.mjs");
        const mod = dir ? await import(pathToFileURL(path.join(dir, "lib", "dispatch-core.mjs")).href) : null;
        this._clarityScFn = mod && typeof mod.clarityShortCircuit === "function" ? mod.clarityShortCircuit : null;
      }
      return this._clarityScFn ? this._clarityScFn(message) : null;
    } catch {
      return null;
    }
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

  // S3d (MARATHON-V3 D6): route ONE message through the Dispatcher DUTY
  // (duties-and-levels vocabulary) — the successor to classify(). Returns
  // { duty, level, confidence, reason, overridden, overrideSource, evidence }.
  // OPT-IN: only reachable when a dispatcher bundle was injected (opts.dispatcher
  // at construction); classify() (the live default) is untouched, so the 122-case
  // classifier corpus and the gateway suite pass unchanged. The dispatch call runs
  // single-shot on a small fast model via the injected garrison-call invoker; code
  // clamps + applies the human "run at level N" / card override; routing evidence
  // (message DIGEST, never the raw message) is logged to the decisions file.
  async dispatchRoute(message, opts = {}) {
    if (!this._dispatcher || !this._dispatcher.core || typeof this._dispatcher.core.dispatch !== "function") {
      throw new Error("dispatchRoute: no Dispatcher wired (construct RoutedGateway with opts.dispatcher = { core, model, call })");
    }
    const { core, model, call, evidenceFile, callOpts } = this._dispatcher;
    const currentModel = typeof model === "function" ? await model() : model;
    const result = await core.dispatch(currentModel, message, {
      call,
      now: this.nowFn,
      evidenceFile: evidenceFile ?? this.decisionsFile,
      cardLevel: opts.cardLevel,
      ...(callOpts ?? {}),
    });
    if (result?.dispatchOk === false) {
      this.logFn({
        kind: "dispatcher-fallback",
        duty: result.duty ?? null,
        level: result.level ?? null,
        reason: result.reason ?? null,
        error: result.callError ?? null
      });
    }
    // S4b (D15 acceptance 9): the dispatch now CONSULTS THE RESOLVED MODEL. Attach
    // the ordered phase sequence the resolved (duty, level) walks — read from the
    // SAME runner-projected model.json the board reads — so a task entering via the
    // web-channel produces a card that visits the IDENTICAL sequence a board-entered
    // card with the same (duty, level) would (divergence zero). Additive + best-
    // effort: an absent/unresolvable model leaves the historical dispatch fields
    // untouched and `sequence` unset, so the pre-S4b behaviour is byte-for-byte kept.
    try {
      const sequence = await this.resolvedSequenceForDispatch(result?.duty, result?.level);
      if (sequence.length) {
        result.sequence = sequence;
        this.logFn({ kind: "dispatch-sequence", duty: result.duty, level: result.level, sequence });
      }
    } catch (err) {
      this.logFn({ kind: "dispatch-sequence-failed", error: err?.message });
    }
    return result;
  }

  // Load the board's resolved-model helpers (loadResolvedModel + resolveCardSequence)
  // from the kanban-loop fitting — the SAME module the board uses to decide a card's
  // flow — so the gateway's dispatch consult and the board's card-flow decision read
  // one implementation and cannot drift. Cached; null when the fitting isn't
  // resolvable on disk (the gateway then attaches no sequence and behaves as before).
  async _kanbanResolvedModelLib() {
    if (this._resolvedModelLib !== undefined) return this._resolvedModelLib;
    if (this._kanbanLib !== undefined) return this._kanbanLib;
    try {
      const dir = resolveKanbanLoopDir(this.compositionDir);
      this._kanbanLib = dir
        ? await import(pathToFileURL(path.join(dir, "lib", "resolved-model.mjs")).href)
        : null;
    } catch {
      this._kanbanLib = null;
    }
    return this._kanbanLib;
  }

  async executionModel() {
    const lib = await this._kanbanResolvedModelLib();
    const latest = lib?.loadResolvedModel?.(undefined, this.compositionId);
    if (latest) this._executionModel = latest;
    return this._executionModel;
  }

  async executionRouteFor({ duty, level, phase = null, stepIndex = null } = {}) {
    const lib = await this._kanbanResolvedModelLib();
    const model = await this.executionModel();
    return lib?.executionRouteFor?.({ duty, level, phase, stepIndex }, model) ?? null;
  }

  // S4b (D15 acceptance 9): resolve a (duty, level) to the ordered phase-list
  // sequence a card would VISIT, reading the runner-projected model.json (the SAME
  // file the board reads via resolved-model.mjs). Returns [] when the model is
  // absent/unresolvable — the gateway then keeps its historical entry lists
  // (backlog/plan/implement) unchanged. This is DOOR 1's consult of the shared model.
  async resolvedSequenceForDispatch(duty, level) {
    if (!duty) return [];
    const lib = await this._kanbanResolvedModelLib();
    if (!lib || typeof lib.loadResolvedModel !== "function" || typeof lib.resolveCardSequence !== "function") {
      return [];
    }
    const model = lib.loadResolvedModel(undefined, this.compositionId);
    if (!model) return [];
    const seq = lib.resolveCardSequence({ duty, level: level ?? 1 }, model);
    return Array.isArray(seq) ? seq : [];
  }

  async preRouteV4(message, { duty, level, phase = null, stepIndex = null, sequence = null } = {}) {
    const resolved = await this.executionRouteFor({ duty, level, phase, stepIndex });
    if (!resolved) {
      throw new Error(
        `v4 duty route unresolved for ${duty || "?"} level ${level || "?"}` +
        `${phase ? ` phase ${phase}` : ""} — the assigned cell must name a projected target with runtime and model`
      );
    }
    const effectivePhase = phase || resolved.phase || resolved.step?.duty || duty;
    const compatibilityTask = phase
      ? effectivePhase
      : duty === "develop" ? "code" : duty;
    const compatibilityTier = level <= 1 ? "T0-trivial" : level >= 3 ? "T2-deep" : "T1-standard";
    const classification = { taskType: compatibilityTask || "other", tier: compatibilityTier };
    const route = {
      profile: "composition-v4",
      role: effectivePhase,
      ruleId: `duty:${duty}/L${level}/${effectivePhase}`,
      via: "duty-cell",
      targetId: resolved.targetId,
      target: resolved.target,
      duty,
      level,
      phase: effectivePhase,
      skill: resolved.skill
    };
    const decision = {
      ...this.core.decisionRecord({ prompt: message, classification, route, at: this.nowFn() }),
      kind: "duty-route",
      duty,
      level,
      phase: effectivePhase,
      skill: resolved.skill ?? null,
      runtime: route.target.runtime,
      provider: route.target.provider ?? null,
      model: route.target.model,
      effort: route.target.effort ?? null
    };
    await this.core.appendDecision(this.decisionsFile, decision);
    this.logFn({
      kind: "duty-route-resolved",
      duty,
      level,
      phase: effectivePhase,
      skill: resolved.skill ?? null,
      target: route.targetId,
      runtime: route.target.runtime,
      model: route.target.model,
      effort: route.target.effort ?? null
    });

    let plan;
    if (this.isAgentSdkTarget(route)) {
      plan = { path: "agent-sdk", reasons: [`v4 duty cell → agent-sdk ${route.target.provider}/${route.target.model}`] };
    } else if (this.isClaudeDelegateTarget(route)) {
      plan = { path: "claude-delegate", reasons: [`v4 duty cell → Claude delegate under ${this.primaryEngine} primary`] };
    } else if (this.isSecondaryTarget(route)) {
      plan = { path: "secondary", reasons: [`v4 duty cell → ${route.target.runtime}/${route.target.model}`] };
    } else {
      plan = await this.applySwitch(route);
    }
    const seq = Array.isArray(sequence) && sequence.length
      ? sequence
      : await this.resolvedSequenceForDispatch(duty, level);
    const skillInstruction = resolved.skill
      ? `[v4 duty cell: ${duty} L${level} / ${effectivePhase}; invoke skill ${resolved.skill}; target ${route.targetId}]\n`
      : `[v4 duty cell: ${duty} L${level} / ${effectivePhase}; target ${route.targetId}]\n`;
    return {
      classification,
      route,
      decision,
      plan,
      annotation: `${routeAnnotation(route)}\n${skillInstruction}`,
      carried: false,
      duty,
      level,
      phase: effectivePhase,
      skill: resolved.skill ?? null,
      sequence: seq
    };
  }

  // classify → resolve role → resolve target → LOG at resolution time → switch.
  //
  // When the active profile sets `preRoute: "off"`, the per-turn classifier turn
  // is SKIPPED entirely (it costs ~5s) and every turn is pinned to the profile's
  // `fast` target. The slash-inject in applySwitch still fires once to move the
  // operative onto that target, then no-ops. This is the latency path for
  // conversational channels (e.g. Jarvis voice) where every turn is short.
  async preRoute(message, opts = {}) {
    this._lastUserMessage = message;
    // A Kanban phase carries the card's semantic v4 identity. It is authoritative:
    // resolve the assigned leaf cell from the shared execution manifest and never
    // send it through the legacy taskType×tier matrix.
    if (typeof opts.duty === "string" && Number.isInteger(opts.level) && typeof opts.phase === "string") {
      return this.preRouteV4(message, {
        duty: opts.duty,
        level: opts.level,
        phase: opts.phase,
        stepIndex: opts.stepIndex,
        sequence: opts.sequence
      });
    }
    // Direct channel work enters through the production Dispatcher. Tests/raw
    // internal callers with no channel, explicit legacy classifications, and old
    // cards remain on the historical classifier path below.
    const origin = String(opts.channel || "").toLowerCase();
    const cardOriginated = cards.isCardOriginatedChannel(origin);
    if (this._dispatcher && origin && !cardOriginated && !opts.classification) {
      const dispatched = await this.dispatchRoute(message, { cardLevel: opts.cardLevel });
      if (dispatched?.duty && Number.isInteger(dispatched.level)) {
        return this.preRouteV4(message, {
          duty: dispatched.duty,
          level: dispatched.level,
          sequence: dispatched.sequence
        });
      }
    }
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
    // Effort is part of the resolved route (duty cells overlay it onto the
    // target) — persist it so "which effort served this turn" is provable
    // from the decision log alone.
    decision.effort = route.target?.effort ?? route.effort ?? null;
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
        : this.isClaudeDelegateTarget(route)
          ? { path: "claude-delegate", reasons: [`Claude delegate under ${this.primaryEngine} primary`] }
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
      // slash-inject assumes a Claude PTY session (writeKeys). A non-claude
      // primary's session has none — but its ADAPTER can apply the same model /
      // effort moves through setModel/setEffort. Route through the adapter when it
      // implements them; only skip (with the historical log) when it does not.
      if (typeof this.operative?.session?.writeKeys !== "function") {
        const adapter = this.operativeAdapter();
        if (adapter && typeof adapter.setModel === "function" && typeof adapter.setEffort === "function") {
          const session = this.operative?.session;
          const model = route.target?.model ?? null;
          const effort = route.target?.effort ?? null;
          // Apply exactly the moves planSwitch planned (model and/or effort), with
          // the values taken from the resolved target.
          const moved = [];
          for (const inj of plan.injections) {
            if (inj.startsWith("/model")) {
              await adapter.setModel(session, model);
              moved.push(inj);
            } else if (inj.startsWith("/effort")) {
              await adapter.setEffort(session, effort);
              moved.push(inj);
            }
          }
          this.currentTarget = route.target;
          this.switchLog.push({ path: "adapter-moves", injections: moved, target: route.targetId, reasons: plan.reasons });
          this.logFn({ kind: "route-switch", path: "adapter-moves", injections: moved, target: route.targetId, runtime: adapter.id });
          return plan;
        }
        this.logFn({
          kind: "route-switch-skipped",
          reason: `slash-inject needs a Claude PTY operative or an adapter with setModel/setEffort; the current primary session has neither — model/effort stay launch-fixed (target ${route.targetId})`
        });
        this.switchLog.push({ path: "skipped-non-pty", injections: [], target: route.targetId, reasons: plan.reasons });
        return plan;
      }
      for (const inj of plan.injections) {
        // injectSlash drives the command to completion (it also answers the
        // "Switch model?" confirm modal Claude >=2.1.181 puts up, which a fixed
        // sleep would leave parked). The settle wait below still applies: a
        // /model switch re-renders the TUI after the prompt goes idle, and a
        // message written into that re-render gets swallowed.
        await injectSlash(this.operative.session, inj, 8000);
        // 1s, not 250ms: a /model switch between real models re-renders the
        // TUI; a message written into that re-render gets swallowed and the
        // turn's reply extraction then reads the PREVIOUS turn still on
        // screen (the stale-echo wedge that parks kanban phase turns).
        await sleep(this.injectSettleMs ?? 1000);
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
    // A NON-claude primary resumes through its OWN adapter (the SDK/Codex/Gemini
    // resume contract), not the claude-specific spawnFn + --continue path. The
    // config mirrors what the adapter's spawn takes (provider/model/effort/cwd).
    const adapter = this.operativeAdapter();
    if (adapter && adapter.id !== "claude-code" && typeof adapter.resume === "function") {
      const config = {
        compositionDir: this.compositionDir,
        provider: target?.provider,
        model: target?.model,
        effort: target?.effort ?? null,
        appendSystemPromptFile: this.appendSystemPromptFile,
        secrets: this.secrets ?? null,
        permissionMode: "bypassPermissions",
        // carry the prior conversation id where the adapter tracks one (SDK resume)
        sessionId: this.operative?.session?.sessionId ?? null,
      };
      const fresh = await adapter.resume(config);
      const old = this.operative;
      // Install the fresh session FIRST so a slow/throwing teardown of the old one
      // never leaves the gateway operative-less — resume has already succeeded.
      // The wrapper's release honors {evict:true} (already retired below, just
      // forget) vs a bare shutdown() call (tear the live session down).
      this.operative = {
        id: `respawn:${target?.id}`,
        session: fresh,
        release: (opts = {}) => {
          if (opts.evict) return;
          try {
            adapter.teardown?.(fresh);
          } catch {
            /* ignore */
          }
        },
      };
      // Retire the OLD operative exactly once: tear its session down through the
      // adapter (loud on failure — a swallowed throw could orphan a running
      // session), then evict its pool checkout WITHOUT a second dispose (the
      // adapter already tore it down), so gw.shutdown() cannot double-teardown it.
      try {
        await adapter.teardown?.(old?.session);
      } catch (error) {
        this.logFn({
          kind: "route-respawn-teardown-failed",
          error: String(error?.message ?? error),
          target: target?.id,
          runtime: adapter.id,
        });
      }
      try {
        old?.release?.({ evict: true });
      } catch {
        /* ignore */
      }
      this.logFn({ kind: "route-respawn", path: "adapter-resume", target: target?.id, runtime: adapter.id });
      return;
    }
    if (!this.spawnFn) {
      this.logFn({ kind: "respawn-skip", reason: "no spawnFn injected", target: target?.id });
      return;
    }
    const opts = this.core.buildRespawnOpts(target, {
      compositionDir: this.compositionDir,
      appendSystemPromptFile: this.appendSystemPromptFile,
      baseEnv: process.env,
      secrets: this.secrets ?? null,
      // Keep the operative's spawn-time extra claude args (e.g. --mcp-config)
      // across a model-switch respawn.
      extraArgs: this._operativeSpawnConfig?.extraArgs,
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
    this.logFn({ kind: "route-respawn", path: "spawn-continue", target: target?.id });
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
    for (const session of this._agentSdkSessions.values()) {
      try {
        Promise.resolve(this._agentSdkAdapter?.teardown?.(session)).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    this._agentSdkSessions.clear();
    for (const session of this._claudeDelegateSessions.values()) {
      try {
        Promise.resolve(this._claudeDelegateAdapter?.teardown?.(session)).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    this._claudeDelegateSessions.clear();
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
const KNOWN_PRIMARY_ENGINES = ["claude-code", "agent-sdk", "codex", "gemini", "opencode"];

// Exec-style runtimes (a stateless `run`/`exec` subprocess per turn) that can ALSO
// host the PRIMARY: same resolveSecondaryDir + bridge-probe warm shape, only the
// adapter class name differs. opencode joined codex/gemini in S2c (the
// runtime-agnosticism matrix) — the uniform RuntimeAdapter contract is exactly what
// lets a non-Claude primary boot identically regardless of which exec engine it is,
// so leaving opencode out of this map (while it is a first-class runtime fitting)
// was an agnosticism gap, not a design choice.
const EXEC_PRIMARY_ADAPTER_CLASS = { codex: "CodexAdapter", gemini: "GeminiAdapter", opencode: "OpenCodeAdapter" };

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
    // A spawn-level error (e.g. ENOENT) means the child never ran — there is
    // nothing to reap and no stderr; rejecting here is correct. If an error
    // ever fires post-spawn, the promise's single-settle semantics make the
    // race with `close` benign (first settle wins). Same remediation text.
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          `${engine} bridge probe failed to start: ${String(e?.message || e)} — install/authenticate the ${engine} CLI, or switch primaryRuntime back to claude-code-runtime in the composer`
        )
      );
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
        // The agent-sdk primary defaults to the Anthropic Max subscription (D29),
        // byte-identical when the operative spawn config names no provider. A
        // non-anthropic provider (ollama-local / z.ai / …) is honored when named,
        // threading its per-target baseUrl + vault secrets so the primary can run
        // off-Anthropic (e.g. a free local ollama operative).
        provider: operativeSpawnConfig.provider ?? "anthropic",
        model: operativeSpawnConfig.model,
        promptMode: operativeSpawnConfig.promptMode ?? "full",
        compositionDir,
        ...(operativeSpawnConfig.baseUrl ? { baseUrl: operativeSpawnConfig.baseUrl } : {}),
        ...(operativeSpawnConfig.leanPrompt ? { leanPrompt: operativeSpawnConfig.leanPrompt } : {}),
        ...(operativeSpawnConfig.secrets ? { secrets: operativeSpawnConfig.secrets } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {})
      },
      claude: false
    };
  }
  // Object.hasOwn guards against prototype keys (e.g. engine === "toString")
  // slipping past the explicit unknown-engine throw below into exec resolution.
  const execCls = Object.hasOwn(EXEC_PRIMARY_ADAPTER_CLASS, engine)
    ? EXEC_PRIMARY_ADAPTER_CLASS[engine]
    : undefined;
  if (execCls) {
    let adapter = opts.secondaryAdapters?.get?.(engine) ?? null;
    let dir = null;
    if (!adapter) {
      dir = resolveSecondaryDir(compositionDir, engine);
      if (!dir) {
        throw new Error(
          `primaryRuntime names the ${engine} engine but the ${engine}-runtime fitting is not installed — compose it under the runtimes faculty (apm install), or switch primaryRuntime back to claude-code-runtime`
        );
      }
      const mod = await import(pathToFileURL(path.join(dir, "lib", `${engine}-adapter.mjs`)).href);
      adapter = new mod[execCls]();
      // Warm-time CLI probe — fail the startup loudly, not the first turn.
      if (opts.probeExecPrimaries !== false) await probeRuntimeBridge(dir, engine);
    }
    // The composition's primary configuration is authoritative for Codex/Gemini.
    // OpenCode keeps its provider/model validation: only its required
    // `provider/model` shape may override native config. Reasoning effort is a
    // Codex control; do not claim or forward it to unsupported exec engines.
    const spawnConfig = { compositionDir, env: process.env };
    if (
      (engine === "codex" || engine === "gemini") &&
      typeof operativeSpawnConfig?.model === "string" &&
      operativeSpawnConfig.model
    ) {
      spawnConfig.model = operativeSpawnConfig.model;
    } else if (
      engine === "opencode" &&
      typeof operativeSpawnConfig?.model === "string" &&
      operativeSpawnConfig.model.includes("/")
    ) {
      spawnConfig.model = operativeSpawnConfig.model;
    }
    if (engine === "codex" && operativeSpawnConfig?.effort != null) {
      spawnConfig.effort = operativeSpawnConfig.effort;
    }
    return { adapter, spawnConfig, claude: false };
  }
  throw new Error(
    `unknown primary engine "${engine}" — expected one of ${KNOWN_PRIMARY_ENGINES.join(", ")}. Fix primaryRuntime in the composer (policy file).`
  );
}

// Is the claude-code runtime resolvable (its CLI installed / a stub standing in
// for it)? The classifier stays on the cheap claude-code haiku session whenever
// this is true — the default, byte-identical to before. Only a NON-claude primary
// with claude-code genuinely absent falls the classifier back to the primary.
export function claudeCodeResolvable(ctx = {}) {
  const o = ctx.opts ?? {};
  // TEST-INJECTION SEAM ONLY — the boolean/function override exists so unit tests
  // (and, if ever needed, the runner) can force resolvability without probing a
  // real CLI. Production leaves it unset and takes the isClaudeBinaryPresent()
  // path below; do NOT wire this to user/config input.
  if (typeof o.claudeCodeResolvable === "boolean") return o.claudeCodeResolvable;
  if (typeof o.claudeCodeResolvable === "function") return !!o.claudeCodeResolvable();
  // A stub spawnFn stands in for the real claude binary (tests + the dev seam).
  if (ctx.spawnFn) return true;
  return isClaudeBinaryPresent();
}

// Cheap PATH probe for the claude CLI — no spawn, no new deps. Honors CLAUDE_BINARY
// (absolute path → stat it; bare name → search PATH).
function isClaudeBinaryPresent() {
  const bin = process.env.CLAUDE_BINARY || "claude";
  const isExec = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (bin.includes(path.sep) || bin.includes("/")) return isExec(bin);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir && isExec(path.join(dir, bin))) return true;
  }
  return false;
}

// The classifier spawn config for a fallback to the primary adapter: reuse the
// primary's spawn config, dropping to a cheaper model only when an override is
// supplied AND the config carries a model field.
function classifierFallbackConfig(primarySpawnConfig, opts = {}) {
  const cheap = opts.classifierFallbackModel ?? null;
  if (cheap && primarySpawnConfig && "model" in primarySpawnConfig) {
    return { ...primarySpawnConfig, model: cheap };
  }
  return primarySpawnConfig;
}

// Resolve the { adapter, spawnConfig } that back the CLASSIFIER pool entry.
// Default (claude-code resolvable): the cheap claude-code haiku session, exactly
// as before. Non-claude primary + claude-code ABSENT: fall back to the primary
// adapter and log the fallback loudly.
export function resolveClassifierAdapter(ctx) {
  const { primary, primaryEngine, spawnFn, classifierSpawnConfig, opts, logFn } = ctx;
  if (primary.claude) {
    // claude-code primary → the operative adapter also serves the classifier.
    return { adapter: primary.adapter, spawnConfig: classifierSpawnConfig };
  }
  if (claudeCodeResolvable({ spawnFn, primaryEngine, opts })) {
    // non-claude primary but claude-code IS resolvable → keep the cheap haiku
    // classifier on its own ClaudeCodeAdapter (byte-identical to before).
    return { adapter: new ClaudeCodeAdapter(spawnFn ? { spawnFn } : {}), spawnConfig: classifierSpawnConfig };
  }
  // non-claude primary AND claude-code absent → the primary adapter classifies.
  (logFn ?? (() => {}))({
    kind: "classifier-fallback",
    from: "claude-code",
    to: primaryEngine,
    reason: "claude-code runtime not resolvable (CLI absent); classifying on the primary adapter instead of the cheap claude-code haiku session",
  });
  return { adapter: primary.adapter, spawnConfig: classifierFallbackConfig(primary.spawnConfig, opts) };
}

// Build a RoutedGateway wired to the real claude runtime (or an injected stub).
// spawnFn lets a test swap the leaf session factory (the documented test seam
// GARRISON_GATEWAY_RUNTIME_STUB in gateway-pty.mjs); production passes none and
// the ClaudeCodeAdapter spawns the real TUI.
export async function createRoutedGateway(opts = {}) {
  const compositionDir = opts.compositionDir;
  const compositionId = opts.compositionId ?? null;
  const core = opts.core ?? (await loadRoutingCore(compositionDir));
  let config = opts.config ?? loadRoutingConfig(compositionDir, core.dir);
  // Duties repoint: merge the composition's duty-ladder cells over the matrix
  // rows so a Muster duty edit (target/effort/level) is what actually routes.
  // Skipped when the caller injected a config (tests own their fixture) or no
  // projected model exists.
  if (!opts.config && typeof core.applyDutyCells === "function") {
    const dutyModel = opts.dutyModel ?? loadKanbanDutyModel();
    if (dutyModel) config = core.applyDutyCells(config, dutyModel);
  }
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
    (opts.primaryEngine ?? process.env.GARRISON_PRIMARY_ENGINE ?? "claude-code").trim().toLowerCase() ||
    "claude-code";
  const primary = await resolvePrimaryAdapter(primaryEngine, {
    compositionDir,
    spawnFn,
    operativeSpawnConfig,
    opts
  });
  // The classifier stays on the cheap claude-code haiku session by default; only a
  // non-claude primary with claude-code genuinely absent falls it back to the
  // primary adapter (logged loudly). See resolveClassifierAdapter.
  const classifier = resolveClassifierAdapter({
    primary,
    primaryEngine,
    spawnFn,
    classifierSpawnConfig,
    opts,
    logFn: opts.logFn,
  });
  const pool =
    opts.pool ??
    new MultiRuntimePool({
      maxTotal: opts.maxTotal ?? 4,
      runtimes: [
        { id: "operative", adapter: primary.adapter, role: "primary", size: 1, spawnConfig: primary.spawnConfig },
        { id: "classifier", adapter: classifier.adapter, role: "secondary", size: 1, spawnConfig: classifier.spawnConfig },
      ],
      });

  const decisionsFile = opts.decisionsFile ?? path.join(compositionDir, ".garrison", "decisions.jsonl");
  let resolvedModelLib = opts.resolvedModelLib;
  let executionModel = opts.executionModel;
  // Production gateway-pty opts into the v4 Dispatcher. Keeping the flag explicit
  // prevents pure Stage-A tests (and old deployments with only model v1) from
  // consulting machine-global board state by accident.
  if (opts.enableV4Dispatcher === true && !resolvedModelLib) {
    const kanbanDir = resolveKanbanLoopDir(compositionDir);
    if (kanbanDir) {
      resolvedModelLib = await import(pathToFileURL(path.join(kanbanDir, "lib", "resolved-model.mjs")).href);
    }
  }
  if (opts.enableV4Dispatcher === true && executionModel === undefined) {
    executionModel = resolvedModelLib?.loadResolvedModel?.(undefined, compositionId) ?? null;
  }
  let dispatcher = opts.dispatcher;
  if (dispatcher === undefined && opts.enableV4Dispatcher === true && executionModel) {
    dispatcher = await buildProductionDispatcher({
      compositionDir,
      compositionId,
      executionModel,
      resolvedLib: resolvedModelLib,
      decisionsFile,
      spawnImpl: opts.garrisonCallSpawnImpl
    });
    if (dispatcher) {
      opts.logFn?.({ kind: "dispatcher-wired", source: "composition-v4", call: dispatcher.configuredCall });
    } else {
      opts.logFn?.({ kind: "dispatcher-unavailable", source: "composition-v4", fallback: "legacy-classifier" });
    }
  }
  if (!dispatcher && opts.fallbackDispatcher) {
    dispatcher = opts.fallbackDispatcher;
    opts.logFn?.({ kind: "dispatcher-wired", source: "control-fallback" });
  }

  const gw = new RoutedGateway({
    core,
    config,
    decisionsFile,
    compositionDir,
    compositionId,
    appendSystemPromptFile: opts.appendSystemPromptFile,
    nowFn: opts.nowFn,
    logFn: opts.logFn,
    slashInjectWorks: opts.slashInjectWorks,
    pool,
    initialTarget: opts.initialTarget ?? {
      provider: "anthropic-plan",
      model: operativeSpawnConfig.model,
      effort: operativeSpawnConfig.effort ?? null
    },
    spawnFn,
    agentSdkAdapter: opts.agentSdkAdapter, // injectable (tests); production lazy-loads from disk
    secondaryAdapters: opts.secondaryAdapters,
    claudeDelegateAdapter: opts.claudeDelegateAdapter,
    dispatcher,
    executionModel,
    resolvedModelLib,
    primaryEngine,
    // The resolved primary adapter drives the operative session; Stage-B moves +
    // resume route through it (a non-claude primary is driven by its own adapter).
    operativeAdapter: primary.adapter,
    // S3b: the operative spawn config + injectable one-shot for web materialized turns.
    operativeSpawnConfig,
    oneShotFn: opts.oneShotFn ?? null,
    // S3c: injectable steering classifier (default lazy-loads the dispatcher steer-core).
    steer: opts.steer ?? null,
    // S3d: injectable clarity judge (default = phrasing short-circuit + wired dispatcher).
    clarity: opts.clarity ?? null,
  });
  gw.secrets = opts.secrets ?? null;
  return gw;
}
