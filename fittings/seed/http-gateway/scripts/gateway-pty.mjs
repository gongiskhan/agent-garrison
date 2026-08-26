#!/usr/bin/env node
/**
 * Agent Garrison HTTP gateway — PTY engine.
 *
 * The operative is a single, persistent INTERACTIVE `claude` TUI driven via
 * @garrison/claude-pty (node-pty + @xterm/headless). This replaces the
 * in-process Agent SDK (gateway-legacy.mjs). Real Claude Code: slash
 * commands, skills, hooks, and status line — all available.
 *
 * Endpoint surface is byte-compatible with gateway-legacy.mjs so the
 * web-channel and slack-channel relays work unchanged:
 *   POST /chat          { message }            → { reply, session_id, cost_usd }
 *   POST /chat/stream    { message }           → SSE open/session_event/chunk/tool/done/error
 *   POST /chat/interrupt { threadId, generationId } | { sessionId?, cardId? }
 *   POST /chat/permission { threadId, generationId, requestId, decision } → one live SDK resolver
 *   POST /jobs           { kind, ... }         → { ack, deduped } or retryable 503
 *   POST /attachments    { filename, content_base64 } → { path, bytes }
 *   GET  /health                               → { ok, session_id, uptime_ms, engine, pty_status }
 *
 * Environment (set by src/lib/runner.ts spawnGateway):
 *   GARRISON_GATEWAY_HOST / GARRISON_GATEWAY_PORT
 *   GARRISON_SYSTEM_PROMPT_PATH    → --append-system-prompt-file
 *   GARRISON_COMPOSITION_DIR       → cwd
 *   GARRISON_PERMISSION_MODE       → bypassPermissions | acceptEdits | plan | default
 *   GARRISON_MODEL                 → --model
 */

import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { realpathSync, statSync, readFileSync as readFileSyncFs, writeFileSync as writeFileSyncFs, mkdirSync as mkdirSyncFs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  OperativePtySession,
  captureLines,
  extractReply,
  parseActivity,
  openRichStream,
  richStatus,
  keySequence,
  cycleMode,
  enumerateCommandsCached,
  claudeProjectDirForCwd,
  readJsonlFrom,
  compactionsFrom,
  contextTokensFrom,
} from "@garrison/claude-pty";
import {
  createRoutedGateway,
  resolveModelRouterDir,
  shouldUseEphemeralSession,
  listVaultAccounts,
  autonomyHoldPlan,
  heldCardRoute,
  TURN_EFFORTS,
  normalizeFailureInfo
} from "./lib/gateway-routing.mjs";
import { listProjectNames, resolvePersonalScope } from "./lib/project-source.mjs";
import { SessionLog, runLog } from "@garrison/claude-pty";
import { createCompactController, resolveCompactConfig, COMPACT_TIMEOUT_MS } from "./lib/compact-controller.mjs";
import {
  isCardOriginatedChannel,
  isEmptyQuickReply,
  quickEmptyFailureReason,
  moveCardEngine
} from "./lib/autonomous-cards.mjs";
import { resolveDiscussInterception } from "./lib/discuss-intercept.mjs";
import { detectOverride, buildOverrideRecord, appendFeedback } from "./lib/feedback-queue.mjs";
import { createAskQuestionWatcher, answerKeySequence, resolveOptionIndex } from "./lib/ask-question.mjs";
import {
  createJobIngressGuard,
  forwardClaimWithRetry,
  isPendingJobClaim,
  jobDescription,
  prepareClaimForAcknowledgement
} from "./lib/job-ingress.mjs";
import {
  announceSession,
  touchSession,
  openGeneration as announceGenerationOpen,
  closeGeneration as announceGenerationClose,
  endSession
} from "./lib/session-registry.mjs";

const HOST = process.env.GARRISON_GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GARRISON_GATEWAY_PORT ?? "4777");
const SYSTEM_PROMPT_PATH = process.env.GARRISON_SYSTEM_PROMPT_PATH ?? "";
const COMPOSITION_DIR = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();
const COMPOSITION_ID = process.env.AGENT_GARRISON_COMPOSITION ?? path.basename(COMPOSITION_DIR);

// ── Session log run identity (Harness brief §1) ─────────────────────────────
// One append-only JSONL per Operative run; this process (and the in-process
// runtime adapters, via the shared @garrison/claude-pty module instance) is the
// single writer. The env var is how the adapters find the run.
const SESSION_LOG_RUN = `${COMPOSITION_ID}@${new Date().toISOString().replace(/:/g, "-")}`;
process.env.GARRISON_SESSION_LOG_RUN = SESSION_LOG_RUN;

// ── Local-API token (Harness brief §7) ──────────────────────────────────────
// Minted once per Garrison home, 0600. Server-to-server loopback callers may
// send it as x-garrison-token; its real job is that BROWSER pages cannot read
// it, so a browser-origin request without it is refused below.
const GATEWAY_TOKEN = (() => {
  try {
    const home = process.env.GARRISON_HOME?.trim() || path.join(homedir(), ".garrison");
    const file = path.join(home, "gateway-token");
    try {
      const existing = String(readFileSyncFs(file, "utf8")).trim();
      if (existing) return existing;
    } catch { /* mint below */ }
    const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    mkdirSyncFs(home, { recursive: true });
    writeFileSyncFs(file, token + "\n", { mode: 0o600 });
    return token;
  } catch {
    return randomUUID();
  }
})();
const PERMISSION_MODE = process.env.GARRISON_PERMISSION_MODE ?? "bypassPermissions";
const MODEL = process.env.GARRISON_MODEL ?? "opus";
const CLAUDE_BINARY = process.env.GARRISON_CLAUDE_BINARY ?? "claude";
// When the primary runtime selects a non-default provider, the runner sets
// ANTHROPIC_BASE_URL/AUTH_TOKEN + GARRISON_PROVIDER(_LAUNCH). providerLaunch keeps
// those vars through the orchestrator spawn instead of stripping them for Max-plan.
const PROVIDER_LAUNCH = process.env.GARRISON_PROVIDER_LAUNCH === "1";
const PRIMARY_PROVIDER = process.env.GARRISON_PROVIDER ?? "anthropic-plan";
// The agent-sdk primary resolves its provider spec from operativeSpawnConfig
// (baseUrl + capabilities). Historically we passed no provider there, so an
// agent-sdk-as-primary composition on a non-Anthropic provider (e.g.
// ollama-local) fell back to the "anthropic" spec — right endpoint only because
// the process env still carried ANTHROPIC_BASE_URL, but the wrong capability
// profile and a fence that leaned on inheritance. Thread the real provider so it
// is configured explicitly. The runner spells the Max-plan path "anthropic-plan";
// the SDK spec key for it is "anthropic".
const PRIMARY_SDK_PROVIDER = PRIMARY_PROVIDER === "anthropic-plan" ? "anthropic" : PRIMARY_PROVIDER;

const STARTED_AT = Date.now();
const SESSION_ID_FILE = path.join(COMPOSITION_DIR, ".garrison", "operative-session-id");

// ─────────────────────────────────────────────────────── module state
let session = null;
// Backwards-compatible status field for the disposable Web Claude lane. M7
// removed prompt materialization, so every new record reports assembledChars:0.
let lastMaterialized = null;
let ptyStatus = "spawning"; // spawning | ready | failed
let ptyError = null;
// 2026-08-07: the PTY-era GLOBAL turn chain is gone. Turns now serialize per
// execution lane: warm SDK sessions and cwd-keyed delegates queue inside
// RoutedGateway (_onLane), exec secondaries and disposable one-shots are
// independent by construction, and only work that touches the STANDING
// operative session waits here. Three run-killing starvations in one week
// (gemini flood, curation backlog, one 5-minute chat turn) all came from the
// global chain making every lane wait on every other lane's turn.
let operativeChain = null; // promise chain — STANDING-operative work only
function enqueueOperative(fn) {
  const previous = operativeChain ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => fn());
  operativeChain = next.catch(() => {});
  return next;
}
let router = null; // pre-session routing layer, null = legacy single-session
const jobIngress = createJobIngressGuard();

// Web Agent SDK permission control is deliberately process-local. Durable
// permission_request events survive a restart in the thread journal, but their
// resolver closures cannot; answering one of those restored prompts must return
// 409 instead of pretending a decision reached a dead query.
const PERMISSION_DECISIONS = new Set(["allow_once", "allow_always", "deny"]);

function permissionControlError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortedPermissionError(reason = "permission request is no longer active") {
  const error = permissionControlError(reason, "permission_request_aborted");
  error.name = "AbortError";
  return error;
}

function exactPermissionId(raw, max = 512) {
  if (typeof raw !== "string" || !raw || raw !== raw.trim() || raw.length > max) return null;
  return raw;
}

// Admission ids are generated by the trusted Web store and later used as an
// exact recovery coordinate. Reject controls and truncation instead of allowing
// two wire values to normalize onto one claimed generation.
export function exactDurableInputId(raw) {
  if (typeof raw !== "string" || !raw || raw !== raw.trim() || raw.length > 512) return null;
  return /[\u0000-\u001f\u007f]/.test(raw) ? null : raw;
}

/**
 * In-memory, generation-safe bridge from an HTTP decision to the exact SDK
 * canUseTool callback waiting for it. The factory is exported for focused tests;
 * production uses the singleton below.
 */
export function createPermissionControlPlane({ generateId = randomUUID } = {}) {
  const generations = new Map();

  const openGeneration = (threadId) => {
    const thread = exactPermissionId(threadId);
    if (!thread) throw permissionControlError("threadId is required", "invalid_permission_thread");
    const generationId = exactPermissionId(generateId());
    if (!generationId || generations.has(generationId)) {
      throw permissionControlError("could not create a unique permission generation", "invalid_permission_generation");
    }
    generations.set(generationId, { threadId: thread, pending: new Map() });
    return generationId;
  };

  const awaitDecision = (threadId, generationId, publicRequest, { signal } = {}) => {
    const thread = exactPermissionId(threadId);
    const generation = exactPermissionId(generationId);
    const requestId = exactPermissionId(publicRequest?.requestId);
    const requestGeneration = exactPermissionId(publicRequest?.generationId);
    const scope = generation ? generations.get(generation) : null;
    if (
      !thread ||
      !generation ||
      !requestId ||
      requestGeneration !== generation ||
      !scope ||
      scope.threadId !== thread
    ) {
      return Promise.reject(permissionControlError("permission generation is unavailable", "permission_generation_unavailable"));
    }
    if (scope.pending.has(requestId)) {
      return Promise.reject(permissionControlError("permission request is already pending", "permission_request_conflict"));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        inputComplete: publicRequest?.inputComplete === true,
        allowAlways:
          publicRequest?.inputComplete === true &&
          publicRequest?.suggestionsComplete === true &&
          Array.isArray(publicRequest?.suggestions) &&
          publicRequest.suggestions.length > 0,
        detachAbort: null,
      };
      const removeExact = () => {
        if (scope.pending.get(requestId) !== entry) return false;
        scope.pending.delete(requestId);
        entry.detachAbort?.();
        return true;
      };
      const abort = () => {
        if (removeExact()) reject(abortedPermissionError());
      };
      if (signal?.aborted) {
        reject(abortedPermissionError());
        return;
      }
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", abort, { once: true });
        entry.detachAbort = () => signal.removeEventListener?.("abort", abort);
      }
      scope.pending.set(requestId, entry);
    });
  };

  const decide = (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { status: 400, body: { error: "permission decision body must be an object" } };
    }
    const keys = Object.keys(raw).sort();
    if (
      keys.length !== 4 ||
      keys[0] !== "decision" ||
      keys[1] !== "generationId" ||
      keys[2] !== "requestId" ||
      keys[3] !== "threadId"
    ) {
      return { status: 400, body: { error: "only threadId, generationId, requestId, and decision are accepted" } };
    }
    const threadId = exactPermissionId(raw.threadId);
    const generationId = exactPermissionId(raw.generationId);
    const requestId = exactPermissionId(raw.requestId);
    const decision = typeof raw.decision === "string" && PERMISSION_DECISIONS.has(raw.decision) ? raw.decision : null;
    if (!threadId || !generationId || !requestId || !decision) {
      return { status: 400, body: { error: "threadId, generationId, requestId, and a valid decision are required" } };
    }
    const scope = generations.get(generationId);
    const entry = scope?.threadId === threadId ? scope.pending.get(requestId) : null;
    if (!entry) {
      return { status: 409, body: { error: "permission request is unavailable", code: "permission_request_unavailable" } };
    }
    if (decision === "allow_once" && !entry.inputComplete) {
      return { status: 422, body: { error: "allow once requires complete tool input", code: "permission_input_incomplete" } };
    }
    if (decision === "allow_always" && !entry.allowAlways) {
      return { status: 422, body: { error: "always allow is not available for this request", code: "allow_always_unavailable" } };
    }

    // Consume before resolving: two concurrent HTTP answers can never both win.
    scope.pending.delete(requestId);
    entry.detachAbort?.();
    entry.resolve(decision);
    return { status: 200, body: { ok: true, decision } };
  };

  const closeGeneration = (generationId, reason = "permission generation closed") => {
    const generation = exactPermissionId(generationId);
    const scope = generation ? generations.get(generation) : null;
    if (!scope) return false;
    generations.delete(generation);
    for (const entry of scope.pending.values()) {
      entry.detachAbort?.();
      entry.reject(abortedPermissionError(reason));
    }
    scope.pending.clear();
    return true;
  };

  return { openGeneration, awaitDecision, decide, closeGeneration };
}

const permissionControl = createPermissionControlPlane();
let readyResolve;
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve;
});

// RuntimeAdapter sessions deliberately have different shapes. Claude Code owns
// a PTY handle + getClaudeSessionId(); Agent SDK exposes sessionId; exec-style
// primaries such as Codex only carry {alive, config}. Generic HTTP/lifecycle
// paths must not turn Claude-only methods into adapter requirements.
function activeRuntimeSession() {
  return router?.getOperativeSession?.() ?? session;
}

function runtimeSessionId(sess = activeRuntimeSession()) {
  try {
    const id =
      typeof sess?.getClaudeSessionId === "function"
        ? sess.getClaudeSessionId()
        : typeof sess?.sessionId === "string"
          ? sess.sessionId
          : null;
    return typeof id === "string" && id.trim() ? id : null;
  } catch {
    return null;
  }
}

function runtimeSessionAlive(sess = activeRuntimeSession()) {
  if (!sess) return false;
  try {
    if (typeof sess.isDisposed === "function" && sess.isDisposed()) return false;
    if (typeof sess.isAlive === "function") return sess.isAlive() !== false;
    if (typeof sess.alive === "boolean") return sess.alive;
    return true;
  } catch {
    return false;
  }
}

// Runtime-neutral journal identity for any Claude-shaped session. PTY Claude
// versions do not always create the file, but when a session id exists the
// location is still deterministic and safe to advertise: the transcript SSE
// endpoint performs its own existence/confinement checks. Other runtimes report
// their identity directly through opts.onJournal instead of being forced into
// this Claude path convention.
function sessionJournalIdentity(sess, cwd = sess?.compositionDir ?? CANONICAL_COMPOSITION_DIR) {
  const sessionId = runtimeSessionId(sess);
  if (!sessionId) return null;
  let canonical = cwd;
  try {
    canonical = realpathSync(cwd);
  } catch {
    // A disposable cwd may have gone away after spawn; use the launch value.
  }
  return {
    session_id: sessionId,
    transcript_path: path.join(claudeProjectDirForCwd(canonical), `${sessionId}.jsonl`)
  };
}

function reportJournal(opts, identity, questionSession = null) {
  if (!identity?.session_id) return identity;
  bindQuestionJournal(identity, questionSession);
  if (typeof opts?.onJournal !== "function") return identity;
  try {
    opts.onJournal(identity);
  } catch {
    /* observability must never break the turn */
  }
  return identity;
}

function richPtyAvailable(sess = activeRuntimeSession()) {
  return runtimeSessionAlive(sess) && !!sess?.handle && typeof sess?.writeKeys === "function";
}

function primaryRuntime() {
  return router?.primaryEngine ?? process.env.GARRISON_PRIMARY_ENGINE ?? "claude-code";
}

function richUnavailable() {
  return {
    error: "rich Claude PTY controls are unavailable for this primary runtime",
    code: "RICH_PTY_UNAVAILABLE",
    primary_runtime: primaryRuntime(),
  };
}

// Active rich /claude/stream emitters. An agent-sdk turn runs OFF the PTY operative
// screen, so its reply is INJECTED into these connections (the rich UI renders an
// `assistant {text}` event the same whether screen-derived or injected).
const richClients = new Set();
function broadcastRich(event, data) {
  for (const emit of richClients) {
    try {
      emit(event, data);
    } catch {
      /* client gone */
    }
  }
}

// ─────────────────────────────────────── context telemetry (D5b / S1a)
// The operative's transcript (deterministic path from the pre-minted --session-id)
// carries per-assistant-event usage + compact_boundary events. We surface, per
// turn, the live contextPct + the session-lifetime peakContextPct (both off the
// session's peak tracker) plus a compaction count + last record read from the
// transcript. Every field is additive on the /claude/status + /chat/stream done
// payloads and null/zero when unknown — never load-bearing.
const CANONICAL_COMPOSITION_DIR = (() => {
  try {
    return realpathSync(COMPOSITION_DIR);
  } catch {
    return COMPOSITION_DIR;
  }
})();

// The operative session that ran/serves the turn: the routed layer's operative
// when routing, else the legacy single session. Null-safe.
function operativeSessionForTelemetry() {
  try {
    if (router && typeof router.getOperativeSession === "function") return router.getOperativeSession();
  } catch {
    /* routing layer mid-teardown — fall through */
  }
  return session;
}

// The operative PTY's current rendered screen as text lines, or null when no
// session is live (spawning, respawn wedge, torn down).
function renderedScreenLines() {
  const sess = operativeSessionForTelemetry();
  if (!sess?.handle) return null;
  try {
    return captureLines(sess.handle);
  } catch {
    return null;
  }
}

// Transcript telemetry: the compaction summary { count, last } AND the current
// context-tokens estimate (contextTokensFrom), both off ONE cached read. Re-scans
// only when the file grows (compaction count needs a full scan); cached by
// (file, size) so a hot /claude/status poll doesn't re-read a multi-MB transcript.
//
// S1b-fix1 — reality check: this OPERATIVE is a PTY/TUI session (claude spawned
// under node-pty), and claude 2.1.209 PTY sessions do NOT persist a transcript at
// all — no <session-id>.jsonl is ever written under ~/.claude/projects for them
// (verified live). So for the PTY operative `count` is always 0 and `contextTokens`
// is null: the live context signal is the status-line ctx% scraped off the screen,
// and the compact-log (./garrison/compact-log.jsonl) is the record of truth for
// compactions. This read still works for SDK-driven sessions (which DO persist) and
// for any future claude that journals PTY turns.
let transcriptCache = { file: null, size: -1, compactions: { count: 0, last: null }, contextTokens: null };
function readTranscript(sess) {
  const empty = { compactions: { count: 0, last: null }, contextTokens: null };
  const sid = sess?.getClaudeSessionId?.();
  if (!sid) return empty;
  const file = path.join(claudeProjectDirForCwd(CANONICAL_COMPOSITION_DIR), `${sid}.jsonl`);
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return empty; // transcript not written yet
  }
  if (transcriptCache.file === file && transcriptCache.size === size) {
    return { compactions: transcriptCache.compactions, contextTokens: transcriptCache.contextTokens };
  }
  let compactions = { count: 0, last: null };
  let contextTokens = null;
  try {
    const { events } = readJsonlFrom(file, 0);
    const list = compactionsFrom(events);
    if (list.length) {
      const last = list[list.length - 1];
      compactions = { count: list.length, last: { preTokens: last.preTokens, postTokens: last.postTokens, trigger: last.trigger, durationMs: last.durationMs } };
    }
    const t = contextTokensFrom(events);
    contextTokens = typeof t === "number" ? t : null;
  } catch {
    /* unreadable transcript — report no compactions rather than throw */
  }
  transcriptCache = { file, size, compactions, contextTokens };
  return { compactions, contextTokens };
}

// The compaction summary alone (S1a shape, kept for /claude/status + the done frame).
function readCompactions(sess) {
  return readTranscript(sess).compactions;
}

// The operative's current usage sample for the compact controller: live contextPct
// off the statusline (peak-tracked) plus the transcript context-tokens fallback.
function operativeUsageSample() {
  const sess = operativeSessionForTelemetry();
  let contextPct = null;
  try {
    const st = sess?.status?.();
    contextPct = typeof st?.contextPct === "number" ? st.contextPct : null;
  } catch {
    /* screen unreadable */
  }
  const { contextTokens } = readTranscript(sess);
  return { contextPct, contextTokens };
}

