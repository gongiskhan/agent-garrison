// gateway-routing.mjs — pre-session routing for the PTY gateway.
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
import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { MultiRuntimePool, ClaudeCodeAdapter, oneShotTurn, claudeProjectDirForCwd } from "@garrison/claude-pty";
import * as cards from "./autonomous-cards.mjs";
import { appendFeedback } from "./feedback-queue.mjs";
import {
  PERSONAL_SCOPE_LABEL,
  PERSONAL_SCOPE_TOKEN,
  resolveRunScope
} from "./project-source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function shouldUseEphemeralSession(channel) {
  return channel === "web" || channel === "garrison";
}

// ── per-turn run context (decision 2026-07-25-web-channel-run-context) ────────
//
// A channel may PIN a sparse `TurnRouting` intent (§2) onto one turn. The pin is
// honored here - on the resolved route, BEFORE the decision record and the plan
// selection - so it reaches the runtime lane and not merely the badge. Everything
// it cannot honor is RECORDED as a rejection with a reason from §7's list; a
// silently-dropped pin would render as a lie ("running on X" while X never ran).

// The effort vocabulary a channel may pin. MIRROR of `dutyEfforts`
// (src/lib/types.ts) - a fitting cannot import src/lib, so
// tests/gateway-run-context.test.ts pins the two lists equal against drift.
export const TURN_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Warm agent-sdk sessions held at once (§12). Keyed by target AND conversation,
// so the ceiling is what stops a busy day of web threads from accumulating SDK
// queries forever.
export const AGENT_SDK_SESSION_CAP = 8;

const FAILURE_TEXT_CAP = 1_000;
const FAILURE_ID_CAP = 200;
const FAILURE_KINDS = new Set([
  "authentication",
  "authorization",
  "billing",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "not_found",
  "limit",
  "execution",
  "runtime",
  "transport",
  "routing",
  "protocol",
  "permission",
  "unknown",
]);
const FAILURE_SOURCES = new Set([
  "assistant",
  "result",
  "runtime",
  "session",
  "transport",
  "system",
  "gateway",
  "web",
]);

function boundedFailureText(value, fallback = "Gateway turn failed.") {
  const text = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim();
  return (text || fallback).slice(0, FAILURE_TEXT_CAP);
}

function boundedFailureId(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)
    ? text.slice(0, FAILURE_ID_CAP)
    : fallback;
}

function failureKind(value, code, fallback = "unknown") {
  const direct = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (FAILURE_KINDS.has(direct)) return direct;
  const hint = `${direct} ${String(code ?? "")}`.toLowerCase();
  if (/oauth_org_not_allowed|authori[sz]|permission/.test(hint)) return "authorization";
  if (/auth/.test(hint)) return "authentication";
  if (/billing|budget/.test(hint)) return "billing";
  if (/rate.?limit/.test(hint)) return "rate_limit";
  if (/overload/.test(hint)) return "overloaded";
  if (/invalid.?request/.test(hint)) return "invalid_request";
  if (/not.?found/.test(hint)) return "not_found";
  if (/max_|limit|output.?tokens/.test(hint)) return "limit";
  if (/execution/.test(hint)) return "execution";
  if (/transport|network|upstream|timeout|econn/.test(hint)) return "transport";
  if (/route|target|scope/.test(hint)) return "routing";
  if (/protocol|frame|generation/.test(hint)) return "protocol";
  if (/runtime|subprocess|iterator|query|session/.test(hint)) return "runtime";
  return FAILURE_KINDS.has(fallback) ? fallback : "unknown";
}

/** Closed, bounded public failure vocabulary shared by runtime results and the
 * HTTP gateway lifecycle signal. Provider/private objects never cross this seam. */
export function normalizeFailureInfo(value, defaults = {}) {
  const outer = value && typeof value === "object" ? value : {};
  const raw = outer.failure && typeof outer.failure === "object" ? outer.failure : outer;
  const defaultCode = boundedFailureId(defaults.code, "gateway_turn_failed");
  const code = boundedFailureId(raw.code ?? outer.code, defaultCode);
  const kind = failureKind(raw.kind ?? outer.kind, code, defaults.kind ?? "unknown");
  const requestedSource = boundedFailureId(raw.source ?? outer.source, null);
  const defaultSource = boundedFailureId(defaults.source, "gateway");
  const source = FAILURE_SOURCES.has(requestedSource)
    ? requestedSource
    : FAILURE_SOURCES.has(defaultSource)
      ? defaultSource
      : "gateway";
  const text = boundedFailureText(
    raw.text ?? raw.message ?? outer.text ?? outer.message ?? (value instanceof Error ? value.message : value),
    defaults.text ?? "Gateway turn failed."
  );
  const status = raw.httpStatus ?? outer.httpStatus ?? outer.statusCode ?? outer.status;
  const statusRetryable = status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599);
  const out = {
    code,
    kind,
    source,
    text,
    retryable: typeof raw.retryable === "boolean"
      ? raw.retryable
      : typeof outer.retryable === "boolean"
        ? outer.retryable
        : defaults.retryable === true || statusRetryable,
  };
  if (Number.isInteger(status) && status >= 100 && status <= 599) out.httpStatus = status;
  const retryAt = raw.retryAt ?? outer.retryAt;
  if (typeof retryAt === "number" && Number.isFinite(retryAt) && retryAt > 0) out.retryAt = retryAt;
  const requestId = boundedFailureId(raw.requestId ?? raw.request_id ?? outer.requestId ?? outer.request_id, null);
  if (requestId) out.requestId = requestId;
  return out;
}

// Cache compatibility must change when the credential that will actually reach
// the SDK subprocess changes. The process-local HMAC key makes this a one-way,
// non-portable version marker: useful for equality inside this gateway process,
// useless as a credential oracle in logs, cache keys, or diagnostics.
const SDK_CREDENTIAL_FINGERPRINT_KEY = randomBytes(32);
const SDK_PROVIDER_VAULT_KEYS = {
  "zai-glm": "ZAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "llm-proxy": "LLM_PROXY_API_KEY",
};

export function effectiveAgentSdkCredentialVersion(target = {}, { secrets = null, env = {} } = {}) {
  const provider = String(target?.provider ?? "");
  const account = String(target?.account ?? "").trim();
  let source = "none";
  let credential = "";
  if (isAnthropicProviderId(provider)) {
    if (account) {
      source = `anthropic-account:${account}`;
      credential = String(secrets?.[`${ANTHROPIC_ACCOUNT_PREFIX}${account}`] ?? "missing");
    } else if (env?.GARRISON_ACCOUNT && env?.ANTHROPIC_AUTH_TOKEN) {
      source = `anthropic-inherited:${env.GARRISON_ACCOUNT}`;
      credential = String(env.ANTHROPIC_AUTH_TOKEN);
    } else {
      // Stored /login state is outside the materialized env and the warm cache;
      // a gateway restart is its lifecycle boundary.
      source = "anthropic-stored-login";
    }
  } else if (SDK_PROVIDER_VAULT_KEYS[provider]) {
    const vaultKey = SDK_PROVIDER_VAULT_KEYS[provider];
    source = `vault:${vaultKey}`;
    credential = String(secrets?.[vaultKey] ?? "missing");
  } else {
    source = `keyless:${provider || "unknown"}`;
  }
  return createHmac("sha256", SDK_CREDENTIAL_FINGERPRINT_KEY)
    .update(source)
    .update("\0")
    .update(credential)
    .digest("hex");
}

// The vault prefixes an account's secret is sealed under. MIRROR of
// src/lib/account-env.ts (same reason: no src/lib import from a fitting); the
// other two mirrors are orchestrator/lib/stage-b.mjs and
// agent-sdk-runtime/lib/providers.mjs.
const ANTHROPIC_ACCOUNT_PREFIX = "ANTHROPIC_ACCOUNT__";
const GENERIC_ACCOUNT_PREFIX = "ACCOUNT__";

// True when the provider sits on the Anthropic endpoint (subscription path). The
// runner spells the Max-plan provider "anthropic-plan"; the SDK spec key is
// "anthropic". Both, and an unset provider on a Claude target, are Anthropic.
function isAnthropicProviderId(provider) {
  const p = String(provider ?? "anthropic").trim();
  return p === "anthropic" || p === "anthropic-plan";
}

// The account PLATFORM that can actually authenticate this target, or null when a
// named account is meaningless for it. Pinning an Anthropic account onto an
// ollama endpoint changes nothing at the runtime (buildSdkEnv ignores
// target.account for a non-Anthropic provider), and codex/gemini read their own
// credential files - so those pins are refused instead of being shown as applied.
function accountPlatformForTarget(target) {
  const runtime = target?.runtime ?? null;
  if (runtime === "claude-code") return "anthropic";
  if (runtime === "agent-sdk") return isAnthropicProviderId(target?.provider) ? "anthropic" : null;
  if (runtime === "codex") return "openai";
  if (runtime === "gemini") return "google";
  // cursor authenticates with its OWN login (~/.config/cursor/auth.json) or a
  // CURSOR_API_KEY. There is no Cursor AccountPlatform, so a pin here would be a
  // badge with nothing behind it — refuse it explicitly rather than by fallthrough.
  if (runtime === "cursor") return null;
  // openai-agents is an endpoint family, so the account vehicle is the PROVIDER,
  // not the engine: `openai`/`openai-compat` authenticate with an OpenAI key,
  // `glm` with a self-hosted GLM key, `ollama-local` with nothing at all. Naming
  // the wrong platform here would offer a pin that injects a key the endpoint
  // rejects, so map only the providers that have a real platform behind them.
  if (runtime === "openai-agents") {
    const p = String(target?.provider ?? "").trim();
    if (p === "openai" || p === "openai-compat") return "openai";
    if (p === "glm") return "glm";
    return null; // ollama-local (keyless) / unset → no account vehicle
  }
  return null; // ollama-native, workflow, unknown → no account vehicle
}

// True when the target has a REAL effort control. agent-sdk marks `effort: false`
// for every non-Anthropic provider (providers.mjs SDK_PROVIDERS) and the gemini
// CLI has no effort control at all, so an effort pin there would be a badge with
// nothing behind it. claude-code applies `/effort`; codex applies it at exec.
// cursor is the same shape as gemini for a different reason: effort is baked into
// its MODEL IDS (gpt-5.3-codex-low vs -high), so the control is the model, not an
// effort flag — route to another Cursor model id instead of pinning effort.
export function effortControllable(target) {
  const runtime = target?.runtime ?? null;
  if (runtime === "gemini" || runtime === "cursor" || runtime === "ollama-native") return false;
  // openai-agents: every provider entry in its table declares `effort: false` —
  // plain chat_completions carries no reasoning-effort parameter, so the adapter
  // records the request and reports it unapplied. Never claim the control.
  if (runtime === "openai-agents") return false;
  if (runtime === "agent-sdk") return isAnthropicProviderId(target?.provider);
  return true;
}

// ── the materialized vault, read-only ────────────────────────────────────────
// The runner writes EVERY vault secret to <compositionDir>/.env (mode 0600,
// vault.ts materializeEnv) before it spawns the gateway, and wipes it on down.
// That file is the gateway's only view of the vault: it holds no master key and
// cannot call src/lib. Cached by (mtime, size) so a per-turn account lookup and a
// /route/options poll do not re-read it on every request.
let secretsCache = { file: null, mtimeMs: -1, size: -1, secrets: {} };