// ─────────────────────────────────────── compact controller (S1b, D1/D2/D5)
const COMPACT_LOG_FILE = path.join(COMPOSITION_DIR, ".garrison", "compact-log.jsonl");
async function appendCompactLog(record) {
  try {
    await fs.mkdir(path.dirname(COMPACT_LOG_FILE), { recursive: true });
    await fs.appendFile(COMPACT_LOG_FILE, JSON.stringify(record) + "\n");
  } catch {
    /* best-effort — a log-write failure must never break a boundary check */
  }
}
async function readCompactLog(limit = 50) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  try {
    const raw = await fs.readFile(COMPACT_LOG_FILE, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Inject `/compact <focus>` into the operative and await the compaction. A generous
// timeout (real compactions run 106-143s) overrides the 45s command default. Returns
// the turn outcome so the controller can see claude's response (e.g. the
// "Not enough messages to compact." refusal on very young sessions).
async function injectCompactIntoOperative(line, timeoutMs) {
  const sess = operativeSessionForTelemetry();
  if (!sess || typeof sess.runTurn !== "function" || !sess.isAlive?.()) {
    throw new Error("no live operative session to compact");
  }
  const message = line ? `/compact ${line}` : "/compact";
  const outcome = await sess.runTurn({ message, timeoutMs: timeoutMs ?? COMPACT_TIMEOUT_MS });
  // Command results render as TUI output lines, not assistant text, so the reply
  // may be empty — attach the visible screen tail so the controller can read
  // claude's response to the command itself.
  let screenTail = "";
  try {
    screenTail = captureLines(sess.handle).slice(-14).join("\n");
  } catch {
    /* screen unreadable — reply alone */
  }
  return { ...outcome, screenTail };
}

const compactController = createCompactController({
  resolveConfig: () => resolveCompactConfig(process.env),
  sampleUsage: async () => operativeUsageSample(),
  readCompactions: async () => readCompactions(operativeSessionForTelemetry()),
  injectCompact: injectCompactIntoOperative,
  logDecision: appendCompactLog,
});

// Lightweight focus context from a turn's route hints (the rich context comes from
// the engine's duty-boundary call). Empty -> the generic focus template variant.
function focusContextFromHints(hints) {
  if (!hints || typeof hints !== "object") return {};
  const out = {};
  if (typeof hints.dutyKey === "string" && hints.dutyKey) {
    const [cardId, phase] = hints.dutyKey.split(":");
    if (cardId) out.card_id = cardId;
    if (phase) out.duty = phase;
  }
  return out;
}

// Turn-boundary compaction check — runs inside the serialized chain AFTER a turn,
// before the next dequeues. Only the claude-code operative accumulates context
// across turns; a routed agent-sdk/secondary turn left it idle (its own runtime
// handles its own rebuild), so skip the PTY check there.
async function maybeCompactAtTurnBoundary(hints, result) {
  const sess = operativeSessionForTelemetry();
  if (!sess || !sess.isAlive?.()) return;
  // Routed mode has many non-operative success shapes (cards, steering,
  // delegates, one-shots, SDK and secondary lanes). Missing runtime metadata is
  // not proof that the shared operative accumulated context. Only the standing
  // branch marks that fact explicitly; router-null legacy mode keeps its former
  // single-session default below.
  if (router && result?.standingOperative !== true) return;
  // S3b: a web materialized turn ran one-shot on a disposable claude — it did NOT
  // accumulate context on the standing operative, so the compact controller must not
  // fire for it (the controller applies to real working sessions / duty dispatches).
  if (result?.materialized?.oneShot) return;
  const runtime = result?.runtime ?? "claude-code";
  if (runtime !== "claude-code") return;
  try {
    await compactController.check({
      sessionId: "operative",
      runtime: "claude-code",
      boundary: "turn",
      hold: hints?.contextHold === true,
      cardId: typeof hints?.dutyKey === "string" ? hints.dutyKey.split(":")[0] || null : null,
      dutyKey: typeof hints?.dutyKey === "string" ? hints.dutyKey : null,
      focusContext: focusContextFromHints(hints),
    });
  } catch {
    /* a boundary check must never break the turn chain */
  }
}

// { contextPct, peakContextPct, compactions } for the operative session. Sampling
// status() also folds the current contextPct into the session peak.
function contextTelemetry() {
  const sess = operativeSessionForTelemetry();
  if (!sess || typeof sess.status !== "function") {
    return { contextPct: null, peakContextPct: null, compactions: { count: 0, last: null } };
  }
  let contextPct = null;
  let peakContextPct = null;
  try {
    const st = sess.status();
    contextPct = typeof st?.contextPct === "number" ? st.contextPct : null;
    peakContextPct = typeof st?.peakContextPct === "number" ? st.peakContextPct : null;
  } catch {
    /* screen unreadable — leave nulls */
  }
  return { contextPct, peakContextPct, compactions: readCompactions(sess) };
}

// ─────────────────────────────────────── AskUserQuestion (tappable picker, D28)
// The operative's AskUserQuestion tool renders as a keyboard picker in the TUI. A
// phone/web channel has no arrow keys, so a background watcher tails the session
// JSONL, emits ONE `tool` SSE event per tool_use id (buttons on the client), and
// the answer POST drives the picker via keySequence. See lib/ask-question.mjs.
const pendingQuestions = new Map(); // tool_use_id -> { questions, at, cardId } (for label->index + binding)
let askWatcher = null;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Route watcher-originated AskUserQuestion payloads by their transcript, the
 * durable coordinate the watcher actually observed. Multiple runtime lanes can
 * finish in any order, so release is identity-checked: A finishing after B has
 * claimed a reused transcript can never erase B's ownership.
 */
export function createQuestionTurnRegistry({
  pending = new Map(),
  broadcastRichFn = () => {},
  nowFn = Date.now,
} = {}) {
  const ownersByTranscript = new Map();
  const transcriptsByOwner = new WeakMap();
  const transcriptKey = (value) =>
    typeof value === "string" && value.trim() ? path.resolve(value) : null;

  const bind = (owner, identity, { actuator = null } = {}) => {
    const transcript = transcriptKey(identity?.transcript_path);
    if (!owner || typeof owner !== "object" || !transcript) return false;
    const previous = ownersByTranscript.get(transcript);
    ownersByTranscript.set(transcript, {
      owner,
      // reportJournal may bind once with the concrete PTY session and its
      // observer may immediately bind the same identity again. Preserve the
      // exact actuator across that additive observability callback.
      actuator: actuator ?? (previous?.owner === owner ? previous.actuator ?? null : null),
    });
    let owned = transcriptsByOwner.get(owner);
    if (!owned) {
      owned = new Set();
      transcriptsByOwner.set(owner, owned);
    }
    owned.add(transcript);
    return true;
  };

  const lookup = (source = {}) => {
    const transcript = transcriptKey(source?.transcriptPath);
    return transcript ? ownersByTranscript.get(transcript) ?? null : null;
  };

  const deliver = (payload, source = {}) => {
    const binding = lookup(source);
    const owner = binding?.owner ?? null;
    if (payload?.tool_use_id) {
      pending.set(payload.tool_use_id, {
        questions: payload.questions,
        at: nowFn(),
        cardId: owner?.questionCardId ?? null,
        threadId: owner?.questionThreadId ?? null,
        actuator: binding?.actuator ?? null,
        owner,
      });
    }
    broadcastRichFn("tool", payload); // rich /claude/stream observers
    if (typeof owner?.questionSink === "function") {
      try {
        owner.questionSink(payload);
      } catch {
        /* a disconnected stream must never break the owning turn */
      }
    }
    return binding;
  };

  const release = (owner) => {
    if (!owner || typeof owner !== "object") return;
    for (const transcript of transcriptsByOwner.get(owner) ?? []) {
      if (ownersByTranscript.get(transcript)?.owner === owner) ownersByTranscript.delete(transcript);
    }
    transcriptsByOwner.delete(owner);
    // A question that outlived its exact turn (answered elsewhere, timed out, or
    // parked) must not hijack a later message, even when two turns share a card.
    for (const [id, entry] of pending) {
      if (entry?.owner === owner) pending.delete(id);
    }
  };

  return { ownersByTranscript, bind, lookup, deliver, release };
}

const questionTurns = createQuestionTurnRegistry({
  pending: pendingQuestions,
  broadcastRichFn: (type, payload) => broadcastRich(type, payload),
});

function questionActuatorForSession(questionSession) {
  if (!questionSession || typeof questionSession.writeKeys !== "function") return null;
  return {
    sessionId: runtimeSessionId(questionSession),
    available: () => richPtyAvailable(questionSession),
    write: (bytes) => questionSession.writeKeys(bytes),
  };
}

function bindQuestionJournal(identity, questionSession = null) {
  return questionTurns.bind(turnContext.getStore(), identity, {
    actuator: questionActuatorForSession(questionSession),
  });
}

function registerQuestionSession(questionSession, identity = null) {
  const owner = turnContext.getStore();
  if (!owner) return false;
  const resolvedIdentity = identity ?? sessionJournalIdentity(questionSession);
  return questionTurns.bind(owner, resolvedIdentity, {
    actuator: questionActuatorForSession(questionSession),
  });
}

const richQuestionOwner = {
  questionCardId: null,
  questionThreadId: null,
  questionSink: null,
};

// Start the JSONL AskUserQuestion watcher once the operative is ready. Idempotent.
function startAskWatcher() {
  // AskUserQuestion is a Claude TUI picker. Exec/API primaries have no screen or
  // key channel; their ordinary /chat endpoints remain available.
  if (askWatcher || !richPtyAvailable()) return;
  let projectDir;
  try {
    projectDir = claudeProjectDirForCwd(realpathSync(COMPOSITION_DIR));
  } catch {
    projectDir = claudeProjectDirForCwd(COMPOSITION_DIR);
  }
  askWatcher = createAskQuestionWatcher({
    projectDir,
    onQuestion: (payload, source) => {
      logEvent("stdout", { kind: "ask-question", tool_use_id: payload.tool_use_id, questions: payload.questions?.length ?? 0 });
      // Raw /claude/* input does not pass through runTurn, but its question still
      // has an exact transcript and PTY. Bind that session only when the watcher
      // source equals the currently active operative transcript; never fall back
      // from an unrelated one-shot/delegate transcript to the module-global PTY.
      if (!questionTurns.lookup(source)) {
        const active = activeRuntimeSession();
        const activeIdentity = sessionJournalIdentity(active);
        if (
          activeIdentity?.transcript_path &&
          path.resolve(activeIdentity.transcript_path) === path.resolve(String(source?.transcriptPath ?? ""))
        ) {
          questionTurns.release(richQuestionOwner);
          questionTurns.bind(richQuestionOwner, activeIdentity, {
            actuator: questionActuatorForSession(active),
          });
        }
      }
      questionTurns.deliver(payload, source);
    },
    logFn: (e) => logEvent("stderr", e),
  });
  askWatcher.start();
}

// Drive the live TUI picker with an ordered list of key names (down/enter/escape).
// A short dwell between keys lets each keypress register in the picker.
async function drivePicker(actuator, keyNames) {
  for (const name of keyNames) {
    const bytes = keySequence(name);
    if (!bytes) continue;
    await Promise.resolve(actuator.write(bytes));
    await sleepMs(140);
  }
}

// Answer an AskUserQuestion picker for the channel. Body: { tool_use_id, label? ,
// text?, dismiss? }. A matching option label drives arrow-down×index + Enter; a
// free-text ("Other...") answer types the text + Enter (best-effort - the picker
// may reject free text); dismiss sends Escape. Returns {status, body}.
export async function handleAnswer(body, {
  pending = pendingQuestions,
  trustedCardId = null,
} = {}) {
  const toolUseId = typeof body?.tool_use_id === "string" ? body.tool_use_id.trim() : "";
  const label = typeof body?.label === "string" ? body.label : "";
  const text = typeof body?.text === "string" ? body.text : "";
  const dismiss = body?.dismiss === true;
  if (!toolUseId) {
    return { status: 400, body: { error: "tool_use_id is required", code: "question_id_required" } };
  }
  const entry = pending.get(toolUseId) ?? null;
  if (!entry) {
    // Preserve the runtime-neutral refusal used by non-PTY primaries, but never
    // use the process-global operative as an actuator for a known question.
    if (pending === pendingQuestions && !richPtyAvailable()) {
      return { status: 503, body: richUnavailable() };
    }
    return { status: 404, body: { error: "unknown or expired question", tool_use_id: toolUseId } };
  }

  const suppliedThreads = [body?.session_id, body?.thread_id, body?.threadId]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  if (new Set(suppliedThreads).size > 1) {
    return { status: 400, body: { error: "conflicting question owner coordinates", code: "question_owner_invalid" } };
  }
  const suppliedThread = suppliedThreads[0] ?? null;
  if (entry.threadId) {
    if (!suppliedThread) {
      return { status: 400, body: { error: "session_id is required for this question", code: "question_owner_required" } };
    }
    if (suppliedThread !== entry.threadId) {
      return { status: 409, body: { error: "question belongs to another thread", code: "question_owner_mismatch" } };
    }
  } else if (suppliedThread) {
    // A Web thread may never actuate an unscoped rich/card question just because
    // it learned a tool id from another surface.
    return { status: 409, body: { error: "question does not belong to this thread", code: "question_owner_mismatch" } };
  }
  if (entry.cardId && trustedCardId && entry.cardId !== trustedCardId) {
    return { status: 409, body: { error: "question belongs to another card", code: "question_owner_mismatch" } };
  }

  const actionCount = Number(dismiss) + Number(label.length > 0) + Number(text.length > 0);
  if (actionCount !== 1) {
    return { status: 400, body: { error: "exactly one of label, text, or dismiss is required", code: "question_action_invalid" } };
  }
  const question = entry.questions?.[0] ?? null;
  const index = question ? resolveOptionIndex(question, label) : -1;
  if (label && index < 0) {
    return { status: 404, body: { error: "unknown option for question", tool_use_id: toolUseId } };
  }
  const actuator = entry.actuator;
  let available = false;
  try {
    available = !!actuator && actuator.available() !== false;
  } catch {
    available = false;
  }
  if (!available || typeof actuator?.write !== "function") {
    return { status: 409, body: { error: "question owner is no longer interactive", code: "question_owner_unavailable" } };
  }
  if (entry.answering) {
    return { status: 409, body: { error: "question answer is already in progress", code: "question_answer_in_progress" } };
  }

  entry.answering = true;
  try {
    if (dismiss) {
      await drivePicker(actuator, ["escape"]);
    } else if (text) {
      await Promise.resolve(actuator.write("\x15")); // Ctrl-U clear
      await Promise.resolve(actuator.write(text));
      await sleepMs(140);
      await drivePicker(actuator, ["enter"]);
    } else {
      await drivePicker(actuator, answerKeySequence(index));
    }
  } catch (err) {
    entry.answering = false;
    return {
      status: 500,
      body: { error: "question actuation failed", code: "question_actuation_failed" }
    };
  }
  if (pending.get(toolUseId) === entry) pending.delete(toolUseId);
  return dismiss
    ? { status: 200, body: { ok: true, action: "dismiss" } }
    : text
      ? { status: 200, body: { ok: true, action: "text" } }
      : { status: 200, body: { ok: true, action: "select", index, label } };
}

// Routing is ON whenever the model-router fitting is resolvable, unless
// explicitly disabled. The gateway then pre-routes every inbound message.
const ROUTING_ENABLED = process.env.GARRISON_ROUTING !== "0";
// Documented test seam: a module path exporting `spawnFn(config) -> session`.
// Lets the HTTP integration test drive the REAL gateway with a deterministic
// fake runtime (no live model). Production leaves it unset → real claude TUI.
const RUNTIME_STUB = process.env.GARRISON_GATEWAY_RUNTIME_STUB ?? "";

async function loadStubSpawnFn() {
  if (!RUNTIME_STUB) return null;
  try {
    const mod = await import(pathToFileURL(path.resolve(RUNTIME_STUB)).href);
    return mod.spawnFn ?? mod.default ?? null;
  } catch (err) {
    logEvent("stderr", { kind: "runtime-stub-load-failed", error: err.message });
    return null;
  }
}

// Build + start the routing layer. Returns true when the operative is served by
// the routing pool; false when routing is unavailable (caller falls back to the
// legacy single-session spawn).
// Write/refresh the shared stdio MCP config for spawned claude sessions (the
// routed gateway's shared MCP config: same file, same contract).
// Returns the exact PTY argv plus the same process-local SDK server map. SDK
// Queries use strictMcpConfig, so there is no hidden user/project MCP drift.
async function writeRoutedMcpConfig() {
  const gatewayScriptPath = path.join(COMPOSITION_DIR, "apm_modules", "_local", "mcp-gateway", "scripts", "gateway.mjs");
  try {
    await fs.access(gatewayScriptPath);
  } catch {
    logEvent("stdout", { kind: "mcp-config-skipped", reason: "mcp-gateway fitting not installed" });
    return { extraArgs: [], mcpServers: {} };
  }
  const filePath = path.join(COMPOSITION_DIR, ".garrison", "mcp.json");
  const mcpServers = {
    garrison: {
      command: "node",
      args: [gatewayScriptPath, "stdio"],
      env: {
        GARRISON_COMPOSITION_DIR: COMPOSITION_DIR,
        GARRISON_HTTP_GATEWAY_BASE_URL: `http://${HOST}:${PORT}`,
      },
    },
  };
  const cfg = { mcpServers };
  try {
    await fs.writeFile(filePath, JSON.stringify(cfg, null, 2), "utf8");
    logEvent("stdout", { kind: "mcp-config-written", path: filePath });
    return { extraArgs: ["--mcp-config", filePath, "--strict-mcp-config"], mcpServers };
  } catch (err) {
    logEvent("stderr", { kind: "mcp-config-write-failed", error: String(err?.message ?? err) });
    return { extraArgs: [], mcpServers: {} };
  }
}

async function initRouting() {
  if (!resolveModelRouterDir(COMPOSITION_DIR)) {
    logEvent("stdout", { kind: "routing-absent", message: "model-router fitting not found — legacy single-session" });
    return false;
  }
  await fs.mkdir(path.join(COMPOSITION_DIR, ".garrison"), { recursive: true });
  // garrison-control MCP for the operative (WS5 prep): write/refresh the shared
  // stdio mcp.json and pass it at
  // spawn so duty sessions can call fetch_evidence / create_continuation /
  // poll_origin_events. Graceful: no installed mcp-gateway -> no extra args.
  const routedMcp = await writeRoutedMcpConfig();
  const spawnFn = await loadStubSpawnFn();
  const continueSession = await hasPriorSession();
  router = await createRoutedGateway({
    compositionDir: COMPOSITION_DIR,
    compositionId: COMPOSITION_ID,
    appendSystemPromptFile: SYSTEM_PROMPT_PATH || undefined,
    agentSdkMcpServers: routedMcp.mcpServers,
    permissionMode: PERMISSION_MODE,
    decisionsFile: path.join(COMPOSITION_DIR, ".garrison", "decisions.jsonl"),
    spawnFn,
    // Production front door: load the runner-projected v4 execution manifest and
    // wire the Dispatcher. Pure routing tests leave this opt-in unset.
    enableV4Dispatcher: true,
    operativeSpawnConfig: {
      compositionDir: COMPOSITION_DIR,
      appendSystemPromptFile: SYSTEM_PROMPT_PATH || undefined,
      model: MODEL,
      permissionMode: PERMISSION_MODE,
      continueSession,
      claudeBinary: CLAUDE_BINARY,
      providerLaunch: PROVIDER_LAUNCH,
      // --mcp-config args (or []) so the operative carries the garrison MCP
      // tools; ClaudeCodeAdapter forwards this config verbatim to
      // OperativePtySession.spawn, which appends extraArgs to the claude argv.
      extraArgs: routedMcp.extraArgs,
      // Consumed only by the agent-sdk primary path (claude-code ignores it and
      // uses providerLaunch env). Makes an ollama-local / z.ai / … primary run
      // on its own provider spec instead of defaulting to "anthropic".
      provider: PRIMARY_SDK_PROVIDER,
      // Harness knobs from the primary fitting's selection config (runner env);
      // agent-sdk only — claude-code has no promptMode and no turn cap.
      ...(process.env.GARRISON_PRIMARY_PROMPT_MODE ? { promptMode: process.env.GARRISON_PRIMARY_PROMPT_MODE } : {}),
      ...(Number(process.env.GARRISON_PRIMARY_MAX_TURNS) > 0
        ? { maxTurns: Number(process.env.GARRISON_PRIMARY_MAX_TURNS) }
        : {}),
    },
    classifierSpawnConfig: {
      compositionDir: COMPOSITION_DIR,
      model: process.env.GARRISON_CLASSIFIER_MODEL ?? "haiku",
      permissionMode: PERMISSION_MODE,
      claudeBinary: CLAUDE_BINARY,
    },
    initialTarget: { provider: PRIMARY_PROVIDER, model: MODEL, effort: null },
    logFn: (e) => logEvent("stdout", { kind: "routing", ...e }),
  });
  await router.start();
  session = router.getOperativeSession();
  if (continueSession && continueWedged(session)) {
    logEvent("stderr", {
      kind: "continue-wedge",
      message: "claude --continue found no conversation to resume - clearing the stale session marker and respawning fresh",
    });
    await clearPriorSessionMarker();
    try {
      router.shutdown();
    } catch {
      /* best effort */
    }
    router = null;
    session = null;
    // The marker is gone, so the retry spawns WITHOUT --continue (bounded: the
    // wedge check is gated on continueSession).
    return initRouting();
  }
  ptyStatus = "ready";
  await markPriorSession();
  startAskWatcher();
  logEvent("stdout", { kind: "routing-ready", model: MODEL, profile: router.config?.activeProfile });
  return true;
}

function logEvent(stream, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), component: "http-gateway-pty", stream, ...payload });
  (stream === "stderr" ? process.stderr : process.stdout).write(line + "\n");
}

// ─────────────────────────────────────────────────────── session lifecycle

// A marker file recording that this composition has had at least one operative
// session, so a restart resumes the latest conversation via `claude --continue`
// (claude 2.1.x persists conversations for --continue even though they are not
// in the readable session JSONL; --resume <id> is unreliable for those).
async function hasPriorSession() {
  try {
    await fs.access(SESSION_ID_FILE);
    return true;
  } catch {
    return false;
  }
}

async function markPriorSession() {
  try {
    await fs.mkdir(path.dirname(SESSION_ID_FILE), { recursive: true });
    await fs.writeFile(SESSION_ID_FILE, runtimeSessionId() ?? "continue", "utf8");
  } catch (err) {
    logEvent("stderr", { kind: "persist-session-marker-failed", error: err.message });
  }
}

async function clearPriorSessionMarker() {
  try {
    await fs.unlink(SESSION_ID_FILE);
  } catch {
    /* already gone */
  }
}

// The session-marker wedge: the marker file says "continue" but this machine has
// no resumable conversation (fresh box, wiped ~/.claude, ...), so `claude
// --continue` renders a "No conversation found to continue" banner and the
// operative sits permanently wedged on it. Detect the banner on the freshly
// spawned screen so the caller can clear the stale marker and respawn fresh.
const CONTINUE_WEDGE_RE = /no conversation found to continue/i;

function continueWedged(sess) {
  try {
    if (!sess?.handle) return false;
    return captureLines(sess.handle).some((line) => CONTINUE_WEDGE_RE.test(line));
  } catch {
    return false;
  }
}

async function spawnOperative({ resume = true } = {}) {
  const continueSession = resume && (await hasPriorSession());
  const appendSystemPromptFile = SYSTEM_PROMPT_PATH || undefined;
  logEvent("stdout", {
    kind: "spawning",
    model: MODEL,
    permission_mode: PERMISSION_MODE,
    continue: continueSession,
    composition_dir: COMPOSITION_DIR,
  });
  session = await OperativePtySession.spawn({
    compositionDir: COMPOSITION_DIR,
    appendSystemPromptFile,
    model: MODEL,
    permissionMode: PERMISSION_MODE,
    continueSession,
    claudeBinary: CLAUDE_BINARY,
    providerLaunch: PROVIDER_LAUNCH,
  });
  if (continueSession && continueWedged(session)) {
    logEvent("stderr", {
      kind: "continue-wedge",
      message: "claude --continue found no conversation to resume - clearing the stale session marker and respawning fresh",
    });
    try {
      session.dispose();
    } catch {
      /* best effort */
    }
    session = null;
    await clearPriorSessionMarker();
    return spawnOperative({ resume: false });
  }
  ptyStatus = "ready";
  await markPriorSession();
  startAskWatcher();
  logEvent("stdout", { kind: "ready", session_id: session.getClaudeSessionId(), continued: continueSession });
  void touchSession(SESSION_LOG_RUN, "idle", { runtime: primaryRuntime() });
  readyResolve();
}

// ───────────────────────── per-turn run context (2026-07-25 decision)
//
// A web turn used to report ONE text chip and nothing else. These helpers are the
// gateway half of the contract: validate the channel's pinned intent (§2/§3),
// resolve the attribution ONCE (§6) instead of at nine branch-dependent returns,
// and expose the cancel registry (§9) + the menu source (§11).

// Field-length ceilings for the pinned intent. Ids stay short; a pin is a menu
// choice, not free prose (the one free-text field, `model`, is still bounded).
const PIN_ID_MAX = 120;

function pinnedString(raw, field, rejected) {
  if (typeof raw !== "string") {
    rejected.push({ field, reason: "not-a-non-empty-string" });
    return null;
  }
  const value = raw.trim();
  if (!value) {
    rejected.push({ field, reason: "not-a-non-empty-string" });
    return null;
  }
  if (value.length > PIN_ID_MAX) {
    rejected.push({ field, reason: "too-long" });
    return null;
  }
  // A pin is echoed back on the badge row and (for target/duty/project) used as a
  // lookup key - control characters have no business in either.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    rejected.push({ field, reason: "control-characters" });
    return null;
  }
  return value;
}

/**
 * The vocabularies the run-plan pins are validated against, read from the LIVE
 * routing config. Kept as an explicit parameter of sanitizeRouting (defaulted here)
 * rather than reached for inside it: the validator is pure and unit-tested, and a
 * hidden module-global would make a test pass while production rejected everything.
 *
 * An ABSENT config yields empty lists, which sanitizeRouting reports as
 * `policy-unavailable` rather than accepting the pin blindly. A pin the resolver
 * could not honor must die at the edge, with a reason - that is the whole contract.
 */
export function routingVocabulary(config = router?.config ?? null) {
  return {
    tiers: Array.isArray(config?.tiers) ? config.tiers.filter((t) => typeof t === "string") : [],
    flows:
      config?.flows && typeof config.flows === "object" && !Array.isArray(config.flows)
        ? Object.keys(config.flows)
        : [],
    phases: Array.isArray(config?.phases) ? config.phases.filter((p) => typeof p === "string") : [],
    // Retired flow name -> the flow that absorbed it. Part of the VOCABULARY, not
    // reached for inside the validator, for the same reason the lists above are:
    // a hidden module-global would make a test pass while production behaved
    // differently. The router publishes it once its level chain is loaded (see
    // RoutedGateway.flowAliases); empty means "no aliasing", which is how this
    // validator behaved before the flow library was rewritten.
    flowAliases: router?.flowAliases && typeof router.flowAliases === "object" ? router.flowAliases : {}
  };
}

/**
 * Validate a channel-supplied `TurnRouting` (§2). STRICT and closed: an invalid
 * value is DROPPED and recorded as a rejection, never coerced and never passed
 * through to the resolver. The rejection is what makes the badge read "override
 * rejected: <reason>" instead of quietly showing the composition default as if
 * the user's choice had been honored.
 *
 * @returns {{routing: object|null, rejected: {field: string, reason: string}[]}}
 */
export function sanitizeRouting(raw, vocabulary = routingVocabulary()) {
  const rejected = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { routing: null, rejected };
  const out = {};
  // A closed vocabulary that is EMPTY means the policy could not be read, not that
  // every value is invalid. Distinguish the two so the badge says "policy
  // unavailable" instead of blaming the user's choice.
  const inVocab = (list, value, field) => {
    if (!list.length) {
      rejected.push({ field, reason: "policy-unavailable" });
      return false;
    }
    if (list.includes(value)) return true;
    rejected.push({ field, reason: `${field}-not-in-vocabulary` });
    return false;
  };
  for (const field of ["target", "model", "duty", "project", "account"]) {
    if (raw[field] === undefined || raw[field] === null) continue;
    const value = pinnedString(raw[field], field, rejected);
    if (value !== null) out[field] = value;
  }
  // Whether the project above was CHOSEN by the user or DEFAULTED by Garrison.
  // It matters because an applied pin sets `via: "turn-override"`, which the
  // improver reads as "Goncalo corrected the router". Every project-less card now
  // carries the workspace scope, so without this marker every one of them would
  // arrive looking like a manual override and flood the signal registry with
  // evidence nobody produced.
  if (raw.projectDefaulted === true) out.projectDefaulted = true;
  if (raw.effort !== undefined && raw.effort !== null) {
    const effort = typeof raw.effort === "string" ? raw.effort.trim() : "";
    if (TURN_EFFORTS.includes(effort)) out.effort = effort;
    else rejected.push({ field: "effort", reason: "effort-not-in-vocabulary" });
  }
  if (raw.level !== undefined && raw.level !== null) {
    // A menu value may arrive as a digit string; anything else is refused rather
    // than Number()-coerced (Number("") === 0 and Number(true) === 1 both lie).
    const level = typeof raw.level === "number" ? raw.level : /^[0-9]+$/.test(String(raw.level)) ? Number(raw.level) : NaN;
    if (Number.isInteger(level) && level >= 1 && level <= 9) out.level = level;
    else rejected.push({ field: "level", reason: "level-not-an-integer-1-9" });
  }
  // The run-plan pins (RUN-SPEC-V1). `tier` and `flow` are validated against the
  // COMPILED POLICY's own vocabulary rather than a hardcoded list here - the policy
  // is the thing that will actually be resolved against, so a value this edge
  // accepted but the matrix cannot key on would be a pin that dies silently later.
  if (raw.tier !== undefined && raw.tier !== null) {
    const tier = pinnedString(raw.tier, "tier", rejected);
    if (tier !== null && inVocab(vocabulary.tiers, tier, "tier")) out.tier = tier;
  }
  if (raw.flow !== undefined && raw.flow !== null) {
    const pinned = pinnedString(raw.flow, "flow", rejected);
    // ALIAS FIRST, THEN VALIDATE. A pin can arrive from a surface that saved it
    // months ago, and the 2026-08-09 library rewrite retired six flow names.
    // Validating first would refuse a pin that names a flow which still exists
    // under another name - a rejection badge for a choice that is perfectly
    // honourable. The alias is a fallback: a config that still defines the old
    // name means it, so a live name never gets re-pointed.
    const aliases = vocabulary.flowAliases && typeof vocabulary.flowAliases === "object" ? vocabulary.flowAliases : {};
    const kind = pinned !== null && !vocabulary.flows.includes(pinned) ? aliases[pinned] ?? pinned : pinned;
    if (kind !== null && inVocab(vocabulary.flows, kind, "flow")) out.flow = kind;
  }
  // The two phase-override pins share one validation shape: a CSV of ids from
  // the policy's GLOBAL phase catalog. `phasesOff` skips plan phases;
  // `phasesOn` (2026-08-22, the routing modal) ADDS phases the resolved flow's
  // plan does not carry — which is exactly why both validate against the full
  // catalog, not the plan.
  for (const field of ["phasesOff", "phasesOn"]) {
    if (raw[field] === undefined || raw[field] === null) continue;
    const csv = pinnedString(raw[field], field, rejected);
    if (csv !== null) {
      const ids = csv.split(",").map((s) => s.trim()).filter(Boolean);
      if (!vocabulary.phases.length) {
        rejected.push({ field, reason: "policy-unavailable" });
      } else {
        const unknown = ids.filter((id) => !vocabulary.phases.includes(id));
        // ALL-or-nothing. Silently keeping the recognised half would turn "skip
        // these three gates" into "skip two of them" with nothing on the badge to
        // say so - and a phase the user believes is off would run.
        if (unknown.length) rejected.push({ field, reason: `unknown-phase:${unknown[0]}` });
        else if (ids.length) out[field] = ids.join(",");
      }
    }
  }
  return { routing: Object.keys(out).length ? out : null, rejected };
}

/**
 * The NEW attribution fields for one turn (§6) - the run context the gateway has
 * always known and never reported. PURE apart from reading the process account
 * pin. Merged as a PREFIX at the three returns of runRoutedTurn
 * (`{...turnAttribution(pre, hints), ...result}`), so a lane's own field always
 * wins and kanban-loop's fixed-field routeFromDone cannot break.
 */
export function turnAttribution(pre, hints, extra = {}) {
  const route = pre?.route ?? null;
  const target = route?.target ?? null;
  const applied = Array.isArray(pre?.overridesApplied) ? pre.overridesApplied : [];
  // account: a pin on the resolved target wins (an override sets exactly that),
  // else the process-wide pin the runner exported at launch, else NULL. Null is
  // reported, not omitted: "ran on this box's own Claude login" and "this lane
  // cannot say" are different facts and the rail renders them differently.
  const targetAccount = typeof target?.account === "string" && target.account.trim() ? target.account.trim() : null;
  const processAccount =
    typeof process.env.GARRISON_ACCOUNT === "string" && process.env.GARRISON_ACCOUNT.trim()
      ? process.env.GARRISON_ACCOUNT.trim()
      : null;
  const account = targetAccount ?? processAccount ?? null;
  const accountSource = targetAccount
    ? applied.includes("account")
      ? "override"
      : "target"
    : processAccount
      ? "process"
      : null;
  const level = pre?.level ?? route?.level ?? hints?.level ?? null;
  return {
    duty: pre?.duty ?? route?.duty ?? hints?.duty ?? null,
    level: Number.isInteger(level) ? level : null,
    phase: pre?.phase ?? route?.phase ?? route?.role ?? null,
    // Honest limit: no live composition stations a duty-* fitting, so every cell
    // resolves with no skill. Reported as null ("skill: none") rather than hidden.
    skill: pre?.skill ?? route?.skill ?? hints?.skill ?? null,
    via: route?.via ?? null,
    // RUN-SPEC-V1 run plan. `flow`/`phasesOff` are reported from the RESOLVED
    // hints (the pin when the user set one, the gateway's inference otherwise) so
    // the badge shows an auto-chosen plan instead of leaving it invisible - which is
    // the whole point of "if it was auto, say what it chose". `pre.flow` is the
    // third source and the newest: the flow the ROUTE resolved its sequence from
    // when nobody pinned one, which is the flow the turn is actually running.
    flow: hints?.flow ?? pre?.flow ?? null,
    phasesOff: phaseTogglesToCsv(hints?.phases),
    phasesOn: phaseTogglesOnToCsv(hints?.phases),
    // Undefined (not false) when the router did not say: an older lane that never
    // reports it must not be badged "a classifier ran" on no evidence.
    classifierSkipped: typeof pre?.classifierSkipped === "boolean" ? pre.classifierSkipped : null,
    account,
    accountSource,
    project: pre?.project ?? hints?.project ?? null,
    projectPath: pre?.projectPath ?? null,
    // preRoute folds the wire-validation rejections into its own list; hints are
    // the only source when the route never resolved.
    overridesApplied: applied.length ? applied : null,
    overridesRejected: pre?.overridesRejected ?? (hints?.routingRejected?.length ? hints.routingRejected : null),
    // Echoed on BOTH frames so the client can drop a frame belonging to an older
    // turn instead of writing it onto the newest bubble (§5).
    turnSeq: Number.isInteger(hints?.turnSeq) ? hints.turnSeq : null,
    ...publicRouteSessionFields(pre?.routeSession),
    ...extra
  };
}

/**
 * The already-existing RouteAttribution fields, read off the resolved route
 * BEFORE the turn runs, for the pre-turn `route` frame (§4). `effortApplied` and
 * `honored` are deliberately absent: neither is knowable yet, and the client
 * merges the done frame over this one.
 */
export function routeFieldsFrom(pre) {
  const route = pre?.route ?? null;
  const target = route?.target ?? null;
  return {
    route: route?.targetId ?? null,
    runtime: target?.runtime ?? null,
    provider: target?.provider ?? null,
    model: target?.model ?? null,
    effort: target?.effort ?? pre?.decision?.effort ?? null,
    taskType: pre?.decision?.taskType ?? pre?.classification?.taskType ?? null,
    tier: pre?.decision?.tier ?? pre?.classification?.tier ?? null,
    ruleId: pre?.decision?.ruleId ?? route?.ruleId ?? null,
    profile: pre?.decision?.profile ?? route?.profile ?? null
  };
}

const SPAWN_SIGNATURE_V1_KEYS = [
  "target",
  "runtime",
  "provider",
  "model",
  "account",
  "accountSource",
  "projectPath",
];
const SPAWN_SIGNATURE_V2_KEYS = ["version", ...SPAWN_SIGNATURE_V1_KEYS, "assembly"];
const ROUTE_SESSION_BOUNDARY_REASONS = new Set([
  "initial",
  "spawn-signature-changed",
  "restart-recovery",
  "resume-unavailable",
  "stateless-runtime",
]);
// Mirror the execution-lane defaults used by RoutedGateway. A policy target may
// omit an engine's conventional provider/model, but the durable signature must
// name the resolved values that the lane will actually use.
const ROUTE_SIGNATURE_RUNTIME_DEFAULTS = {
  "agent-sdk": { provider: "anthropic", model: null },
  "claude-code": { provider: PRIMARY_PROVIDER, model: MODEL },
  codex: { provider: "openai", model: "gpt-5-codex" },
  gemini: { provider: "google", model: "gemini-2.5-flash" },
  opencode: { provider: "opencode", model: null },
  cursor: { provider: "cursor", model: "auto" },
  "openai-agents": { provider: "ollama-local", model: null },
  "ollama-native": { provider: "ollama-local", model: null },
  // The "provider" of a remote-shell turn is the remote machine's own agent —
  // there is no vendor identity behind it, but the signature needs a resolved
  // name (the target's `model` slot carries the TRANSPORT, so it is always set).
  "remote-shell": { provider: "remote-shell", model: null },
};

function exactRouteSessionString(raw, max = 200) {
  if (typeof raw !== "string" || !raw || raw !== raw.trim() || raw.length > max) return null;
  return /[\u0000-\u001f\u007f]/.test(raw) ? null : raw;
}

/** Closed durable spawn identity. Effort is intentionally absent: it rotates a
 * standing Query through native resume without changing the logical session. */
export function sanitizeSpawnSignature(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw).sort();
  const v1 = keys.join("\0") === [...SPAWN_SIGNATURE_V1_KEYS].sort().join("\0");
  const v2 = keys.join("\0") === [...SPAWN_SIGNATURE_V2_KEYS].sort().join("\0") && raw.version === 2;
  if (!v1 && !v2) return null;
  const target = exactRouteSessionString(raw.target);
  const runtime = exactRouteSessionString(raw.runtime);
  const provider = exactRouteSessionString(raw.provider);
  const model = exactRouteSessionString(raw.model);
  const nullable = (key, max = 200) => raw[key] === null ? null : exactRouteSessionString(raw[key], max);
  const account = nullable("account");
  const accountSource = nullable("accountSource");
  const projectPath = nullable("projectPath", 4_000);
  if (!target || !runtime || !provider || !model) return null;
  if (raw.account !== null && !account) return null;
  if (raw.accountSource !== null && !accountSource) return null;
  if (raw.projectPath !== null && (!projectPath || !path.isAbsolute(projectPath))) return null;
  const base = { target, runtime, provider, model, account, accountSource, projectPath };
  if (v1) return base;
  const assembly = typeof raw.assembly === "string" && /^a1:[a-f0-9]{64}$/.test(raw.assembly)
    ? raw.assembly
    : null;
  return assembly ? { version: 2, ...base, assembly } : null;
}

/** Exact Web hint; unknown/partial fields cannot steer a live conversation. */
export function sanitizeRouteSession(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (Object.keys(raw).sort().join("\0") !== ["epoch", "signature"].sort().join("\0")) return null;
  const epoch = Number.isSafeInteger(raw.epoch) && raw.epoch >= 1 ? raw.epoch : null;
  const signature = sanitizeSpawnSignature(raw.signature);
  return epoch === null || !signature ? null : { epoch, signature };
}

export function resolvedSpawnSignature(pre, hints) {
  const target = pre?.route?.target ?? null;
  const attribution = turnAttribution(pre, hints);
  // Workflow targets are declarative aliases executed by the Claude operative;
  // unlike runtime-targets they intentionally carry no runtime/provider/model.
  // Sign what actually spawns, not the sparse workflow record.
  const workflow = target?.type === "workflow";
  const nativeVisionTurn = Array.isArray(hints?.images) &&
    hints.images.length > 0 &&
    target?.provider === "ollama-local";
  const defaults = ROUTE_SIGNATURE_RUNTIME_DEFAULTS[target?.runtime] ?? {};
  const base = {
    target: pre?.route?.targetId ?? null,
    runtime: nativeVisionTurn
      ? "ollama-native"
      : target?.runtime ?? (workflow ? "claude-code" : null),
    provider: target?.provider ?? (workflow ? PRIMARY_PROVIDER : defaults.provider ?? null),
    model: target?.model ?? (workflow ? MODEL : defaults.model ?? null),
    account: attribution.account ?? null,
    accountSource: attribution.accountSource ?? null,
    projectPath: pre?.projectPath ?? null,
  };
  const signature = sanitizeSpawnSignature(
    target?.runtime === "agent-sdk" && !nativeVisionTurn
      ? { version: 2, ...base, assembly: pre?.agentSdkAssembly?.digest ?? null }
      : base
  );
  if (signature) return signature;
  const error = new Error("resolved route does not provide a complete spawn signature");
  error.code = "invalid_spawn_signature";
  error.kind = "routing";
  error.source = "gateway";
  error.retryable = false;
  throw error;
}

/** Compute the next durable logical-session epoch before a runtime is touched. */
export function resolveRouteSession(pre, hints = {}) {
  const signature = resolvedSpawnSignature(pre, hints);
  const prior = sanitizeRouteSession(hints?.routeSession);
  const changed = prior && JSON.stringify(prior.signature) !== JSON.stringify(signature);
  const restart = hints?.agentSdkNewGeneration === true;
  // Web continuity is provided only by the generation-owned standing Agent SDK
  // Query. Claude one-shots, native vision, and secondary CLI turns are clean
  // executions; calling them "warm" would claim context they do not possess.
  const target = pre?.route?.target ?? null;
  const nativeVisionTurn = Array.isArray(hints?.images) &&
    hints.images.length > 0 &&
    target?.provider === "ollama-local";
  const statelessWebRuntime = hints?.channel === "web" &&
    (target?.runtime !== "agent-sdk" || nativeVisionTurn);
  const boundaryReason = !prior
    ? "initial"
    : restart
      ? "restart-recovery"
      : changed
        ? "spawn-signature-changed"
        : statelessWebRuntime
          ? "stateless-runtime"
          : null;
  return {
    epoch: prior ? prior.epoch + (boundaryReason ? 1 : 0) : 1,
    signature,
    boundaryReason,
    disposition: boundaryReason ? "new" : "warm",
    hadPrior: Boolean(prior),
  };
}

function publicRouteSessionFields(routeSession) {
  // A selected route is not yet a runtime session. Omit the coordinate entirely
  // until admission activates it; explicit null keys are rejected by the Web
  // proxy's exact route-session validator and would turn a valid pending badge
  // into a protocol failure.
  if (!routeSession) return {};
  return {
    sessionDisposition: routeSession?.disposition ?? null,
    sessionBoundaryReason: routeSession?.boundaryReason ?? null,
    sessionEpoch: Number.isSafeInteger(routeSession?.epoch) ? routeSession.epoch : null,
    spawnSignature: routeSession?.signature ?? null,
  };
}

const PUBLIC_ROUTE_SESSION_KEYS = [
  "sessionDisposition",
  "sessionBoundaryReason",
  "sessionEpoch",
  "spawnSignature",
];

function withoutPublicRouteSessionFields(attribution) {
  const out = { ...(attribution ?? {}) };
  for (const key of PUBLIC_ROUTE_SESSION_KEYS) delete out[key];
  return out;
}

export function controlTurnAttribution(pre, hints, extra = {}) {
  return withoutPublicRouteSessionFields(turnAttribution(pre, hints, extra));
}

/** One canonical route event per streamed generation. Revisions refine the same
 * logical event and keep order 0, so runtime content/terminal always follows it. */
export function createRouteSessionEventPublisher(pre, hints, opts = {}) {
  if (typeof opts.onSessionEvent !== "function") return { observe() {}, activate() {} };
  const generationId = exactPermissionId(opts.generationId);
  if (!generationId) return { observe() {}, activate() {} };
  const eventId = `route:${generationId}`;
  const ts = Date.now();
  const requestedModel = exactRouteSessionString(hints?.routing?.model);
  let revision = 0;
  let observed = {};
  let lastSignature = null;
  let routeSessionActive = opts.deferRouteSession !== true;
  const emit = () => {
    const baseAttribution = turnAttribution(pre, hints);
    const attribution = {
      ...(routeSessionActive
        ? baseAttribution
        : withoutPublicRouteSessionFields(baseAttribution)),
      ...routeFieldsFrom(pre),
      ...(routeSessionActive ? publicRouteSessionFields(pre?.routeSession) : {}),
      ...observed,
    };
    const routeBlock = {
      type: "route",
      attribution,
      ...(requestedModel ? { requestedModel } : {}),
    };
    const signature = JSON.stringify(routeBlock);
    if (signature === lastSignature) return;
    lastSignature = signature;
    revision += 1;
    try {
      opts.onSessionEvent({
        id: eventId,
        role: "assistant",
        ts,
        ...(hints?.turnSeq == null ? {} : { turnId: String(hints.turnSeq) }),
        order: 0,
        revision,
        generationId,
        blocks: [routeBlock],
      });
    } catch {
      /* a session-event transport sink must never break the turn */
    }
  };
  const applyObservation = (value = {}) => {
    if (!value || typeof value !== "object") return;
    if (["new", "warm", "resumed"].includes(value.sessionDisposition)) {
      pre.routeSession.disposition = value.sessionDisposition;
    }
    if (value.sessionBoundaryReason === null || ROUTE_SESSION_BOUNDARY_REASONS.has(value.sessionBoundaryReason)) {
      pre.routeSession.boundaryReason = value.sessionBoundaryReason;
    }
    if (Number.isSafeInteger(value.sessionEpoch) && value.sessionEpoch >= 1) {
      pre.routeSession.epoch = value.sessionEpoch;
    }
    const signature = sanitizeSpawnSignature(value.spawnSignature);
    if (signature) pre.routeSession.signature = signature;
    const model = exactRouteSessionString(value.model);
    if (model) observed.model = model;
    const sessionId = exactRouteSessionString(value.sessionId, 512);
    if (sessionId) observed.sessionId = sessionId;
  };
  return {
    observe(value = {}) {
      applyObservation(value);
      emit();
    },
    activate(value = {}) {
      routeSessionActive = true;
      applyObservation(value);
      emit();
    },
  };
}

export function gatewayFailureSessionEvent({ generationId, turnId = null, order = 1, failure, ts = Date.now() }) {
  const normalized = normalizeFailureInfo(failure, {
    code: "gateway_turn_failed",
    kind: "runtime",
    source: "gateway",
    retryable: false,
  });
  const generation = exactPermissionId(generationId) ?? "unscoped";
  return {
    id: `terminal:${JSON.stringify([generation])}`,
    role: "assistant",
    ts,
    ...(turnId == null ? {} : { turnId: String(turnId) }),
    order: Number.isSafeInteger(order) && order >= 1 ? order : 1,
    revision: 1,
    ...(generation !== "unscoped" ? { generationId: generation } : {}),
    blocks: [
      { type: "error", ...normalized },
      {
        type: "turn_end",
        status: "error",
        subtype: normalized.code,
        reason: normalized.code,
        stopReason: null,
        terminalReason: "error",
      },
    ],
  };
}

/** Additive pre-completion route frame. A runtime can refine it with journal
 * identity after preRoute without waiting for the turn's authoritative `done`. */
export function pendingRouteFrame(pre, hints, extra = {}) {
  const base = pre
    ? { ...turnAttribution(pre, hints), ...routeFieldsFrom(pre) }
    : { turnSeq: Number.isInteger(hints?.turnSeq) ? hints.turnSeq : null };
  return {
    ...base,
    ...extra,
    pending: true,
    turnSeq: Number.isInteger(hints?.turnSeq) ? hints.turnSeq : null
  };
}

// ───────────────────────── cancel registry (§9)
// One entry per IN-FLIGHT turn, keyed by the conversation the turn belongs to.
// Turns are serialized on the inflight chain, so this holds at most one live
// entry; the key still matters because a stale client id must 404 rather than
// stop somebody else's turn. `stop` is filled in by the LANE (the primitives
// differ per runtime and are only knowable once the route resolved), so an
// interrupt arriving before then reports the honest "no cancel primitive yet".
const activeTurns = new Map(); // sessionId -> { lane, stop: fn|null, cancelled, dutyKey, cardIds }
const INTERRUPT_FALLBACK_KEY = "operative";

/**
 * Exact-generation control for streamed Web turns. Unlike the legacy/card
 * registry above, a thread can have only one claimed generation and cleanup is
 * identity-checked so an older turn can never erase a newer claimant.
 */
export function createGenerationTurnControlPlane({ logFn = () => {} } = {}) {
  const turnsByGeneration = new Map();
  const currentGenerationByThread = new Map();

  const isCurrent = (entry) =>
    !!entry &&
    turnsByGeneration.get(entry.generationId) === entry &&
    currentGenerationByThread.get(entry.threadId) === entry.generationId;

  const claim = (threadId, generationId, options = {}) => {
    const lane = options?.lane ?? null;
    const inputWasSupplied = Object.hasOwn(options ?? {}, "inputId");
    const inputId = inputWasSupplied ? exactDurableInputId(options.inputId) : null;
    const thread = exactPermissionId(threadId);
    const generation = exactPermissionId(generationId);
    if (!thread || !generation || (inputWasSupplied && !inputId)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "threadId, generationId, and any supplied inputId must be valid",
          code: "invalid_turn_generation"
        }
      };
    }
    const currentGeneration = currentGenerationByThread.get(thread);
    if (currentGeneration) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "thread already has an active generation",
          code: "thread_generation_conflict"
        }
      };
    }
    if (turnsByGeneration.has(generation)) {
      return {
        status: 409,
        body: { ok: false, error: "generation is already active", code: "turn_generation_conflict" }
      };
    }
    const entry = {
      kind: "web-generation",
      threadId: thread,
      inputId,
      generationId: generation,
      lane,
      stop: null,
      stopPromise: null,
      stopOutcome: null,
      cancelRequested: false,
      cancelled: false,
      recoveryResetRequested: false,
      recoveryReset: null,
      releasePromise: null,
      dutyKey: null,
      cardIds: []
    };
    turnsByGeneration.set(generation, entry);
    currentGenerationByThread.set(thread, generation);
    return { status: 201, entry };
  };

  // A restarted Web process has only the durable admission id when it crashed
  // after the gateway claim but before persisting `open.generationId`. This
  // exact lookup lets it recover that otherwise-lost coordinate, interrupt the
  // orphaned Query, and wait for release before promoting the FIFO successor.
  const lookupInput = (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { status: 400, body: { ok: false, error: "generation lookup body must be an object" } };
    }
    const keys = Object.keys(raw).sort();
    if (keys.length !== 2 || keys[0] !== "inputId" || keys[1] !== "threadId") {
      return {
        status: 400,
        body: { ok: false, error: "generation lookup accepts only threadId and inputId" }
      };
    }
    const threadId = exactPermissionId(raw.threadId);
    const inputId = exactDurableInputId(raw.inputId);
    if (!threadId || !inputId) {
      return {
        status: 400,
        body: { ok: false, error: "threadId and inputId are required", code: "invalid_input_generation" }
      };
    }
    const generationId = currentGenerationByThread.get(threadId);
    const entry = generationId ? turnsByGeneration.get(generationId) : null;
    if (!entry || !isCurrent(entry)) {
      return {
        status: 404,
        body: { ok: false, error: "input generation is unavailable", code: "input_generation_unavailable" }
      };
    }
    if (entry.inputId !== inputId) {
      // Do not reveal another input's generation, but also do not tell restart
      // recovery that this thread is clear. This covers an in-flight legacy
      // claim made before inputId was deployed: the successor stays parked until
      // that claim naturally releases instead of receiving a destructive 409.
      return {
        status: 409,
        body: { ok: false, error: "thread belongs to another input", code: "thread_input_generation_conflict" }
      };
    }
    const state = entry.releasePromise
      ? "releasing"
      : entry.cancelRequested
        ? "stopping"
        : typeof entry.stop === "function"
          ? "running"
          : "starting";
    return {
      status: 200,
      body: {
        ok: true,
        threadId,
        inputId,
        generationId: entry.generationId,
        lane: entry.lane ?? null,
        state
      }
    };
  };

  const beginStop = (entry) => {
    if (entry.stopPromise) return entry.stopPromise;
    if (entry.stopOutcome) return Promise.resolve(entry.stopOutcome);
    if (!isCurrent(entry) || typeof entry.stop !== "function") return null;

    // Assign the shared promise before invoking user/runtime code. Concurrent
    // duplicate interrupts therefore converge on exactly one primitive call.
    // Invoke the primitive synchronously after that assignment: a latched stop
    // registered immediately before runtime entry must take effect before the
    // lane can advance to send/runTurn in the same JavaScript turn.
    let settleStop;
    const stopPromise = new Promise((resolve) => {
      settleStop = resolve;
    });
    entry.stopPromise = stopPromise;
    const settle = (outcome, { memoize = false } = {}) => {
      // A successful stop is terminal for this generation, so later duplicate
      // requests can reuse it without signalling the runtime again. A refused
      // or failed attempt is not terminal: settle every waiter coalesced onto
      // THIS attempt, then reopen the exact tuple so the UI's explicit Retry can
      // reach a primitive that has since become usable.
      entry.stopOutcome = memoize ? outcome : null;
      if (entry.stopPromise === stopPromise) entry.stopPromise = null;
      settleStop(outcome);
    };
    const succeeded = (value) => {
      const didStop = value !== false;
      if (!didStop) {
        logFn("stderr", {
          kind: "generation-interrupt-refused",
          lane: entry.lane,
          threadId: entry.threadId,
          generationId: entry.generationId
        });
        settle({
          status: 409,
          body: { ok: false, error: "cancel-primitive-did-not-stop", lane: entry.lane }
        });
        return;
      }
      entry.cancelled = true;
      logFn("stdout", {
        kind: "generation-interrupt",
        lane: entry.lane,
        threadId: entry.threadId,
        generationId: entry.generationId,
        stopped: true
      });
      settle(
        { status: 200, body: { ok: true, lane: entry.lane, stopped: true } },
        { memoize: true }
      );
    };
    const failed = (err) => {
      logFn("stderr", {
        kind: "generation-interrupt-failed",
        lane: entry.lane,
        threadId: entry.threadId,
        generationId: entry.generationId,
        error: String(err?.message ?? err)
      });
      settle({ status: 500, body: { ok: false, error: "cancel-failed", lane: entry.lane } });
    };
    try {
      Promise.resolve(entry.stop()).then(succeeded, failed);
    } catch (err) {
      failed(err);
    }
    // Keep the attempt-local handle: a synchronously throwing primitive clears
    // entry.stopPromise while settling, but this caller still needs its 500
    // result rather than mistaking the cleared registry slot for a pre-stop
    // latch and returning 202.
    return stopPromise;
  };

  const registerStop = (entry, lane, stop) => {
    if (!isCurrent(entry) || typeof stop !== "function") {
      return { registered: false, cancelRequested: false };
    }
    entry.lane = lane;
    // One generation owns one runtime primitive. A late duplicate registration
    // cannot replace the primitive an in-flight interrupt is already calling.
    if (typeof entry.stop !== "function") entry.stop = stop;
    if (entry.cancelRequested) void beginStop(entry);
    return { registered: true, cancelRequested: entry.cancelRequested };
  };

  const registerRecoveryReset = (entry, reset) => {
    if (!isCurrent(entry) || typeof reset !== "function") return false;
    if (typeof entry.recoveryReset !== "function") entry.recoveryReset = reset;
    return true;
  };

  const interrupt = async (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { status: 400, body: { ok: false, error: "interrupt body must be an object" } };
    }
    const keys = Object.keys(raw).sort();
    if (keys.length !== 2 || keys[0] !== "generationId" || keys[1] !== "threadId") {
      return {
        status: 400,
        body: { ok: false, error: "Web interrupt accepts only threadId and generationId" }
      };
    }
    const threadId = exactPermissionId(raw.threadId);
    const generationId = exactPermissionId(raw.generationId);
    if (!threadId || !generationId) {
      return {
        status: 400,
        body: { ok: false, error: "threadId and generationId are required", code: "invalid_turn_generation" }
      };
    }
    const entry = turnsByGeneration.get(generationId);
    if (!entry || entry.threadId !== threadId || !isCurrent(entry)) {
      return {
        status: 409,
        body: { ok: false, error: "turn generation is unavailable", code: "turn_generation_unavailable" }
      };
    }

    entry.cancelRequested = true;
    const stop = beginStop(entry);
    if (!stop) {
      // The request is latched. Registration will call the primitive (at most
      // once) and abort entry into the runtime before it can start useful work.
      return { status: 202, body: { ok: true, state: "pending-stop" } };
    }
    return stop;
  };

  // Process-restart recovery is stronger than a user Stop. The old SDK Query
  // and journal may contain an input/output the Web process never persisted, so
  // the lane must be abandoned before this thread can claim a successor.
  const recoverInput = async (raw) => {
    const found = lookupInput(raw);
    if (found.status !== 200) return found;
    const entry = turnsByGeneration.get(found.body.generationId);
    if (!entry || !isCurrent(entry)) {
      return {
        status: 404,
        body: { ok: false, error: "input generation is unavailable", code: "input_generation_unavailable" }
      };
    }
    entry.recoveryResetRequested = true;
    entry.cancelRequested = true;
    const stop = beginStop(entry);
    if (!stop) {
      return {
        status: 202,
        body: { ok: true, state: "pending-stop", generationId: entry.generationId }
      };
    }
    const result = await stop;
    return {
      ...result,
      body: { ...result.body, generationId: entry.generationId }
    };
  };

  const release = (entry) => {
    if (!isCurrent(entry)) return false;
    const finish = () => {
      if (!isCurrent(entry)) return;
      turnsByGeneration.delete(entry.generationId);
      currentGenerationByThread.delete(entry.threadId);
    };
    if (entry.recoveryResetRequested && typeof entry.recoveryReset === "function") {
      if (!entry.releasePromise) {
        entry.releasePromise = Promise.resolve()
          .then(() => entry.recoveryReset())
          .then(finish)
          .catch((err) => {
            logFn("stderr", {
              kind: "generation-recovery-reset-failed",
              threadId: entry.threadId,
              generationId: entry.generationId,
              error: String(err?.message ?? err)
            });
          });
      }
      return true;
    }
    finish();
    return true;
  };

  return {
    turnsByGeneration,
    currentGenerationByThread,
    claim,
    lookupInput,
    recoverInput,
    interrupt,
    registerStop,
    registerRecoveryReset,
    release,
    isCurrent
  };
}

const generationTurnControl = createGenerationTurnControlPlane({ logFn: logEvent });
// Concurrent turns (2026-08-07) can no longer share one module-global "current
// turn" cursor: each turn's registry entry rides its own async context, so a
// lane registering its stop primitive always lands on ITS turn even while other
// turns are mid-flight on other lanes.
const turnContext = new AsyncLocalStorage();

// Called by each lane once it owns something interruptible.
function registerTurnStop(lane, stop) {
  const entry = turnContext.getStore();
  if (!entry) return;
  if (entry.kind === "web-generation") {
    const registration = generationTurnControl.registerStop(entry, lane, stop);
    if (registration.cancelRequested) {
      const error = new Error("turn interrupted before runtime start");
      error.code = "turn_interrupted_before_runtime";
      throw error;
    }
    return;
  }
  entry.lane = lane;
  entry.stop = stop;
}

function registerTurnRecoveryReset(reset) {
  const entry = turnContext.getStore();
  if (entry?.kind !== "web-generation") return false;
  return generationTurnControl.registerRecoveryReset(entry, reset);
}