function parseDotenv(raw) {
  const out = {};
  for (const line of String(raw).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readMaterializedSecrets(compositionDir) {
  if (!compositionDir) return {};
  const file = path.join(compositionDir, ".env");
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return {}; // no materialized env (vault locked / composition down)
  }
  if (secretsCache.file === file && secretsCache.mtimeMs === st.mtimeMs && secretsCache.size === st.size) {
    return secretsCache.secrets;
  }
  let secrets = {};
  try {
    secrets = parseDotenv(fs.readFileSync(file, "utf8"));
  } catch {
    secrets = {}; // unreadable → behave exactly as vault-locked
  }
  secretsCache = { file, mtimeMs: st.mtimeMs, size: st.size, secrets };
  return secrets;
}

// The named accounts the vault actually holds, as {name, platform}. Anthropic
// keeps its original key shape; every other platform seals under
// ACCOUNT__<PLATFORM>__<name>.
export function listVaultAccounts(compositionDir) {
  const secrets = readMaterializedSecrets(compositionDir);
  const out = [];
  for (const key of Object.keys(secrets)) {
    if (key.startsWith(ANTHROPIC_ACCOUNT_PREFIX)) {
      const name = key.slice(ANTHROPIC_ACCOUNT_PREFIX.length);
      if (name) out.push({ name, platform: "anthropic" });
      continue;
    }
    if (key.startsWith(GENERIC_ACCOUNT_PREFIX)) {
      const rest = key.slice(GENERIC_ACCOUNT_PREFIX.length);
      const sep = rest.indexOf("__");
      if (sep <= 0) continue;
      const platform = rest.slice(0, sep).toLowerCase();
      const name = rest.slice(sep + 2);
      if (platform && platform !== "anthropic" && name) out.push({ name, platform });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// One account by name: {name, platform, token} or null when the vault has no
// secret for it (locked vault included - indistinguishable from absent here, and
// both mean "cannot honor this pin").
export function resolveVaultAccount(compositionDir, name) {
  const wanted = typeof name === "string" ? name.trim() : "";
  if (!wanted) return null;
  const secrets = readMaterializedSecrets(compositionDir);
  for (const account of listVaultAccounts(compositionDir)) {
    if (account.name !== wanted) continue;
    const key =
      account.platform === "anthropic"
        ? `${ANTHROPIC_ACCOUNT_PREFIX}${account.name}`
        : `${GENERIC_ACCOUNT_PREFIX}${account.platform.toUpperCase()}__${account.name}`;
    const token = secrets[key];
    return token ? { ...account, token } : null;
  }
  return null;
}

// The env block that pins a spawned Claude session to a named Anthropic account.
// MIRROR of src/lib/account-env.ts accountAuthEnv: ANTHROPIC_AUTH_TOKEN is
// authoritative (stored /login credentials beat CLAUDE_CODE_OAUTH_TOKEN but not
// this), CLAUDE_CODE_OAUTH_TOKEN covers credential-less config dirs, and
// ANTHROPIC_API_KEY is forced empty so an inherited key cannot outrank the token.
export function anthropicAccountEnv(name, token) {
  return {
    GARRISON_ACCOUNT: name,
    ANTHROPIC_AUTH_TOKEN: token,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    ANTHROPIC_API_KEY: ""
  };
}

/**
 * Overlay a pinned TurnRouting onto an already-resolved route (§7). Mutates
 * `route` (new target OBJECTS - never the config's own target records) and
 * returns what was honored and what was refused.
 *
 * `duty`/`level` are NOT handled here: a duty pin re-enters preRouteV4, which is
 * the lane the kanban engine already drives, so it produces a real duty cell
 * rather than a relabelled matrix route.
 *
 * @returns {{applied: string[], rejected: {field: string, reason: string}[],
 *            project: string|null, projectPath: string|null, account: string|null}}
 */
export function applyTurnOverride(config, route, ov, ctx = {}) {
  const applied = [];
  const rejected = [];
  const out = { applied, rejected, project: null, projectPath: null, account: null };
  if (!ov || typeof ov !== "object" || !route?.target) return out;

  // A named composition target picks runtime+provider+model COHERENTLY. There is
  // no model catalog anywhere in the repo, so offering runtime and model as
  // independent menus would invite invalid pairs (gemini + opus) - §2.
  if (ov.target) {
    const targets = Array.isArray(config?.targets) ? config.targets : [];
    const found = targets.find((t) => t && t.id === ov.target);
    if (!found) rejected.push({ field: "target", reason: "unknown-target" });
    else {
      route.target = { ...found };
      route.targetId = found.id;
      applied.push("target");
    }
  }
  // The typed escape hatch: overlay the model on the resolved target only.
  if (ov.model) {
    route.target = { ...route.target, model: ov.model };
    applied.push("model");
  }
  if (ov.effort) {
    if (!TURN_EFFORTS.includes(ov.effort)) {
      rejected.push({ field: "effort", reason: "effort-not-in-vocabulary" });
    } else if (!effortControllable(route.target)) {
      rejected.push({ field: "effort", reason: "provider-has-no-effort-control" });
    } else {
      route.target = { ...route.target, effort: ov.effort };
      applied.push("effort");
    }
  }
  // A project is a real execution scope (the turn's cwd), normally confined to a
  // git repo one level under the dev-root. The exact @personal token is the sole
  // exception and resolves server-side to $GARRISON_HOME/personal. Unresolvable
  // is a REJECTION: falling back while showing a scope badge is the exact lie §7
  // bans.
  if (ov.project) {
    const requestedScope = String(ov.project).trim();
    const resolve = typeof ctx.resolveProject === "function" ? ctx.resolveProject : resolveRunScope;
    const dir = resolve(ov.project);
    if (!dir) {
      rejected.push({
        field: "project",
        reason: requestedScope === PERSONAL_SCOPE_TOKEN
          ? "personal-workspace-unavailable"
          : "project-not-a-git-repo-under-dev-root"
      });
    }
    else {
      // Keep the reserved token internal. Attribution says "personal" while the
      // actual canonical path remains separately available as projectPath.
      out.project = requestedScope === PERSONAL_SCOPE_TOKEN ? PERSONAL_SCOPE_LABEL : requestedScope;
      out.projectPath = dir;
      // A DEFAULTED scope still resolves to a real cwd, but it is not a user
      // override and must not be attributed as one: `applied` is what sets
      // `via: "turn-override"`, and the improver treats that as Goncalo having
      // corrected the router. Counting Garrison's own fallback as his correction
      // would train the signal registry on evidence nobody produced.
      if (ov.projectDefaulted !== true) applied.push("project");
    }
  }
  if (ov.account) {
    const lookup = typeof ctx.resolveAccount === "function" ? ctx.resolveAccount : () => null;
    const account = lookup(ov.account);
    if (!account) {
      rejected.push({ field: "account", reason: "account-not-found-in-vault" });
    } else if (accountPlatformForTarget(route.target) !== account.platform) {
      rejected.push({ field: "account", reason: "account-platform-mismatch" });
    } else {
      route.target = { ...route.target, account: account.name };
      out.account = account.name;
      applied.push("account");
    }
  }
  if (applied.length) {
    route.via = "turn-override";
    route.ruleId = `override:${route.targetId ?? "target"}`;
  }
  return out;
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
    // A hyphenated engine name ("openai-agents") must not produce
    // GARRISON_OPENAI-AGENTS_DIR — that is not a legal shell identifier, so the
    // override could never be set and the escape hatch was silently dead.
    process.env[`GARRISON_${runtime.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_DIR`],
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

// Routing inference belongs to Orchestrator. Legacy composition manifests are
// migrated before this resolver is called.
export function resolveOrchestratorRoutingDir(compositionDir, requiredModule = "steer-core.mjs") {
  const candidates = [
    process.env.GARRISON_ORCHESTRATOR_DIR,
    compositionDir && path.join(compositionDir, "apm_modules", "_local", "orchestrator"),
    path.resolve(HERE, "..", "..", "..", "orchestrator")
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
// A dispatch invoker backed by a RUNTIME ADAPTER instead of garrison-call's HTTP
// wire shapes. garrison-call speaks Anthropic/OpenAI/Ollama over HTTP behind a
// base-URL fence, so it cannot reach a CLI engine at all: a composition whose only
// engine is a CLI (Cursor, Codex, …) would ALWAYS take the deterministic keyword
// fallback, with a low-confidence "call unavailable" reason on every dispatch.
//
// The dispatch prompt already demands a bare single-line JSON object (and carries
// its own example), so one adapter turn returning text is enough — parseDispatch
// extracts the object from it. `spec.shape`/`spec.provider` are HTTP concepts and
// are ignored here; `spec.maxTokens`/`spec.timeoutMs` cannot be honored by a CLI
// engine, so they are not silently claimed either. Each call is a fresh one-shot
// session: dispatch must never inherit or pollute conversational context.
export function makeAdapterCallInvoker(adapter, spawnConfig = {}, opts = {}) {
  if (!adapter) {
    return async () => ({ ok: false, code: "unavailable", error: "dispatch runtime adapter is unavailable" });
  }
  return async (spec) => {
    let session = null;
    let timer = null;
    let timedOut = false;
    let cancelPromise = null;
    let teardownPromise = null;
    const timeoutResult = { ok: false, code: "timeout", error: "dispatch inference timed out" };
    const cancel = () => {
      if (!session) return Promise.resolve();
      if (!cancelPromise) {
        cancelPromise = (async () => {
          try { await adapter.cancel?.(session); } catch { /* best effort */ }
        })();
      }
      return cancelPromise;
    };
    const cleanup = (cancelFirst) => {
      if (!session) return Promise.resolve();
      // Cancellation and teardown are tracked independently. A normal completion
      // may already have entered teardown when the timeout wins the race; in that
      // case a later cleanup(true) must still issue the missing cancellation.
      // Start cancellation first, but do not await it before invoking teardown:
      // an adapter with a wedged cancel must not retain the process forever.
      if (cancelFirst) void cancel();
      if (!teardownPromise) {
        teardownPromise = (async () => {
          try { await adapter.teardown?.(session); } catch { /* best effort */ }
        })();
      }
      return cancelFirst
        ? Promise.allSettled([cancel(), teardownPromise]).then(() => undefined)
        : teardownPromise;
    };
    const stopIfTimedOut = async () => {
      if (!timedOut) return false;
      await cleanup(true);
      return true;
    };
    const timeoutMs = Number.isFinite(spec?.timeoutMs)
      ? Math.max(1, spec.timeoutMs)
      : Number.isFinite(opts.timeoutMs) ? Math.max(1, opts.timeoutMs) : 8000;
    const run = (async () => {
      try {
        session = await adapter.spawn({
          ...spawnConfig,
          ...(spec?.model ? { model: spec.model } : {})
        });
        if (await stopIfTimedOut()) return timeoutResult;
        await adapter.awaitReady?.(session);
        if (await stopIfTimedOut()) return timeoutResult;
        await adapter.sendTurn(session, spec?.prompt ?? "");
        if (await stopIfTimedOut()) return timeoutResult;
        const out = await adapter.awaitResponse(session);
        if (await stopIfTimedOut()) return timeoutResult;
        return { ok: true, text: out?.text ?? "" };
      } catch (err) {
        return { ok: false, code: "call-failed", error: `dispatch adapter failed: ${err?.message || String(err)}` };
      } finally {
        // On a late spawn this is the only owner still alive after Promise.race;
        // it observes the timeout flag and guarantees cancel + teardown.
        if (session) await cleanup(timedOut);
      }
    })();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([run, timeout]);
    if (result?.code === "timeout") {
      timedOut = true;
      // The inference deadline is a caller-visible bound. Cleanup begins now,
      // but a wedged adapter cannot extend the eight-second response contract.
      if (session) void cleanup(true);
      // Observe a late failure/settlement after the bounded caller has returned.
      run.catch(() => {});
    }
    if (timer) clearTimeout(timer);
    return result;
  };
}

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

function dispatcherCallOpts(executionModel, resolvedLib, inferenceConfig = {}) {
  const route = resolvedLib?.executionRouteFor?.({ duty: "dispatch", level: 1 }, executionModel);
  const target = route?.target ?? {};
  const provider = target.provider ?? "anthropic";
  const shape = target.shape ?? (
    provider === "ollama-local" ? "ollama" :
      ["openai", "deepseek", "zai-glm"].includes(provider) ? "openai" : "anthropic"
  );
  return {
    runtime: target.runtime ?? null,
    shape,
    provider: provider === "anthropic-plan" ? "anthropic" : provider,
    model: target.model ?? "claude-haiku-4-5",
    authMode: target.authMode ?? "subscription",
    promptMode: target.promptMode ?? "lean",
    maxTurns: 1,
    maxTokens: Number.isFinite(inferenceConfig.maxTokens)
      ? inferenceConfig.maxTokens
      : Number.isFinite(target.maxTokens) ? target.maxTokens : 256,
    timeoutMs: Number.isFinite(inferenceConfig.timeoutMs)
      ? inferenceConfig.timeoutMs
      : Number.isFinite(target.timeoutMs) ? target.timeoutMs : 8000,
    ...(typeof inferenceConfig.clarityRubric === "string" && inferenceConfig.clarityRubric.trim()
      ? { clarityRubric: inferenceConfig.clarityRubric.trim() }
      : {})
  };
}

export async function buildProductionDispatcher({
  compositionDir,
  compositionId,
  executionModel,
  resolvedLib,
  decisionsFile,
  agentSdkAdapter = null,
  primaryAdapter = null,
  primaryEngine = null,
  inferenceConfig = {}
} = {}) {
  const model = resolvedLib?.dispatcherModelFrom?.(executionModel);
  if (!model || !model.duties?.dispatch) return null;
  const dispatcherDir = resolveOrchestratorRoutingDir(compositionDir, "dispatch-core.mjs");
  if (!dispatcherDir) return null;
  const core = await import(pathToFileURL(path.join(dispatcherDir, "lib", "dispatch-core.mjs")).href);
  const callOpts = dispatcherCallOpts(executionModel, resolvedLib, inferenceConfig);
  let adapter = null;
  if (callOpts.runtime === "agent-sdk") {
    adapter = agentSdkAdapter;
    if (!adapter && primaryEngine === "agent-sdk") adapter = primaryAdapter;
    if (!adapter) {
      const dir = resolveAgentSdkDir(compositionDir);
      if (dir) {
        const mod = await import(pathToFileURL(path.join(dir, "lib", "agent-sdk-adapter.mjs")).href);
        adapter = new mod.AgentSdkAdapter();
      }
    }
  } else if (callOpts.runtime && callOpts.runtime === primaryEngine) {
    adapter = primaryAdapter;
  }

  const spawnConfig = {
    compositionDir,
    env: process.env,
    provider: callOpts.provider,
    model: callOpts.model,
    effort: "low",
    thinking: { type: "disabled" },
    authMode: callOpts.authMode,
    promptMode: "lean",
    maxTurns: 1,
    allowedTools: [],
    permissionMode: "bypassPermissions"
  };
  return {
    core,
    // Re-read at call time when possible so a runner projection refresh is seen
    // without restarting the gateway; the static model is the safe fallback.
    model: () =>
      resolvedLib?.dispatcherModelFrom?.(
        resolvedLib.loadResolvedModel?.(undefined, compositionId ?? null)
      ) ?? model,
    call: makeAdapterCallInvoker(adapter, spawnConfig, { timeoutMs: callOpts.timeoutMs }),
    evidenceFile: decisionsFile,
    callOpts: {
      ...callOpts,
      fallback: core.deterministicFallbackDispatch
    },
    configuredCall: adapter ? `${callOpts.runtime}-adapter` : "deterministic-fallback"
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

// The autonomy consult, compressed for the decision log (§7.5). The decisions
// file is the record someone reads back to ask "why did it do that without
// asking me?", so it carries the BAND PER CATEGORY, the confidence behind each,
// and whether the number leaned on the cold-start seed rather than on anything
// the user actually said. Confidence is rounded because four decimals of a
// derived ratio is false precision in a log a human reads.
//
// `deferred` is the v1 digest: a question that was real but not required, which
// the day's budget sent away unasked. Recording it is the whole digest for now -
// the alternative is a question silently evaporating, which is how a rate limit
// turns into amnesia.
export function autonomyDecisionRecord(autonomy) {
  if (!autonomy || typeof autonomy !== "object") return null;
  const bands = {};
  for (const [category, d] of Object.entries(autonomy.decisions ?? {})) {
    bands[category] = {
      band: d.band,
      confidence: Math.round((Number(d.confidence) || 0) * 1000) / 1000,
      observations: d.observations ?? 0
    };
  }
  return {
    band: autonomy.band,
    shape: autonomy.shape ?? null,
    bands,
    seeded: autonomy.seeded === true,
    ...(autonomy.ask ? { asked: true, reason: autonomy.reason ?? null } : {}),
    ...(!autonomy.ask && autonomy.informational ? { informed: true, reason: autonomy.reason ?? null } : {}),
    ...(autonomy.deferred ? { deferred: true, reason: autonomy.deferred } : {})
  };
}

// Whether a routed turn must be HELD, and the list it resumes onto (§7.1).
//
// Pure, and separate from the lane that acts on it, because the interesting half
// of this rule is the one that is easiest to get wrong: a QUICK turn - the
// trivial-plan work the gateway runs inline - is held exactly like a significant
// one. A board-side hold cannot help a turn that never reaches the board, so an
// ask band on a quick turn means "do not run it inline, card it and wait", not
// "quick work is too small to ask about". Whether the router should ask is a
// property of the shape's track record, never of how big the job looked.
//
// `resumeList` is where the card goes when the go arrives: the list the turn
// would have started on had the band allowed it.
export function autonomyHoldPlan(autonomy, { significant = false, sequence = null, targetList = null } = {}) {
  if (!autonomy || autonomy.ask !== true) return { hold: false, resumeList: null };
  const first = Array.isArray(sequence) && sequence.length ? sequence[0] : null;
  return {
    hold: true,
    resumeList: significant ? targetList ?? first ?? "plan" : first ?? "implement"
  };
}

// The route a HELD card is currently proposing, and whether a correction changed
// it (§7.1, 2026-08-13).
//
// A hold is stamped into `autonomyAsk` at create time, and `autonomyAsk` is NOT a
// patchable card field - the board's PATCH accepts the run spec (`routing`) and
// engine-only `dutyLevels`, nothing else routing-shaped. So a correction lands on
// `routing`, and this reader states the precedence once: a run spec on a HELD card
// is always fresher than the ask that created it, because a card carrying a human
// pin never reaches the autonomy consult in the first place (preRoute exempts a
// pinned turn), so the only way a held card can carry `routing.duty` is a
// correction that re-stamped it.
//
// Pure. `corrected` is what lets the go branch stay byte-identical on an
// uncorrected card: false means every field below came from exactly where it came
// from before this seam existed.
export function heldCardRoute(card) {
  const ask = card?.autonomyAsk && typeof card.autonomyAsk === "object" ? card.autonomyAsk : {};
  const routing = card?.routing && typeof card.routing === "object" && !Array.isArray(card.routing) ? card.routing : {};
  const corrected = typeof routing.duty === "string" && routing.duty.trim().length > 0;
  return {
    corrected,
    flow: (corrected ? routing.flow : null) ?? ask.flow ?? card?.flow ?? null,
    duty: (corrected ? routing.duty : null) ?? ask.duty ?? card?.duty ?? null,
    level: corrected && Number.isInteger(routing.level)
      ? routing.level
      : Number.isInteger(ask.level) ? ask.level : card?.level ?? null,
    tier: (corrected ? routing.tier : null) ?? ask.tier ?? card?.tier ?? null,
    decisionId: ask.decisionId ?? null,
    resumeList: typeof ask.resumeList === "string" && ask.resumeList ? ask.resumeList : null
  };
}

// Re-stamp a HELD card's routing on the board: an engine-context PATCH of the run
// spec, with the same rev-refresh retry every other write in this layer uses.
//
// Deliberately NOT a list move. Moving a held card is what RELEASES the hold (the
// board clears autonomyHeld inside the same CAS as the move), and a correction
// must leave the card exactly as held as it found it - the user corrected the
// route, they did not say go.
//
// `dutyLevels` rides along only when the caller has verified it raises nothing
// down: the board enforces raise-only at the storage boundary and answers a lower
// with a 400 that would take the whole re-stamp with it.
//
// Injectable `fetchImpl` so the seam is testable without a live board; the caller
// supplies `base` (from the board's status file, never a hardcoded port).
export async function patchHeldCardRouting({ base, id, routing, dutyLevels = null, fetchImpl = fetch, logFn = () => {} }) {
  if (!base || !id) return { ok: false, error: "board unavailable" };
  if (!routing || typeof routing !== "object") return { ok: false, error: "routing is required" };
  let lastError = "board PATCH failed";
  for (let attempt = 0; attempt < 3; attempt++) {
    let rev = 0;
    try {
      const fresh = await fetchImpl(`${base}/cards/${encodeURIComponent(id)}`);
      if (fresh.ok) {
        const doc = await fresh.json();
        rev = doc.card?.rev ?? doc.rev ?? 0;
      }
    } catch { /* fall through with rev 0 */ }
    const patched = await fetchImpl(`${base}/cards/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
      body: JSON.stringify({ routing, ...(dutyLevels ? { dutyLevels } : {}), rev })
    });
    if (patched.ok) {
      const doc = await patched.json().catch(() => null);
      logFn({ kind: "held-card-rerouted", id, routing });
      return { ok: true, card: doc?.card ?? null };
    }
    // Only a 409 ("the card changed under you") is worth another attempt; a
    // refusal is final and must never be retried into the same refusal.
    if (patched.status !== 409) {
      const body = await patched.json().catch(() => null);
      lastError = body?.message || body?.error || `board PATCH ${patched.status}`;
      break;
    }
    lastError = "card changed under the correction";
    await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
  }
  logFn({ kind: "held-card-reroute-failed", id, error: lastError });
  return { ok: false, error: lastError };
}

// The subset of a resolved `dutyLevels` map that is safe to send with a re-stamp:
// every entry the card does not already hold at a HIGHER level. The board refuses
// a lower with a 400, and a correction that re-routes DOWN (image L2 -> discuss
// L1, the incident) is the common case, so filtering here is what keeps the run
// spec landing instead of the whole PATCH bouncing. Returns null when nothing
// survives - the run spec alone is still the correction.
export function raisableDutyLevels(next, held) {
  if (!next || typeof next !== "object") return null;
  const current = held && typeof held === "object" && !Array.isArray(held) ? held : {};
  const out = {};
  for (const [duty, level] of Object.entries(next)) {
    if (!Number.isInteger(level)) continue;
    const have = current[duty];
    if (Number.isInteger(have) && level < have) continue;
    out[duty] = level;
  }
  return Object.keys(out).length ? out : null;
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
    // Retired flow name -> the flow that absorbed it, published for the HTTP edge
    // (sanitizeRouting runs per request and cannot await the level chain). Filled
    // by _levelChain(); empty until then, which simply means an inbound retired
    // name is refused as out-of-vocabulary exactly as it was before.
    this.flowAliases = {};
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
    // Per-lane turn queues (2026-08-07): a warm session is ONE conversation, so
    // turns on the same session key serialize on its own chain - and nothing
    // else. The PTY-era GLOBAL chain lived in gateway-pty's enqueueTurn and made
    // every lane wait for every other lane's turn; three run-killing
    // starvations in one week came from exactly that.
    this._laneQueues = new Map();
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
    this._legacyClassifierEnabled = opts.legacyClassifierEnabled ?? !this._dispatcher;
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
    // Run-context (2026-07-25) seams. secrets/secretsFn is the materialized vault
    // (createRoutedGateway assigns them); the two resolvers back a per-turn
    // project/account pin and default to the real dev-root + vault readers, so a
    // test can honor or refuse a pin without a repo on disk or an unlocked vault.
    this.secrets = opts.secrets ?? null;
    this.secretsFn = opts.secretsFn ?? null;
    this._projectResolver = opts.resolveProject ?? null;
    this._accountResolver = opts.resolveAccount ?? null;
    // Injectable board-cards lib (tests) - resolveThreadCard uses it; null =
    // the real autonomous-cards module.
    this._cardsLib = opts.cardsLib ?? null;
    // Injectable board base URL (tests). Null = discover it from the kanban-loop
    // status file, which is the only production path.
    this._boardBaseOverride = opts.boardBase ?? null;
  }

  async start() {
    await this.pool.start();
    this.operative = await this.pool.checkout(this.operativeRuntimeId);
    if (this._legacyClassifierEnabled) {
      this.classifier = await this.pool.checkout(this.classifierRuntimeId);
    }
    this.logFn({
      kind: "routing-started",
      operative: this.operative.id,
      classifier: this.classifier?.id ?? null,
      routing: this._dispatcher ? "orchestrator-dispatch" : "legacy-stage-a"
    });
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

  // Serialize `fn` on the named lane's promise chain. A lane is one execution
  // resource that cannot interleave turns (a warm SDK session, a cwd-keyed
  // delegate); turns on DIFFERENT lanes run concurrently. The chain entry is
  // removed once its tail settles so an idle lane holds no memory.
  _onLane(laneKey, fn) {
    // Lazy: callers exercised via partial test doubles may bypass the constructor.
    const queues = (this._laneQueues ??= new Map());
    const previous = queues.get(laneKey) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    queues.set(laneKey, tail);
    tail.then(() => {
      if (queues.get(laneKey) === tail) {
        queues.delete(laneKey);
        // Session insertion may temporarily overflow the SDK LRU when every
        // candidate is active/queued. The first lane to become genuinely idle
        // re-runs trimming; fire-and-observe so cleanup never changes the turn's
        // already-settled result.
        if (laneKey.startsWith("sdk:")) {
          Promise.resolve(this._retireStaleAgentSdkSessions?.(this._agentSdkAdapter))
            .then(() => this._evictAgentSdkSessions?.(this._agentSdkAdapter))
            .catch(() => {});
        }
      }
    });
    return run;
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
  // per {provider,model,promptMode} + CONVERSATION, reused across turns (SDK resume).
  //
  // opts (all optional, additive - every existing 3-arg caller is unchanged):
  //   sessionKey    - the conversation identity (§12). Without it two web threads
  //                   on the same target share ONE SDK session and one session_id,
  //                   so the per-message transcript badge would point at the wrong
  //                   conversation.
  //   coldStartContext - caller-owned durable conversation seed. Applied only when
  //                   this call actually spawns a new SDK session; a warm standing
  //                   Query already owns its history and must not receive it twice.
  //   resumeSessionId - previously persisted SDK journal identity, already checked
  //                   against the resolved route/account/project by the HTTP edge.
  //                   Honored only for a cold standing session with no live owner.
  //   forceNewSession - durable host-recovery boundary. Retires a same-thread warm
  //                   Query and ignores resume so coldStartContext seeds a new one.
  //   onEvent(event) - channel-neutral structured session event observer.
  //   turnId         - caller-owned stable turn identity attached by the adapter.
  //   generationId   - caller-owned permission-control generation identity.
  //   permissionMode - trusted SDK mode override; omitted remains bypass.
  //   streamingInput - explicit streamed-Web opt-in. Requires sessionKey and
  //                   keeps one SDK Query open across settled input boundaries.
  //   onPermissionRequest(request,{signal}) - resolves one SDK tool prompt.
  //   onActivity({kind,name,id}) - tool_use liveness (the `activity` SSE frame).
  //   registerStop(stop)         - hands the caller a real cancel primitive for
  //                   THIS turn's session (adapter.cancel aborts the stashed query).
  //   registerRecoveryReset(reset) - host-restart-only abandonment primitive;
  //                   closes/tombstones this journal before FIFO promotion.
  async runAgentSdkTurn(route, message, onChunk, opts = {}) {
    const adapter = await this.getAgentSdkAdapter();
    const t = route.target;
    // Match the runtime fitting + adapter defaults when the target editor leaves
    // these controls at "runtime default". Falling back to lean/4 here silently
    // stripped CLAUDE.md, skills and tools from otherwise agentic targets even
    // though AgentSdkAdapter itself defaults to the full harness and 12 turns.
    const promptMode = t.promptMode ?? "full";
    const requestedEffort = t.effort ?? null;
    const sessionKey = typeof opts.sessionKey === "string" && opts.sessionKey ? opts.sessionKey : null;
    const generationId = typeof opts.generationId === "string" ? opts.generationId.trim() : "";
    const coldStartContext =
      typeof opts.coldStartContext === "string" && opts.coldStartContext.trim()
        ? opts.coldStartContext.trim()
        : "";
    // A standing Query has a long-lived control callback and therefore requires
    // a stable conversation coordinate. Threadless/one-shot callers remain on the
    // historical string-prompt path even if they accidentally pass the flag.
    if (opts.streamingInput === true && sessionKey !== null && !generationId) {
      throw new Error("standing Agent SDK streaming input requires a generation id");
    }
    const streamingInput = opts.streamingInput === true && sessionKey !== null && Boolean(generationId);
    const forceNewSession = streamingInput && opts.forceNewSession === true;
    let requestedResumeSessionId =
      streamingInput &&
      !forceNewSession &&
      typeof opts.resumeSessionId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(opts.resumeSessionId)
        ? opts.resumeSessionId
        : "";
    const spawnArgs = {
      provider: t.provider,
      model: t.model,
      effort: requestedEffort,
      promptMode,
      leanPrompt: t.leanPrompt,
      baseUrl: t.baseUrl,
      // cwd, most specific first: a PINNED PROJECT for this turn (§8 - the turn
      // really runs in that repo, which is what the project badge asserts), else
      // the shared build workspace when set, else the composition dir.
      // spawnArgs feeds the warm-session cache key below, so two projects
      // correctly get two sessions instead of silently sharing one cwd.
      compositionDir: opts.cwd ?? this.buildWorkspace ?? this.compositionDir,
      disallowedTools: t.disallowedTools,
      allowedTools: t.allowedTools,
      maxTurns: t.maxTurns ?? 12,
      budgetTokens: t.budgetTokens ?? null,
      // The named account this target (or this turn's override) runs under.
      // buildSdkEnv already resolves it into ANTHROPIC_AUTH_TOKEN off the
      // materialized vault - until now nothing ever passed it, so a target with
      // an account silently rode the process-wide pin.
      account: t.account ?? null,
      secrets: this.resolveSecrets(),
      // Inherit the gateway process env (PATH/HOME/CLAUDE_CONFIG_DIR + the
      // Paymaster account pin) — the SDK replaces the subprocess env, so an
      // empty baseEnv would strip config-dir isolation and the account token.
      env: process.env,
      permissionMode: opts.permissionMode ?? "bypassPermissions",
      ...(streamingInput ? { streamingInput: true } : {}),
    };
    // Every target-owned execution knob participates in session identity. A live
    // manifest edit from lean → full (or maxTurns/tool-policy changes) must spawn
    // a session with the new harness instead of reusing an incompatible warm one.
    // env/secrets are excluded: the whole process env would bloat the key and
    // change on any unrelated env mutation, needlessly churning warm sessions.
    // sessionKey adds the CONVERSATION (§12) so two threads never share one SDK
    // session - and therefore never report each other's session_id/transcript.
    const compatibility = {
      targetId: route.targetId,
      sessionKey,
      ...spawnArgs,
      secrets: undefined,
      env: undefined,
    };
    const compatibilityKey = JSON.stringify(compatibility);
    // Effort configures the standing Query but is deliberately NOT logical
    // conversation identity. A change closes the idle Query and resumes its same
    // journal with a fresh Query rather than cold-materializing the Web history.
    const effortCompatibility = { ...compatibility, effort: undefined };
    const effortCompatibilityKey = JSON.stringify(effortCompatibility);
    const credentialVersion = effectiveAgentSdkCredentialVersion(t, {
      secrets: spawnArgs.secrets,
      env: spawnArgs.env,
    });
    const key = JSON.stringify({ ...compatibility, credentialVersion });
    // A standing conversation keeps ONE lane even while its effort or resolved
    // spawn signature changes. That makes closing the previous idle Query and
    // opening its successor atomic; distinct Web conversations still run in
    // parallel. Historical/threadless calls retain their exact cache-key lane.
    const laneKey = streamingInput && sessionKey
      ? `sdk:conversation:${JSON.stringify(sessionKey)}`
      : `sdk:${key}`;
    return this._onLane(laneKey, async () => {
    let session = this._agentSdkSessions.get(key);
    let spawnedSession = false;
    let spawnedFromResume = false;
    let effortRotated = false;
    if (forceNewSession) {
      // A signature/recovery boundary applies to the logical conversation, not
      // merely the NEW cache key. Close every same-thread standing Query while
      // this conversation lane proves they are idle, then start without resume.
      for (const [candidateKey, candidate] of [...this._agentSdkSessions]) {
        const meta = this._agentSdkSessionMeta?.get(candidateKey);
        if (meta?.sessionKey !== sessionKey) continue;
        await this._releaseAgentSdkSession(adapter, candidateKey, candidate, "generation-reset", { strict: true });
      }
      session = null;
      requestedResumeSessionId = "";
    } else if ((!session || session.alive === false) && streamingInput) {
      const effortSibling = [...this._agentSdkSessions.entries()].find(([candidateKey, candidate]) => {
        if (candidateKey === key || candidate?.alive === false) return false;
        const meta = this._agentSdkSessionMeta?.get(candidateKey);
        return meta?.effortCompatibilityKey === effortCompatibilityKey &&
          meta?.credentialVersion === credentialVersion &&
          meta?.requestedEffort !== requestedEffort;
      });
      if (effortSibling) {
        const [candidateKey, candidate] = effortSibling;
        const journalId = typeof candidate?.sessionId === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate.sessionId)
          ? candidate.sessionId
          : "";
        if (!journalId) {
          const error = new Error("Agent SDK effort change cannot resume: the standing Query has no journal identity");
          error.code = "agent_sdk_effort_resume_unavailable";
          error.kind = "runtime";
          error.source = "gateway";
          error.retryable = false;
          throw error;
        }
        // _onLane above proves the old Query is idle. Await teardown completely
        // before native resume so two live Queries never own one journal.
        await this._releaseAgentSdkSession(adapter, candidateKey, candidate, "effort-rotated", { strict: true });
        requestedResumeSessionId = journalId;
        effortRotated = true;
      }
    }
    if (!session || session.alive === false) {
      // Never open two standing Queries on one SDK journal. This is especially
      // important during an in-process credential rotation: the old cache entry
      // may still be alive even though the new credential has a different key.
      const resumeOwnedByAnotherLiveSession = requestedResumeSessionId
        ? [...this._agentSdkSessions.entries()].some(([candidateKey, candidate]) =>
            candidateKey !== key &&
            candidate?.alive !== false &&
            candidate?.sessionId === requestedResumeSessionId)
        : false;
      const resumeIsStillReleasing = requestedResumeSessionId
        ? this._releasingAgentSdkSessionIds?.has(requestedResumeSessionId) === true
        : false;
      const resumeWasRecoveryAbandoned = requestedResumeSessionId
        ? this._abandonedAgentSdkSessionIds?.has(requestedResumeSessionId) === true
        : false;
      const resumeSessionId = resumeOwnedByAnotherLiveSession || resumeIsStillReleasing || resumeWasRecoveryAbandoned
        ? ""
        : requestedResumeSessionId;
      session = await adapter.spawn(resumeSessionId ? { ...spawnArgs, sessionId: resumeSessionId } : spawnArgs);
      spawnedSession = true;
      // An adapter that ignores the candidate did not resume. Preserve the cold
      // materialized fallback instead of silently dropping all prior context.
      spawnedFromResume = Boolean(resumeSessionId && session?.sessionId === resumeSessionId);
      if (effortRotated && !spawnedFromResume) {
        await adapter?.teardown?.(session);
        if (session) session.alive = false;
        const error = new Error("Agent SDK effort change was not resumed by the runtime");
        error.code = "agent_sdk_effort_resume_refused";
        error.kind = "runtime";
        error.source = "gateway";
        error.retryable = false;
        throw error;
      }
      if (requestedResumeSessionId && !spawnedFromResume) {
        this.logFn({
          kind: "agent-sdk-resume-refused",
          reason: resumeWasRecoveryAbandoned
            ? "session-abandoned-after-host-recovery"
            : resumeOwnedByAnotherLiveSession || resumeIsStillReleasing
              ? "session-owned-by-live-or-releasing-cache-entry"
              : "adapter-did-not-accept-session",
          target: route.targetId,
        });
      }
    }
    // Re-insert so Map iteration order is least-recently-used first (see
    // _evictAgentSdkSessions: keying by conversation multiplies live sessions by
    // thread count, so the map needs a real cap).
    this._agentSdkSessions.delete(key);
    this._agentSdkSessions.set(key, session);
    (this._agentSdkSessionMeta ??= new Map()).set(key, {
      compatibilityKey,
      effortCompatibilityKey,
      credentialVersion,
      requestedEffort,
      sessionKey,
      laneKey,
    });
    (this._currentAgentSdkKeyByCompatibility ??= new Map()).set(compatibilityKey, key);
    await this._retireStaleAgentSdkSessions(adapter);
    await this._evictAgentSdkSessions(adapter);
    if (typeof opts.registerRecoveryReset === "function") {
      // Host recovery means the durable transcript and this SDK journal diverged:
      // this turn may already have entered the journal before its SSE owner died.
      // Hold the generation claim until the Query is closed, and tombstone both
      // the requested and provider-refined ids so the next turn cold-materializes.
      opts.registerRecoveryReset(async () => {
        const abandoned = (this._abandonedAgentSdkSessionIds ??= new Set());
        for (const candidate of [requestedResumeSessionId, session?.sessionId]) {
          if (typeof candidate !== "string" || !candidate) continue;
          abandoned.delete(candidate);
          abandoned.add(candidate);
        }
        while (abandoned.size > 1_024) abandoned.delete(abandoned.values().next().value);
        const cached = this._agentSdkSessions.get(key);
        if (cached) {
          await this._releaseAgentSdkSession(adapter, key, cached, "recovery-abandoned");
        } else if (session?.alive !== false) {
          await adapter?.teardown?.(session);
          session.alive = false;
        }
      });
    }
    if (typeof opts.registerStop === "function") {
      // Bind the cancel to THIS turn's session (the warm session is reused, so a
      // stop captured from an earlier turn would abort the wrong query).
      opts.registerStop(() => adapter.cancel?.(session) ?? false);
    }
    const sessionDisposition = spawnedFromResume ? "resumed" : spawnedSession ? "new" : "warm";
    let sessionEpoch = Number.isSafeInteger(opts.routeSession?.epoch) && opts.routeSession.epoch >= 1
      ? opts.routeSession.epoch
      : null;
    let sessionBoundaryReason = typeof opts.routeSession?.boundaryReason === "string"
      ? opts.routeSession.boundaryReason
      : null;
    // A matching durable hint expected warm/native-resume. If neither was
    // possible, make the unavoidable cold boundary explicit and advance its
    // epoch instead of pretending continuity.
    if (sessionDisposition === "new" && opts.routeSession?.hadPrior === true && sessionBoundaryReason === null) {
      sessionEpoch = sessionEpoch === null ? null : sessionEpoch + 1;
      sessionBoundaryReason = "resume-unavailable";
    }
    let lastRouteObservation = null;
    const routeObservation = (extra = {}) => {
      if (typeof opts.onRouteSession !== "function") return;
      const observation = {
        sessionDisposition,
        sessionBoundaryReason,
        sessionEpoch,
        spawnSignature: opts.routeSession?.signature ?? null,
        model: session?.observedModel ?? t.model ?? null,
        sessionId: session?.sessionId ?? null,
        ...extra,
      };
      const signature = JSON.stringify(observation);
      if (signature === lastRouteObservation) return;
      lastRouteObservation = signature;
      try {
        opts.onRouteSession(observation);
      } catch {
        /* route observability must never break a turn */
      }
    };
    this.logFn({
      kind: "runtime-turn",
      runtime: "agent-sdk",
      provider: t.provider,
      model: t.model,
      promptMode: session.harness?.promptMode,
      authMode: t.authMode ?? null,
      target: route.targetId,
      conversation: sessionDisposition,
    });
    await adapter.awaitReady(session);
    // Runtime selection is known before journal reporting or input admission.
    routeObservation();
    // A resumed SDK session is known before sendTurn; a fresh session is only
    // announced by the SDK's first system frame. One reporter covers both timing
    // paths and de-duplicates the warm session's later system announcement.
    let reportedJournalSessionId = null;
    const reportJournalSession = (value) => {
      const sessionId = typeof value === "string" ? value.trim() : "";
      if (!sessionId || sessionId === reportedJournalSessionId || typeof opts.onJournal !== "function") return;
      reportedJournalSessionId = sessionId;
      try {
        routeObservation({ sessionId });
        opts.onJournal({
          session_id: sessionId,
          transcript_path: this.claudeTranscriptPathFor(spawnArgs.compositionDir, sessionId)
        });
      } catch {
        /* an observability sink must never break a turn */
      }
    };
    reportJournalSession(session.sessionId);
    if (requestedEffort != null && typeof adapter.setEffort === "function") {
      await adapter.setEffort(session, requestedEffort);
    }
    // §12 liveness: the SDK's structured stream already yields one text block at a
    // time, so the reply can grow in the channel instead of arriving as a blob
    // minutes later. onText hands the ACCUMULATED text, which is exactly the
    // onChunk(text, replace=true) contract. tool_use becomes an `activity` frame.
    let terminalStatus = null;
    let failure = null;
    let fallbackModel = null;
    const deferredTerminalEvents = [];
    const observeSessionEvent = (event) => {
      for (const block of Array.isArray(event?.blocks) ? event.blocks : []) {
        if (block?.type === "error") failure = normalizeFailureInfo(block, { source: "runtime", kind: "runtime" });
        if (block?.type === "turn_end" && typeof block.status === "string") terminalStatus = block.status;
        if (block?.type === "retry" && block.kind === "model_fallback" && typeof block.toModel === "string") {
          // A provider refusal fallback is an intra-request retry. Disclose the
          // model that actually answered, but keep the pre-runtime Query config
          // as this epoch's durable spawn signature.
          fallbackModel = block.toModel;
          routeObservation({ model: block.toModel });
        }
      }
      if (typeof event?.sessionId === "string") routeObservation({ sessionId: event.sessionId });
      const isTerminal = Array.isArray(event?.blocks) && event.blocks.some((block) => block?.type === "turn_end");
      if (isTerminal) deferredTerminalEvents.push(event);
      else opts.onEvent?.(event);
    };
    const flushTerminalEvents = (finalAttribution = {}) => {
      routeObservation(finalAttribution);
      for (const event of deferredTerminalEvents.splice(0)) opts.onEvent?.(event);
    };
    const captureRuntimeOutcome = (value) => {
      if (typeof value?.terminalStatus === "string") terminalStatus = value.terminalStatus;
      if (value?.failure && typeof value.failure === "object") failure = value.failure;
    };
    const runtimeAttribution = (value) => ({
      model: value?.model ?? fallbackModel ?? session?.observedModel ?? t.model ?? null,
      sessionId: value?.sessionId ?? session?.sessionId ?? null,
    });
    const streamHooks = {
      // Keep the callback and turn identity byte-for-byte as supplied. The runtime
      // adapter owns the canonical event vocabulary; the gateway is only a
      // transport boundary and must not reshape channel-neutral events.
      // Hold a canonical turn_end only until final runtime attribution has been
      // observed. The route revision is then guaranteed to precede terminal.
      onEvent: typeof opts.onRouteSession === "function"
        ? observeSessionEvent
        : opts.onEvent,
      turnId: opts.turnId,
      generationId: opts.generationId,
      onPermissionRequest: opts.onPermissionRequest,
      onSession: reportJournalSession,
      onText: onChunk ? (text) => onChunk(text, true) : undefined,
      onTool: typeof opts.onActivity === "function" ? (tool) => opts.onActivity({ kind: "tool", ...tool }) : undefined,
      // Extended thinking is where a turn spends its silent minutes, so it is the
      // single most useful liveness signal - without it a reasoning phase is
      // indistinguishable from a hung channel. Only the TAIL is forwarded: the
      // hint slot shows one line, and shipping whole reasoning transcripts over
      // the wire would be both noisy and a disclosure the user did not ask for.
      onThinking:
        typeof opts.onActivity === "function"
          ? (text) => {
              const line = String(text ?? "")
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean)
                .pop();
              opts.onActivity({ kind: "thinking", text: line ? line.slice(0, 160) : "" });
            }
          : undefined
    };
    const coldSessionMessage = coldStartContext
      ? `${coldStartContext}\n\n---\n\n${message}`
      : message;
    // Native resume loads the persisted SDK transcript, so adding the Web's
    // materialized history would duplicate every prior turn. Cold/new sessions
    // receive that bounded context; warm and resumed sessions receive only the
    // newly admitted message.
    const sessionMessage = spawnedSession && !spawnedFromResume ? coldSessionMessage : message;
    let resp;
    try {
      await adapter.sendTurn(session, sessionMessage, streamHooks);
      resp = await adapter.awaitResponse(session);
      captureRuntimeOutcome(resp);
      reportJournalSession(resp?.sessionId);
      const attribution = runtimeAttribution(resp);
      if (this.buildWorkspace) routeObservation(attribution);
      else flushTerminalEvents(attribution);
    } catch (error) {
      captureRuntimeOutcome(error);
      reportJournalSession(error?.sessionId);
      flushTerminalEvents(runtimeAttribution(error));
      throw error;
    }
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
        // An invalid generation is an internal bounded retry, not this public
        // turn's terminal. Close its idle Query, discard only that attempt's held
        // terminal, and let the final attempt own the canonical turn_end.
        deferredTerminalEvents.splice(0);
        terminalStatus = null;
        failure = null;
        fallbackModel = null;
        await adapter.teardown(session);
        if (session) session.alive = false;
        session = await adapter.spawn(spawnArgs);
        await adapter.awaitReady(session);
        routeObservation();
        reportJournalSession(session?.sessionId);
        try {
          await adapter.sendTurn(session, coldSessionMessage, streamHooks);
          resp = await adapter.awaitResponse(session);
          captureRuntimeOutcome(resp);
          reportJournalSession(resp?.sessionId);
          routeObservation(runtimeAttribution(resp));
        } catch (error) {
          captureRuntimeOutcome(error);
          reportJournalSession(error?.sessionId);
          flushTerminalEvents(runtimeAttribution(error));
          throw error;
        }
        committed = commitGeneratedFile(this.buildWorkspace, message, resp.text ?? "");
      }
      flushTerminalEvents(runtimeAttribution(resp));
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
      session_id: resp?.sessionId ?? session.sessionId ?? null,
      // SDK-driven sessions DO journal a transcript (unlike the PTY operative), so
      // the per-message `transcript` badge (§12) has a real file to open.
      transcript_path: this.claudeTranscriptPathFor(
        spawnArgs.compositionDir,
        resp?.sessionId ?? session.sessionId ?? null
      ),
      cost_usd: null,
      route: route.targetId,
      runtime: "agent-sdk",
      provider: t.provider,
      model: resp?.model ?? fallbackModel ?? session?.observedModel ?? t.model,
      account: t.account ?? null,
      effort: requestedEffort,
      effortApplied: requestedEffort == null ? null : session.effortApplied === true,
      toolUses: resp.toolUses ?? [],
      stoppedReason: resp.stoppedReason ?? null,
      terminalStatus,
      failure,
      sessionDisposition,
      sessionBoundaryReason,
      sessionEpoch,
      spawnSignature: opts.routeSession?.signature ?? null,
    };
    });
  }

  // Cap the warm agent-sdk session map. Conversation-keyed sessions (§12) grow
  // with thread count against a Map that had no eviction at all. A standing Query
  // must be closed, not merely interrupted (interrupt intentionally preserves it
  // for the next turn). Historical one-shot sessions retain cancel-before-teardown.
  async _releaseAgentSdkSession(adapter, key, session, kind = "evicted", { strict = false } = {}) {
    const releasingSessionId = typeof session?.sessionId === "string" && session.sessionId
      ? session.sessionId
      : null;
    if (releasingSessionId) (this._releasingAgentSdkSessionIds ??= new Set()).add(releasingSessionId);
    const meta = this._agentSdkSessionMeta?.get(key) ?? null;
    // Eviction/recovery releases disappear from lookup before an asynchronous
    // close (the releasing-id barrier then prevents a concurrent native resume).
    // Logical signature/effort rotations serialize on the conversation lane and
    // stay discoverable until close succeeds, so a failed close cannot orphan a
    // possibly-live Query and then spawn a second owner for its journal.
    if (!strict) this._agentSdkSessions.delete(key);
    let releaseError = null;
    try {
      if (session?.streamingInput === true || session?.config?.streamingInput === true) {
        await adapter?.teardown?.(session);
      } else {
        await adapter?.cancel?.(session);
        await adapter?.teardown?.(session);
      }
    } catch (error) {
      releaseError = error;
    } finally {
      if (releasingSessionId) this._releasingAgentSdkSessionIds?.delete(releasingSessionId);
    }
    if (releaseError && strict) throw releaseError;
    this._agentSdkSessions.delete(key);
    this._agentSdkSessionMeta?.delete(key);
    if (meta && this._currentAgentSdkKeyByCompatibility?.get(meta.compatibilityKey) === key) {
      const hasOlderSibling = [...(this._agentSdkSessionMeta?.values() ?? [])]
        .some((candidate) => candidate.compatibilityKey === meta.compatibilityKey);
      // If an older-credential sibling is still active, retain the desired key
      // even when cap pressure evicts the newer idle session. That sibling must
      // still retire on idle and can never become the compatibility winner.
      if (!hasOlderSibling) this._currentAgentSdkKeyByCompatibility.delete(meta.compatibilityKey);
    }
    // Non-strict retirement preserves the historical idempotent behavior: an
    // already-finished query may reject close, but it is no longer reusable.
    if (session) session.alive = false;
    this.logFn({ kind: `agent-sdk-session-${kind}`, live: this._agentSdkSessions.size });
  }

  async _retireStaleAgentSdkSessions(adapter) {
    const metadata = this._agentSdkSessionMeta ?? new Map();
    const current = this._currentAgentSdkKeyByCompatibility ?? new Map();
    const queues = this._laneQueues ?? new Map();
    for (const [key, session] of [...this._agentSdkSessions]) {
      const meta = metadata.get(key);
      if (!meta || current.get(meta.compatibilityKey) === key) continue;
      if (queues.has(meta.laneKey ?? `sdk:${key}`)) continue;
      await this._releaseAgentSdkSession(adapter, key, session, "credential-retired");
    }
  }

  async _evictAgentSdkSessions(adapter) {
    while (this._agentSdkSessions.size > AGENT_SDK_SESSION_CAP) {
      const queues = this._laneQueues ?? new Map();
      // An SDK lane remains present for both its active turn and everything
      // queued behind it. Evicting any such key can interrupt the oldest live
      // conversation merely because a ninth distinct thread arrived. Prefer the
      // oldest IDLE entry; if all are busy, bounded correctness beats a hard
      // instantaneous cap and the lane-idle callback above trims the overflow.
      const oldestIdleKey = [...this._agentSdkSessions.keys()]
        .find((candidate) => {
          const laneKey = this._agentSdkSessionMeta?.get(candidate)?.laneKey ?? `sdk:${candidate}`;
          return !queues.has(laneKey);
        });
      if (oldestIdleKey === undefined) return;
      const session = this._agentSdkSessions.get(oldestIdleKey);
      await this._releaseAgentSdkSession(adapter, oldestIdleKey, session, "evicted");
    }
  }

  // The materialized vault for this composition, or null when it is unreadable
  // (locked). Injected `secrets` (tests, and the runner-threaded map) wins; the
  // default reads <compositionDir>/.env at CALL time so a vault unlock mid-run is
  // picked up without restarting the gateway.
  resolveSecrets() {
    if (this.secrets) return this.secrets;
    if (typeof this.secretsFn === "function") {
      try {
        const s = this.secretsFn();
        return s && Object.keys(s).length ? s : null;
      } catch {
        return null;
      }
    }
    const s = readMaterializedSecrets(this.compositionDir);
    return Object.keys(s).length ? s : null;
  }

  // True when the resolved route runs on a runtime the gateway executes directly
  // via its adapter — an EXEC engine (codex/gpt, gemini, opencode, cursor) or an
  // in-process HTTP engine (openai-agents). Reads ROUTABLE_RUNTIMES, the same
  // registry the primary warm seam uses, so the two lanes cannot disagree about
  // which engines exist. NOTE: that unification also admits `opencode`, which the
  // previous hand-written `codex || gemini` test excluded even though opencode is a
  // first-class exec runtime with a full adapter; an opencode secondary target used
  // to miss this lane and fall through to the Claude path. Same agnosticism gap the
  // primary seam already documents, closed on the same terms.
  isSecondaryTarget(route) {
    const t = route?.target;
    // `type: secondary` is legacy metadata, not sufficient runtime identity: a
    // Claude-bound target under a Codex primary must take the real Claude lane.
    return !!t && ROUTABLE_RUNTIMES.has(t.runtime);
  }

  isClaudeDelegateTarget(route) {
    return route?.target?.runtime === "claude-code" && this.primaryEngine !== "claude-code";
  }

  // A scoped Claude turn cannot use the composition-rooted standing operative.
  // Reuse the delegate pool even when Claude is the primary: delegate sessions
  // are keyed by cwd below, so attribution and the process's actual cwd agree
  // while Kanban follow-up turns retain project/personal context.
  usesScopedClaudeSession(route, cwd = null) {
    if (this.isClaudeDelegateTarget(route)) return true;
    const claudeExecutable = route?.target?.runtime === "claude-code" || this.isWorkflowTarget(route);
    return claudeExecutable && typeof cwd === "string" && cwd.trim().length > 0;
  }

  // The on-disk jsonl transcript a Claude CLI session at `cwd` journals to.
  // Callers (e.g. the automations vision path) use it to link a routed turn to
  // its session transcript; null when either coordinate is missing.
  claudeTranscriptPathFor(cwd, sessionId) {
    if (!cwd || !sessionId) return null;
    let canonical = cwd;
    try {
      canonical = fs.realpathSync(cwd);
    } catch {
      // unresolvable path (already gone / permission) — use it as given
    }
    return path.join(claudeProjectDirForCwd(canonical), `${sessionId}.jsonl`);
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
    const model = t.model ?? this._operativeSpawnConfig?.model ?? this.currentTarget?.model ?? "sonnet";
    const effort = t.effort ?? null;
    const executableTarget = { ...t, runtime: "claude-code", provider, model };
    // cwd, most specific first: a PINNED PROJECT for this turn (§8), else the build
    // workspace, else the composition dir. It is part of the cache KEY because a
    // warm delegate session is pinned to the cwd it spawned in - keying without it
    // would hand a project-pinned turn a session rooted somewhere else, and the
    // project badge would assert a scope the turn never had.
    const cwd = opts.cwd ?? this.buildWorkspace ?? this.compositionDir;
    const key = `${provider}:${model}:${effort ?? "none"}:${cwd}`;
    // A warm delegate is one Claude session: same-key turns serialize on its
    // lane; different cwds/targets run concurrently (2026-08-07).
    return this._onLane(`delegate:${key}`, async () => {
    let session = this._claudeDelegateSessions.get(key);
    if (!session || !this.#alive({ session })) {
      const spawnConfig = this.core.buildRespawnOpts(executableTarget, {
        compositionDir: cwd,
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
    try {
      const sessionId = session.getClaudeSessionId?.() ?? session.sessionId ?? null;
      if (sessionId) {
        const journalIdentity = {
          session_id: sessionId,
          transcript_path: this.claudeTranscriptPathFor(session.compositionDir ?? cwd, sessionId)
        };
        // AskUserQuestion actuation is session-owned, not process-global. Give
        // the gateway the concrete delegate before the transcript watcher can
        // surface a picker from it; observability remains independently optional.
        opts.registerQuestionSession?.(session, journalIdentity);
        opts.onJournal?.(journalIdentity);
      }
    } catch {
      /* question/observability sinks must never break a turn */
    }
    this.logFn({ kind: "runtime-turn", runtime: "claude-code", provider, model, effort, target: route.targetId, delegated: true });
    // §9: a delegate is a real Claude session, so ESC is its stop primitive (the
    // same one /claude/interrupt uses); a non-PTY delegate falls back to the
    // adapter's cancel when it has one.
    if (typeof opts.registerStop === "function") {
      opts.registerStop(() => {
        if (typeof session.writeKeys === "function") {
          session.writeKeys("\x1b");
          return true;
        }
        return adapter.cancel?.(session) ?? false;
      });
    }
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
      transcript_path: this.claudeTranscriptPathFor(
        // Claude Code journals per-cwd, so this MUST be the cwd the session
        // actually spawned in - `cwd` already folds in a pinned project (§8).
        session.compositionDir ?? cwd,
        response.sessionId
      ),
      route: route.targetId,
      runtime: "claude-code",
      provider,
      model,
      effort,
      effortApplied: effort == null ? null : session.__garrisonEffortApplied === true
    };
    });
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
    // One source of truth for engine → adapter class: the same map the PRIMARY
    // warm seam uses, so a runtime can never be executable as primary but not as
    // secondary (or vice versa) because two lists drifted apart.
    const cls = Object.hasOwn(SECONDARY_ADAPTER_CLASS, runtime) ? SECONDARY_ADAPTER_CLASS[runtime] : undefined;
    if (!cls) throw new Error(`gateway-routing: no adapter class registered for runtime "${runtime}"`);
    const mod = await import(pathToFileURL(path.join(dir, "lib", `${runtime}-adapter.mjs`)).href);
    const adapter = new mod[cls]();
    this._secondaryAdapters.set(runtime, adapter);
    return adapter;
  }

  // Run one turn on a secondary runtime (the orchestrator delegating a step to
  // gpt/codex or gemini). One-shot exec; the reply is returned + (by gateway-pty)
  // injected into the rich channel stream.
  async runSecondaryTurn(route, message, opts = {}) {
    const rt = route.target.runtime;
    const defaults = EXEC_ENGINE_DEFAULTS[rt] ?? {};
    const provider = route.target.provider ?? defaults.provider ?? null;
    const model = route.target.model ?? defaults.model ?? null;
    const effort = route.target.effort ?? null;
    const adapter = await this.getSecondaryAdapter(rt);
    // cwd, most specific first: a PINNED PROJECT for this turn (§8), else the
    // shared BUILD WORKSPACE when set (so codex reads + gemini edits the REAL
    // project files), else a clean scratch cwd (default — keep the agentic CLI out
    // of the repo). codex on a ChatGPT account rejects an explicit model override,
    // so use its default; gemini accepts -m.
    const cwd =
      opts.cwd ??
      this.buildWorkspace ??
      (this._secondaryScratch ??= fs.mkdtempSync(path.join(os.tmpdir(), "garrison-secondary-")));
    const spawnModel = model;
    // Trust the cwd for gemini 0.46 (else it downgrades yolo + blocks); harmless for codex.
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" };
    const session = await adapter.spawn({
      compositionDir: cwd,
      model: spawnModel,
      effort,
      env,
      // An in-process HTTP engine resolves its ENDPOINT from the spawn config, not
      // from a CLI's own login state: without provider (and the vault secrets that
      // back its key) it cannot resolve a base URL at all and throws
      // `unknown openai-agents provider "undefined"` on the first turn. The exec
      // engines ignore these keys, so this is unconditional rather than branched.
      ...(Object.hasOwn(HTTP_ADAPTER_CLASS, rt)
        ? {
            provider,
            ...(route.target.baseUrl ? { baseUrl: route.target.baseUrl } : {}),
            ...(route.target.apiKeyEnv ? { apiKeyEnv: route.target.apiKeyEnv } : {}),
            ...(route.target.keyless != null ? { keyless: !!route.target.keyless } : {}),
            ...(route.target.promptMode ? { promptMode: route.target.promptMode } : {}),
            ...(Number(route.target.maxTurns) > 0 ? { maxTurns: Number(route.target.maxTurns) } : {}),
            secrets: this.resolveSecrets()
          }
        : {})
    });
    this.logFn({ kind: "runtime-turn", runtime: rt, provider, model, effort, target: route.targetId });
    // §9: the exec child used to be unreachable from here (a local const inside the
    // adapter), so Stop could not touch a codex/gemini turn. adapter.cancel SIGTERMs
    // the stored child (SIGKILL after a grace) and settles the turn with its partial
    // output - feature-detected, since not every runtime adapter implements it.
    if (typeof opts.registerStop === "function" && typeof adapter.cancel === "function") {
      opts.registerStop(() => adapter.cancel(session));
    }
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
      // A cancelled exec turn settles with its partial output and says so; the
      // done frame turns that into stoppedByUser for the badge row. Dropping it
      // here (as this return used to) made a stopped turn look like a normal one.
      stoppedReason: resp?.stoppedReason ?? null,
      // Codex applies the reasoning-effort config at exec and says so on the
      // session. Gemini has no CLI effort control and Cursor bakes effort into
      // the model id, so both report the requested-but-unapplied state. Read the
      // ADAPTER's own claim rather than an engine allowlist here — an adapter
      // that cannot apply effort simply never sets the flag.
      effortApplied: effort == null ? null : session.effortApplied === true
    };
  }

  // A target naming a runtime nothing can execute used to reach applySwitch and
  // run on the PRIMARY session, reporting itself as the primary's runtime — so a
  // mis-wired `openrouter` / `huggingface` / typo'd target looked like a working
  // delegation while every turn actually ran on Claude. Log it loudly instead of
  // letting it pass as success. Deliberately a WARNING, not a throw: the
  // legitimately-non-session runtimes below reach this path by design, and a
  // hand-edited composition should degrade visibly rather than refuse to serve.
  #warnIfUnroutable(route) {
    const rt = route?.target?.runtime;
    if (!rt || rt === this.primaryEngine) return;
    // Runtimes that legitimately land on the primary-adjust path: the Claude PTY
    // lanes, and the single-shot dispatch/vision targets that are not session
    // engines at all (garrison-call declares no `provides` on purpose).
    if (PRIMARY_ADJUST_RUNTIMES.has(rt)) return;
    if (ROUTABLE_RUNTIMES.has(rt)) return; // has its own lane; never gets here
    this.logFn({
      kind: "route-unroutable",
      runtime: rt,
      target: route.targetId,
      reason:
        `target ${route.targetId} names runtime "${rt}", which no execution lane serves ` +
        `(routable: ${[...ROUTABLE_RUNTIMES].sort().join(", ")}). The turn is running on the ` +
        `"${this.primaryEngine}" primary instead — fix the target's runtime in the policy, or ` +
        `station a fitting that provides "${rt}" and register it in the adapter registry.`
    });
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
    // Serialized: concurrent turns (2026-08-07) must not race two checkouts of
    // the singleton operative slot when both find it dead.
    return this._onLane("operative-ensure", async () => {
      if (!this.#alive(this.operative)) {
        this.operative = await this.pool.checkout(this.operativeRuntimeId);
        this.logFn({ kind: "operative-recheckout", id: this.operative.id });
      }
      return this.operative.session;
    });
  }

  async ensureClassifier() {
    if (!this._legacyClassifierEnabled) {
      throw new Error("legacy Stage-A classifier is disabled for schema-v4 routing");
    }
    if (!this.#alive(this.classifier)) {
      this.classifier = await this.pool.checkout(this.classifierRuntimeId);
      this.logFn({ kind: "classifier-recheckout", id: this.classifier.id });
    }
    return this.classifier.session;
  }

  // Resolve the board's base URL from the kanban-loop status file (URL-link
  // contract, never a hardcoded port — the same discovery the gateway uses for
  // every fitting). Returns the base URL or null (board down / not installed).
  // Implementation lives in the shared board-card client; an injected base (tests)
  // wins, the same seam `_cardsLib` provides for the card client itself.
  _boardBase() {
    return this._boardBaseOverride ?? cards.boardBase();
  }

  // D19: register a turn as a card on the board. Thin wrapper over the shared
  // implementation (lib/autonomous-cards.mjs) — deps resolve at CALL time from
  // this.core/this.logFn so prototype-created receivers (tests) keep working.
  async createAutonomousCard(message, classification, opts = {}) {
    const base = this.core?.buildAutonomousCardPayload ?? null;
    // §7.1: the autonomy fields ride ON TOP of the pure payload builder rather
    // than inside it. buildAutonomousCardPayload is the Orchestrator's card
    // contract; a HOLD is the gateway's decision about one turn, and the BAND is
    // context about that decision - neither is a property of what a card is. One
    // builder, one place to read what a held card carries.
    const needsAutonomy = opts.autonomyHeld === true || Boolean(opts.autonomy);
    // With no core wired the shared client builds its own minimal payload, which
    // would drop these fields silently - and a "held" card that reached the board
    // without its flag would never pose its question. So when there IS something
    // to carry, this supplies the minimal payload itself rather than letting the
    // hold evaporate into a card nobody is waiting on.
    const minimal = (args) => ({
      description: args.brief ?? "",
      goalMode: true,
      project: args.project ?? null,
      originChannel: args.originChannel ?? null
    });
    const buildPayload = needsAutonomy
      ? (args) => {
          const payload = (base ?? minimal)(args);
          if (opts.autonomyHeld) {
            payload.autonomyHeld = true;
            payload.autonomyAsk = opts.autonomyAsk ?? null;
          }
          if (opts.autonomy) payload.autonomy = opts.autonomy;
          return payload;
        }
      : base;
    return cards.createAutonomousCard({
      message,
      classification,
      opts,
      buildPayload,
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
  // Implementation lives in the shared board-card client.
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
    const lib = this._cardsLib ?? cards;
    const list = await lib.cardsByOrigin(origin_id);
    if (Array.isArray(list) && list.length > 0) {
      const live = list.find(
        (c) => c && c.list && c.list !== "done" && c.list !== "needs-attention" && !c.preparedRevert
      );
      if (live) return { attach: live };
      const done = list.find((c) => c && c.list === "done");
      if (done) return { continueFrom: done.id };
      return null;
    }
    // Discuss threads name the card IN the thread key (`web:kanban-<cardId>`,
    // the buildDiscussUrl convention) and never write an origins entry. Before
    // 2026-08-07 this lookup simply missed, the kickoff classified task-shaped,
    // and the gateway registered a fresh QUICK card that answered one-shot and
    // self-completed while the real card sat in Discuss (observed twice on
    // 2026-08-06). Resolve the embedded id directly, same live/done contract.
    const threadCardId = /^web:kanban-([0-9A-HJKMNP-TV-Z]{26})$/i.exec(String(origin_id ?? ""))?.[1];
    if (threadCardId && typeof lib.cardById === "function") {
      const card = await lib.cardById(threadCardId);
      if (card?.id && card.list && card.list !== "done" && card.list !== "needs-attention" && !card.preparedRevert) {
        return { attach: card };
      }
      if (card?.list === "done") return { continueFrom: card.id };
    }
    return null;
  }

  /**
   * Raise ONE duty on ONE card (level-resolution.mjs step 3).
   *
   * Escalation is the only part of the level chain that happens at RUNTIME, and
   * the brief is explicit that an unlogged escalation is a bug - so this is the
   * one supported way to make one, and it does all four halves together:
   * resolve, LOG, apply, report. The order matters: the decision record is
   * written whether or not the raise applied, because a REFUSED escalation (an
   * attempt to lower a level) is exactly as interesting to the improver as an
   * accepted one, and a caller that believes it de-escalated and did not would
   * ship unreviewed work thinking it had chosen to.
   *
   * The record is stamped with the FLOW before it is written. `escalateDuty`
   * cannot know it - it is handed a flow DEFINITION, not its name - and
   * `summariseEscalations` groups on `r.flow`, so an unstamped record is a
   * record the improver can never turn into a pin. Same field the routing tracks
   * read as the escalation's shape.
   *
   * Returns {status, body} so the HTTP route above it stays a thin adapter.
   */
  async escalateCardDuty({ cardId, duty, toLevel, reason } = {}) {
    const chain = await this._levelChain();
    if (!chain) return { status: 503, body: { error: "level-chain-unavailable" } };
    if (typeof cardId !== "string" || !cardId) return { status: 400, body: { error: "cardId is required" } };
    if (typeof duty !== "string" || !duty) return { status: 400, body: { error: "duty is required" } };
    // clampLevel CLAMPS (9 becomes 3), which is right inside the resolver and
    // wrong at an HTTP door: a caller asking for level 9 has a bug, and silently
    // serving it level 3 hides that. Accept only a level that survives the clamp
    // unchanged.
    const wanted = chain.levels.clampLevel(toLevel);
    if (wanted == null || Math.trunc(Number(toLevel)) !== wanted) {
      return { status: 400, body: { error: "toLevel must be a level 1-3" } };
    }
    // A reason is not optional: an escalation with no reason cannot become a
    // useful improver signal and cannot be judged in the decisions log.
    const why = typeof reason === "string" ? reason.trim() : "";
    if (!why) return { status: 400, body: { error: "reason is required for an escalation" } };

    const lib = this._cardsLib ?? cards;
    const card = await lib.cardById(cardId);
    if (!card) return { status: 404, body: { error: `card not found: ${cardId}` } };

    const flows = this.config?.flows || {};
    const requested = typeof card.flow === "string" && card.flow ? card.flow : this.config?.defaultFlow;
    const flowName = flows[requested] ? requested : chain.policy.adoptFlow(requested);
    const definition = flowName ? flows[flowName] : null;
    if (!definition || !definition.levels) {
      return { status: 409, body: { error: "flow-not-levelled", flow: flowName ?? null } };
    }
    // A duty the card's flow does not run at this level cannot be escalated: the
    // resolver would happily answer for it (every duty inherits the flow level),
    // the record would look exactly like a real one, and the card would never run
    // the duty. That is a typo turning into a permanent decision-log entry.
    const inFlow = chain.levels.dutiesForLevel(definition, card.level);
    if (inFlow.length && !inFlow.includes(duty)) {
      return { status: 409, body: { error: "duty-not-in-flow", flow: flowName, duties: inFlow } };
    }

    const { applied, resolved, record } = chain.levels.escalateDuty({
      flow: definition,
      flowLevel: card.level,
      duty,
      toLevel: wanted,
      reason: why,
      cardId,
      at: this.nowFn()
    });
    record.flow = flowName;
    await this.core.appendDecision(this.decisionsFile, record);
    this.logFn({
      kind: "duty-escalation",
      card: cardId,
      duty,
      flow: flowName,
      from: record.from,
      to: record.to,
      applied
    });
    if (!applied) return { status: 200, body: { applied: false, resolved, record } };

    const patched = await lib.patchCardDutyLevels({
      id: cardId,
      dutyLevels: { [duty]: resolved.level },
      reason: why,
      logFn: (e) => this.logFn(e)
    });
    if (!patched.ok) {
      return { status: 502, body: { applied: false, resolved, record, error: patched.error ?? "board-patch-failed" } };
    }
    return { status: 200, body: { applied: true, resolved, record } };
  }

  // S3b: run ONE web materialized turn as a one-shot (fresh disposable claude), so
  // the standing operative session holds NO web context between messages. Injectable
  // for tests via opts.oneShotFn. Returns { reply, sessionId, transcriptPath }.
  //
  // cwd/env are per-turn (2026-07-25 §8, §6): a pinned PROJECT becomes the real cwd
  // (a confined dev-root repo, resolved by the caller) and a pinned ACCOUNT becomes
  // real auth env. Both were hardcoded here before - the composition dir and the
  // gateway's own env - which is why "project" could only ever have been a label.
  // Absent → byte-identical to the previous behaviour.
  async runWebOneShot({ message, model, onScreen, onSession, cwd: cwdOverride, env } = {}) {
    const cfg = this._operativeSpawnConfig || {};
    const fn = this._oneShotFn ?? oneShotTurn;
    const cwd = cwdOverride ?? cfg.compositionDir ?? this.compositionDir;
    const outcome = await fn({
      cwd,
      appendSystemPromptFile: cfg.appendSystemPromptFile ?? this.appendSystemPromptFile,
      model: model ?? cfg.model,
      permissionMode: cfg.permissionMode ?? "bypassPermissions",
      claudeBinary: cfg.claudeBinary,
      extraArgs: cfg.extraArgs,
      ...(env ? { env } : {}),
      message,
      onScreen,
      onSession
    });
    const sessionId = outcome?.sessionId ?? null;
    return {
      reply: outcome?.reply ?? "",
      sessionId,
      transcriptPath: this.claudeTranscriptPathFor(cwd, sessionId)
    };
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
      const dir = resolveOrchestratorRoutingDir(this.compositionDir, "steer-core.mjs");
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
    // A card sitting in Discuss is a DIALOGUE, not a live run: its thread
    // messages are the conversation itself, never steering. Classifying them
    // as absorb/revisit would post steer directives at a card that has not
    // started - fall through to the ordinary conversational turn instead.
    if (card.list === "discuss") return null;
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
        const dir = resolveOrchestratorRoutingDir(this.compositionDir, "dispatch-core.mjs");
        const mod = dir ? await import(pathToFileURL(path.join(dir, "lib", "dispatch-core.mjs")).href) : null;
        this._clarityScFn = mod && typeof mod.clarityShortCircuit === "function" ? mod.clarityShortCircuit : null;
      }
      return this._clarityScFn ? this._clarityScFn(message) : null;
    } catch {
      return null;
    }
  }

  // Drive ONE classification turn on the warm classifier session, whatever engine
  // backs it. A claude-code (PTY) classifier session exposes runTurn directly; an
  // agent-sdk classifier session (when the primary is agent-sdk) has no runTurn —
  // it is driven through its adapter's sendTurn/awaitResponse, exactly like the
  // Claude delegate lane. Returns the reply text (empty string on no output).
  async _runClassifierTurn(prompt) {
    const session = this.classifier.session;
    if (typeof session.runTurn === "function") {
      const r = await session.runTurn({ message: prompt, timeoutMs: 60_000 });
      return r?.reply ?? "";
    }
    const adapter =
      (typeof this.pool?.adapterFor === "function" && this.pool.adapterFor(this.classifierRuntimeId)) || null;
    if (!adapter) throw new Error("classifier session has no runTurn and no adapter to drive it");
    await adapter.sendTurn(session, prompt);
    const out = await adapter.awaitResponse(session);
    return out?.text ?? "";
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
      reply = await this._runClassifierTurn(prompt);
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
      throw new Error("dispatchRoute: no Orchestrator routing inference wired (construct RoutedGateway with opts.dispatcher = { core, model, call })");
    }
    const { core, model, call, evidenceFile, callOpts } = this._dispatcher;
    const currentModel = typeof model === "function" ? await model() : model;
    const result = await core.dispatch(currentModel, message, {
      call,
      now: this.nowFn,
      evidenceFile: evidenceFile ?? this.decisionsFile,
      cardLevel: opts.cardLevel,
      deterministicOnly: opts.deterministicOnly === true,
      ...(callOpts ?? {}),
    });
    if (result?.dispatchOk === false) {
      this.logFn({
        kind: "dispatcher-fallback",
        duty: result.duty ?? null,
        level: result.level ?? null,
        source: result.source ?? "fallback",
        latencyMs: result.latencyMs ?? null,
        failureCode: result.failureCode ?? "call-failed"
      });
    }
    // S4b (D15 acceptance 9): the dispatch now CONSULTS THE RESOLVED MODEL. Attach
    // the ordered phase sequence the resolved (duty, level) walks — read from the
    // SAME runner-projected model.json the board reads — so a task entering via the
    // web-channel produces a card that visits the IDENTICAL sequence a board-entered
    // card with the same (duty, level) would (divergence zero). Additive + best-
    // effort: an absent/unresolvable model leaves the historical dispatch fields
    // untouched and `sequence` unset, so the pre-S4b behaviour is byte-for-byte kept.
    //
    // 2026-08-13: the FLOW's duty list at the routed level wins where one resolves.
    // The duty ladder is the fallback, so nothing changes for flow-less work.
    try {
      const plan = await this.resolvedFlowPlan(result?.duty, result?.level, opts.flow ?? null);
      const sequence = plan?.sequence?.length
        ? plan.sequence
        : await this.resolvedSequenceForDispatch(result?.duty, result?.level);
      if (sequence.length) {
        result.sequence = sequence;
        if (plan) {
          result.flow = plan.flow;
          result.flowLevel = plan.flowLevel;
          result.dutyLevels = plan.dutyLevels;
        }
        this.logFn({
          kind: "dispatch-sequence",
          duty: result.duty,
          level: result.level,
          sequence,
          flow: plan?.flow ?? null,
          dutyLevels: plan?.dutyLevels ?? null
        });
      }
    } catch (err) {
      this.logFn({ kind: "dispatch-sequence-failed", error: err?.message });
    }
    return result;
  }

  async legacyClassificationToV4(classification) {
    if (!classification?.taskType || !classification?.tier) return null;
    const model = await this.executionModel();
    const duties = model?.duties ?? {};
    const selected = Array.isArray(model?.selectedDuties) ? model.selectedDuties : Object.keys(duties);
    let duty = selected.includes(classification.taskType) ? classification.taskType : null;
    if (!duty && classification.taskType === "code" && selected.includes("develop")) duty = "develop";
    if (!duty && selected.includes("other")) duty = "other";
    if (!duty) return null;
    const requested = classification.tier === "T0-trivial" ? 1 : classification.tier === "T2-deep" ? 3 : 2;
    const count = Math.max(1, Array.isArray(duties[duty]?.levels) ? duties[duty].levels.length : 1);
    return { duty, level: Math.min(requested, count) };
  }

  // The v2 config's exceptions map a caller-asserted matchedException id to a
  // target — the deterministic half of an explicit classification that the duty
  // cells cannot express (e.g. the automations vision route steering off an
  // engine with no credentials on this box).
  exceptionTarget(id) {
    if (typeof id !== "string" || !id) return null;
    const ex = (this.config?.exceptions || []).find((e) => e && e.id === id);
    return typeof ex?.target === "string" && ex.target ? ex.target : null;
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

  // The Orchestrator's LEVEL CHAIN (level-resolution.mjs) plus the policy vocabulary
  // it needs (policy-core.mjs's flow aliases + flow-for-duty derivation), loaded the
  // same way dispatch-core is: dynamic import from the resolved orchestrator fitting
  // dir, cached, null when it is not on disk (the gateway then keeps the duty-ladder
  // sequence and stamps no per-duty levels - exactly the pre-level-chain behaviour).
  //
  // policy-core is imported DIRECTLY rather than read off `this.core`: routing-core
  // re-exports only part of policy-core, and `levelPlanFor` / `adoptFlow` are not in
  // that list. Resolving the dir on level-resolution.mjs also means an older installed
  // orchestrator that predates the level chain falls through to the repo seed instead
  // of half-loading.
  async _levelChain() {
    if (this._levelChainLib !== undefined) return this._levelChainLib;
    try {
      const dir = resolveOrchestratorRoutingDir(this.compositionDir, "level-resolution.mjs");
      this._levelChainLib = dir
        ? {
            levels: await import(pathToFileURL(path.join(dir, "lib", "level-resolution.mjs")).href),
            policy: await import(pathToFileURL(path.join(dir, "lib", "policy-core.mjs")).href)
          }
        : null;
      if (this._levelChainLib?.policy?.FLOW_ALIASES) {
        this.flowAliases = { ...this._levelChainLib.policy.FLOW_ALIASES };
      }
    } catch {
      this._levelChainLib = null;
    }
    return this._levelChainLib;
  }

  // The AUTONOMY CONSULT (ORCHESTRATOR_COHERENCE.md §7.1/§7.5), loaded exactly the
  // way the level chain is: a dynamic import from the resolved orchestrator fitting
  // dir, cached, null when it is not on disk.
  //
  // NULL IS A REAL ANSWER HERE, and the most important one. With no consult the
  // router behaves precisely as it did before this seam existed - decide and go -
  // because a broken autonomy layer must FAIL OPEN. Parking every turn because a
  // module would not import is not caution, it is an outage with a moral.
  async _autonomyConsult() {
    if (this._autonomyLib !== undefined) return this._autonomyLib;
    try {
      const dir = resolveOrchestratorRoutingDir(this.compositionDir, "autonomy-consult.mjs");
      this._autonomyLib = dir
        ? await import(pathToFileURL(path.join(dir, "lib", "autonomy-consult.mjs")).href)
        : null;
      if (!dir) this.logFn({ kind: "autonomy-consult-unavailable", reason: "autonomy-consult.mjs not resolvable" });
    } catch (err) {
      this._autonomyLib = null;
      this.logFn({ kind: "autonomy-consult-unavailable", reason: err?.message ?? "import failed" });
    }
    return this._autonomyLib;
  }

  /**
   * How much freedom the router has to act on THIS decision, per category.
   *
   * `action` is the reversibility class of what the router is about to do, and it
   * is load-bearing: bandFor refuses act-and-inform for anything irreversible
   * however good the track record is. Pass the honest class, never the convenient
   * one.
   *
   * Returns null when the consult is unavailable or throws - the caller then
   * proceeds exactly as it always did (see _autonomyConsult).
   */
  async autonomyFor({ flow = null, duty = null, level = null, action = "code-change" } = {}) {
    const lib = await this._autonomyConsult();
    if (!lib || typeof lib.consultAutonomy !== "function") return null;
    try {
      const result = await lib.consultAutonomy({
        compositionDir: this.compositionDir,
        decision: { flow, duty, level },
        action,
        now: this.nowFn()
      });
      this.logFn({
        kind: "autonomy-consulted",
        shape: result.shape,
        band: result.band,
        ask: result.ask === true,
        deferred: result.deferred ?? null,
        reason: result.reason ?? null,
        seeded: result.seeded === true,
        askedToday: result.askBudget?.askedToday ?? null
      });
      return result;
    } catch (err) {
      this.logFn({ kind: "autonomy-consult-failed", error: err?.message ?? String(err) });
      return null; // fail OPEN: decide and go, exactly as before the consult existed
    }
  }

  /**
   * Record the GO on a held card - the answer to the question the hold posed.
   *
   * Two writes, because they are two different things and conflating them is how
   * this layer went blind in the first place:
   *
   *   • decisions.jsonl gets the AUDIT record. "The router asked about this card
   *     and was told to go" is a routing event, and the decisions log is where
   *     routing events are reconstructable from.
   *   • the feedback queue gets the SIGNAL, in the verdict shape both track folds
   *     already read as `explicit-confirmation`. Without it the hold teaches the
   *     router nothing and asks the same question about the same shape forever.
   *
   * Returns {logged, signalled} so a caller can report what actually landed.
   * Neither failure is fatal: the card is already released.
   */
  async recordAutonomyGo({ cardId = null, flow = null, duty = null, level = null, tier = null, decisionId = null, sessionId = null } = {}) {
    const at = this.nowFn();
    let logged = false;
    let signalled = false;
    try {
      await this.core.appendDecision(this.decisionsFile, {
        at,
        kind: "autonomy-ask",
        resolution: "go",
        cardId,
        flow,
        duty,
        level,
        ...(decisionId ? { decisionId } : {})
      });
      logged = true;
    } catch (err) {
      this.logFn({ kind: "autonomy-go-log-failed", error: err?.message ?? String(err) });
    }
    try {
      const lib = await this._autonomyConsult();
      if (lib && typeof lib.buildGoConfirmationRecord === "function") {
        await appendFeedback(
          lib.buildGoConfirmationRecord({ flow, duty, level, tier, decisionId, sessionId, at })
        );
        signalled = true;
      }
    } catch (err) {
      this.logFn({ kind: "autonomy-go-signal-failed", error: err?.message ?? String(err) });
    }
    this.logFn({ kind: "autonomy-go-recorded", cardId, flow, duty, level, logged, signalled });
    return { logged, signalled };
  }

  /**
   * Record the CORRECTION of a held card - the hold's other answer.
   *
   * Same two writes as recordAutonomyGo, for the same two reasons, with the
   * verdict flipped: decisions.jsonl gets the audit record ("the router asked
   * about this card and was corrected") and the feedback queue gets the SIGNAL,
   * an explicit-negative against the shape the router PROPOSED, naming what the
   * user corrected toward. Without the second write a hold could only ever teach
   * the router that it was right.
   *
   * Returns {logged, signalled}; neither failure is fatal - the card is already
   * re-stamped, and losing a log line must not un-apply a correction.
   */
  async recordAutonomyCorrection({ cardId = null, original = {}, applied = {}, decisionId = null, sessionId = null } = {}) {
    const at = this.nowFn();
    let logged = false;
    let signalled = false;
    try {
      await this.core.appendDecision(this.decisionsFile, {
        at,
        kind: "autonomy-ask",
        resolution: "corrected",
        cardId,
        flow: applied.flow ?? null,
        duty: applied.duty ?? null,
        level: Number.isInteger(applied.level) ? applied.level : null,
        // The proposal the user rejected, so the pair is reconstructable from the
        // audit log alone rather than only from the feedback queue.
        from: {
          flow: original.flow ?? null,
          duty: original.duty ?? null,
          level: Number.isInteger(original.level) ? original.level : null
        },
        ...(decisionId ? { decisionId } : {})
      });
      logged = true;
    } catch (err) {
      this.logFn({ kind: "autonomy-correction-log-failed", error: err?.message ?? String(err) });
    }
    try {
      const lib = await this._autonomyConsult();
      if (lib && typeof lib.buildCorrectionRecord === "function") {
        await appendFeedback(lib.buildCorrectionRecord({ original, applied, decisionId, sessionId, at }));
        signalled = true;
      }
    } catch (err) {
      this.logFn({ kind: "autonomy-correction-signal-failed", error: err?.message ?? String(err) });
    }
    this.logFn({
      kind: "autonomy-correction-recorded",
      cardId,
      from: original.duty ?? null,
      to: applied.duty ?? null,
      logged,
      signalled
    });
    return { logged, signalled };
  }

  /**
   * The list a (flow, duty, level) resumes onto: the first step of the sequence
   * that route would walk. The SAME resolution dispatchRoute performs, so a
   * corrected card resumes onto the list its corrected route actually starts at
   * instead of the list the rejected route proposed.
   *
   * Null when the model/flow library is unavailable - the caller then keeps the
   * resume list already stamped on the card, which is the pre-correction answer
   * rather than a guess.
   */
  async resumeListFor({ flow = null, duty = null, level = null } = {}) {
    if (!duty) return null;
    try {
      const plan = await this.resolvedFlowPlan(duty, level, flow);
      if (plan?.sequence?.length) return plan.sequence[0];
      const sequence = await this.resolvedSequenceForDispatch(duty, level);
      if (sequence.length) return sequence[0];
    } catch (err) {
      this.logFn({ kind: "resume-list-unresolved", duty, level, error: err?.message ?? String(err) });
    }
    return null;
  }

  /**
   * Apply a user's CORRECTION to a card the router is holding (§7.1, 2026-08-13).
   *
   * The ask says "reply go to proceed, or correct me" and, until this existed,
   * only the first half had a branch: a correction fell through to ordinary
   * routing and ran as a brand-new turn with no thread context, answering a
   * question nobody had asked. The correction is re-dispatched over the card's
   * ORIGINAL brief plus what the user just said - the correction usually names
   * the answer outright ("should be discuss duty level 1") - and the result
   * re-stamps the card, which STAYS HELD. Re-routing is not authorisation.
   *
   * Fails HONESTLY: every failure returns {ok:false, reason} and the caller says
   * so. Falling through to routing the correction as a fresh turn is the exact
   * failure this seam exists to remove, so it is never a fallback here.
   */
  async correctHeldCard({ card, correction, sessionId = null } = {}) {
    const id = card?.id ?? null;
    const text = typeof correction === "string" ? correction.trim() : "";
    if (!id || !text) return { ok: false, reason: "no-correction" };
    const original = heldCardRoute(card);

    // The brief the card was created from, plus the correction. The description is
    // the brief the run would execute; the title is the fallback for a card whose
    // description never made it across the projection.
    const brief = typeof card.description === "string" && card.description.trim()
      ? card.description.trim()
      : typeof card.title === "string" ? card.title.trim() : "";
    const message = `${brief}\n\nCorrection from the user about how to run this: ${text}`;

    let dispatched = null;
    try {
      dispatched = await this.dispatchRoute(message, { deterministicOnly: false });
    } catch (err) {
      this.logFn({ kind: "autonomy-correction-dispatch-failed", cardId: id, error: err?.message ?? String(err) });
      return { ok: false, reason: "dispatch-unavailable" };
    }
    if (!dispatched?.duty || !Number.isInteger(dispatched.level)) {
      return { ok: false, reason: "dispatch-unresolved" };
    }

    const applied = {
      flow: dispatched.flow ?? null,
      duty: dispatched.duty,
      level: dispatched.level,
      // The compatibility tier the v4 lane derives from a level, so the re-stamped
      // run spec carries the same pair preRouteV4 would have stamped.
      tier: dispatched.level <= 1 ? "T0-trivial" : dispatched.level >= 3 ? "T2-deep" : "T1-standard"
    };

    const base = this._boardBase();
    const patched = await patchHeldCardRouting({
      base,
      id,
      routing: {
        ...(applied.flow ? { flow: applied.flow } : {}),
        duty: applied.duty,
        level: applied.level,
        tier: applied.tier
      },
      dutyLevels: raisableDutyLevels(dispatched.dutyLevels ?? null, card.dutyLevels ?? null),
      logFn: (e) => this.logFn(e)
    });
    if (!patched.ok) {
      this.logFn({ kind: "autonomy-correction-restamp-failed", cardId: id, error: patched.error });
      return { ok: false, reason: "restamp-failed", error: patched.error };
    }

    await this.recordAutonomyCorrection({
      cardId: id,
      original: { flow: original.flow, duty: original.duty, level: original.level, tier: original.tier },
      applied,
      decisionId: original.decisionId,
      sessionId
    });

    const resumeList = Array.isArray(dispatched.sequence) && dispatched.sequence.length
      ? dispatched.sequence[0]
      : original.resumeList;
    // The re-ask names the new route in the SAME words the first ask named the old
    // one (askQuestion's own phrase builder). Null only when the consult module is
    // unresolvable - which is also the state in which no card would have been held.
    const consult = await this._autonomyConsult();
    return {
      ok: true,
      original,
      applied,
      phrase: typeof consult?.routePhrase === "function" ? consult.routePhrase(applied) : null,
      resumeList: resumeList ?? null,
      // True when the correction landed on the same route the router proposed. The
      // caller says so rather than announcing a change that did not happen. An
      // UNRESOLVED flow (no flow library on this composition) is not a change -
      // comparing it as one would report every correction as a re-route.
      unchanged:
        original.duty === applied.duty &&
        original.level === applied.level &&
        (applied.flow == null || (original.flow ?? null) === applied.flow)
    };
  }

  /** Count a question that was ACTUALLY POSED against today's budget. Counting
   *  intent rather than delivery is how a rate limit starts suppressing questions
   *  nobody ever saw. Never throws. */
  async recordAutonomyAsked() {
    const lib = await this._autonomyConsult();
    if (!lib || typeof lib.recordAsked !== "function") return null;
    try {
      return await lib.recordAsked(this.compositionDir, { now: this.nowFn() });
    } catch (err) {
      this.logFn({ kind: "autonomy-budget-write-failed", error: err?.message ?? String(err) });
      return null;
    }
  }

  /**
   * The FLOW's own plan for a routed (duty, level): the ordered duty list the flow
   * runs at that level, and the level EACH of those duties runs at once the flow
   * definition's pins are applied.
   *
   * This is the seam where the flow library stops being decoration. Until it existed
   * a card's sequence came from `model.sequences[duty][level]` - the apm.yml duty
   * ladder, whose cells are all leaves, so every sequence was a single duty and a
   * `fix` card ran `implement` alone while the flow said implement, test.
   *
   * `flow` is the EXPLICIT pin when there is one (aliased, because a pin can name a
   * retired flow); with no pin the flow is derived from the routed duty. Returns null
   * for anything not levelled, and the caller falls back to the duty ladder - so a
   * composition with the pre-levels flow shape behaves byte-identically.
   */
  async resolvedFlowPlan(duty, level, flow = null) {
    const chain = await this._levelChain();
    const flows = this.config?.flows;
    if (!chain || !flows || typeof flows !== "object") return null;
    const requested = typeof flow === "string" && flow ? flow : null;
    const name = requested
      ? (flows[requested] ? requested : chain.policy.adoptFlow(requested))
      : chain.policy.defaultFlowForDuty(this.config, duty);
    const definition = name ? flows[name] : null;
    if (!definition || !definition.levels) return null;
    // A MANUAL flow authors no sequence. Its level definitions document the shape
    // of the work (`personal` names `other`), and turning that into a dispatchable
    // sequence is exactly the confusion `manual: true` exists to prevent. The rail
    // is the real gate, but this stops a manual card being handed a plan at all.
    if (definition.manual === true) return null;
    // The third step of the chain (a per-card runtime escalation) is deliberately
    // NOT applied here: a card is escalated after it exists, never before. The
    // parameter stays plumbed so the escalation seam resolves through one function.
    const plan = chain.levels.resolveFlowPlan(definition, level, {});
    const sequence = plan.duties.map((d) => d.duty);
    if (!sequence.length) return null;
    return {
      flow: name,
      flowLevel: plan.flowLevel,
      sequence,
      dutyLevels: Object.fromEntries(plan.duties.map((d) => [d.duty, d.level])),
      evidence: plan.evidence ?? null
    };
  }

  // S4b (D15 acceptance 9): resolve a (duty, level) to the ordered phase-list
  // sequence a card would VISIT, reading the runner-projected model.json (the SAME
  // file the board reads via resolved-model.mjs). Returns [] when the model is
  // absent/unresolvable — the gateway then keeps its historical entry lists
  // (backlog/plan/implement) unchanged. This is DOOR 1's consult of the shared model.
  //
  // The FLOW's plan (resolvedFlowPlan) wins over this wherever a levelled flow
  // resolves; this stays as the fallback for flow-less and unlevelled work.
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

  // Honor a pinned TurnRouting on a resolved route and log both sides. Wired here
  // (not in applyTurnOverride) so the project/account resolvers stay injectable and
  // the pure overlay keeps no I/O.
  _applyOverride(route, ov, { implicitTarget = false } = {}) {
    const originalVia = route?.via;
    const originalRuleId = route?.ruleId;
    const result = applyTurnOverride(this.config, route, ov, {
      resolveProject: this._projectResolver ?? undefined,
      resolveAccount: this._accountResolver ?? ((name) => resolveVaultAccount(this.compositionDir, name))
    });
    if (implicitTarget) {
      // A durable thread's prior target is sticky spawn identity, not a new user
      // override. It still has to run through the exact target resolver, but must
      // not claim `overridesApplied:["target"]` or rewrite the route's provenance.
      result.applied = result.applied.filter((field) => field !== "target");
      if (result.applied.length === 0) {
        route.via = originalVia;
        route.ruleId = originalRuleId;
      }
      this.logFn({ kind: "route-session-sticky-target", target: route?.targetId ?? null });
    }
    if (result.applied.length) {
      this.logFn({ kind: "turn-override", applied: result.applied, target: route.targetId, via: route.via });
    }
    for (const rejection of result.rejected) {
      this.logFn({ kind: "turn-override-rejected", field: rejection.field, reason: rejection.reason });
    }
    return result;
  }

  async preRouteV4(
    message,
    {
      duty,
      level,
      phase = null,
      stepIndex = null,
      sequence = null,
      // The flow the sequence came from and the level each of its duties runs at
      // (resolvedFlowPlan). Both ride through to the caller so a turn that becomes
      // a CARD stamps the same resolution the route was decided from - resolving it
      // twice is how the card and the run end up on different plans.
      flow = null,
      dutyLevels = null,
      routing = null,
      rejected = [],
      viaOverride = false,
      // §7.1/§7.5: the autonomy consult's answer for THIS decision, when one was
      // taken (null on every exempt lane). It rides onto the decision record so
      // the band a turn acted under is provable from the log alone, and onto the
      // returned frame so the card seam can hold, notice, or say nothing.
      autonomy = null,
      // Carried through from preRoute so a duty-routed decision names its
      // conversation too, not just the classifier-path decision below.
      sessionId = null,
      sessionTitle = null,
      implicitStickyTarget = false
    } = {}
  ) {
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
    // §7: honor the pin BEFORE the decision record and the plan/lane selection
    // below, so an overridden target.runtime actually changes which lane runs.
    const override = this._applyOverride(route, routing, { implicitTarget: implicitStickyTarget });
    const overridesApplied = [...(viaOverride ? ["duty", "level"] : []), ...override.applied];
    const overridesRejected = [...(Array.isArray(rejected) ? rejected : []), ...override.rejected];
    if (viaOverride) route.via = "turn-override";
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
      effort: route.target.effort ?? null,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(overridesApplied.length ? { overrides: overridesApplied } : {}),
      ...(autonomy ? { autonomy: autonomyDecisionRecord(autonomy) } : {})
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

    const personalScopeRefused = override.rejected.some(
      (entry) => entry?.field === "project" && entry?.reason === "personal-workspace-unavailable"
    );
    let plan;
    if (personalScopeRefused) {
      plan = { path: "refused", reasons: ["managed personal workspace unavailable"] };
    } else if (this.isAgentSdkTarget(route)) {
      plan = { path: "agent-sdk", reasons: [`v4 duty cell → agent-sdk ${route.target.provider}/${route.target.model}`] };
    } else if (this.usesScopedClaudeSession(route, override.projectPath)) {
      plan = {
        path: "claude-delegate",
        reasons: [override.projectPath
          ? `v4 duty cell → cwd-keyed Claude session at ${override.projectPath}`
          : `v4 duty cell → Claude delegate under ${this.primaryEngine} primary`]
      };
    } else if (this.isSecondaryTarget(route)) {
      plan = { path: "secondary", reasons: [`v4 duty cell → ${route.target.runtime}/${route.target.model}`] };
    } else {
      plan = await this.applySwitch(route);
    }
    // The sequence the caller already resolved wins; otherwise resolve one here -
    // the FLOW's duty list at this level when a levelled flow applies (carrying its
    // per-duty levels with it), else the duty ladder's.
    let flowPlan = null;
    if (!(Array.isArray(sequence) && sequence.length)) {
      try {
        flowPlan = await this.resolvedFlowPlan(duty, level, flow ?? routing?.flow ?? null);
      } catch (err) {
        this.logFn({ kind: "flow-plan-failed", duty, level, error: err?.message });
      }
    }
    const seq = Array.isArray(sequence) && sequence.length
      ? sequence
      : flowPlan?.sequence?.length
        ? flowPlan.sequence
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
      sequence: seq,
      // The flow that produced `sequence`, and the level each of its duties runs
      // at. Null for a duty-ladder sequence, and null is what the card seam reads
      // as "no per-duty levels" - a card without them behaves exactly as before.
      flow: flow ?? flowPlan?.flow ?? null,
      dutyLevels: dutyLevels ?? flowPlan?.dutyLevels ?? null,
      // The band this decision was taken under. Null on every exempt lane (a
      // card-originated turn, a schedule, an explicit pin) and null when the
      // consult was unavailable - both of which the card seam reads as "behave
      // exactly as before".
      autonomy,
      // Run-context bookkeeping the attribution helper folds onto every frame.
      // Pinned INTENT stays separate from what RAN: `overridesApplied` is what the
      // route actually carries now, `overridesRejected` is what was refused.
      overridesApplied: overridesApplied.length ? overridesApplied : null,
      overridesRejected: overridesRejected.length ? overridesRejected : null,
      project: override.project,
      projectPath: override.projectPath,
      // The v4 duty lane resolves an assigned cell directly and never calls
      // classify() at all - so this is unconditionally true here, where the
      // classifier-path preRoute has to earn it.
      classifierSkipped: true
    };
  }

  // classify → resolve role → resolve target → LOG at resolution time → switch.
  async preRoute(message, opts = {}) {
    this._lastUserMessage = message;
    // The per-turn pin (§2), already validated at the HTTP edge (sanitizeRouting),
    // plus the rejections that validation itself produced - one list reaches the
    // badge whether a value died on the wire or died here.
    const explicitRouting = opts.routing && typeof opts.routing === "object" ? opts.routing : null;
    const stickyTarget = typeof opts.routeSession?.signature?.target === "string"
      ? opts.routeSession.signature.target
      : null;
    const implicitStickyTarget = Boolean(stickyTarget && !explicitRouting?.target);
    // Keep a standing conversation on its durable target even while duty/flow
    // classification changes per request. Explicit target/model/account/project
    // fields still overlay this base and the gateway records a logical boundary
    // if the resulting resolved spawn signature differs.
    const ov = implicitStickyTarget
      ? { ...(explicitRouting ?? {}), target: stickyTarget }
      : explicitRouting;
    const rejected = Array.isArray(opts.routingRejected) ? [...opts.routingRejected] : [];
    // A Kanban phase carries the card's semantic v4 identity. It is authoritative:
    // resolve the assigned leaf cell from the shared execution manifest and never
    // send it through the legacy taskType×tier matrix.
    if (typeof opts.duty === "string" && Number.isInteger(opts.level) && typeof opts.phase === "string") {
      return this.preRouteV4(message, {
        duty: opts.duty,
        level: opts.level,
        phase: opts.phase,
        stepIndex: opts.stepIndex,
        sequence: opts.sequence,
        routing: ov,
        implicitStickyTarget,
        sessionId: opts.sessionId ?? null,
        sessionTitle: opts.sessionTitle ?? null,
        rejected
      });
    }
    // A duty+level pin re-enters the v4 duty lane - the lane the kanban engine
    // already drives - so the turn runs a REAL duty cell instead of a matrix route
    // wearing a duty label. An unresolvable cell is a rejection, not a throw: the
    // turn falls through to normal routing carrying the reason.
    if (ov?.duty && Number.isInteger(ov.level)) {
      try {
        return await this.preRouteV4(message, {
          duty: ov.duty,
          level: ov.level,
          routing: ov,
          implicitStickyTarget,
          rejected,
          viaOverride: true
        });
      } catch (err) {
        rejected.push({ field: "duty", reason: "duty-cell-unresolved" });
        this.logFn({
          kind: "turn-override-rejected",
          field: "duty",
          reason: "duty-cell-unresolved",
          error: String(err?.message ?? err)
        });
      }
    }
    // Compatibility migration: an explicit schema-v3 taskType/tier is already a
    // deterministic routing decision. Translate it to the single duty/level
    // vocabulary; never ask either Stage A or the inference model to reinterpret it.
    if (this._dispatcher && opts.classification) {
      const migrated = await this.legacyClassificationToV4(opts.classification);
      if (migrated) {
        // The caller-asserted matchedException is part of that decision, and the
        // duty cell it migrates onto knows nothing about it. Carry the exception's
        // configured target into the turn as a target pin: an explicit caller pin
        // still wins, and an unknown target is rejected (and recorded) by
        // applyTurnOverride rather than silently falling back to the cell.
        const exceptionTarget = this.exceptionTarget(opts.classification.matchedException);
        const routing = exceptionTarget && !ov?.target ? { ...(ov ?? {}), target: exceptionTarget } : ov;
        return this.preRouteV4(message, {
          ...migrated,
          routing,
          implicitStickyTarget,
          sessionId: opts.sessionId ?? null,
          sessionTitle: opts.sessionTitle ?? null,
          rejected
        });
      }
    }

    // All schema-v4 work enters through Orchestrator routing inference. Internal,
    // scheduled, and card-originated work takes deterministic policy only; only
    // an unpinned human channel may spend the bounded Haiku call.
    const origin = String(opts.channel || "").toLowerCase();
    const cardOriginated = cards.isCardOriginatedChannel(origin);
    if (this._dispatcher && !opts.classification) {
      const internalOrigin = !origin || /^(?:internal|scheduler|scheduled|heartbeat|job|kanban)/.test(origin);
      const dispatched = await this.dispatchRoute(message, {
        cardLevel: opts.cardLevel,
        deterministicOnly: cardOriginated || internalOrigin,
        // A pinned flow decides WHICH flow's duty list the sequence comes from.
        flow: ov?.flow ?? null
      });
      if (dispatched?.duty && Number.isInteger(dispatched.level)) {
        // §7.1/§7.5: consult the bands HERE - the route is known and the turn has
        // not opened yet, which is the only point where "ask first" is still an
        // available answer. Three lanes are exempt, each for its own reason:
        //
        //   • deterministicOnly (card-originated, scheduled, internal) - the work
        //     was ALREADY routed and, for a card, already authorised. Re-gating it
        //     would ask about a decision the user made when they made the card.
        //   • an explicit pin - a human naming the flow, duty, level or tier IS
        //     the answer. Asking them to confirm what they just said is the
        //     fastest way to train someone to stop reading the question.
        //
        // Anything else - an unpinned human request - gets the consult, and a
        // null answer (consult unavailable) means proceed exactly as before.
        const pinned = !!(ov && (ov.flow || ov.duty || Number.isInteger(ov.level) || ov.tier));
        const autonomy =
          cardOriginated || internalOrigin || pinned
            ? null
            : await this.autonomyFor({
                flow: dispatched.flow ?? null,
                duty: dispatched.duty,
                level: dispatched.level,
                // Both classes are `one-action` reversible, so this names what the
                // turn will DO rather than changing the arithmetic: a task-shaped
                // duty becomes a card (gateway-pty's D19 carding), and everything
                // else is an inline change to code or config. Naming it honestly
                // is what keeps the record readable when the taxonomy grows a
                // class that is NOT one-action.
                action: dispatched.duty && dispatched.duty !== "other" && dispatched.duty !== "dispatch"
                  ? "card-create"
                  : "code-change"
              });
        return this.preRouteV4(message, {
          duty: dispatched.duty,
          level: dispatched.level,
          sequence: dispatched.sequence,
          flow: dispatched.flow ?? null,
          dutyLevels: dispatched.dutyLevels ?? null,
          routing: ov,
          implicitStickyTarget,
          autonomy,
          sessionId: opts.sessionId ?? null,
          sessionTitle: opts.sessionTitle ?? null,
          rejected
        });
      }
      throw new Error("Orchestrator routing inference did not return a resolvable duty/level");
    }
    // Honor an EXPLICIT {taskType,tier} classification from the caller (the Kanban Loop
    // §10 contract: each agent-list carries its own classification) instead of
    // re-classifying from scratch — but ONLY when both values are in the router's
    // vocabulary. A malformed/out-of-vocab/absent hint is NOT trusted; it falls back to
    // the message classifier so a bad hint can never silently misroute a turn.
    const explicit = opts.classification;
    const validTask = Array.isArray(this.config.taskTypes) ? this.config.taskTypes : [];
    const validTier = Array.isArray(this.config.tiers) ? this.config.tiers : [];
    // RUN-SPEC-V1: the user's per-turn pin is a classification the user already
    // made. `duty` is the settable spelling of `taskType` and `tier` is pinnable
    // directly, so a turn that carries both is ALREADY classified and must not pay
    // for a classifier call. (A duty+level pin never reaches here - it took the v4
    // lane at :1825 - so this is the duty-WITHOUT-level case, which until now fell
    // silently through to the classifier.)
    const inList = (list, v) => typeof v === "string" && list.includes(v);
    const pinnedTask = inList(validTask, ov?.duty) ? ov.duty : null;
    const pinnedTier = inList(validTier, ov?.tier) ? ov.tier : null;
    const taskType = pinnedTask ?? (inList(validTask, explicit?.taskType) ? explicit.taskType : null);
    const tier = pinnedTier ?? (inList(validTier, explicit?.tier) ? explicit.tier : null);
    const honored = !!(taskType && tier);
    let raw = honored
      ? { taskType, tier, ...(explicit?.matchedException ? { matchedException: explicit.matchedException } : {}) }
      : await this.classify(message);
    // A pin that could not skip classification on its own still OVERRULES the
    // classifier's answer on the axis it names. Otherwise pinning a tier would
    // change nothing whenever the task type was left automatic - a control that
    // silently does nothing is worse than no control.
    if (!honored && (pinnedTask || pinnedTier)) {
      raw = { ...raw, ...(pinnedTask ? { taskType: pinnedTask } : {}), ...(pinnedTier ? { tier: pinnedTier } : {}) };
    }
    // D18: `execution` is no longer a classification axis. Where work runs is
    // derived from the resolved phase plan — a multi-phase or cross-model plan is
    // engine-dispatched, a trivial plan runs inline (see the D19 carding in
    // gateway-pty) — never from a per-turn execution flag. The classifier parser
    // still attaches a legacy `execution`; drop it here so it never re-enters the
    // routed decision, the decisions.jsonl record, or the preRoute output.
    const { execution: _legacyExecution, ...classification } = raw;
    if (honored) {
      this.logFn({
        kind: "classification-honored",
        taskType: classification.taskType,
        tier: classification.tier,
        skill: opts.skill ?? null,
        // Which side supplied it, so "no classifier ran" is attributable rather
        // than just asserted.
        source: pinnedTask || pinnedTier ? "turn-override" : "caller"
      });
    }
    const route = this.core.resolveRoute(this.config, this.config.activeProfile, classification);
    // §7: the pin lands HERE - after the route resolves, before the decision record
    // and before the plan/lane selection below reads route.target.runtime. Applying
    // it any later would change the badge and nothing else.
    const override = this._applyOverride(route, ov, { implicitTarget: implicitStickyTarget });
    rejected.push(...override.rejected);
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
    // Whether this decision cost a classifier turn. Persisted because it is the
    // evidence for "explicit choices are cheaper" - and because the Decisions feed
    // needs to distinguish a route the orchestrator picked from one the user did.
    decision.classifierSkipped = honored;
    // Which conversation caused this decision. Without it the Muster Decisions
    // feed is a list of routing outcomes with no way back to the turn that
    // produced them. An OPAQUE handle only - never the message, which stays a
    // digest.
    if (opts.sessionId) decision.sessionId = opts.sessionId;
    if (opts.sessionTitle) decision.sessionTitle = opts.sessionTitle;
    if (override.applied.length) decision.overrides = override.applied;
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
    const personalScopeRefused = override.rejected.some(
      (entry) => entry?.field === "project" && entry?.reason === "personal-workspace-unavailable"
    );
    const plan = personalScopeRefused
      ? { path: "refused", reasons: ["managed personal workspace unavailable"] }
      : !route.target
      ? { path: "noop", reasons: ["no target"] }
      : route.target.runtime === "agent-sdk"
        ? { path: "agent-sdk", reasons: [`agent-sdk runtime ${route.target.provider}/${route.target.model}`] }
        : this.usesScopedClaudeSession(route, override.projectPath)
          ? {
              path: "claude-delegate",
              reasons: [override.projectPath
                ? `cwd-keyed Claude session at ${override.projectPath}`
                : `Claude delegate under ${this.primaryEngine} primary`]
            }
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
    return {
      classification,
      route,
      decision,
      plan,
      annotation,
      carried: annotation.includes("context carried over"),
      overridesApplied: override.applied.length ? override.applied : null,
      overridesRejected: rejected.length ? rejected : null,
      project: override.project,
      projectPath: override.projectPath,
      // Reported, not inferred: the rail badges "no classifier ran" only when the
      // router can say so. `honored` is exactly that fact at the one place it is
      // known.
      classifierSkipped: honored
    };
  }

  // Stage B: move the live operative onto the resolved target.
  async applySwitch(route) {
    this.#warnIfUnroutable(route);
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
        this.operative.session.writeKeys(inj + "\r");
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
    this._agentSdkSessionMeta?.clear();
    this._currentAgentSdkKeyByCompatibility?.clear();
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
const KNOWN_PRIMARY_ENGINES = [
  "claude-code",
  "agent-sdk",
  "codex",
  "gemini",
  "opencode",
  "cursor",
  "openai-agents"
];

// Exec-style runtimes (a stateless `run`/`exec` subprocess per turn) that can ALSO
// host the PRIMARY: same resolveSecondaryDir + bridge-probe warm shape, only the
// adapter class name differs. opencode joined codex/gemini in S2c (the
// runtime-agnosticism matrix) — the uniform RuntimeAdapter contract is exactly what
// lets a non-Claude primary boot identically regardless of which exec engine it is,
// so leaving opencode out of this map (while it is a first-class runtime fitting)
// was an agnosticism gap, not a design choice. cursor joined on the same terms.
const EXEC_ADAPTER_CLASS = {
  codex: "CodexAdapter",
  gemini: "GeminiAdapter",
  opencode: "OpenCodeAdapter",
  cursor: "CursorAdapter"
};
const EXEC_RUNTIMES = new Set(Object.keys(EXEC_ADAPTER_CLASS));

// IN-PROCESS HTTP runtimes: they satisfy the same RuntimeAdapter contract and load
// through the same resolveSecondaryDir path, but there is NO CLI — the "session" is
// an HTTP client, so (a) there is no PATH to probe and (b) the endpoint, its key and
// the harness mode must be threaded onto spawnConfig or the adapter cannot resolve
// its provider at all. That is why they are a separate map from EXEC rather than
// four more keys in it: the exec spawn path forwards only `model`.
const HTTP_ADAPTER_CLASS = {
  "openai-agents": "OpenAiAgentsAdapter"
};

// The union is what "is this engine routable at all" means. Both lanes read it, so
// an engine is never executable as primary but invisible as a secondary target (or
// vice versa) because two lists drifted apart.
const SECONDARY_ADAPTER_CLASS = { ...EXEC_ADAPTER_CLASS, ...HTTP_ADAPTER_CLASS };
const ROUTABLE_RUNTIMES = new Set(Object.keys(SECONDARY_ADAPTER_CLASS));

// Target runtimes that legitimately reach applySwitch (the primary-session adjust
// path) instead of an execution lane of their own: the Claude PTY lanes, plus the
// single-shot dispatch / local-vision targets that are not session engines at all
// (`garrison-call` deliberately declares no `provides`). Anything ELSE arriving
// there is a mis-wired target — see #warnIfUnroutable.
const PRIMARY_ADJUST_RUNTIMES = new Set(["claude-code", "agent-sdk", "garrison-call", "ollama-native"]);

// The provider identity + fallback model each engine runs under when the routing
// target names none. Kept beside the adapter registry so adding an engine is one
// edit, not a chain of ternaries scattered through the turn path.
const EXEC_ENGINE_DEFAULTS = {
  codex: { provider: "openai", model: "gpt-5-codex" },
  gemini: { provider: "google", model: "gemini-2.5-flash" },
  opencode: { provider: "opencode", model: null },
  // `auto` lets Cursor pick from the signed-in account's catalog.
  cursor: { provider: "cursor", model: "auto" },
  // openai-agents has no single natural home — it is an endpoint family, not a
  // vendor. Default to the free local one so an unconfigured target cannot
  // accidentally bill a paid endpoint; a real composition names its provider.
  "openai-agents": { provider: "ollama-local", model: null }
};

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
        // The Agent SDK REPLACES the subprocess environment with options.env
        // (it does not merge process.env underneath). Seed baseEnv from the
        // gateway's own process env so the claude subprocess keeps PATH / HOME /
        // CLAUDE_CONFIG_DIR (dev-instance isolation) AND inherits the Paymaster
        // account pin the runner set on this process (GARRISON_ACCOUNT +
        // ANTHROPIC_AUTH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN). buildSdkEnv strips the
        // ANTHROPIC_* keys and re-derives them per provider, so this is safe for
        // an off-Anthropic primary too. Mirrors the codex/gemini exec path.
        env: process.env,
        ...(Number(operativeSpawnConfig.maxTurns) > 0 ? { maxTurns: Number(operativeSpawnConfig.maxTurns) } : {}),
        ...(operativeSpawnConfig.baseUrl ? { baseUrl: operativeSpawnConfig.baseUrl } : {}),
        ...(operativeSpawnConfig.leanPrompt ? { leanPrompt: operativeSpawnConfig.leanPrompt } : {}),
        ...(operativeSpawnConfig.secrets ? { secrets: operativeSpawnConfig.secrets } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {})
      },
      claude: false
    };
  }
  // In-process HTTP primaries (openai-agents). Shaped like the agent-sdk branch,
  // NOT like the exec branch: the endpoint, its by-name key, the harness mode and
  // the assembled system prompt all have to be threaded, because there is no CLI
  // holding any of that in its own config. The exec branch forwards `model` alone,
  // so an HTTP engine routed through it resolves no provider and dies on turn one.
  const httpCls = Object.hasOwn(HTTP_ADAPTER_CLASS, engine) ? HTTP_ADAPTER_CLASS[engine] : undefined;
  if (httpCls) {
    let adapter = opts.secondaryAdapters?.get?.(engine) ?? null;
    if (!adapter) {
      const dir = resolveSecondaryDir(compositionDir, engine);
      if (!dir) {
        throw new Error(
          `primaryRuntime names the ${engine} engine but the ${engine}-runtime fitting is not installed — compose it under the runtimes faculty (apm install), or switch primaryRuntime back to claude-code-runtime`
        );
      }
      const mod = await import(pathToFileURL(path.join(dir, "lib", `${engine}-adapter.mjs`)).href);
      adapter = new mod[httpCls]();
      // The bridge probe here proves the MODULE loads and its deps are installed
      // (`npm install` ran). It is not a network reachability check — the endpoint
      // is per-provider and may legitimately be unreachable until the vault is
      // unlocked, which must not block startup.
      if (opts.probeExecPrimaries !== false) await probeRuntimeBridge(dir, engine);
    }
    // This adapter consumes the prompt as an in-memory STRING (it becomes the
    // agent's `instructions`), like the SDK and unlike the CLI engines that read a
    // projected context file.
    let appendSystemPrompt;
    const promptFile = operativeSpawnConfig.appendSystemPromptFile;
    if (promptFile) {
      try {
        appendSystemPrompt = fs.readFileSync(promptFile, "utf8");
      } catch (err) {
        throw new Error(
          `${engine} primary: assembled system prompt unreadable at ${promptFile}: ${String(err?.message || err)}`
        );
      }
    }
    const defaults = EXEC_ENGINE_DEFAULTS[engine] ?? {};
    return {
      adapter,
      spawnConfig: {
        compositionDir,
        env: process.env,
        provider: operativeSpawnConfig.provider ?? defaults.provider,
        model: operativeSpawnConfig.model ?? defaults.model,
        promptMode: operativeSpawnConfig.promptMode ?? "full",
        ...(operativeSpawnConfig.baseUrl ? { baseUrl: operativeSpawnConfig.baseUrl } : {}),
        ...(operativeSpawnConfig.apiKeyEnv ? { apiKeyEnv: operativeSpawnConfig.apiKeyEnv } : {}),
        ...(operativeSpawnConfig.keyless != null ? { keyless: !!operativeSpawnConfig.keyless } : {}),
        ...(Number(operativeSpawnConfig.maxTurns) > 0 ? { maxTurns: Number(operativeSpawnConfig.maxTurns) } : {}),
        ...(operativeSpawnConfig.leanPrompt ? { leanPrompt: operativeSpawnConfig.leanPrompt } : {}),
        ...(operativeSpawnConfig.secrets ? { secrets: operativeSpawnConfig.secrets } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {})
      },
      claude: false
    };
  }
  // Object.hasOwn guards against prototype keys (e.g. engine === "toString")
  // slipping past the explicit unknown-engine throw below into exec resolution.
  const execCls = Object.hasOwn(EXEC_ADAPTER_CLASS, engine)
    ? EXEC_ADAPTER_CLASS[engine]
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
    // The composition's primary configuration is authoritative for
    // Codex/Gemini/Cursor (Cursor's model is a bare catalog id passed as
    // --model). OpenCode keeps its provider/model validation: only its required
    // `provider/model` shape may override native config. Reasoning effort is a
    // Codex control; do not claim or forward it to unsupported exec engines —
    // Cursor in particular carries effort inside the model id, so forwarding one
    // here would be a silently ignored knob.
    const spawnConfig = { compositionDir, env: process.env };
    if (
      (engine === "codex" || engine === "gemini" || engine === "cursor") &&
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
// claude-code primary: the operative adapter serves the classifier, exactly as
// before. agent-sdk primary: classify on the SAME engine — a lean, cheap SDK
// session on the classifier model — instead of spinning a Claude Code PTY just
// for classification (the point of an agent-sdk primary is no PTY dependency;
// a wedged PTY classifier would block every turn's pre-route). Other non-claude
// primaries (codex/gemini/opencode) keep the cheap PTY classifier when the CLI
// is present, and fall back to the primary adapter loudly when it is not.
export function resolveClassifierAdapter(ctx) {
  const { primary, primaryEngine, spawnFn, classifierSpawnConfig, opts, logFn } = ctx;
  if (primary.claude) {
    // claude-code primary → the operative adapter also serves the classifier.
    return { adapter: primary.adapter, spawnConfig: classifierSpawnConfig };
  }
  if (primaryEngine === "agent-sdk") {
    // Lean drops the appended orchestrator prompt and disables tools, so a
    // classification turn is a pure completion on the cheap model. The primary's
    // provider/secrets carry over; the account pin inherits via the process env.
    return {
      adapter: primary.adapter,
      spawnConfig: {
        ...primary.spawnConfig,
        model: classifierSpawnConfig?.model ?? "haiku",
        promptMode: "lean",
      },
    };
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
  const decisionsFile = opts.decisionsFile ?? path.join(compositionDir, ".garrison", "decisions.jsonl");
  let resolvedModelLib = opts.resolvedModelLib;
  let executionModel = opts.executionModel;
  // Production gateway-pty opts into v4 Orchestrator routing. Keeping the flag explicit
  // prevents pre-v4 tests (and old deployments with only model v1) from
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
      agentSdkAdapter: opts.agentSdkAdapter,
      primaryAdapter: primary.adapter,
      primaryEngine,
      inferenceConfig: config?.dispatchInference ?? {}
    });
    if (dispatcher) {
      opts.logFn?.({ kind: "dispatcher-wired", source: "composition-v4", call: dispatcher.configuredCall });
    }
  }
  if (!dispatcher && opts.fallbackDispatcher) {
    dispatcher = opts.fallbackDispatcher;
    opts.logFn?.({ kind: "dispatcher-wired", source: "control-fallback" });
  }

  // Schema-v4 may never fall back to the retired task-type/tier classifier: it
  // would reintroduce a second vocabulary and could contradict the duty model.
  // A missing projection/Orchestrator core is a composition-readiness failure,
  // not permission to silently route through Stage A.
  if (opts.enableV4Dispatcher === true && !dispatcher) {
    opts.logFn?.({
      kind: "dispatcher-unavailable",
      source: "composition-v4",
      fallback: null,
      reason: executionModel ? "Orchestrator dispatch core or dispatch duty unavailable" : "resolved v2 execution model unavailable"
    });
    throw new Error("schema-v4 routing requires Orchestrator dispatch inference and a resolved v2 execution model");
  }

  // Schema-v4 has one routing vocabulary and one inference call. Do not even
  // warm the old Stage-A classifier when an Orchestrator dispatcher exists; an
  // idle second session was both costly and a source of conflicting decisions.
  const classifier = opts.enableV4Dispatcher === true || dispatcher ? null : resolveClassifierAdapter({
    primary,
    primaryEngine,
    spawnFn,
    classifierSpawnConfig,
    opts,
    logFn: opts.logFn,
  });
  const runtimes = [
    { id: "operative", adapter: primary.adapter, role: "primary", size: 1, spawnConfig: primary.spawnConfig }
  ];
  if (classifier) {
    runtimes.push({ id: "classifier", adapter: classifier.adapter, role: "secondary", size: 1, spawnConfig: classifier.spawnConfig });
  }
  const pool = opts.pool ?? new MultiRuntimePool({
    maxTotal: opts.maxTotal ?? 4,
    runtimes
  });

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
    legacyClassifierEnabled: opts.enableV4Dispatcher !== true && !dispatcher,
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
  // Run-context seams (see the constructor): a call-time vault reader plus the
  // injectable project/account resolvers for a per-turn pin.
  gw.secretsFn = opts.secretsFn ?? null;
  gw._projectResolver = opts.resolveProject ?? null;
  gw._accountResolver = opts.resolveAccount ?? null;
  // Warm the level chain HERE rather than on first use: the HTTP edge validates a
  // pinned flow synchronously (sanitizeRouting) and reads `gw.flowAliases` to do
  // it, so a lazy load would silently reject a retired flow name on the first
  // request after every gateway start. Best-effort - _levelChain never throws, and
  // an absent chain leaves the map empty, which is the pre-level-chain behaviour.
  await gw._levelChain();
  return gw;
}