/** POST /chat/interrupt {sessionId?, cardId?} → {ok, lane} | 404 | 409.
 *
 * A card-bound interrupt fails closed unless the requested card belongs to the
 * active turn. Kanban does not allocate a conversation session per card (its
 * turns use the shared `operative` key), so sessionId alone cannot prevent a
 * queued card from stopping whichever card happens to be running. Batched turns
 * deliberately carry every member: panicking any one member stops the shared
 * runtime turn and the batch engine parks all of them.
 */
export async function handleInterrupt(body, turns = activeTurns, webTurns = generationTurnControl) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { ok: false, error: "interrupt body must be an object" } };
  }
  // Presence of either generation coordinate commits the request to the strict
  // Web union. A malformed/mixed request must never fall through to the legacy
  // fallback key and stop a card or operative turn.
  if (Object.hasOwn(body, "threadId") || Object.hasOwn(body, "generationId")) {
    return webTurns.interrupt(body);
  }
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "sessionId" && key !== "cardId")) {
    return { status: 400, body: { ok: false, error: "legacy interrupt accepts only sessionId and cardId" } };
  }
  const sessionId =
    typeof body?.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : INTERRUPT_FALLBACK_KEY;
  const entry = turns.get(sessionId);
  if (!entry) return { status: 404, body: { ok: false, error: "no-active-turn", sessionId } };
  const cardId = typeof body?.cardId === "string" && body.cardId.trim() ? body.cardId.trim() : null;
  const cardIds = Array.isArray(entry.cardIds)
    ? entry.cardIds.filter((id) => typeof id === "string" && id)
    : [];
  if (cardId && !cardIds.includes(cardId)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "active-turn-belongs-to-another-card",
        cardId,
        activeCardIds: cardIds
      }
    };
  }
  if (typeof entry.stop !== "function") {
    return { status: 409, body: { ok: false, error: "lane-has-no-cancel-primitive", lane: entry.lane } };
  }
  let stopped = false;
  try {
    stopped = (await entry.stop()) !== false;
  } catch (err) {
    logEvent("stderr", { kind: "interrupt-failed", lane: entry.lane, error: String(err?.message ?? err) });
    return { status: 500, body: { ok: false, error: "cancel-failed", lane: entry.lane } };
  }
  if (!stopped) {
    logEvent("stderr", { kind: "interrupt-refused", lane: entry.lane, sessionId, cardId, cardIds });
    return {
      status: 409,
      body: { ok: false, error: "cancel-primitive-did-not-stop", lane: entry.lane, cardIds }
    };
  }
  entry.interruptedByCardId = cardId;
  entry.cancelled = true;
  logEvent("stdout", { kind: "interrupt", lane: entry.lane, sessionId, cardId, cardIds, stopped });
  // The turn now settles normally with its partial reply; runTurn stamps
  // stoppedByUser onto the done frame.
  return { status: 200, body: { ok: true, lane: entry.lane, stopped, cardIds } };
}

// ── levelled-flow preview, mirrored ─────────────────────────────────────────
// The menu is built SYNCHRONOUSLY (GET /route/options is deliberately not behind
// the readiness await), and `levelPlanFor` lives in policy-core, which the
// gateway can only reach through an async dynamic import (routing-core does not
// re-export it). So the two reads a preview needs are mirrored here, and
// tests/level-chain.test.ts pins them to policy-core's originals.
const FLOW_LEVEL_KEYS = ["1", "2", "3"];

/** The level a flow runs at: what was asked, else its default, else 1. */
export function flowLevelKey(flow, requested) {
  const ok = (n) =>
    (typeof n === "number" || (typeof n === "string" && String(n).trim() !== "")) &&
    FLOW_LEVEL_KEYS.includes(String(Math.trunc(Number(n))));
  if (ok(requested)) return String(Math.trunc(Number(requested)));
  if (ok(flow?.defaultLevel)) return String(Math.trunc(Number(flow.defaultLevel)));
  return "1";
}

/** A flow level rendered as a phase plan ({phases, evidence}), or null when the
 *  flow carries no levels (the pre-2026-08-09 single-plan shape). */
export function flowLevelPlan(flow, requested) {
  if (!flow || !flow.levels || typeof flow.levels !== "object") return null;
  const lvl = flow.levels[flowLevelKey(flow, requested)];
  if (!lvl) return null;
  const duties = Array.isArray(lvl.duties) ? lvl.duties.filter((d) => typeof d === "string" && d) : [];
  return { phases: duties, evidence: lvl.evidence || "none" };
}

/**
 * Everything the Turn Rail's menus offer, in ONE read (§11). Sources are the
 * live routing config, the runner-projected v4 execution manifest, the
 * materialized vault and the dev-root - no new state, no second scan. Never
 * throws: an empty list disables a row, it does not 500 the menu.
 */
export function buildRouteOptions() {
  const config = router?.config ?? null;
  // A pinned target (the classifier) is infrastructure, not a routing choice.
  const targets = (Array.isArray(config?.targets) ? config.targets : [])
    .filter((t) => t && typeof t.id === "string" && t.pinned !== true)
    .map((t) => ({
      id: t.id,
      runtime: t.runtime ?? null,
      provider: t.provider ?? null,
      model: t.model ?? null,
      effort: t.effort ?? null,
      account: t.account ?? null
    }));
  // The v4 execution manifest is the duty vocabulary the board and the gateway
  // already share; the wired dispatcher's model is the compatibility fallback.
  const model = router?._executionModel ?? null;
  const dutyMap =
    (model?.duties && typeof model.duties === "object" ? model.duties : null) ??
    (router?._dispatcher?.model?.duties && typeof router._dispatcher.model.duties === "object"
      ? router._dispatcher.model.duties
      : {});
  const selectedDuties = Array.isArray(model?.selectedDuties)
    ? [...model.selectedDuties]
    : Array.isArray(router?._dispatcher?.model?.selectedDuties)
      ? [...router._dispatcher.model.selectedDuties]
      : [];
  const duties = Object.values(dutyMap)
    .filter((d) => d && typeof d.id === "string")
    .map((d) => ({
      id: d.id,
      title: typeof d.title === "string" && d.title ? d.title : d.id,
      levels: (Array.isArray(d.levels) ? d.levels : []).map((level, index) => ({
        n: index + 1,
        description: typeof level?.description === "string" ? level.description : ""
      }))
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const processAccount =
    typeof process.env.GARRISON_ACCOUNT === "string" && process.env.GARRISON_ACCOUNT.trim()
      ? process.env.GARRISON_ACCOUNT.trim()
      : null;
  let accounts = [];
  let projects = [];
  try {
    accounts = listVaultAccounts(COMPOSITION_DIR);
  } catch {
    accounts = []; // vault unreadable → the row is simply empty
  }
  try {
    // §8's confined enumerator: exactly the names resolveProjectName accepts, so
    // the menu can never offer a value the resolver would refuse.
    projects = listProjectNames();
  } catch {
    projects = [];
  }
  // The run-plan vocabularies (RUN-SPEC-V1), from the same live config the
  // validator checks pins against - so the menu and the edge can never drift into
  // offering something that would then be refused.
  const vocab = routingVocabulary(config);
  const phasePlans = config?.phasePlans && typeof config.phasePlans === "object" ? config.phasePlans : {};
  const flows = vocab.flows
    .map((id) => {
      const kind = config.flows[id] ?? {};
      // A LEVELLED flow (2026-08-09) has no phase plan at all - its ordered duty
      // list lives per level - so previewing only `phasePlans[kind.phasePlan]`
      // showed an EMPTY plan for every flow in the current library. Preview the
      // flow at its own default level, which is what an unpinned run gets.
      const plan = flowLevelPlan(kind) ?? phasePlans[kind.phasePlan] ?? null;
      return {
        id,
        description: typeof kind.description === "string" ? kind.description : null,
        // The plan's phases IN PLAN ORDER: this doubles as the preview of what the
        // run will walk, so the order is load-bearing, not cosmetic.
        phases: Array.isArray(plan?.phases)
          ? plan.phases.map((p) => (typeof p === "string" ? p : p?.id)).filter((p) => typeof p === "string")
          : [],
        // Which levels the flow defines, and the one an unpinned run resolves to,
        // so the menu can offer them instead of implying every flow is flat. Both
        // empty/null for the pre-levels shape, which genuinely has no levels to
        // offer - claiming "level 1" there would invent a dial that does nothing.
        levels: kind.levels && typeof kind.levels === "object" ? Object.keys(kind.levels).sort() : [],
        defaultLevel: kind.levels && typeof kind.levels === "object" ? Number(flowLevelKey(kind, undefined)) : null
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    targets,
    duties,
    selectedDuties,
    efforts: [...TURN_EFFORTS],
    accounts,
    // Null name = the box's own Claude login (the honest "machine login" badge).
    account: { name: processAccount, source: processAccount ? "process" : null },
    projects,
    tiers: vocab.tiers,
    // The tier prose from the policy (tierDefinitions), so a menu can say what
    // T1-standard MEANS instead of offering three bare ids.
    tierDefinitions:
      config?.tierDefinitions && typeof config.tierDefinitions === "object" ? { ...config.tierDefinitions } : {},
    flows,
    // The policy's GLOBAL ordered phase catalog — the same list pins validate
    // against, so the phases menu can offer out-of-plan phases (phasesOn)
    // without a client-side copy of the vocabulary.
    phaseCatalog: [...vocab.phases],
    defaultFlow: typeof config?.defaultFlow === "string" ? config.defaultFlow : null,
    primaryRuntime: primaryRuntime(),
    activeProfile: config?.activeProfile ?? null,
    // Routing may be off entirely (no orchestrator fitting) - the rail then shows
    // the menus as read-only rather than pretending a pin would be honored.
    routing: !!router
  };
}

/** Run one turn through pre-session routing: infer → resolve → log → switch →
 *  turn → honored check. The operative session is served by the routing pool.
 *  `opts.onPreRoute(pre)` fires the moment the route is known (the pre-turn
 *  `route` frame, §4); `opts.onActivity(payload)` carries tool activity;
 *  `opts.onSessionEvent(payload)` carries the channel-neutral Agent SDK event;
 *  `opts.onJournal({session_id,transcript_path})` fires as soon as a runtime's
 *  structured journal can be tailed, before the turn settles. */
// Liveness for the INTERACTIVE lane, which has no structured event stream: the
// TUI draws thinking and tool use instead of emitting them, so a channel sees
// nothing between "sent" and the final reply. Scrape the screen for the current
// activity and forward it as the same `activity` frame the routed SDK lanes emit.
//
// Deduped (a tool line stays on screen for the rest of the turn, so an undeduped
// emitter would repeat it forever) and throttled (onScreen fires on every
// repaint, which is many times a second while a spinner animates).
export function screenActivityEmitter(handle, onActivity, nowFn = Date.now) {
  if (typeof onActivity !== "function" || !handle) return () => {};
  let last = "";
  let lastAt = 0;
  return () => {
    const now = nowFn();
    if (now - lastAt < 400) return;
    lastAt = now;
    const activity = parseActivity(handle);
    if (!activity?.text) return;
    const key = `${activity.kind}:${activity.text}`;
    if (key === last) return;
    last = key;
    // Match the wire shape the SDK lanes already emit, or the client drops it:
    // a tool frame is keyed on `name`, a thinking frame on `text`.
    const payload =
      activity.kind === "tool"
        ? { kind: "tool", name: activity.text }
        : { kind: "thinking", text: activity.text };
    try {
      onActivity(payload);
    } catch {
      /* a streaming consumer must never break the turn */
    }
  };
}

async function runRoutedTurn(message, onChunk, hints, opts = {}) {
  // Session log (Harness brief §1): the injection is written BEFORE the runtime
  // sees it, and the settled outcome after — every lane, one seam.
  const slog = runLog();
  const turnLogId = hints?.threadId && Number.isInteger(hints?.turnSeq)
    ? `${hints.threadId}#${hints.turnSeq}`
    : randomUUID();
  slog?.append({
    domain: "channel", kind: "inbound", turn: turnLogId,
    payload: {
      channel: hints?.channel ?? null,
      message: typeof message === "string" ? message.slice(0, 4000) : null,
      routing: hints?.routing ?? null,
      cardIds: hints?.cardIds ?? null,
      flow: hints?.flow ?? null,
    },
  });
  try {
    // Thread the turn identity into the runtime lane: the adapters stamp it on
    // their session-log events (and the web lane's own id wins when present).
    const out = await runRoutedTurnInner(message, onChunk, hints, { ...opts, turnId: opts.turnId ?? turnLogId });
    slog?.append({
      domain: "channel", kind: "outbound", turn: turnLogId,
      runtimeSessionId: out?.session_id ?? null,
      payload: {
        route: out?.route ?? null,
        runtime: out?.runtime ?? null,
        model: out?.model ?? null,
        replyChars: typeof out?.reply === "string" ? out.reply.length : 0,
        stoppedReason: out?.stoppedReason ?? null,
      },
    });
    return out;
  } catch (err) {
    slog?.append({ domain: "channel", kind: "turn-error", turn: turnLogId, payload: { error: String(err?.message ?? err).slice(0, 500) } });
    throw err;
  }
}

async function runRoutedTurnInner(message, onChunk, hints, opts = {}) {
  await router.ensureOperative();
  // NOTE (S3d review R1): the Discuss reply-as-answer / explicit-go interception is NOT
  // here - it runs at the HTTP entry points BEFORE enqueueTurn (dispatchDiscussIntercept),
  // out-of-band from the serialized turn chain, so it can drive the LIVE picker while the
  // blocked discuss turn is holding the chain. Inside the chain it would deadlock.
  // hints (e.g. from the Kanban Loop) carry an EXPLICIT {taskType,tier} classification
  // so preRoute can honor §10 instead of re-classifying from scratch, plus the per-list
  // skill + suppressContinuations controls. Absent hints → classify as before.
  const pre = await router.preRoute(message, hints || {}); // classify/honor + resolve + LOG + switch
  if (router.isAgentSdkTarget(pre.route)) {
    const streamingInput = hints?.channel === "web" &&
      exactPermissionId(hints?.sessionId) &&
      exactPermissionId(opts?.generationId);
    pre.agentSdkAssembly = router.resolveAgentSdkAssembly(pre.route, {
      cwd: pre.projectPath ?? workspaceCwdFallback(),
      permissionMode: opts.permissionMode === "default" ? "default" : "bypassPermissions",
      streamingInput: Boolean(streamingInput),
    });
  }
  // Resolve the effort-free spawn identity and next logical epoch before any
  // runtime/provider lane is entered. This is the durable boundary the Web echoes
  // on its next request; an identical signature stays on the same epoch.
  pre.routeSession = resolveRouteSession(pre, hints || {});
  const routeEvents = createRouteSessionEventPublisher(pre, hints || {}, {
    ...opts,
    deferRouteSession: true,
  });
  // §4: emit the badge row NOW (pending), ~1s into the turn, instead of only at the
  // end. Everything the rail shows except the reply is already known here. The
  // client MERGES this frame with the one folded into `done`.
  if (typeof opts.onPreRoute === "function") {
    try {
      opts.onPreRoute({ ...pre, routeSession: null });
    } catch {
      /* a frame observer must never break the turn */
    }
  }
  routeEvents.observe();
  // Web workflow/skill selection is control-plane state. Enforce the native
  // control requirement before autonomous-card or runtime side effects; every
  // lane must either use a real control seam or fail visibly without rewriting
  // the admitted user message.
  assertWebPromptControls(pre, hints, router);
  const observeRouteSession = (observation = {}) => {
    routeEvents.observe(observation);
    try {
      opts.onRouteSessionObservation?.(observation);
    } catch {
      /* a compatibility frame observer must never break the turn */
    }
  };
  let routeSessionActivated = false;
  const activateRouteSession = () => {
    if (routeSessionActivated) return;
    const turn = turnContext.getStore();
    if (turn?.kind === "web-generation" && turn.cancelRequested) {
      const error = new Error("turn interrupted before runtime start");
      error.code = "turn_interrupted_before_runtime";
      throw error;
    }
    routeSessionActivated = true;
    const observation = publicRouteSessionFields(pre.routeSession);
    routeEvents.activate(observation);
    try {
      opts.onRouteSessionObservation?.(observation);
    } catch {
      /* a compatibility frame observer must never break the turn */
    }
  };
  const routedOpts = {
    ...opts,
    // A selected route is not a runtime session. Activate the durable logical
    // session only after the chosen lane has registered its Stop primitive and
    // is about to admit the exact user input. A latched pre-runtime Stop throws
    // from registration first, so it cannot advance the epoch or claim warm/
    // resumed continuity for a turn the runtime never received.
    onRuntimeAdmission: activateRouteSession,
    onRouteSessionObservation: observeRouteSession,
    onJournal: (identity) => {
      observeRouteSession({ sessionId: identity?.session_id ?? null });
      opts.onJournal?.(identity);
    },
  };
  assertExecutableRunScope(pre);
  // D19: EVERY task-shaped turn is a card. A trivial plan runs INLINE under a
  // `quick` card that auto-advances Implement→Done at completion; a multi-phase
  // (significant) plan is dispatched to the run engine (the reply carries the card
  // link, the turn does not run here). Card-/scheduler-/engine-originated turns are
  // already cards (the engine's own worker dispatches) — they run inline. A
  // follow-up turn about the same task attaches to the live card (no duplicate).
  let quickCard = null;
  // Attach follow-ups only within an IDENTIFIED conversation. When the surface
  // sends no session id (e.g. the raw console web surface), we do NOT fall back to
  // the channel literal ("web") — that key would collapse every console turn onto
  // one card and cross-attach distinct tasks (S7 review F1c). No id → no attach →
  // each task-shaped turn registers fresh.
  const sessionKey = hints?.sessionId || null;
  {
    const cls = pre.classification || {};
    const origin = String(hints?.channel || "").toLowerCase();
    const cardOriginated = isCardOriginatedChannel(origin);
    const v4TaskShaped = !!pre?.duty && pre.duty !== "other" && pre.duty !== "dispatch";
    if (!cardOriginated && (v4TaskShaped || router.isTaskShaped(cls))) {
      let attached = sessionKey ? await router.attachedCard(sessionKey, cls) : null;
      // S3b: a post-done follow-up on a web thread becomes a CONTINUATION card.
      let continueFrom = null;
      // S3b: durable thread→card lookup (heals gateway restarts — the in-RAM attach
      // map is memory-only). Only for web origins with a thread id.
      if (!attached && origin === "web" && sessionKey) {
        const resolved = await router.resolveThreadCard(`web:${sessionKey}`);
        if (resolved?.attach) {
          // Carry the full card (title/list/sequence) so we can classify steering.
          attached = { cardId: resolved.attach.id, card: resolved.attach };
          router.rememberCard(sessionKey, { cardId: resolved.attach.id, quick: false, taskType: cls.taskType });
        } else if (resolved?.continueFrom) {
          continueFrom = resolved.continueFrom;
        }
      }
      if (attached) {
        logEvent("stdout", { kind: "card-attached", id: attached.cardId, taskType: cls.taskType });
        // S3c: a mid-run message on a LIVE web card is STEERING. absorb/revisit post
        // to the board's steer endpoint and confirm in the thread; acknowledge falls
        // through to a normal one-shot answer (the classifier already logged evidence).
        // classifyAttachSteering resolves the full card even on the in-RAM attach path
        // (which carries only a cardId), so a 2nd+ same-session message still steers.
        const steered = origin === "web" ? await router.classifyAttachSteering({ attached, origin, message }) : null;
        if (steered) {
          const { steer, card } = steered;
          logEvent("stdout", { kind: "steering", id: card.id, action: steer.action, revisitDuty: steer.revisitDuty ?? null });
          if (steer.action === "absorb" || steer.action === "revisit") {
            const posted = await router.postSteer(card.id, {
              message,
              action: steer.action,
              revisitDuty: steer.revisitDuty ?? null,
              reason: steer.reason ?? null,
            });
            const reply =
              steer.action === "absorb"
                ? `Noted — folded into the current ${card.list} work.`
                : posted?.applied
                  ? `Going back to ${steer.revisitDuty} to include that.`
                  : `Going back to ${steer.revisitDuty} at the next duty boundary.`;
            broadcastRich("assistant", { text: reply });
            broadcastRich("turn", { active: false });
            if (onChunk && reply) onChunk(reply, true);
            // §6 site 1 of 3: PREFIX-merge the attribution so the lane's own
            // fields (here: card + steering) always win.
            return {
              ...controlTurnAttribution(pre, hints, { card: card.id, cardUrl: card.url ?? null }),
              reply,
              session_id: null,
              cost_usd: null,
              route: pre.route?.targetId ?? null,
              card: card.id,
              steering: { action: steer.action, revisitDuty: steer.revisitDuty ?? null },
            };
          }
          // acknowledge → fall through to execRoutedTurn (the S3b web one-shot).
        }
      } else {
        // S4b door-1 persistence: carry the resolved (duty, level, sequence) onto
        // the card when preRoute produced one — this happens when the Dispatcher
        // is wired (S3d opt-in). On the default classifier path these are
        // undefined and the payload builder keeps the pre-S4b card shape, so a
        // web-channel card FLOWS through the resolved sequence exactly when the
        // Dispatcher is active (divergence-zero at runtime, gated on the opt-in).
        // Tier discipline decides the card's phase plan when the caller sent
        // none (D2: inferPhasePlan, "recorded by the caller on the card") — a
        // T1-standard card runs plan/implement/review/test; only T2-deep walks
        // the adversarial/walkthrough/validate gates. Stamped TWICE, from the
        // same inference: as the phases-toggle map (the rail's honest off-chips)
        // AND as the card's ordered `sequence` (what it actually walks). Without
        // the sequence, a duty-less goal card follows the board's list-union
        // order — duty declaration order, not a pipeline — and marches from its
        // last phase into whatever list is declared next (seen live: Test → Image).
        let inferredPhases = hints?.phases ?? null;
        let pipelineSequence = null;
        if (!inferredPhases && !hints?.flow && cls.tier && router.core?.inferPhasePlan && router.core?.phaseTogglesFor) {
          try {
            const inferredPlan = router.core.inferPhasePlan(router.config, router.config.activeProfile, cls.tier);
            inferredPhases = router.core.phaseTogglesFor(inferredPlan);
            pipelineSequence = (inferredPlan.phases || [])
              .filter((ph) => (typeof ph === "string" ? true : ph.on !== false))
              .map((ph) => (typeof ph === "string" ? ph : ph.id));
            if (!pipelineSequence.length) pipelineSequence = null;
          } catch {
            inferredPhases = null;
            pipelineSequence = null;
          }
        }
        // Report the plan that was actually chosen, whoever chose it. Without this
        // the phases badge is blank on exactly the turns where the ORCHESTRATOR
        // picked the plan - which is the case the badge exists for. `hints` is the
        // per-turn object turnAttribution already reads, so this keeps one reporting
        // path instead of threading a second one through three lane returns.
        if (hints && inferredPhases && !hints.phases) hints.phases = inferredPhases;
        // The FLOW a card runs. Only an explicit client pin ever set this, so it
        // stayed null on every card the router created - which is why the flow
        // layer was configured but unused (2 of 90 live cards carried one, and
        // none ever ran a phased plan). With no pin, derive it deterministically
        // from the routed duty so a card arrives knowing which plan it is on.
        const routedDuty = pre?.duty ?? pre?.route?.duty ?? cls?.taskType ?? null;
        let derivedFlow = null;
        try {
          derivedFlow = router.core?.defaultFlowForDuty?.(router.config, routedDuty) ?? null;
        } catch {
          derivedFlow = null; // never block a card on flow derivation
        }
        // `pre.flow` is the flow the ROUTE actually resolved its sequence from
        // (resolvedFlowPlan). Prefer it over re-deriving: deriving twice is how a
        // card and the run that produced it end up on two different plans. An
        // explicit pin still wins, as it always did.
        const cardFlow = hints?.flow ?? pre?.flow ?? derivedFlow;
        // The per-duty levels only travel when they belong to the flow the card
        // will actually carry - a pin that overrode the routed flow invalidates
        // them, and a card is better off with none (every phase then runs at the
        // card's own level, the pre-level-chain reading) than with levels resolved
        // from a different flow.
        const cardDutyLevels = pre?.flow && pre.flow === cardFlow ? (pre.dutyLevels ?? null) : null;
        const cardOpts = {
          flow: cardFlow,
          phases: inferredPhases,
          project: hints?.project ?? null,
          duty: pre?.duty ?? pre?.route?.duty,
          level: pre?.level ?? pre?.route?.level,
          sequence: pre?.sequence ?? pre?.route?.sequence ?? pipelineSequence,
          dutyLevels: cardDutyLevels,
          // A composite card starts on its first resolved leaf, not the legacy
          // hardcoded Plan list (a valid workflow may begin at implement/research).
          targetList: (pre?.sequence ?? pre?.route?.sequence ?? pipelineSequence)?.[0] ?? undefined,
          // Where the task came from, so the run engine can post the outcome
          // back to the originating channel thread when the card completes.
          originChannel: origin && sessionKey ? { channel: origin, threadId: sessionKey } : null,
          // S3b: a post-done follow-up continues the predecessor card (its prompt is
          // seeded from the predecessor's handoff packet — WS2).
          ...(continueFrom ? { continues: continueFrom } : {})
        };
        const naturalSignificant = Array.isArray(pre?.sequence) && pre.sequence.length > 1
          ? true
          : typeof router.core?.isSignificantAutonomous === "function" && router.core.isSignificantAutonomous(cls);
        // D20: a conversational override in the operator's words reclassifies the
        // plan (full pipeline / just do it quickly / run in the background). When it
        // FLIPS the natural resolution, the gateway records ONE override event to the
        // Improver queue carrying both resolutions (agreement is never recorded).
        const override = detectOverride(message);
        let significant = naturalSignificant;
        if (override) {
          significant = override.plan === "full";
          if (significant !== naturalSignificant) {
            const resolution = (sig) => ({
              taskType: cls.taskType,
              tier: cls.tier,
              flow: hints?.flow ?? null,
              plan: sig ? "full" : "quick",
            });
            try {
              await appendFeedback(
                buildOverrideRecord({
                  session_id: hints?.sessionId ?? null,
                  answer: override.answer,
                  original: resolution(naturalSignificant),
                  applied: resolution(significant),
                })
              );
              logEvent("stdout", { kind: "override-feedback", answer: override.answer, applied: significant ? "full" : "quick" });
            } catch (err) {
              logEvent("stderr", { kind: "override-feedback-failed", error: err.message });
            }
          }
        }
        // §7.1/§7.5: the autonomy band decides HOW this runs, not whether the
        // router was right. Below the lower threshold the card is created but
        // HELD - the work waits for a go rather than starting and apologising -
        // and that applies identically to a quick (inline) turn, which is the case
        // that matters most: a board-side hold cannot help a turn that never
        // reaches the board, so the decision has to happen here, before the turn
        // opens. Above the threshold nothing changes except that the card carries
        // the band, so the board can say what it is doing (act-revert) or note it
        // in passing (act-inform).
        const autonomy = pre?.autonomy ?? null;
        const holdPlan = autonomyHoldPlan(autonomy, {
          significant,
          sequence: pre?.sequence ?? null,
          targetList: cardOpts.targetList ?? null
        });
        if (holdPlan.hold) {
          const resumeList = holdPlan.resumeList;
          const card = await router.createAutonomousCard(message, cls, {
            ...cardOpts,
            // A held card sits in the board's capture list, which is manual and
            // never auto-dispatched. That is the hold: no flag has to win a race
            // with a tick, because nothing dispatches from Backlog in the first
            // place. The flag is what the guards, the board UI and the resume path
            // read.
            targetList: "backlog",
            autonomyHeld: true,
            autonomyAsk: {
              question: autonomy.question,
              reason: autonomy.reason ?? null,
              band: autonomy.band,
              bands: autonomy.decisions ?? null,
              flow: pre?.flow ?? cardOpts.flow ?? null,
              duty: pre?.duty ?? null,
              level: pre?.level ?? null,
              tier: cls.tier ?? null,
              // The routing decision this question is ABOUT, so the answer can be
              // attributed back to it in the Signals view instead of floating free.
              decisionId: pre?.decision?.id ?? null,
              resumeList,
              at: new Date().toISOString()
            }
          });
          if (card) {
            // The budget counts questions POSED, and this one is about to be: the
            // board asks it through the card's origin thread the moment the card
            // exists (handleCreateCard), and the reply below carries it inline.
            await router.recordAutonomyAsked();
            router.rememberCard(sessionKey, { cardId: card.id, quick: false, taskType: cls.taskType });
            const reply = `${autonomy.question}\nCard: ${card.url}`;
            broadcastRich("assistant", { text: reply });
            logEvent("stdout", {
              kind: "autonomy-held",
              id: card.id,
              band: autonomy.band,
              reason: autonomy.reason ?? null,
              resumeList
            });
            return {
              ...controlTurnAttribution(pre, hints, { card: card.id, cardUrl: card.url ?? null }),
              reply,
              session_id: null,
              cost_usd: null,
              route: pre.route?.targetId ?? null,
              card: card.id,
              cardUrl: card.url,
              autonomy: { band: autonomy.band, held: true }
            };
          }
          // Board unavailable. Every other card failure here falls through and
          // runs inline; this one must NOT - running is exactly what the band
          // forbids. So ask in the thread and run nothing. The loop still closes:
          // the answer is an ordinary next message, and a pin ("as a fix at level
          // 2") exempts the consult, so the user is never stuck with a question
          // they cannot act on.
          await router.recordAutonomyAsked();
          logEvent("stderr", { kind: "autonomy-held-uncarded", band: autonomy.band, reason: autonomy.reason ?? null });
          const reply = autonomy.question;
          broadcastRich("assistant", { text: reply });
          broadcastRich("turn", { active: false });
          if (onChunk && reply) onChunk(reply, true);
          return {
            ...controlTurnAttribution(pre, hints, {}),
            reply,
            session_id: null,
            cost_usd: null,
            route: pre.route?.targetId ?? null,
            autonomy: { band: autonomy.band, held: true, carded: false }
          };
        }
        // An acting band travels ON the card so the board can announce the act at
        // its first real dispatch (post-CAS, never optimistically). An
        // INFORMATIONAL question - one the band did not require but the record is
        // near a boundary - rides along on that notice rather than interrupting
        // separately.
        //
        // Its budget is spent HERE, one step before delivery, because the counter
        // lives beside the composition and the board does not. A card that is
        // abandoned before its first dispatch therefore over-counts by one, and
        // that is the right direction to be wrong in: over-counting asks FEWER
        // questions, and an anti-fatigue budget that errs toward asking more is
        // not a budget.
        if (autonomy && (autonomy.band === "act-revert" || autonomy.band === "act-inform")) {
          cardOpts.autonomy = {
            band: autonomy.band,
            shape: autonomy.shape ?? null,
            flow: pre?.flow ?? cardOpts.flow ?? null,
            duty: pre?.duty ?? null,
            level: pre?.level ?? null,
            ...(autonomy.informational && autonomy.question ? { question: autonomy.question } : {})
          };
          if (autonomy.informational && autonomy.question) await router.recordAutonomyAsked();
        }
        if (significant) {
          // S3d (D9b): judge whether the ask is specified enough to plan against. A
          // needs-discuss verdict cards the run onto the interactive Discuss list
          // (targetList) + stamps clarity, so the engine dispatches the discuss duty
          // session (scope Q&A → brief → plan) before the build; a clear verdict runs
          // straight to plan as before. Phrasing overrides both ways ("just do it" /
          // "let's discuss first"). Never blocks - a judge failure defaults to clear.
          const clarity = await router.judgeClarity(message);
          const needsDiscuss = clarity?.clarity === "needs-discuss";
          const createOpts = needsDiscuss
            ? { ...cardOpts, targetList: "discuss", clarity: "needs-discuss" }
            : cardOpts;
          const card = await router.createAutonomousCard(message, cls, createOpts);
          if (card) {
            router.rememberCard(sessionKey, { cardId: card.id, quick: false, taskType: cls.taskType });
            const reply = needsDiscuss
              ? `Registered as a run - discussing scope first.\nCard: ${card.url}`
              : `Registered as a run - the board's run engine will drive it through the pipeline.\n` +
                `Card: ${card.url}`;
            broadcastRich("assistant", { text: reply });
            logEvent("stdout", { kind: "run-card", id: card.id, url: card.url, clarity: needsDiscuss ? "needs-discuss" : "clear" });
            // §6 site 2 of 3. cardUrl is the board's LOOPBACK url: the renderer
            // (which owns the client's host context) passes it through
            // rewriteHostUrl - the gateway cannot, it has no page host.
            return {
              ...controlTurnAttribution(pre, hints, { card: card.id, cardUrl: card.url ?? null }),
              reply,
              session_id: null,
              cost_usd: null,
              route: pre.route?.targetId ?? null,
              card: card.id,
              cardUrl: card.url
            };
          }
          // board unavailable → fall through inline (never hard-block on the window)
        } else {
          const card = await router.createAutonomousCard(message, cls, {
            ...cardOpts,
            quick: true,
            targetList: pre?.sequence?.[0] ?? "implement"
          });
          if (card) {
            quickCard = card;
            router.rememberCard(sessionKey, { cardId: card.id, quick: true, taskType: cls.taskType });
            logEvent("stdout", { kind: "quick-card", id: card.id, url: card.url });
          }
          // board unavailable → run inline without a card (never hard-block)
        }
      }
    }
  }
  let result;
  try {
    result = await execRoutedTurn(pre, message, onChunk, hints, routedOpts);
  } catch (error) {
    // Rejected runtime iterators can still carry the provider's final observed
    // model/session. Refine the stable route event before the HTTP edge emits its
    // canonical error terminal; absent values leave the pre-route attribution.
    if (routeSessionActivated) {
      observeRouteSession({
        sessionDisposition: pre.routeSession.disposition,
        sessionBoundaryReason: pre.routeSession.boundaryReason,
        sessionEpoch: pre.routeSession.epoch,
        spawnSignature: pre.routeSession.signature,
        ...(typeof error?.model === "string" ? { model: error.model } : {}),
        ...(typeof (error?.sessionId ?? error?.session_id) === "string"
          ? { sessionId: error.sessionId ?? error.session_id }
          : {}),
      });
    }
    // A provider/runtime rejection is just as non-successful as an empty reply.
    // Keep the board honest while preserving the rejection for the HTTP edge,
    // which will publish the typed failure and canonical terminal event.
    if (quickCard) {
      const failure = normalizeFailureInfo(error?.failure ?? error, {
        code: "quick_turn_failed",
        kind: "execution",
        source: "gateway",
        retryable: false,
      });
      const reason = (
        `This quick task failed before producing a verifiable result (${failure.code}): ${failure.text} ` +
        "It was routed to needs-attention rather than advanced. Move it back to retry after addressing the failure."
      ).slice(0, 1_500);
      try {
        await router.parkQuickCard(quickCard.id, reason);
        logEvent("stdout", { kind: "quick-card-failure-parked", id: quickCard.id, code: failure.code });
      } finally {
        router.forgetCard(sessionKey);
      }
    }
    throw error;
  }
  // Agent SDK selection/final attribution is published from inside its adapter
  // path before a held terminal event. Other lanes have no canonical terminal
  // stream, so refine their observed session/model here before legacy `done`.
  if (!router.isAgentSdkTarget(pre.route)) {
    observeRouteSession({
      sessionDisposition: pre.routeSession.disposition,
      sessionBoundaryReason: pre.routeSession.boundaryReason,
      sessionEpoch: pre.routeSession.epoch,
      spawnSignature: pre.routeSession.signature,
      model: result?.model ?? pre.route?.target?.model ?? null,
      sessionId: result?.session_id ?? null,
    });
  }
  // D19: a quick card runs inline; advance it Implement→Done now that the turn
  // finished — but ONLY if it finished honestly. An EMPTY reply is a FAILURE, not
  // a pass: route it to needs-attention with the failure contract instead of Done
  // Either way, release the
  // session slot so the next task starts a fresh card.
  if (quickCard) {
    if (isEmptyQuickReply(result?.reply)) {
      await router.parkQuickCard(quickCard.id, quickEmptyFailureReason());
      logEvent("stdout", { kind: "quick-card-empty-parked", id: quickCard.id, reason: "empty reply — routed to needs-attention" });
    } else {
      await router.completeQuickCard(quickCard.id, {
        ...result,
        phase: pre.phase ?? pre.route?.phase ?? pre.route?.role ?? null
      });
    }
    router.forgetCard(sessionKey);
  }
  // §6 site 3 of 3 - and the one that matters most: this tail covers ALL SIX
  // execRoutedTurn lane returns at once, which is why the attribution is added
  // here instead of at nine branch-dependent returns. A quick card ran inline, so
  // its id belongs on the rail too.
  return {
    ...turnAttribution(pre, hints, quickCard ? { card: quickCard.id, cardUrl: quickCard.url ?? null } : {}),
    ...result
  };
}

// Personal execution is fail-closed. A normal project pin may retain the
// historical composition-dir fallback, but @personal is a promise to run in the
// managed private workspace. If resolution rejected that scope, stop after the
// observable pre-route frame and before card creation or any runtime lane.
export function personalWorkspaceRejection(pre) {
  const rejected = Array.isArray(pre?.overridesRejected) ? pre.overridesRejected : [];
  return rejected.find(
    (entry) => entry?.field === "project" && entry?.reason === "personal-workspace-unavailable"
  ) ?? null;
}

export function assertExecutableRunScope(pre) {
  if (!personalWorkspaceRejection(pre)) return;
  const err = new Error(
    "personal execution refused: the managed personal workspace is missing, invalid, or symlinked; " +
      "run Kanban setup and verify GARRISON_HOME/personal"
  );
  err.code = "personal-workspace-unavailable";
  throw err;
}

/** Execute the resolved turn on its runtime (agent-sdk / secondary / workflow /
 *  claude-code PTY) and return the channel-shaped result. Split out of
 *  runRoutedTurn so the D19 quick-card completion runs on every runtime path. */
// The cwd a turn runs in when NOTHING resolved a project.
//
// `undefined` used to mean "inherit the gateway process cwd", which is the
// composition directory - so a project-less turn asked to write a file wrote it
// into compositions/default/. Verified live: a note-taking task landed
// notes-comparison.md there.
//
// Falls back to Garrison's own workspace instead. Deliberately does NOT touch
// `pre.projectPath`: that is what shouldUseScopedClaudeLane keys on, and setting
// it would divert every project-less chat turn off the standing operative
// session onto a cwd-keyed one. The lane choice stays exactly as it was; only
// the directory the turn lands in changes.
//
// Null when the workspace cannot be resolved, which restores the old behaviour
// rather than inventing a path.
function workspaceCwdFallback() {
  try {
    return resolvePersonalScope() ?? undefined;
  } catch {
    return undefined;
  }
}

export function shouldUseScopedClaudeLane(routing, route, projectPath) {
  return Boolean(routing?.usesScopedClaudeSession?.(route, projectPath));
}

/** Model-facing text for Claude PTY lanes. Web user text is an exact authority
 * boundary: routing/duty facts are already structured route state and may not be
 * spliced into it. A Web workflow/skill that still requires a prompt instruction
 * fails visibly until it has a native control-plane operation. Other internal
 * channels retain their established orchestrator instruction contract. */
export function assertWebPromptControls(pre, hints, routing = router) {
  if (hints?.channel !== "web") return;
  const workflow = pre?.route?.target?.type === "workflow" || routing?.isWorkflowTarget?.(pre?.route) === true;
  const rawSkill = pre?.skill ?? pre?.route?.skill ?? hints?.skill;
  const skill = typeof rawSkill === "string" && rawSkill.trim() ? rawSkill.trim() : null;
  if (!workflow && !skill) return;
  const error = new Error(
    workflow
      ? "The selected workflow requires a native Web execution control and was not injected into the user message."
      : `The selected skill ${skill} requires a native Web execution control and was not injected into the user message.`
  );
  error.code = workflow ? "web_workflow_control_unavailable" : "web_skill_control_unavailable";
  error.kind = "routing";
  error.source = "gateway";
  error.retryable = false;
  throw error;
}

export function routedClaudeMessage(pre, message, hints, routing = router) {
  assertWebPromptControls(pre, hints, routing);
  if (hints?.channel === "web") return message;
  const workflowPrefix = routing?.isWorkflowTarget?.(pre?.route)
    ? routing.workflowTurnPrefix(pre.route)
    : "";
  return `${pre?.annotation ?? ""}\n${workflowPrefix}${message}`;
}

async function execRoutedTurn(pre, message, onChunk, hints, opts = {}) {
  // Local-vision lane (Evidence V2): an ollama-local target cannot Read image
  // files (its Anthropic-compat endpoint surfaces no tool_use), so a turn that
  // carries image paths executes natively via garrison-call's image-capable
  // ollama shape — never on the PTY/SDK session. Checked FIRST so cc-ollama-*
  // (PTY-lane) targets are covered too.
  if (typeof router.isOllamaVisionTurn === "function" && router.isOllamaVisionTurn(pre.route, hints?.images)) {
    broadcastRich("turn", { active: true });
    try {
      // garrison-call owns a bounded child process, but its public invocation
      // seam exposes no cancellation handle. Publish that fact as the lane's
      // primitive before entering it: an already-latched stop still unwinds via
      // registerTurnStop's pre-runtime sentinel, while a genuinely in-flight
      // stop gets an honest 409 instead of remaining a misleading 202 forever.
      registerTurnStop("ollama-native", () => false);
      opts.onRuntimeAdmission?.();
      const r = await router.runOllamaVisionTurn(pre.route, message, hints.images);
      broadcastRich("assistant", { text: r.reply });
      logEvent("stdout", {
        kind: "routed-turn",
        target: pre.route.targetId,
        role: pre.route.role,
        runtime: "ollama-native",
        provider: "ollama-local",
        model: r.model,
      });
      return {
        reply: r.reply,
        session_id: null,
        cost_usd: null,
        route: pre.route.targetId,
        runtime: "ollama-native",
        provider: "ollama-local",
        model: r.model,
        effort: null,
        effortApplied: null,
        stoppedReason: null,
        taskType: pre.decision?.taskType ?? null,
        tier: pre.decision?.tier ?? null,
        ruleId: pre.decision?.ruleId ?? null,
        profile: pre.decision?.profile ?? null,
      };
    } finally {
      broadcastRich("turn", { active: false });
    }
  }
  // Agent SDK runtime (non-Anthropic model via the Claude Agent SDK): the turn
  // runs on the SDK adapter session, NOT the claude-code PTY operative.
  if (router.isAgentSdkTarget(pre.route)) {
    broadcastRich("turn", { active: true }); // rich UI shows "thinking"
    const forceNewSession = pre?.routeSession?.boundaryReason === "initial" ||
      hints?.agentSdkNewGeneration === true ||
      pre?.routeSession?.boundaryReason === "spawn-signature-changed";
    const resumeSessionId = forceNewSession
      ? null
      : compatibleAgentSdkResumeSessionId(hints?.agentSdkResume, pre, hints);
    let r;
    try {
      r = await router.runAgentSdkTurn(pre.route, message, onChunk, {
        assembly: pre.agentSdkAssembly,
        // §12: the warm SDK session is keyed by CONVERSATION as well as target, so
        // two web threads never share one session_id (and one transcript badge).
        sessionKey: hints?.sessionId ?? null,
        // A candidate reaches this point only when its persisted runtime, target,
        // model, account source, and project scope exactly match this turn. Effort
        // is Query configuration and rotates by native resume on the same journal.
        // The router still rejects a resume id owned by another live cache entry.
        resumeSessionId,
        // A durable host-recovery barrier is stronger than an absent resume id: a
        // just-finished orphan may still own the same-thread warm Query. Explicitly
        // retire it so the next exact user message starts a clean journal generation.
        forceNewSession,
        // Internal form carries the pre-runtime epoch plus whether an identical
        // durable hint existed. runAgentSdkTurn refines warm/resumed/new and may
        // disclose a resume-unavailable boundary without changing this signature.
        routeSession: pre.routeSession,
        onRouteSession: opts.onRouteSessionObservation,
        // Only a streamed Web turn owns both coordinates required by the standing
        // Agent SDK input protocol. JSON chat, Kanban, and threadless probes retain
        // the historical per-turn string Query path.
        ...(hints?.channel === "web" &&
          exactPermissionId(hints?.sessionId) &&
          exactPermissionId(opts?.generationId)
          ? { streamingInput: true }
          : {}),
        // Interactive permissions are confined to a real Web thread. Every other
        // caller retains the historical bypass mode, including threadless Web
        // probes: without a stable thread coordinate there is no safe answer path.
        permissionMode: opts.permissionMode === "default" ? "default" : "bypassPermissions",
        generationId: opts.generationId,
        onPermissionRequest: opts.onPermissionRequest,
        // §8: a pinned project is a REAL execution scope on every lane, not just the
        // web one-shot. The default composition routes web turns to agent-sdk
        // targets, so wiring cwd only into runWebOneShot made the project badge lie:
        // it reported /home/ggomes/dev/<repo> while the turn actually ran in the
        // composition dir (caught by asking a live turn to print its own pwd).
        cwd: pre.projectPath ?? workspaceCwdFallback(),
        // A web request already owns a monotonic turnSeq. Reuse its stable string
        // form for event grouping; canonical block ids still come from the SDK.
        onEvent: opts.onSessionEvent,
        turnId: hints?.turnSeq == null ? null : String(hints.turnSeq),
        onActivity: opts.onActivity,
        onJournal: opts.onJournal,
        onRuntimeAdmission: opts.onRuntimeAdmission,
        registerRecoveryReset: registerTurnRecoveryReset,
        registerStop: (stop) => registerTurnStop("agent-sdk", stop)
      });
    } catch (error) {
      broadcastRich("turn", { active: false });
      throw error;
    }
    // Inject the off-screen agent-sdk reply + a status badge into rich clients so
    // the channel UI clearly shows the routed runtime/model (not the idle operative).
    broadcastRich("status", {
      rows: [`Garrison orchestrator → runtime: agent-sdk · provider: ${r.provider} · model: ${r.model}`],
      mode: "agent-sdk",
      contextPct: null,
      model: `${r.model} · agent-sdk/${r.provider}`,
    });
    broadcastRich("assistant", { text: r.reply });
    broadcastRich("turn", { active: false });
    logEvent("stdout", {
      kind: "routed-turn",
      target: pre.route.targetId,
      role: pre.route.role,
      runtime: "agent-sdk",
      provider: r.provider,
      model: r.model,
      effort: r.effort ?? null,
      effortApplied: r.effortApplied ?? null,
    });
    return {
      reply: r.reply,
      session_id: r.session_id,
      // §12: an SDK session journals a transcript, so the per-message transcript
      // badge has a real file behind it.
      transcript_path: r.transcript_path ?? null,
      cost_usd: null,
      route: pre.route.targetId,
      runtime: "agent-sdk",
      provider: r.provider ?? null,
      model: r.model,
      effort: r.effort ?? null,
      effortApplied: typeof r.effortApplied === "boolean" ? r.effortApplied : null,
      // A runtime ceiling is an explicit stopped result, not a transport error.
      // Preserve it on the normal SSE `done` payload so the card engine can
      // require durable phase evidence before treating the phase as complete.
      stoppedReason: r.stoppedReason ?? null,
      terminalStatus: r.terminalStatus ?? null,
      failure: r.failure ?? null,
      sessionDisposition: r.sessionDisposition,
      sessionBoundaryReason: r.sessionBoundaryReason,
      sessionEpoch: r.sessionEpoch,
      spawnSignature: r.spawnSignature,
      // Routing attribution for channels/kanban (null-safe — a missing decision
      // must never throw): what the classifier decided and which rule matched.
      taskType: pre.decision?.taskType ?? null,
      tier: pre.decision?.tier ?? null,
      ruleId: pre.decision?.ruleId ?? null,
      profile: pre.decision?.profile ?? null,
    };
  }
  // Secondary runtime (gpt/codex or gemini): the orchestrator delegates this step
  // to the secondary; the gateway executes it directly (not the PTY operative).
  if (router.isSecondaryTarget(pre.route)) {
    broadcastRich("turn", { active: true });
    const r = await router.runSecondaryTurn(pre.route, message, {
      // §8: honor a pinned project here too, else the badge overstates the scope.
      cwd: pre.projectPath ?? workspaceCwdFallback(),
      registerStop: (stop) => registerTurnStop(pre.route.target.runtime, stop),
      onRuntimeAdmission: opts.onRuntimeAdmission,
      // Progress from an adapter that has any to report (remote-shell streams
      // the remote pane while its agent works). The final onChunk below replaces
      // whatever streamed with the settled reply.
      onChunk,
    });
    broadcastRich("status", {
      rows: [`Garrison orchestrator → runtime: ${r.runtime} · provider: ${r.provider} · model: ${r.model}`],
      mode: r.runtime,
      contextPct: null,
      model: `${r.model} · ${r.runtime}`,
    });
    broadcastRich("assistant", { text: r.reply });
    broadcastRich("turn", { active: false });
    if (onChunk && r.reply) onChunk(r.reply, true);
    logEvent("stdout", {
      kind: "routed-turn",
      target: pre.route.targetId,
      role: pre.route.role,
      runtime: r.runtime,
      provider: r.provider,
      model: r.model,
      effort: r.effort ?? null,
      effortApplied: r.effortApplied ?? null,
    });
    return {
      reply: r.reply,
      session_id: null,
      cost_usd: null,
      route: pre.route.targetId,
      runtime: r.runtime,
      provider: r.provider ?? null,
      model: r.model,
      effort: r.effort ?? null,
      effortApplied: typeof r.effortApplied === "boolean" ? r.effortApplied : null,
      // A cancelled exec turn settles with its partial output; forward the reason
      // so the done frame can say the turn was stopped rather than completed.
      stoppedReason: r.stoppedReason ?? null,
      // Routing attribution for channels/kanban (null-safe).
      taskType: pre.decision?.taskType ?? null,
      tier: pre.decision?.tier ?? null,
      ruleId: pre.decision?.ruleId ?? null,
      profile: pre.decision?.profile ?? null,
    };
  }
  // A Claude-bound v4 cell under a non-Claude primary is an actual Claude Code
  // delegate lane. A cwd-scoped Claude turn uses this lane too, even under a
  // Claude primary: the standing operative is rooted in the composition and
  // must never accept a project/personal turn while attribution claims another
  // cwd. The delegate pool is keyed by cwd, preserving follow-up continuity.
  // A scoped delegate pool is keyed by cwd, not by Web thread. Reusing it from
  // Web would share conversation state across threads. Web Claude turns stay on
  // the isolated one-shot below; internal channels retain scoped continuity.
  if (hints?.channel !== "web" && shouldUseScopedClaudeLane(router, pre.route, pre.projectPath)) {
    const annotated = routedClaudeMessage(pre, message, hints, router);
    broadcastRich("turn", { active: true });
    const r = await router.runClaudeDelegateTurn(pre.route, annotated, {
      onChunk,
      timeoutMs: hints?.timeoutMs,
      // §8: honor a pinned project here too, else the badge overstates the scope.
      cwd: pre.projectPath ?? workspaceCwdFallback(),
      onJournal: opts.onJournal,
      onRuntimeAdmission: opts.onRuntimeAdmission,
      registerQuestionSession: (questionSession, identity) =>
        registerQuestionSession(questionSession, identity),
      registerStop: (stop) => registerTurnStop("claude-delegate", stop)
    });
    broadcastRich("status", {
      rows: [`Garrison orchestrator → runtime: claude-code · provider: ${r.provider} · model: ${r.model}`],
      mode: "claude-code",
      contextPct: null,
      model: `${r.model} · claude-code/${r.provider}`,
    });
    broadcastRich("assistant", { text: r.reply });
    broadcastRich("turn", { active: false });
    logEvent("stdout", {
      kind: "routed-turn",
      target: pre.route.targetId,
      role: pre.route.role,
      runtime: "claude-code",
      provider: r.provider,
      model: r.model,
      effort: r.effort ?? null,
      effortApplied: r.effortApplied ?? null,
      delegated: true,
    });
    return {
      reply: r.reply,
      session_id: r.session_id ?? null,
      transcript_path: r.transcript_path ?? null,
      cost_usd: null,
      route: pre.route.targetId,
      runtime: "claude-code",
      provider: r.provider ?? null,
      model: r.model ?? null,
      effort: r.effort ?? null,
      effortApplied: typeof r.effortApplied === "boolean" ? r.effortApplied : null,
      taskType: pre.decision?.taskType ?? null,
      tier: pre.decision?.tier ?? null,
      ruleId: pre.decision?.ruleId ?? null,
      profile: pre.decision?.profile ?? null,
    };
  }
  session = router.getOperativeSession();
  // A resolved `workflow` target runs the named Claude Code workflow ON the
  // operative (via its Workflow tool) — prepend the instruction; else a plain turn.
  const annotated = routedClaudeMessage(pre, message, hints, router);
  // S3b: a WEB conversational turn materializes as a one-shot. Internal
  // screenshot-grounded turns do too: they must not consume or overwrite a
  // human's draft in the standing operative input box. Other channels
  // (kanban/dev-env/…) keep the standing operative context.
  const oneShotChannel = shouldUseEphemeralSession(hints?.channel);
  if (oneShotChannel) {
    const isInternal = hints?.channel === "garrison";
    const oneShotMsg = annotated;
    const model = pre.route?.target?.model ?? MODEL;
    const effort = pre.route?.target?.effort ?? null;
    let reply = "";
    let os1 = null;
    try {
      // Stream the disposable session's reply incrementally (same closure shape as
      // the standing path below); the final onChunk(reply, true) after the turn
      // remains the authoritative replace.
      let osSession = null;
      let osTurnStarted = false;
      let osEmitted = "";
      const osOnScreen =
        onChunk
          ? () => {
              if (!osSession?.handle) return;
              const current = extractReply(osSession.handle, oneShotMsg);
              if (current && current.length > osEmitted.length && current.startsWith(osEmitted)) {
                onChunk(current.slice(osEmitted.length));
                osEmitted = current;
              } else if (current && current !== osEmitted) {
                onChunk(current, true);
                osEmitted = current;
              }
            }
          : undefined;
      // Provider choice is spawn-fixed for Claude Code. Resolve the target's
      // policy-backed endpoint + vault/account auth for this disposable process,
      // including the keep-provider flag that prevents claude-pty from scrubbing
      // an explicitly selected non-plan base URL back to the Max-plan default.
      const oneShotLaunch = router.resolveWebOneShotLaunch(pre.route?.target ?? {});
      os1 = await router.runWebOneShot({
        message: oneShotMsg,
        model,
        effort,
        providerLaunch: oneShotLaunch.providerLaunch,
        // §8: a pinned project IS this turn's cwd (a confined dev-root repo,
        // already resolved by applyTurnOverride). Absent → the composition dir,
        // exactly as before. An unresolvable project never reaches here: it was
        // rejected at resolution time rather than silently falling back.
        cwd: pre.projectPath ?? workspaceCwdFallback(),
        // §6: provider selection and any pinned account are real launch env,
        // resolved by Stage B's provider policy rather than inherited labels.
        env: oneShotLaunch.env,
        onScreen: osOnScreen,
        onSession: (s) => {
          osSession = s;
          // §9: ESC on the disposable session is the one-shot lane's stop
          // primitive; waitForTurnComplete's liveness check then settles the turn
          // with its partial reply instead of hanging to the 5-minute timeout.
          registerTurnStop("web-one-shot", () => {
            // A latched generation interrupt reaches this callback before the
            // one-shot helper enters session.runTurn. Dispose in that narrow
            // window because an ESC written before a turn starts cannot cancel
            // the future input. During a live turn, preserve the ordinary ESC
            // primitive so the partial reply can settle normally.
            if (!osTurnStarted && typeof s?.dispose === "function") {
              s.dispose();
              return true;
            }
            if (typeof s?.writeKeys !== "function") return false;
            s.writeKeys("\x1b");
            return true;
          });
          opts.onRuntimeAdmission?.();
          reportJournal(
            opts,
            sessionJournalIdentity(s, s?.compositionDir ?? pre.projectPath ?? COMPOSITION_DIR),
            s
          );
          osTurnStarted = true;
        },
      });
      reply = os1.reply ?? "";
    } catch (err) {
      logEvent("stderr", { kind: "web-oneshot-failed", error: err?.message || String(err) });
      if (!isInternal) broadcastRich("turn", { active: false });
      // A disposable runtime failure is still a failed turn. Returning the empty
      // accumulator here used to manufacture a successful `done` frame and could
      // advance a quick card despite the provider never producing a result.
      throw err;
    }
    if (!isInternal) {
      lastMaterialized = { at: new Date().toISOString(), threadId: hints?.sessionId ?? null, assembledChars: 0, oneShot: true };
      broadcastRich("status", {
        rows: [`Garrison orchestrator → runtime: claude-code · web isolated (one-shot) · model: ${model}`],
        mode: "claude-code",
        contextPct: null,
        model: `${model} · claude-code`,
      });
      broadcastRich("assistant", { text: reply });
      broadcastRich("turn", { active: false });
    }
    if (onChunk && reply) onChunk(reply, true);
    logEvent("stdout", {
      kind: "routed-turn",
      target: pre.route.targetId,
      runtime: "claude-code",
      web: !isInternal,
      internal: isInternal,
      oneShot: true
    });
    return {
      reply,
      // The one-shot session is disposed, but its id + jsonl transcript survive
      // on disk — callers (e.g. automations vision) link turns to transcripts.
      session_id: os1?.sessionId ?? null,
      transcript_path: os1?.transcriptPath ?? null,
      cost_usd: null,
      route: pre.route.targetId,
      honored: null,
      runtime: "claude-code",
      provider: pre.route?.target?.provider ?? null,
      model: pre.route?.target?.model ?? null,
      taskType: pre.decision?.taskType ?? null,
      tier: pre.decision?.tier ?? null,
      ruleId: pre.decision?.ruleId ?? null,
      profile: pre.decision?.profile ?? null,
      effort,
      effortApplied: os1?.effortApplied ?? null,
      // Acceptance evidence: prove this turn ran one-shot (no standing session).
      materialized: { oneShot: true, assembledChars: 0, internal: isInternal },
    };
  }

  // Standing-operative execution: ONE conversation, so it queues on the
  // operative lane (2026-08-07) while routed SDK/delegate/one-shot turns run
  // concurrently on their own lanes.
  return await enqueueOperative(async () => {
  session = router.getOperativeSession();
  let lastEmitted = "";
  // Runs even when onChunk is absent: the activity hint is the ONLY feedback a
  // caller gets on this lane, so it must not be gated on text streaming.
  const emitScreenActivity = screenActivityEmitter(session.handle, opts?.onActivity);
  const onScreen =
    session.handle
      ? () => {
          emitScreenActivity();
          if (!onChunk) return;
          const current = extractReply(session.handle, annotated);
          if (current && current.length > lastEmitted.length && current.startsWith(lastEmitted)) {
            onChunk(current.slice(lastEmitted.length));
            lastEmitted = current;
          } else if (current && current !== lastEmitted) {
            onChunk(current, true);
            lastEmitted = current;
          }
        }
      : undefined;
  // §9: the standing operative's stop primitive is ESC - the same one
  // /claude/interrupt writes.
  registerTurnStop("standing-pty", () => {
    if (typeof session?.writeKeys !== "function") return false;
    session.writeKeys("\x1b");
    return true;
  });
  opts.onRuntimeAdmission?.();
  const journal = reportJournal(
    opts,
    sessionJournalIdentity(session, session?.compositionDir ?? pre.projectPath ?? CANONICAL_COMPOSITION_DIR),
    session
  );
  const outcome = await session.runTurn({ message: annotated, onScreen, timeoutMs: hints?.timeoutMs });
  const honored = await router.postTurn(pre.route, pre.decision, outcome.reply, message);
  await markPriorSession();
  // Inject a consistent runtime/model status badge for the channel UI (the
  // secondary/agent-sdk branches do the same), so every routed turn shows which
  // model handled it.
  {
    const m = pre.route?.target?.model ?? MODEL;
    broadcastRich("status", {
      rows: [`Garrison orchestrator → runtime: claude-code · provider: anthropic-plan · model: ${m}`],
      mode: "claude-code",
      contextPct: null,
      model: `${m} · claude-code`,
    });
    // Inject the reply + idle the turn explicitly. The rich screen-poll can leave a
    // routed claude turn rendering as "…" with busy stuck on (so the next channel
    // send hits the Stop button) — injecting outcome.reply makes the reply render
    // and clears busy reliably, same as the agent-sdk/secondary paths.
    broadcastRich("assistant", { text: outcome.reply });
    broadcastRich("turn", { active: false });
  }
  const effort = pre.route?.target?.effort ?? null;
  // Stage-B may report exact application truth (adapter move / unsupported
  // runtime). The historical Claude PTY path applies a same-provider effort via
  // `/effort`; a provider/soul respawn cannot be proven from the settled turn and
  // remains unknown instead of claiming success.
  const effortApplied =
    effort == null
      ? null
      : typeof pre.plan?.effortApplied === "boolean"
        ? pre.plan.effortApplied
        : pre.plan?.path === "respawn-resume"
          ? null
          : true;
  logEvent("stdout", {
    kind: "routed-turn",
    target: pre.route.targetId,
    role: pre.route.role,
    runtime: "claude-code",
    model: pre.route?.target?.model ?? MODEL,
    effort,
    effortApplied,
    honored: honored.honored,
  });
  return {
    // Fall back to the operative's claude session id so a routed turn always
    // reports a session (outcome.sessionId is null for the pooled PTY operative).
    reply: outcome.reply,
    session_id: outcome.sessionId ?? session.getClaudeSessionId?.() ?? null,
    transcript_path: journal?.transcript_path ?? null,
    cost_usd: null,
    route: pre.route.targetId,
    honored: honored.honored,
    // Runtime + routing attribution for channels/kanban. The claude-code path
    // carries none of these natively (unlike the agent-sdk/secondary branches),
    // so add them here off the resolved route/decision (null-safe, never throws).
    runtime: "claude-code",
    provider: pre.route?.target?.provider ?? null,
    model: pre.route?.target?.model ?? null,
    effort,
    effortApplied,
    standingOperative: true,
    taskType: pre.decision?.taskType ?? null,
    tier: pre.decision?.tier ?? null,
    ruleId: pre.decision?.ruleId ?? null,
    profile: pre.decision?.profile ?? null,
  };
  });
}

function interruptedBeforeRuntimeResult(entry) {
  return {
    reply: "",
    session_id: null,
    cost_usd: null,
    stoppedByUser: true,
    runtimeStoppedReason: null,
    stoppedReason: "user-interrupt",
    interruptedByCardId: null,
    affectedCardIds: Array.isArray(entry?.cardIds) ? entry.cardIds : []
  };
}

export function shouldRejectGeneratedWebDispatch(hints, currentRouter = router, status = ptyStatus) {
  return hints?.channel === "web" &&
    hints?.directOperative !== true &&
    (!currentRouter || status !== "ready");
}

/** Run one turn against the live operative. Spawns/respawns on demand.
 *  onChunk(text) streams the growing assistant reply (screen-derived).
 *  opts: { onPreRoute, onActivity, onJournal, turnControlEntry } - the
 *  §4/§12 SSE frame sinks plus an exact streamed-Web generation claim. */
async function runTurn(message, onChunk, hints, opts = {}) {
  // Bind AskUserQuestions raised during THIS turn to its card (the engine's
  // dutyKey = "cardId:phase") and exact stream sink. Runtime lanes are
  // concurrent, so this identity rides the AsyncLocalStorage entry rather than
  // a module-global cursor whose save/restore order can corrupt another turn.
  const turnCardId = typeof hints?.dutyKey === "string" ? (hints.dutyKey.split(":")[0] || null) : null;
  // §9: publish this turn in the cancel registry for the whole of its life. The
  // lane fills in the actual `stop` as soon as it owns something interruptible; an
  // interrupt before that answers "no cancel primitive yet" rather than lying.
  const turnKey = hints?.sessionId || INTERRUPT_FALLBACK_KEY;
  const hintedCardIds = Array.isArray(hints?.cardIds)
    ? hints.cardIds.filter((id) => typeof id === "string" && id).slice(0, 100)
    : [];
  const cardIds = [...new Set([turnCardId, ...hintedCardIds].filter(Boolean))];
  const generationEntry = opts?.turnControlEntry?.kind === "web-generation"
    ? opts.turnControlEntry
    : null;
  const entry = generationEntry ?? {
    lane: primaryRuntime(),
    stop: null,
    cancelled: false,
    dutyKey: typeof hints?.dutyKey === "string" ? hints.dutyKey : null,
    cardIds
  };
  entry.dutyKey = typeof hints?.dutyKey === "string" ? hints.dutyKey : null;
  entry.cardIds = cardIds;
  entry.questionCardId = turnCardId;
  entry.questionThreadId = hints?.channel === "web"
    ? exactPermissionId(hints?.sessionId)
    : null;
  entry.questionSink = typeof opts?.onQuestion === "function" ? opts.onQuestion : null;
  if (!generationEntry) activeTurns.set(turnKey, entry);
  try {
    // An interrupt can arrive in the small but real window after `open` and
    // before this function begins. Honor the latched generation without ever
    // entering a runtime lane.
    if (generationEntry?.cancelRequested) return interruptedBeforeRuntimeResult(entry);
    // Re-check at the irreversible lane-selection boundary. The router may
    // have been ready at HTTP ingress and then entered /control/reload-prompt
    // while Discuss interception yielded. A generated Web turn must fail
    // closed in both reload phases: `starting` with the old router still
    // present, and null while it is replaced. It may never fall through to the
    // composition-wide standing PTY. Explicit web-console/direct-operative
    // traffic retains the legacy branch below.
    if (shouldRejectGeneratedWebDispatch(hints)) {
      throw webRouteUnavailableError();
    }
    if (router && hints?.directOperative !== true) {
      const result = await turnContext.run(entry, () => runRoutedTurn(message, onChunk, hints, opts));
      // A cancelled turn settles NORMALLY with its partial reply - the stop is not
      // an error path - so the done frame is where the user learns it was stopped.
      return entry.cancelled
        ? {
            ...result,
            stoppedByUser: true,
            // The adapter may call its own primitive stop "cancelled". Preserve
            // that low-level reason separately; the workflow needs the stable,
            // user-authored cause so it never interprets a partial reply.
            runtimeStoppedReason: result?.stoppedReason ?? null,
            stoppedReason: "user-interrupt",
            interruptedByCardId: entry.interruptedByCardId ?? null,
            affectedCardIds: entry.cardIds
          }
        : result;
    }
    // Legacy single-session path: the standing PTY is one conversation, so its
    // turns queue on the operative lane (the routed path gates its own
    // standing-session tail the same way inside execRoutedTurn).
    return await turnContext.run(entry, () => enqueueOperative(async () => {
      if (router?.getOperativeSession) session = router.getOperativeSession();
      if (!session || session.isDisposed() || !session.isAlive()) {
        logEvent("stdout", { kind: "respawn-before-turn" });
        ptyStatus = "spawning";
        await spawnOperative({ resume: true });
      }
      let lastEmitted = "";
      const emitScreenActivity = screenActivityEmitter(session.handle, opts?.onActivity);
      const onScreen = () => {
        emitScreenActivity();
        if (!onChunk) return;
        const current = extractReply(session.handle, message);
        if (current && current.length > lastEmitted.length && current.startsWith(lastEmitted)) {
          onChunk(current.slice(lastEmitted.length));
          lastEmitted = current;
        } else if (current && current !== lastEmitted) {
          // Reflow / divergence - re-emit the whole thing as a correction.
          onChunk(current, true);
          lastEmitted = current;
        }
      };
      // The legacy single-session path is a Claude PTY too, so ESC stops it.
      registerTurnStop("standing-pty", () => {
        if (typeof session?.writeKeys !== "function") return false;
        session.writeKeys("\x1b");
        return true;
      });
      const journal = reportJournal(opts, sessionJournalIdentity(session), session);
      const outcome = await session.runTurn({ message, onScreen, timeoutMs: hints?.timeoutMs });
      await markPriorSession();
      return {
        reply: outcome.reply,
        session_id: outcome.sessionId ?? session.getClaudeSessionId?.() ?? null,
        transcript_path: journal?.transcript_path ?? null,
        cost_usd: null,
        standingOperative: true,
        ...(entry.cancelled
          ? {
              stoppedByUser: true,
              stoppedReason: "user-interrupt",
              interruptedByCardId: entry.interruptedByCardId ?? null,
              affectedCardIds: entry.cardIds
            }
          : {})
      };
    }));
  } catch (err) {
    // Stop registration happens immediately before a lane starts its runtime.
    // If the generation was interrupted while routing/queueing, registration
    // invokes the primitive once and this sentinel unwinds before send/runTurn.
    if (generationEntry?.cancelRequested && err?.code === "turn_interrupted_before_runtime") {
      return interruptedBeforeRuntimeResult(entry);
    }
    throw err;
  } finally {
    // The turn ended (returned, timed out, or threw): release only transcript
    // mappings and unanswered questions still owned by THIS entry. An older
    // turn completing after a newer claimant cannot erase the newer owner.
    questionTurns.release(entry);
    // Only clear the registry slot if it is still OURS (a later turn on the same
    // conversation key must not be un-cancellable because an older one finished).
    if (generationEntry) generationTurnControl.release(generationEntry);
    else if (activeTurns.get(turnKey) === entry) activeTurns.delete(turnKey);
  }
}

/** Serialize turns — the TUI is one-turn-at-a-time. */
// Extract optional routing hints from a request body (the Kanban Loop sends these):
// an EXPLICIT {taskType,tier} classification preRoute can honor instead of
// re-classifying, the per-list skill, and a suppress-continuations flag. Validated so a
// malformed classification simply falls back to normal classification (never trusted blindly).
/**
 * `phasesOff` (a CSV of the OFF set, the wire form every rail surface pins) → the
 * `{phase: false}` toggle map the card and `railForCard` already speak. Returns null
 * for an empty pin so an unpinned turn stays byte-identical to before - the
 * back-compat shape is test-pinned in two places.
 */
export function phaseTogglesFromCsv(csv) {
  const ids = String(csv ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return null;
  return Object.fromEntries(ids.map((id) => [id, false]));
}

/** Both phase-override pins folded into ONE toggle map: `{id: false}` skips a
 *  plan phase, `{id: true}` adds an out-of-plan phase (railForCard unions true
 *  entries into the plan). OFF wins a conflict — the map is keyed, so a phase
 *  in both CSVs resolves to the safer "does not run". Null when neither pin
 *  carries anything, keeping unpinned turns byte-identical to before. */
export function phaseTogglesFromRouting(routing) {
  const off = phaseTogglesFromCsv(routing?.phasesOff);
  const onIds = String(routing?.phasesOn ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!off && !onIds.length) return null;
  return { ...Object.fromEntries(onIds.map((id) => [id, true])), ...(off ?? {}) };
}

/** The inverse, for reporting a resolved plan back on the badge row. Only `false`
 *  entries count: `railForCard` reads nothing else, so a stray `true` in a toggle
 *  map means "on", not "off", and must not appear in the OFF list. */
export function phaseTogglesToCsv(toggles) {
  if (!toggles || typeof toggles !== "object" || Array.isArray(toggles)) return null;
  const off = Object.entries(toggles).filter(([, on]) => on === false).map(([id]) => id);
  return off.length ? off.join(",") : null;
}

/** The ON half of the same report: phases explicitly ADDED beyond the plan. */
export function phaseTogglesOnToCsv(toggles) {
  if (!toggles || typeof toggles !== "object" || Array.isArray(toggles)) return null;
  const on = Object.entries(toggles).filter(([, v]) => v === true).map(([id]) => id);
  return on.length ? on.join(",") : null;
}

// Durable Web → gateway resume identity. The session id alone is not enough:
// Claude session journals are conversation context, so resuming one under a
// different route/model/account/project would cross an explicit generation
// boundary. Require the complete prior Agent SDK attribution as an exact object;
// legacy or partially-attributed threads safely start a disclosed clean boundary.
const AGENT_SDK_RESUME_KEYS = [
  "sessionId",
  "route",
  "runtime",
  "provider",
  "model",
  "effort",
  "account",
  "accountSource",
  "projectPath",
  "spawnSignature",
];
const AGENT_SDK_RESUME_ACCOUNT_SOURCES = new Set(["target", "override", "process"]);

function exactResumeString(raw, max = 200) {
  if (typeof raw !== "string" || !raw || raw !== raw.trim() || raw.length > max || /[\u0000-\u001f\u007f]/.test(raw)) {
    return null;
  }
  return raw;
}

export function sanitizeAgentSdkResume(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== AGENT_SDK_RESUME_KEYS.length || keys.some((key) => !AGENT_SDK_RESUME_KEYS.includes(key))) {
    return null;
  }
  if (AGENT_SDK_RESUME_KEYS.some((key) => !Object.hasOwn(raw, key))) return null;
  const sessionId =
    typeof raw.sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.sessionId)
      ? raw.sessionId
      : null;
  const route = exactResumeString(raw.route);
  const runtime = raw.runtime === "agent-sdk" ? raw.runtime : null;
  const provider = exactResumeString(raw.provider);
  const model = exactResumeString(raw.model);
  const effort = raw.effort === null || TURN_EFFORTS.includes(raw.effort) ? raw.effort : undefined;
  const account = raw.account === null ? null : exactResumeString(raw.account);
  const accountSource =
    raw.accountSource === null || AGENT_SDK_RESUME_ACCOUNT_SOURCES.has(raw.accountSource)
      ? raw.accountSource
      : undefined;
  const projectPath =
    raw.projectPath === null
      ? null
      : exactResumeString(raw.projectPath, 4_000);
  const spawnSignature = sanitizeSpawnSignature(raw.spawnSignature);
  if (
    !sessionId || !route || !runtime || !provider || !model || effort === undefined ||
    (raw.account !== null && !account) || accountSource === undefined ||
    (raw.projectPath !== null && (!projectPath || !path.isAbsolute(projectPath))) ||
    spawnSignature?.version !== 2 || spawnSignature.runtime !== "agent-sdk"
  ) {
    return null;
  }
  const signedFields = {
    target: route,
    runtime,
    provider,
    model,
    account,
    accountSource,
    projectPath,
  };
  for (const [field, value] of Object.entries(signedFields)) {
    if (spawnSignature[field] !== value) return null;
  }
  return {
    sessionId,
    route,
    runtime,
    provider,
    model,
    effort,
    account,
    accountSource,
    projectPath,
    spawnSignature,
  };
}

export function compatibleAgentSdkResumeSessionId(candidate, pre, hints) {
  const resume = sanitizeAgentSdkResume(candidate);
  const target = pre?.route?.target ?? null;
  if (!resume || target?.runtime !== "agent-sdk") return null;
  // Recompute from this turn's frozen Agent SDK assembly and require the internal
  // routeSession to agree. Bind native resume to that complete v2 identity: a
  // persisted session from assembly A must not resume merely because a later
  // failed turn already advanced the durable thread routeSession to B.
  let currentSignature = null;
  try {
    currentSignature = resolvedSpawnSignature(pre, hints);
  } catch {
    return null;
  }
  const preSignature = sanitizeSpawnSignature(pre?.routeSession?.signature);
  if (
    currentSignature?.version !== 2 ||
    preSignature?.version !== 2 ||
    JSON.stringify(preSignature) !== JSON.stringify(currentSignature) ||
    JSON.stringify(resume.spawnSignature) !== JSON.stringify(currentSignature)
  ) {
    return null;
  }
  const attribution = turnAttribution(pre, hints);
  const current = {
    route: pre?.route?.targetId ?? null,
    runtime: target.runtime,
    provider: target.provider ?? null,
    model: target.model ?? null,
    // Effort is retained in the legacy resume payload for backwards-compatible
    // validation, but it is not spawn identity: changing it rotates the standing
    // Query and resumes this same journal.
    effort: target.effort ?? null,
    account: attribution.account ?? null,
    accountSource: attribution.accountSource ?? null,
    projectPath: pre?.projectPath ?? null,
  };
  for (const field of ["route", "runtime", "provider", "model", "account", "accountSource", "projectPath"]) {
    if (resume[field] !== current[field]) return null;
  }
  return resume.sessionId;
}

export function routeHintsFromBody(body) {
  const c = body?.classification;
  const classification =
    c && typeof c === "object" && typeof c.taskType === "string" && typeof c.tier === "string"
      ? { taskType: c.taskType, tier: c.tier, ...(c.matchedException ? { matchedException: c.matchedException } : {}) }
      : null;
  // §3: the per-turn pinned intent, STRICTLY validated here at the edge. What
  // survives reaches applyTurnOverride; what does not is carried as a rejection so
  // the badge row can say what was refused and why.
  const { routing, rejected: routingRejected } = sanitizeRouting(body?.routing);
  return {
    classification,
    routing,
    routingRejected,
    // §5 turn identity: a client-supplied monotonic counter, echoed on both the
    // pre-turn and the done `route` frame so a late frame can be DROPPED instead
    // of landing on the newest turn.
    turnSeq: Number.isInteger(body?.turnSeq) && body.turnSeq >= 0 ? body.turnSeq : null,
    // Local-vision lane (Evidence V2): absolute image file paths. A turn that
    // resolves to an ollama-local target receives these natively (base64 via
    // garrison-call); Claude lanes Read the same paths from the prompt, so the
    // field is inert for them.
    images: Array.isArray(body?.images)
      ? body.images.filter((p) => typeof p === "string" && p).slice(0, 16)
      : null,
    skill: typeof body?.skill === "string" ? body.skill : null,
    suppressContinuations: body?.suppressContinuations === true,
    // D19 carding inputs: the channel name (kanban/scheduler/board/garrison turns
    // are engine dispatches and run inline; every other channel's task-shaped turn
    // becomes a card), the per-conversation session id (so a multi-turn thread
    // attaches to one card, D19), the resolved mode, and optional card fields
    // (flow / per-card phase toggles / project) for the created card.
    channel: typeof body?.channel === "string" ? body.channel : null,
    // The web channel names this `thread` (its opaque per-conversation key);
    // other hosts send `sessionId`. Accept both so a decision can be traced back
    // to its conversation whichever surface raised the turn.
    sessionId:
      (typeof body?.sessionId === "string" && body.sessionId) ||
      (typeof body?.thread === "string" && body.thread) ||
      null,
    // Trusted durable admission coordinate. Unlike turnSeq this is not display
    // metadata: the generation registry binds it to the gateway claim so a Web
    // restart can recover an `open` frame that was received but not persisted.
    inputId: exactDurableInputId(body?.inputId),
    // Display label for that session, carried alongside the id so the Muster
    // Decisions feed can name the conversation a decision came from instead of
    // showing a bare uuid. Purely cosmetic and optional.
    sessionTitle: typeof body?.sessionTitle === "string" && body.sessionTitle ? body.sessionTitle : null,
    mode: typeof body?.mode === "string" ? body.mode : undefined,
    // S1b holds: a turn dispatched with contextHold=true never triggers a compaction
    // after it (the compaction defers to the duty boundary); dutyKey identifies the
    // card+phase the turn ran, folded into the compact-log record.
    contextHold: body?.contextHold === true,
    dutyKey: typeof body?.dutyKey === "string" && body.dutyKey ? body.dutyKey : null,
    // Kanban batch identity. Bounded and opaque: it is used only to prove that a
    // card-level interrupt belongs to the active shared turn.
    cardIds: Array.isArray(body?.cardIds)
      ? [...new Set(body.cardIds.filter((id) => typeof id === "string" && id).slice(0, 100))]
      : null,
    // M5: server-derived only. A complete prior SDK attribution allows a cold
    // gateway/cache to resume the exact journal. Malformed or legacy candidates
    // become null and the lane starts an explicitly disclosed clean session.
    agentSdkResume: sanitizeAgentSdkResume(body?.agentSdkResume),
    // M6: durable logical route identity. Closed validation makes it an equality
    // hint only; the gateway always recomputes the live signature after routing.
    routeSession: sanitizeRouteSession(body?.routeSession),
    // Server-owned restart boundary. `true` explicitly abandons any same-thread
    // warm Query; false/absent retains the normal warm-or-resume behavior.
    agentSdkNewGeneration: body?.agentSdkNewGeneration === true,
    // The phase plan for a turn that becomes a card. TWO wire spellings reach the
    // same field: the board's long-standing top-level `flow`/`phases`, and the
    // RUN-SPEC-V1 pin (`routing.flow` / `routing.phasesOff`) that every rail
    // surface sends. The top-level form WINS - the board computes it from the card
    // it already owns, so it is a statement of fact, while the pin is an intent that
    // has to survive validation. The pin is only read after sanitizeRouting, so an
    // out-of-vocabulary flow never arrives here at all.
    flow:
      typeof body?.flow === "string" ? body.flow : (routing?.flow ?? null),
    phases:
      body?.phases && typeof body.phases === "object"
        ? body.phases
        : phaseTogglesFromRouting(routing),
    // NOT the same thing as `routing.project`, and deliberately not folded into it:
    // this is the card's project LABEL, `routing.project` is the turn's cwd pin.
    // Collapsing them would silently change the cwd of every existing board caller.
    project: typeof body?.project === "string" ? body.project : null,
    // V4 card execution identity. The Kanban engine supplies these fields for an
    // existing Dispatcher-created card; preRoute resolves the exact assigned leaf
    // cell and bypasses the legacy taskType×tier matrix.
    duty: typeof body?.duty === "string" && body.duty ? body.duty : null,
    level: Number.isInteger(body?.level) ? body.level : null,
    phase: typeof body?.phase === "string" && body.phase ? body.phase : null,
    stepIndex: Number.isInteger(body?.stepIndex) ? body.stepIndex : null,
    sequence:
      Array.isArray(body?.sequence) && body.sequence.every((item) => typeof item === "string")
        ? body.sequence
        : null,
    // An EXPLICIT per-turn timeout (ms). The Kanban Loop sends a generous one because a
    // real garrison-* turn (plan/implement/review/…) runs far longer than the default
    // 5-min turn timeout, which otherwise kills the turn → HTTP 500 → the card parks.
    // Absent (e.g. web chat) → session.runTurn uses its default, so other channels are
    // unaffected. Only honored when finite + positive.
    timeoutMs:
      typeof body?.timeoutMs === "number" && Number.isFinite(body.timeoutMs) && body.timeoutMs > 0
        ? body.timeoutMs
        : undefined,
  };
}

/** Agent SDK permission callbacks are reachable only for a stable Web thread. */
/**
 * Every lane runs unattended.
 *
 * The Web thread used to be the one surface that asked, because it is the one
 * with somewhere to show a prompt. In practice that means work stops until
 * someone is looking at that tab - from the board, from a schedule, from the
 * phone - which is the opposite of what this machine is for. The durable
 * permission-card path is still wired end to end (adapter callback, gateway
 * resolver, durable revisions, answer endpoint, UI cards) and comes back whole
 * with GARRISON_WEB_PERMISSION_PROMPTS=1; nothing was deleted to get here.
 */
export function permissionModeForHints(hints) {
  if (process.env.GARRISON_WEB_PERMISSION_PROMPTS !== "1") return "bypassPermissions";
  return hints?.channel === "web" && exactPermissionId(hints?.sessionId)
    ? "default"
    : "bypassPermissions";
}

function webThreadRequiredFailure() {
  const failure = {
    source: "gateway",
    kind: "invalid_request",
    code: "web_thread_required",
    text: "Generated Web turns require a durable thread identity.",
    retryable: false,
    httpStatus: 400,
  };
  return { error: failure.text, failure };
}

function webStreamRequiredFailure() {
  const failure = {
    source: "gateway",
    kind: "invalid_request",
    code: "web_stream_required",
    text: "Generated Web turns require the streamed durable input endpoint.",
    retryable: false,
    httpStatus: 400,
  };
  return { error: failure.text, failure };
}

function webInputRequiredFailure() {
  const failure = {
    source: "gateway",
    kind: "invalid_request",
    code: "web_input_required",
    text: "Generated Web streams require a durable input identity.",
    retryable: false,
    httpStatus: 400,
  };
  return { error: failure.text, failure };
}

function webRouteUnavailableFailureInfo() {
  return {
    source: "gateway",
    kind: "routing",
    code: "gateway_route_unavailable",
    text: "Generated Web turns require model routing, but the routed gateway is unavailable.",
    retryable: true,
    httpStatus: 503,
  };
}

function webRouteUnavailableFailure() {
  const failure = webRouteUnavailableFailureInfo();
  return { error: failure.text, failure };
}

function webRouteUnavailableError() {
  const failure = webRouteUnavailableFailureInfo();
  const error = new Error(failure.text);
  Object.assign(error, failure, { failure });
  return error;
}

function enqueueTurn(message, onChunk, hints, opts = {}) {
  // No global chain (2026-08-07): the turn starts NOW and serializes only where
  // its resolved lane demands it (see the per-lane queues in gateway-routing and
  // the operative gate above).
  const runP = runTurn(message, onChunk, hints, opts);
  // Mesh session registry: every lane's turn passes through here, so this is the
  // one place the run is honestly "busy". The registry counts overlapping turns,
  // so the row only returns to idle when the LAST one settles.
  void announceGenerationOpen(SESSION_LOG_RUN);
  runP.then(() => announceGenerationClose(SESSION_LOG_RUN), () => announceGenerationClose(SESSION_LOG_RUN));
  // Turn-boundary compaction check (S1b): only the standing claude-code
  // operative accumulates context across turns (maybeCompact self-filters), so
  // the check queues on the OPERATIVE lane - it must never overlap an operative
  // turn, and it must not delay the caller (runP settles independently).
  runP.then((result) => enqueueOperative(() => maybeCompactAtTurnBoundary(hints, result))).catch(() => {});
  return runP;
}

// Enqueue an arbitrary boundary action (e.g. a duty-boundary compact check) onto
// the operative lane, so it can never overlap standing-operative work. Returns
// the action's promise; the chain swallows its rejection so one failure never
// wedges the next turn.
function enqueue(fn) {
  return enqueueOperative(fn);
}

// S3d review R1/R3: at the HTTP entry point (BEFORE enqueueTurn), decide whether a web
// thread message ANSWERS a live discuss picker or is an explicit GO on a card held in
// Discuss, and perform the effect OUT-OF-BAND (drive the live picker via handleAnswer,
// or an engine-header Move discuss->plan). Returns { reply, card, action } when handled,
// else null (the caller enqueues an ordinary turn). Never throws. This runs out-of-band
// like POST /chat/answer, so it works while the blocked discuss turn holds the chain.
async function dispatchDiscussIntercept(body) {
  try {
    const message = String(body?.message ?? "");
    const decision = await resolveDiscussInterception({
      text: message,
      channel: body?.channel,
      sessionId: typeof body?.sessionId === "string" ? body.sessionId : null,
      pendingQuestions,
      resolveThreadCard: (originId) => (router ? router.resolveThreadCard(originId) : Promise.resolve(null)),
    });
    if (!decision) return null;
    if (decision.action === "answer") {
      const r = await handleAnswer(
        { tool_use_id: decision.toolUseId, text: message },
        { trustedCardId: decision.card.id }
      );
      const reply =
        r?.status === 200
          ? "Got it - passing that to the discussion."
          : "Tried to pass that to the discussion, but the question may have already closed.";
      logEvent("stdout", { kind: "discuss-answer", card: decision.card.id, tool_use_id: decision.toolUseId, status: r?.status ?? null });
      return { reply, card: decision.card.id, action: "answer" };
    }
    if (decision.action === "autonomy-go") {
      // §7.1: the go on a card the router HELD below its lower threshold. The
      // move is the release - the board clears the hold inside the same CAS that
      // moves the card and records the confirmation as evidence, so the tracks
      // learn from this word (see handlePatchCard). The resume list is the one
      // the router proposed when it asked; "plan" only when the card predates the
      // field or lost it.
      // The move carries no dispatch header (moveCardEngine's one shape); the
      // board starts the card because CLEARING a hold is itself the authorisation
      // to progress - see handlePatchCard, where the release overrides the
      // engine-context suppression for exactly this reason.
      //
      // A card the user CORRECTED before saying go carries its corrected route on
      // the run spec (heldCardRoute states that precedence). The go then confirms
      // what the correction proposed, and resumes onto the list the corrected
      // route actually starts at - not the list the rejected route named. An
      // uncorrected card takes neither branch: `corrected` is false, so both the
      // resume list and the confirmation are byte-identical to what they were.
      const held = heldCardRoute(decision.card);
      const targetList =
        (held.corrected ? await router.resumeListFor(held) : null) ||
        decision.card.autonomyAsk?.resumeList ||
        "plan";
      const moved = await moveCardEngine({
        id: decision.card.id,
        targetList,
        logFn: (e) => logEvent("stdout", e)
      });
      // The go is EVIDENCE, and only when the release actually landed: recording a
      // confirmation for work that never started would teach the router that a
      // failed move was a job well done.
      if (moved) {
        await router.recordAutonomyGo({
          cardId: decision.card.id,
          flow: held.flow,
          duty: held.duty,
          level: held.level,
          tier: held.tier,
          decisionId: held.decisionId,
          sessionId: typeof body?.sessionId === "string" ? body.sessionId : null
        });
      }
      const reply = moved
        ? `Going ahead - ${targetList}.`
        : `Couldn't start the card just now - try again, or move it on the board.`;
      logEvent("stdout", { kind: "autonomy-go", card: decision.card.id, targetList, moved });
      return { reply, card: decision.card.id, action: "autonomy-go" };
    }
    if (decision.action === "autonomy-correct") {
      // §7.1: the ask's OTHER answer. "Reply go to proceed, or correct me" invited
      // a correction and, until 2026-08-13, had no branch to receive one - the
      // correction was routed as a brand-new turn and answered without the thread.
      // The correction is re-dispatched over the card's original brief, re-stamps
      // the card, and the card STAYS HELD: re-routing is not authorisation.
      const outcome = await router.correctHeldCard({
        card: decision.card,
        correction: decision.correction,
        sessionId: typeof body?.sessionId === "string" ? body.sessionId : null
      });
      if (!outcome?.ok) {
        // Honest failure. Falling through to an ordinary turn here is exactly the
        // bug, so a correction that cannot be applied says so and leaves the hold.
        const reply =
          "I couldn't apply that correction just now - the card is still held. " +
          "Try again in a moment, or set the route on the card and move it on the board.";
        logEvent("stderr", { kind: "autonomy-correct-failed", card: decision.card.id, reason: outcome?.reason ?? "unknown" });
        return { reply, card: decision.card.id, action: "autonomy-correct-failed" };
      }
      // The re-ask is a question POSED, so it counts against today's budget for the
      // same reason the first one did (autonomy-consult §6: count delivery, not intent).
      await router.recordAutonomyAsked();
      const what = outcome.phrase || `duty ${outcome.applied.duty}, level ${outcome.applied.level}`;
      const reply = outcome.unchanged
        ? `Still ${what} - the correction did not change the call. Reply go to proceed, or correct me again.`
        : `Re-routed as ${what} - reply go to proceed, or correct me again.`;
      logEvent("stdout", {
        kind: "autonomy-corrected",
        card: decision.card.id,
        from: outcome.original.duty ?? null,
        to: outcome.applied.duty,
        level: outcome.applied.level,
        flow: outcome.applied.flow ?? null,
        unchanged: outcome.unchanged === true
      });
      return { reply, card: decision.card.id, action: "autonomy-correct" };
    }
    if (decision.action === "go") {
      const moved = await moveCardEngine({ id: decision.card.id, targetList: "plan", logFn: (e) => logEvent("stdout", e) });
      const reply = moved
        ? "Proceeding to plan."
        : "Couldn't move the card to plan just now - try again, or move it on the board.";
      logEvent("stdout", { kind: "discuss-go", card: decision.card.id, moved });
      return { reply, card: decision.card.id, action: "go" };
    }
    return null;
  } catch (err) {
    logEvent("stderr", { kind: "discuss-intercept-failed", error: err?.message || String(err) });
    return null;
  }
}

// ─────────────────────────────────────────────────────── HTTP plumbing

const UPLOADS_DIR = path.join(COMPOSITION_DIR, ".garrison", "uploads");
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
// The wire body is JSON carrying the file as base64 (≈4/3 inflation) plus the
// `{"filename":"…","content_base64":"…"}` envelope. Sizing the request-body cap
// at MAX_UPLOAD_BYTES undercounts by a third, so a file well under 10MB was
// rejected mid-stream. Cap the body at the base64 size + envelope slack instead,
// and let saveAttachment enforce the real 10MB limit on the DECODED bytes.
const MAX_ATTACHMENT_BODY_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 256 * 1024;

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function sseWrite(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(request, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > limit) {
        request.destroy();
        reject(new Error(`request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    request.on("error", reject);
  });
}

function safeFilename(input) {
  const base = path.basename(String(input ?? "file"));
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "file";
}

async function saveAttachment(filename, contentBase64) {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  const safe = safeFilename(filename);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const target = path.join(UPLOADS_DIR, `${stamp}-${safe}`);
  const buffer = Buffer.from(contentBase64, "base64");
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(`attachment exceeds ${MAX_UPLOAD_BYTES} bytes`);
  await fs.writeFile(target, buffer);
  return { path: target, bytes: buffer.length };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  // Local-API hardening (Harness brief §7): localhost binding does not stop a
  // malicious webpage in the user's browser from reaching this RPC surface —
  // browsers attach an Origin header to cross-origin fetches, while loopback
  // server-to-server Node clients send none. A browser-origin request is
  // accepted only from this gateway's own origin, or with the minted token
  // (which a foreign page cannot read).
  {
    const origin = request.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try {
        const o = new URL(origin);
        sameOrigin = (o.hostname === HOST || o.hostname === "localhost" || o.hostname === "127.0.0.1") &&
          String(o.port || (o.protocol === "https:" ? "443" : "80")) === String(PORT);
      } catch { /* malformed origin = not same-origin */ }
      if (!sameOrigin && request.headers["x-garrison-token"] !== GATEWAY_TOKEN) {
        sendJson(response, 403, { error: "browser cross-origin requests are not accepted by the local API" });
        return;
      }
    }
  }
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      const operativeExited = ptyStatus === "ready" && !runtimeSessionAlive();
      const effectiveStatus = operativeExited ? "failed" : ptyStatus;
      sendJson(response, 200, {
        ok: effectiveStatus !== "failed",
        session_id: runtimeSessionId(),
        uptime_ms: Date.now() - STARTED_AT,
        engine: "pty",
        primary_runtime: primaryRuntime(),
        pty_status: effectiveStatus,
        error: operativeExited ? "operative session exited" : ptyError,
      });
      return;
    }

    // §11: everything the Turn Rail's menus need, in ONE read, and deliberately
    // NOT behind `await readyPromise` - the menu must work while the operative is
    // still spawning (that is exactly when a user wants to change where the next
    // turn runs).
    if (request.method === "GET" && url.pathname === "/route/options") {
      return sendJson(response, 200, buildRouteOptions());
    }

    // Authored Orchestrator changes take effect on the next turn. Queue a warm
    // session rebuild on the same serialized boundary as turns so an in-flight
    // response is never interrupted and no later turn can observe the old prompt.
    if (request.method === "POST" && url.pathname === "/control/reload-prompt") {
      if (!router) return sendJson(response, 409, { error: "routed operative is not ready" });
      enqueue(async () => {
        ptyStatus = "starting";
        try {
          await Promise.resolve(router?.shutdown?.());
          router = null;
          session = null;
          await initRouting();
          logEvent("stdout", { kind: "orchestrator-prompt-reloaded" });
        } catch (err) {
          ptyStatus = "failed";
          ptyError = err?.message || String(err);
          logEvent("stderr", { kind: "orchestrator-prompt-reload-failed", error: ptyError });
        }
      }).catch(() => {});
      return sendJson(response, 202, { ok: true, status: "queued" });
    }

    // §9: stop the in-flight turn for one conversation. The turn then settles
    // normally with its partial reply and stoppedByUser on the done frame - this
    // endpoint never ends the SSE stream itself.
    if (request.method === "POST" && url.pathname === "/chat/interrupt") {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (err) {
        return sendJson(response, 400, { ok: false, error: `invalid json: ${err.message}` });
      }
      const r = await handleInterrupt(body);
      return sendJson(response, r.status, r.body);
    }

    // Recover the exact generation claimed for one durable Web admission. This
    // is intentionally read-only and exact: no claim/released is 404; a live
    // same-thread claim for another (or pre-upgrade) input is a fail-closed 409.
    if (request.method === "POST" && url.pathname === "/chat/generation") {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (err) {
        return sendJson(response, 400, { ok: false, error: `invalid json: ${err.message}` });
      }
      const result = generationTurnControl.lookupInput(body);
      return sendJson(response, result.status, result.body);
    }

    // Strong restart recovery for an admission whose SSE owner died. Exact
    // input correlation prevents one process from abandoning another input's
    // journal; the generation remains claimed until its runtime cache is reset.
    if (request.method === "POST" && url.pathname === "/chat/recover") {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (err) {
        return sendJson(response, 400, { ok: false, error: `invalid json: ${err.message}` });
      }
      const result = await generationTurnControl.recoverInput(body);
      return sendJson(response, result.status, result.body);
    }

    // Resolve one exact Agent SDK permission request. Resolver handles are
    // intentionally not reconstructable: after a restart the durable prompt is
    // still visible, but this endpoint returns 409 because no live SDK callback
    // exists to receive the decision.
    if (request.method === "POST" && url.pathname === "/chat/permission") {
      let body;
      try {
        body = await readJsonBody(request);
      } catch (err) {
        return sendJson(response, 400, { error: `invalid json: ${err.message}` });
      }
      const result = permissionControl.decide(body);
      return sendJson(response, result.status, result.body);
    }

    // Read-only rendered-screen surface: the operative session's live terminal
    // screen (the xterm-headless render claude-pty already maintains), for
    // watch surfaces like the Kanban board. GET /screen is one snapshot;
    // /screen/stream is SSE pushing {lines} whenever the render changes.
    // Watch only - no input path exists here.
    if (request.method === "GET" && url.pathname === "/screen") {
      const lines = renderedScreenLines();
      if (!lines) return sendJson(response, 503, { error: "no live operative session" });
      return sendJson(response, 200, { lines, at: Date.now() });
    }
    if (request.method === "GET" && url.pathname === "/screen/stream") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders?.();
      const write = (event, data) => {
        try { response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
      };
      let last = null;
      const pump = () => {
        const lines = renderedScreenLines();
        if (!lines) { write("mode", { live: false }); return; }
        const joined = lines.join("\n");
        if (joined !== last) { write("screen", { lines }); last = joined; }
      };
      write("mode", { live: !!renderedScreenLines() });
      pump();
      const timer = setInterval(pump, 700);
      request.on("close", () => clearInterval(timer));
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      const body = await readJsonBody(request);
      const message = typeof body.message === "string" ? body.message : "";
      if (!message.trim()) return sendJson(response, 400, { error: "message is required" });
      const hints = routeHintsFromBody(body);
      if (hints.channel === "web") {
        if (!exactPermissionId(hints.sessionId)) {
          return sendJson(response, 400, webThreadRequiredFailure());
        }
        return sendJson(response, 400, webStreamRequiredFailure());
      }
      await readyPromise;
      // S3d review R1: intercept a Discuss answer / explicit-go BEFORE enqueueTurn.
      const intercepted = await dispatchDiscussIntercept(body);
      if (intercepted) {
        logEvent("stdout", { kind: "chat-intercept", action: intercepted.action, card: intercepted.card });
        sendJson(response, 200, { reply: intercepted.reply, session_id: null, cost_usd: null, card: intercepted.card, [intercepted.action]: true });
        return;
      }
      logEvent("stdout", { kind: "chat-in", message: message.slice(0, 200) });
      const result = await enqueueTurn(message, undefined, hints);
      logEvent("stdout", { kind: "chat-out", reply: result.reply.slice(0, 200) });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat/stream") {
      const body = await readJsonBody(request);
      const message = typeof body.message === "string" ? body.message : "";
      if (!message.trim()) return sendJson(response, 400, { error: "message is required" });
      if (Object.hasOwn(body, "inputId") && !exactDurableInputId(body.inputId)) {
        return sendJson(response, 400, {
          error: "inputId must be a non-empty exact string of at most 512 characters",
          code: "invalid_input_id"
        });
      }
      // Only the streamed endpoint owns generations. A generation is opaque and
      // new per request; it is exposed on `open` and stamped onto canonical
      // permission events by the Agent SDK path.
      const hints = routeHintsFromBody(body);
      if (hints.channel === "web" && !exactPermissionId(hints.sessionId)) {
        return sendJson(response, 400, webThreadRequiredFailure());
      }
      if (hints.channel === "web" && !hints.inputId) {
        return sendJson(response, 400, webInputRequiredFailure());
      }
      // Generated Web threads are isolated routed conversations. They must
      // never inherit the composition-wide standing PTY merely because routing
      // was disabled for this process. Reject before readiness, interception,
      // generation ownership, or any user bytes can enter the operative lane.
      if (hints.channel === "web" && !ROUTING_ENABLED) {
        return sendJson(response, 503, webRouteUnavailableFailure());
      }
      const permissionMode = permissionModeForHints(hints);
      const permissionEnabled = permissionMode === "default";
      const interceptedGenerationId = randomUUID();

      // S3d review R1: intercept a Discuss answer / explicit-go BEFORE opening the stream
      // and BEFORE enqueueTurn - out-of-band, so it drives the live picker held by the
      // blocked discuss turn instead of queuing behind it. Emit a minimal open/done SSE.
      await readyPromise;
      // Routing may be enabled yet unavailable (for example, the model-router
      // fitting is absent and startup fell back to the legacy PTY). Keep the
      // same fail-closed boundary once startup has resolved that state.
      if (hints.channel === "web" && (!router || ptyStatus !== "ready")) {
        return sendJson(response, 503, webRouteUnavailableFailure());
      }
      const intercepted = await dispatchDiscussIntercept(body);
      if (intercepted) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("cache-control", "no-cache, no-transform");
        response.setHeader("connection", "keep-alive");
        response.setHeader("x-accel-buffering", "no");
        response.flushHeaders?.();
        sseWrite(response, "open", { ts: Date.now(), generationId: interceptedGenerationId });
        sseWrite(response, "done", {
          reply: intercepted.reply,
          session_id: null,
          cost_usd: null,
          card: intercepted.card,
          [intercepted.action]: true,
          generationId: interceptedGenerationId
        });
        logEvent("stdout", { kind: "chat-stream-intercept", action: intercepted.action, card: intercepted.card });
        response.end();
        return;
      }

      // Open the live resolver scope only after readiness/interception. Anything
      // that fails before here has no handle to leak.
      const permissionGenerationId = permissionEnabled ? permissionControl.openGeneration(hints.sessionId) : null;
      const generationId = permissionGenerationId ?? interceptedGenerationId;
      const webThreadId = hints.channel === "web" ? exactPermissionId(hints.sessionId) : null;
      const turnClaim = webThreadId
        ? generationTurnControl.claim(webThreadId, generationId, {
            lane: primaryRuntime(),
            ...(hints.inputId ? { inputId: hints.inputId } : {})
          })
        : null;
      if (turnClaim && turnClaim.status !== 201) {
        if (permissionGenerationId) permissionControl.closeGeneration(permissionGenerationId);
        return sendJson(response, turnClaim.status, turnClaim.body);
      }
      const turnControlEntry = turnClaim?.entry ?? null;
      const withGeneration = (payload) =>
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? { ...payload, generationId }
          : { value: payload, generationId };
      const writeStreamEvent = (event, payload) => sseWrite(response, event, withGeneration(payload));
      let heartbeat = null;
      let pendingPre = null;
      let canonicalMaxOrder = 0;
      let canonicalTerminalObserved = false;
      let canonicalFailure = null;
      // The watcher delivers only questions observed in this turn's transcript
      // to this sink. It is stored on the exact AsyncLocalStorage turn entry;
      // there is deliberately no process-global listener fanout.
      const onQuestion = (payload) => {
        try {
          writeStreamEvent("tool", payload);
        } catch {
          /* client gone */
        }
      };

      try {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("cache-control", "no-cache, no-transform");
        response.setHeader("connection", "keep-alive");
        response.setHeader("x-accel-buffering", "no");
        response.flushHeaders?.();
        writeStreamEvent("open", { ts: Date.now() });
        heartbeat = setInterval(() => {
          try {
            response.write(": keepalive\n\n");
          } catch {
            /* ignore */
          }
        }, 15_000);

        // §4: the FIRST `route` frame, emitted the moment preRoute resolves, so the
        // badge row appears ~1s into the turn instead of after the reply. `pending`
        // marks it as refinable; the client merges the done frame over it and drops
        // any frame from an older turnSeq (§5).
        const emitPendingRoute = (extra = {}) => {
          try {
            writeStreamEvent("route", pendingRouteFrame(pendingPre, hints, extra));
          } catch {
            /* client gone */
          }
        };
        const onPreRoute = (pre) => {
          pendingPre = pre;
          emitPendingRoute();
        };
        // Follow-up `route` frame once the selected runtime has a journal. It
        // merges into the same pending attribution client-side, giving the host a
        // session id early enough to open SessionStream during the turn.
        const onJournal = (identity) => {
          bindQuestionJournal(identity);
          emitPendingRoute(identity);
        };
        const onRouteSessionObservation = (observation = {}) => {
          emitPendingRoute({
            ...(observation && typeof observation === "object" ? observation : {}),
            ...(typeof observation?.sessionId === "string" ? { session_id: observation.sessionId } : {}),
          });
        };
        // §12: tool activity from a routed runtime, for the working-hint slot.
        const onActivity = (payload) => {
          try {
            writeStreamEvent("activity", payload);
          } catch {
            /* client gone */
          }
        };
        // Structured session events are already in the runtime-neutral vocabulary.
        // Forward each payload immediately, adding only the gateway-owned generation
        // coordinate; legacy activity/chunk/done frames remain alongside it.
        const onSessionEvent = (payload) => {
          if (Number.isSafeInteger(payload?.order) && payload.order >= 0) {
            canonicalMaxOrder = Math.max(canonicalMaxOrder, payload.order);
          }
          for (const block of Array.isArray(payload?.blocks) ? payload.blocks : []) {
            if (block?.type === "error") {
              canonicalFailure = normalizeFailureInfo(block, { source: "runtime", kind: "runtime" });
            }
            if (block?.type === "turn_end") canonicalTerminalObserved = true;
          }
          try {
            writeStreamEvent("session_event", payload);
          } catch {
            /* client gone */
          }
        };

        await readyPromise;
        const result = await enqueueTurn(message, (text, replace) => {
          try {
            // `replace` (the onChunk 2nd arg) marks a FULL re-emit of the reply after
            // a screen reflow/divergence — not a delta. Forward it so the client
            // REPLACES its accumulator instead of appending (the duplication bug that
            // turned a short reply into kilobytes of repeated text). Additive field:
            // older clients that ignore it are unaffected.
            writeStreamEvent("chunk", { type: "chunk", text, replace: replace === true });
          } catch {
            /* client gone */
          }
        }, hints, {
          onPreRoute,
          onActivity,
          onJournal,
          onRouteSessionObservation,
          onQuestion,
          onSessionEvent,
          generationId,
          permissionMode,
          turnControlEntry,
          ...(permissionGenerationId
            ? {
                onPermissionRequest: (publicRequest, context = {}) =>
                  permissionControl.awaitDecision(
                    hints.sessionId,
                    permissionGenerationId,
                    publicRequest,
                    { signal: context?.signal }
                  )
              }
            : {})
        });
        if (result?.terminalStatus === "error" && !canonicalTerminalObserved) {
          canonicalFailure = normalizeFailureInfo(result?.failure, {
            code: "runtime_turn_failed",
            kind: "runtime",
            source: "runtime",
            retryable: false,
          });
          onSessionEvent(gatewayFailureSessionEvent({
            generationId,
            turnId: hints?.turnSeq,
            order: canonicalMaxOrder + 1,
            failure: canonicalFailure,
          }));
        }
        // Additive context telemetry (D5b): the turn's live/peak context % + any
        // compactions, read off the operative session that just ran. A nested
        // `context` object so consumers (the kanban engine) opt in without any
        // change to the existing result shape.
        writeStreamEvent("done", { ...result, context: contextTelemetry() });
        logEvent("stdout", { kind: "chat-stream-out", reply: result.reply.slice(0, 200) });
      } catch (err) {
        const failure = normalizeFailureInfo(err?.failure ?? err, {
          code: err?.code ?? "gateway_turn_failed",
          kind: err?.kind ?? "runtime",
          source: err?.failure?.source ?? err?.source ?? "gateway",
          retryable: err?.retryable === true,
        });
        canonicalFailure = canonicalFailure ?? failure;
        if (!canonicalTerminalObserved) {
          const terminal = gatewayFailureSessionEvent({
            generationId,
            turnId: hints?.turnSeq,
            order: canonicalMaxOrder + 1,
            failure: canonicalFailure,
          });
          try {
            writeStreamEvent("session_event", terminal);
            canonicalTerminalObserved = true;
          } catch {
            /* client gone */
          }
        }
        try {
          // Compatibility-only lifecycle signal. The canonical error/turn_end
          // above owns durable content; these bounded flat fields let legacy
          // transports reject with the same typed failure.
          writeStreamEvent("error", { error: failure.text, ...failure, failure });
        } catch {
          /* client gone */
        }
        logEvent("stderr", { kind: "chat-stream-failed", code: failure.code, error: failure.text });
      } finally {
        if (permissionGenerationId) permissionControl.closeGeneration(permissionGenerationId);
        if (turnControlEntry) generationTurnControl.release(turnControlEntry);
        if (heartbeat) clearInterval(heartbeat);
        response.end();
      }
      return;
    }

    // Raise ONE duty on ONE card for THIS card only (level-resolution.mjs step 3).
    // Body: { cardId, duty, toLevel, reason }. The reason is mandatory - an
    // escalation with no reason cannot become an improver signal and cannot be
    // judged in the decisions log, so a reasonless one is refused rather than
    // logged as noise.
    //
    // Deliberately NOT behind `await readyPromise`: escalating a card is a routing
    // decision about work the BOARD is driving, and it must not queue behind a
    // spawning operative. Every branch is answered by the router (which logs the
    // decision either way), so this handler only adapts it to HTTP.
    // ── Conversations (the stretch launcher's doors) ─────────────────────────
    // A conversation is driven in-process on its own lane, OFF the serialized
    // operative turn chain. The board is a trigger (its tick re-POSTs advance
    // for recovery); these routes are the only way work enters the launcher.
    if (url.pathname.startsWith("/conversation")) {
      if (!router) return sendJson(response, 409, { error: "routed operative is not ready" });
      const stretchLib = await import("./lib/stretch.mjs");
      const { openConversation, newConversationId } = await import("@garrison/claude-pty");

      if (request.method === "POST" && url.pathname === "/conversation/open") {
        const body = await readJsonBody(request);
        const conversationId = typeof body.conversationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.conversationId)
          ? body.conversationId
          : newConversationId();
        const store = openConversation(conversationId, { role: "gateway" });
        store.init({
          title: typeof body.title === "string" ? body.title.slice(0, 120) : "Conversation",
          objective: typeof body.objective === "string" ? body.objective.slice(0, 2000) : "",
          origin: typeof body.origin === "string" ? body.origin : null,
          cardId: typeof body.cardId === "string" ? body.cardId : null,
        });
        if (typeof body.task === "string" && body.task.trim()) {
          stretchLib.recordUserMessage(store, { text: body.task, origin: body.origin ?? "api" });
        }
        logEvent("stdout", { kind: "conversation-open", conversationId });
        return sendJson(response, 201, { conversationId });
      }

      if (request.method === "POST" && url.pathname === "/conversation/advance") {
        const body = await readJsonBody(request);
        const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
        if (!conversationId) return sendJson(response, 400, { error: "conversationId is required" });
        const controllers = (globalThis.__conversationAborts ??= new Map());
        if (controllers.has(conversationId)) {
          return sendJson(response, 409, { error: "conversation is already advancing", conversationId });
        }
        const controller = new AbortController();
        controllers.set(conversationId, controller);
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("cache-control", "no-cache, no-transform");
        response.setHeader("connection", "keep-alive");
        response.setHeader("x-accel-buffering", "no");
        response.flushHeaders?.();
        sseWrite(response, "open", { ts: Date.now(), conversationId });
        const heartbeat = setInterval(() => {
          try {
            response.write(": keepalive\n\n");
          } catch {
            /* client gone */
          }
        }, 15_000);
        // Closing the SSE client does NOT cancel the conversation — process
        // survives tab close; /conversation/cancel is the explicit stop.
        try {
          const result = await stretchLib.runConversation(router, {
            conversationId,
            task: typeof body.task === "string" && body.task.trim() ? body.task : null,
            maxStretches: Number(body.maxStretches) > 0 ? Math.min(Number(body.maxStretches), 64) : undefined,
            signal: controller.signal,
            onFrame: (event, payload) => {
              try {
                sseWrite(response, event, payload);
              } catch {
                /* client gone; the loop keeps running */
              }
            },
          });
          logEvent("stdout", { kind: "conversation-advance-done", conversationId, ...result });
        } catch (err) {
          try {
            sseWrite(response, "error", { error: err?.message ?? String(err) });
          } catch {
            /* client gone */
          }
          logEvent("stderr", { kind: "conversation-advance-error", conversationId, error: err?.message });
        } finally {
          clearInterval(heartbeat);
          controllers.delete(conversationId);
          try {
            response.end();
          } catch {
            /* already closed */
          }
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/conversation/message") {
        const body = await readJsonBody(request);
        const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
        const message = typeof body.message === "string" ? body.message : "";
        if (!conversationId || !message.trim()) {
          return sendJson(response, 400, { error: "conversationId and message are required" });
        }
        const store = openConversation(conversationId, { role: "gateway" });
        store.init({});
        const rec = stretchLib.recordUserMessage(store, {
          text: message,
          origin: typeof body.origin === "string" ? body.origin : "web",
          threadId: typeof body.threadId === "string" ? body.threadId : null,
          context: typeof body.context === "string" ? body.context : null,
          routing: body.routing && typeof body.routing === "object" && !Array.isArray(body.routing) ? body.routing : null,
        });
        const running = store.currentStretch();
        const controllers = (globalThis.__conversationAborts ??= new Map());
        const advancing = controllers.has(conversationId);
        // Nothing running → a responder stretch answers from L1. Fire and
        // forget on the conversation lane; the caller watches the store/SSE.
        if (!running && !advancing) {
          const controller = new AbortController();
          controllers.set(conversationId, controller);
          void stretchLib
            .runConversation(router, { conversationId, signal: controller.signal })
            .catch((err) => logEvent("stderr", { kind: "conversation-responder-error", conversationId, error: err?.message }))
            .finally(() => controllers.delete(conversationId));
        }
        return sendJson(response, 202, { accepted: true, seq: rec.seq, pickedUpBy: running ? "running-stretch" : advancing ? "advancing" : "responder" });
      }

      // Fire-and-forget start/recovery door: the board's tick and the Start
      // action land here. Opens the store when new, links the card, clears the
      // schedule trigger, and advances in the background. 202 always; a
      // conversation already advancing answers 409 so kicks are idempotent.
      if (request.method === "POST" && url.pathname === "/conversation/kick") {
        const body = await readJsonBody(request);
        const conversationId = typeof body.conversationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.conversationId)
          ? body.conversationId
          : "";
        if (!conversationId) return sendJson(response, 400, { error: "conversationId is required" });
        const controllers = (globalThis.__conversationAborts ??= new Map());
        if (controllers.has(conversationId)) {
          return sendJson(response, 409, { error: "conversation is already advancing", conversationId });
        }
        const store = openConversation(conversationId, { role: "gateway" });
        store.init({
          title: typeof body.title === "string" ? body.title.slice(0, 120) : "Conversation",
          cardId: typeof body.cardId === "string" ? body.cardId : conversationId,
        });
        // Link the card to its conversation + clear the schedule-run trigger so
        // the tick stops re-kicking; best-effort (the advance still runs).
        void stretchLib
          .patchCardEngine({
            id: typeof body.cardId === "string" ? body.cardId : conversationId,
            patch: { conversationId, scheduleAction: null },
            logFn: (e) => logEvent("stdout", e),
          })
          .catch(() => {});
        const controller = new AbortController();
        controllers.set(conversationId, controller);
        void stretchLib
          .runConversation(router, {
            conversationId,
            task: typeof body.task === "string" && body.task.trim() ? body.task : null,
            signal: controller.signal,
          })
          .then((r) => logEvent("stdout", { kind: "conversation-kick-done", conversationId, ...r }))
          .catch((err) => logEvent("stderr", { kind: "conversation-kick-error", conversationId, error: err?.message }))
          .finally(() => controllers.delete(conversationId));
        return sendJson(response, 202, { accepted: true, conversationId });
      }

      if (request.method === "POST" && url.pathname === "/conversation/cancel") {
        const body = await readJsonBody(request);
        const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
        const controllers = (globalThis.__conversationAborts ??= new Map());
        const controller = controllers.get(conversationId);
        if (!controller) return sendJson(response, 404, { error: "no advancing conversation", conversationId });
        controller.abort();
        logEvent("stdout", { kind: "conversation-cancel", conversationId });
        return sendJson(response, 202, { cancelled: true, conversationId });
      }

      if (request.method === "GET" && /^\/conversation\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(url.pathname)) {
        const conversationId = url.pathname.split("/")[2];
        const store = openConversation(conversationId, { role: "gateway" });
        const summary = store.readSummary();
        if (summary == null) return sendJson(response, 404, { error: "no such conversation" });
        return sendJson(response, 200, {
          conversationId,
          summary,
          handoffs: store.lastHandoffs(10),
          tail: store.tail(100),
          currentStretch: store.currentStretch(),
          advancing: (globalThis.__conversationAborts ?? new Map()).has(conversationId),
        });
      }

      return sendJson(response, 404, { error: "not found", path: url.pathname });
    }

    if (request.method === "POST" && url.pathname === "/escalate") {
      if (!router) return sendJson(response, 409, { error: "routed operative is not ready" });
      const body = await readJsonBody(request);
      const r = await router.escalateCardDuty({
        cardId: body?.cardId,
        duty: body?.duty,
        toLevel: body?.toLevel,
        reason: body?.reason
      });
      logEvent("stdout", {
        kind: "escalate",
        card: body?.cardId ?? null,
        duty: body?.duty ?? null,
        applied: r.body?.applied ?? false,
        status: r.status
      });
      return sendJson(response, r.status, r.body);
    }

    // Answer an AskUserQuestion picker the operative raised (tappable buttons on the
    // client). Body: { session_id?, tool_use_id, label? | text? | dismiss? }.
    if (request.method === "POST" && url.pathname === "/chat/answer") {
      const body = await readJsonBody(request);
      await readyPromise;
      const r = await handleAnswer(body);
      logEvent("stdout", { kind: "chat-answer", tool_use_id: body?.tool_use_id ?? null, action: r.body?.action ?? null, status: r.status });
      sendJson(response, r.status, r.body);
      return;
    }

    if (request.method === "POST" && url.pathname === "/attachments") {
      const body = await readJsonBody(request, MAX_ATTACHMENT_BODY_BYTES);
      const filename = String(body.filename ?? "").trim();
      const contentBase64 = String(body.content_base64 ?? "");
      if (!filename || !contentBase64) {
        return sendJson(response, 400, { error: "filename and content_base64 are required" });
      }
      const saved = await saveAttachment(filename, contentBase64);
      logEvent("stdout", { kind: "attachment-saved", path: saved.path, bytes: saved.bytes });
      sendJson(response, 200, saved);
      return;
    }

    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readJsonBody(request);
      const claim = await jobIngress.claim(body);
      if (!claim.accepted) {
        if (claim.source === "invalid") {
          sendJson(response, 400, { ack: false, retryable: false, error: claim.error });
          return;
        }
        if (claim.source === "storage-error") {
          logEvent("stderr", { kind: "job-storage-unavailable", error: claim.error });
          sendJson(response, 503, { ack: false, retryable: true, error: claim.error });
          return;
        }
        if (claim.source === "backpressure") {
          logEvent("stderr", { kind: "job-backpressure", job: claim.key.split(":", 1)[0] });
          sendJson(response, 503, { ack: false, retryable: true, error: "job ingress is at capacity" });
          return;
        }
        if (isPendingJobClaim(claim)) {
          logEvent("stdout", { kind: "job-dispatch-pending", job: claim.key.split(":", 1)[0] });
          sendJson(response, 503, {
            ack: false,
            retryable: true,
            error: "job dispatch reservation is still being prepared"
          });
          return;
        }
        logEvent("stdout", {
          kind: "job-deduped",
          source: claim.source,
          card: claim.cardId ?? null,
          job: claim.key.split(":", 1)[0]
        });
        sendJson(response, 202, { ack: true, deduped: true, card: claim.cardId ?? null });
        return;
      }
      const jobMessage = jobDescription(body);
      try {
        await prepareClaimForAcknowledgement({ guard: jobIngress, claim });
      } catch (error) {
        logEvent("stderr", {
          kind: "job-dispatch-fence-failed",
          error: error?.message || String(error)
        });
        sendJson(response, 503, {
          ack: false,
          retryable: true,
          error: "job dispatch could not be durably reserved"
        });
        return;
      }
      let resolveAdmission;
      let rejectAdmission;
      const admitted = new Promise((resolve, reject) => {
        resolveAdmission = resolve;
        rejectAdmission = reject;
      });
      const forwarding = forwardClaimWithRetry({
        guard: jobIngress,
        claim,
        dispatchPrepared: true,
        forward: async () => {
          await readyPromise;
          // `/jobs` is a server-owned system-beat surface. Never trust a payload
          // `channel` field, but preserve the gateway's own heartbeat identity so
          // runRoutedTurn executes it inline instead of registering it as a task.
          return { completion: enqueueTurn(jobMessage, undefined, { channel: "heartbeat" }) };
        },
        onAdmitted: () => resolveAdmission(),
        onFailure: (err, attempt, attempts) => {
          logEvent("stderr", {
            kind: "job-turn-attempt-failed",
            attempt,
            attempts,
            error: err?.message || String(err)
          });
        }
      });
      void forwarding.catch((err) => {
        rejectAdmission(err);
        logEvent("stderr", { kind: "job-turn-failed", error: err.message });
      });
      try {
        await admitted;
      } catch {
        sendJson(response, 503, {
          ack: false,
          retryable: true,
          error: "job turn could not be admitted to the operative queue"
        });
        return;
      }
      sendJson(response, 202, { ack: true, deduped: false });
      return;
    }

    // D20: record a conversational override into the Improver evidence queue. The
    // gateway also detects the example phrases deterministically at carding time;
    // this endpoint is the explicit channel for the orchestrator (or a
    // garrison-control tool) to record an override it applied on its own judgment.
    // Body: { session_id?, answer, original?, applied? }. `answer` (the override) is
    // required; original/applied are the prior/new resolutions.
    if (request.method === "POST" && url.pathname === "/feedback/override") {
      const body = await readJsonBody(request);
      const answer = typeof body.answer === "string" ? body.answer.trim() : "";
      if (!answer) return sendJson(response, 400, { error: "answer is required" });
      const record = buildOverrideRecord({
        session_id: typeof body.session_id === "string" ? body.session_id : undefined,
        answer,
        original: body.original ?? null,
        applied: body.applied ?? null,
      });
      // The queue is the state service now, so what comes back is the row's
      // {id, seq}, not a path — reported as such rather than dressed up as one.
      const { id, seq } = await appendFeedback(record);
      logEvent("stdout", { kind: "override-feedback", via: "endpoint", session_id: record.session_id ?? null });
      sendJson(response, 200, { ok: true, recorded: true, id, seq });
      return;
    }

    // ───────────────────────── compact controller (S1b)
    // Duty-boundary compact check: the engine calls this between duties with the
    // card's focus context. Enqueued on the turn chain so it cannot overlap a turn;
    // a boundary DISCHARGES holds. Fire-and-forget with a soft cap so the engine
    // never blocks on the compaction itself.
    if (request.method === "POST" && url.pathname === "/compact/boundary") {
      const body = await readJsonBody(request);
      const cardId = typeof body.cardId === "string" ? body.cardId : null;
      const dutyKey = typeof body.dutyKey === "string" ? body.dutyKey : null;
      const focusContext = body.focusContext && typeof body.focusContext === "object" ? body.focusContext : {};
      const p = enqueue(() =>
        compactController.check({ sessionId: "operative", runtime: "claude-code", boundary: "duty", cardId, dutyKey, focusContext })
      );
      const outcome = await Promise.race([
        p.then((r) => ({ ok: true, action: r?.action ?? "none" })).catch((err) => ({ ok: false, error: String(err?.message ?? err) })),
        sleepMs(500).then(() => ({ ok: true, queued: true })),
      ]);
      logEvent("stdout", { kind: "compact-boundary", cardId, dutyKey, outcome });
      return sendJson(response, 202, outcome);
    }
    if (request.method === "GET" && url.pathname === "/compact/log") {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const entries = await readCompactLog(limit);
      return sendJson(response, 200, { entries, lastDecision: compactController.getLastDecision() });
    }

    // S3b acceptance-7 introspection: no standing per-conversation session exists —
    // one operative checkout (kanban duties), web turns are one-shots.
    if (request.method === "GET" && url.pathname === "/materialized/status") {
      const routerStatus =
        router && typeof router.materializedStatus === "function"
          ? router.materializedStatus()
          : { standingConversationSessions: 0, operativeCheckout: Boolean(session) };
      return sendJson(response, 200, { ...routerStatus, lastMaterialized });
    }

    // ───────────────────────── rich chat surface (/claude/*)
    if (url.pathname.startsWith("/claude/")) {
      if (!runtimeSessionAlive()) {
        if (url.pathname === "/claude/stream") {
          // Still open the SSE so the client can wait; emit an error once.
          response.statusCode = 200;
          response.setHeader("content-type", "text/event-stream");
          response.flushHeaders?.();
          response.write(`event: error\ndata: ${JSON.stringify({ message: "operative not ready" })}\n\n`);
          return;
        }
        return sendJson(response, 503, { error: "operative not ready", pty_status: ptyStatus });
      }
      if (!richPtyAvailable()) {
        return sendJson(response, 503, richUnavailable());
      }
      if (request.method === "GET" && url.pathname === "/claude/stream") {
        openRichStream(session.handle, response, {
          // Feed each poll's contextPct into the session peak so streamed status
          // events carry a live peakContextPct (additive field).
          notePeak: (pct) => session.notePeakContextPct(pct),
          onEmit: (emit) => {
            richClients.add(emit);
            response.on("close", () => richClients.delete(emit));
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/claude/status") {
        const base = richStatus(session.handle, { notePeak: (pct) => session.notePeakContextPct(pct) });
        const cc = resolveCompactConfig(process.env)["claude-code"];
        return sendJson(response, 200, {
          ...base,
          compactions: readCompactions(session),
          compact: { enabled: cc.enabled, thresholdPct: cc.thresholdPct, lastDecision: compactController.getLastDecision() },
        });
      }
      if (request.method === "GET" && url.pathname === "/claude/commands") {
        return sendJson(response, 200, { commands: enumerateCommandsCached({ cwd: COMPOSITION_DIR }) });
      }
      if (request.method === "POST" && url.pathname === "/claude/message") {
        const body = await readJsonBody(request);
        const text = typeof body.text === "string"
          ? body.text
          : typeof body.message === "string"
            ? body.message
            : "";
        if (!text.trim()) return sendJson(response, 400, { error: "text is required" });
        // Non-blocking: enqueue the turn; the SSE reflects progress.
        // The explicit console is a view onto the shared operative, not a
        // generated Web conversation. Bypass routing so its exact bytes reach
        // that existing session without route/duty/carryover prompt prefixes.
        enqueueTurn(text, undefined, { channel: "web-console", directOperative: true })
          .catch((err) => logEvent("stderr", { kind: "claude-message-failed", error: err.message }));
        return sendJson(response, 202, { ack: true });
      }
      if (request.method === "POST" && url.pathname === "/claude/keys") {
        const body = await readJsonBody(request);
        const seq = keySequence(String(body.key ?? ""));
        if (!seq) return sendJson(response, 400, { error: "unknown key" });
        session.writeKeys(seq);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/claude/mode") {
        const body = await readJsonBody(request);
        const target = String(body.mode ?? "");
        const result = await cycleMode(session.handle, target, (b) => session.writeKeys(b));
        return sendJson(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/claude/interrupt") {
        session.writeKeys("\x1b");
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "POST" && url.pathname === "/claude/answer") {
        const body = await readJsonBody(request);
        const r = await handleAnswer(body);
        return sendJson(response, r.status, r.body);
      }
    }

    sendJson(response, 404, { error: "not found", path: url.pathname });
  } catch (err) {
    const failure = normalizeFailureInfo(err?.failure ?? err, {
      code: err?.code ?? "gateway_request_failed",
      kind: err?.kind ?? "runtime",
      source: err?.failure?.source ?? err?.source ?? "gateway",
      retryable: err?.retryable === true,
    });
    logEvent("stderr", {
      kind: "request-failed",
      method: request.method,
      path: url.pathname,
      code: failure.code,
      error: failure.text,
    });
    const status = failure.httpStatus && failure.httpStatus >= 400 ? failure.httpStatus : 500;
    sendJson(response, status, { error: failure.text, ...failure, failure });
  }
});

async function main() {
  // Session-log proxy (Harness brief §2), opt-in via the fitting's
  // `session_log_proxy` config. Started before the operative spawns so the
  // spawn env can carry the proxy URL.
  if (/^(1|true|yes)$/i.test(String(process.env.GARRISON_HTTPGATEWAY_SESSION_LOG_PROXY ?? ""))) {
    try {
      const { startAnthropicLogProxy } = await import("./lib/anthropic-log-proxy.mjs");
      const proxy = await startAnthropicLogProxy();
      process.env.GARRISON_ANTHROPIC_PROXY_URL = proxy.url;
      logEvent("stdout", { kind: "session-log-proxy", url: proxy.url });
    } catch (err) {
      logEvent("stderr", { kind: "session-log-proxy-failed", error: String(err?.message ?? err) });
    }
  }
  // Node's http.Server defaults requestTimeout to 5 min — that would abort a long
  // /chat turn (a real Kanban garrison-* turn runs longer) at the socket layer,
  // regardless of the per-turn timeout, surfacing to the caller as a dropped
  // connection. Disable the request/header socket timeouts here so a long-running
  // turn is governed ONLY by session.runTurn's (per-request) timeout, not the HTTP
  // server. Short channels still pass their own short turn timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  // Listen FIRST so /health answers while the PTY spins up (the runner's
  // health-poll deadline is short; PTY readiness can take several seconds).
  server.listen(PORT, HOST, () => {
    runLog()?.append({
      domain: "lifecycle", kind: "run-start",
      payload: { composition: COMPOSITION_ID, port: PORT, model: MODEL, engine: "pty" },
    });
    // Mesh session registry (metadata only): this run becomes visible to peers
    // the moment it is listening, not once the operative is warm.
    void announceSession({
      id: SESSION_LOG_RUN,
      compositionId: COMPOSITION_ID,
      runtime: primaryRuntime(),
      model: MODEL,
      cwd: COMPOSITION_DIR,
      status: "starting",
    });
    logEvent("stdout", {
      kind: "listening",
      host: HOST,
      port: PORT,
      engine: "pty",
      model: MODEL,
      permission_mode: PERMISSION_MODE,
      composition_dir: COMPOSITION_DIR,
    });
    (async () => {
      const attempt = async () => {
        if (ROUTING_ENABLED && (await initRouting())) {
          void touchSession(SESSION_LOG_RUN, "idle", { runtime: primaryRuntime() });
          readyResolve();
          return;
        }
        await spawnOperative({ resume: true }); // calls readyResolve internally
      };
      try {
        await attempt();
      } catch (err) {
        let finalErr = err;
        // Stale-marker wedge, exit flavor: `claude --continue` can EXIT during
        // startup (not just render the in-TUI banner the initRouting wedge check
        // catches) when the marker says continue but this machine/cwd has no
        // conversation. Same heal: clear the marker, retry ONCE without --continue.
        if (/No conversation found to continue/i.test(String(err.message || ""))) {
          logEvent("stderr", {
            kind: "continue-wedge",
            message: "claude exited with 'No conversation found to continue' - clearing the stale session marker and respawning fresh",
          });
          try { router?.shutdown(); } catch { /* best effort */ }
          router = null;
          session = null;
          try { await clearPriorSessionMarker(); } catch { /* best effort */ }
          try {
            await attempt();
            return;
          } catch (err2) {
            finalErr = err2;
          }
        }
        ptyStatus = "failed";
        ptyError = finalErr.message;
        logEvent("stderr", { kind: "spawn-failed", error: finalErr.message });
        void touchSession(SESSION_LOG_RUN, "failed");
        // Unblock waiters so pending /chat calls fail fast instead of hanging.
        readyResolve();
      }
    })();
  });
}

async function shutdown(signal) {
  logEvent("stdout", { kind: "shutdown", signal });
  // Close the registry row. Started FIRST so it overlaps the seconds spent
  // letting claude persist its conversation, and awaited below so the write
  // actually lands before the process exits — a run left reading "running"
  // forever is exactly the lie the nightly convergence check would trip over.
  const registryClosed = endSession(SESSION_LOG_RUN, "ended");
  // Give claude a chance to persist the conversation (so a restart can
  // --continue with context): double Ctrl-C exits the TUI cleanly. Then kill.
  try {
    if (richPtyAvailable() && (typeof session.isTurnActive !== "function" || !session.isTurnActive())) {
      session.writeKeys("\x03");
      await new Promise((r) => setTimeout(r, 200));
      session.writeKeys("\x03");
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch {
    /* best effort */
  }
  try {
    askWatcher?.stop();
  } catch {
    /* ignore */
  }
  try {
    router?.shutdown();
  } catch {
    /* ignore */
  }
  try {
    session?.dispose?.();
  } catch {
    /* ignore */
  }
  await registryClosed; // never rejects; bounded by the client's own timeout
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

// Documented test seam: gateway.mjs runs this engine by IMPORTING the module, so
// booting on import is the production behaviour. GARRISON_GATEWAY_NO_LISTEN=1
// imports it for the pure run-context helpers alone (turnAttribution /
// sanitizeRouting / buildRouteOptions / handleInterrupt) with no HTTP listener, no
// claude spawn and - deliberately - no signal handlers, since a helpers-only
// import must not hijack the host process's SIGTERM into a server shutdown.
if (process.env.GARRISON_GATEWAY_NO_LISTEN === "1") {
  logEvent("stdout", { kind: "no-listen", message: "GARRISON_GATEWAY_NO_LISTEN=1 - helpers only, no server" });
} else {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  main().catch((err) => {
    logEvent("stderr", { kind: "boot-failed", error: err.message });
    process.exit(1);
  });
}
