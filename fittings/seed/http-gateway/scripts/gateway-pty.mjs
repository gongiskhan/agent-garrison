#!/usr/bin/env node
/**
 * Agent Garrison HTTP gateway — PTY engine.
 *
 * The operative is a single, persistent INTERACTIVE `claude` TUI driven via
 * @garrison/claude-pty (node-pty + @xterm/headless). This replaces the
 * in-process Agent SDK (gateway-legacy.mjs). Real Claude Code: slash
 * commands, skills, hooks, status line, modes — all available.
 *
 * Endpoint surface is byte-compatible with gateway-legacy.mjs so the
 * web-channel and slack-channel relays work unchanged:
 *   POST /chat          { message }            → { reply, session_id, cost_usd }
 *   POST /chat/stream    { message }           → SSE open/chunk/tool/done/error
 *   POST /jobs           { kind, ... }         → { ack: true }
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
import fs from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
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
  anthropicAccountEnv,
  listVaultAccounts,
  resolveVaultAccount,
  TURN_EFFORTS
} from "./lib/gateway-routing.mjs";
import { listProjectNames } from "./lib/project-source.mjs";
import { createCompactController, resolveCompactConfig, COMPACT_TIMEOUT_MS } from "./lib/compact-controller.mjs";
import { isEmptyQuickReply, quickEmptyFailureReason, moveCardEngine } from "./lib/autonomous-cards.mjs";
import { resolveDiscussInterception } from "./lib/discuss-intercept.mjs";
import { detectOverride, buildOverrideRecord, appendFeedback } from "./lib/feedback-queue.mjs";
import { createAskQuestionWatcher, answerKeySequence, resolveOptionIndex } from "./lib/ask-question.mjs";

const HOST = process.env.GARRISON_GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GARRISON_GATEWAY_PORT ?? "4777");
const SYSTEM_PROMPT_PATH = process.env.GARRISON_SYSTEM_PROMPT_PATH ?? "";
const COMPOSITION_DIR = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();
const COMPOSITION_ID = process.env.AGENT_GARRISON_COMPOSITION ?? path.basename(COMPOSITION_DIR);
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
let lastMaterialized = null; // S3b: last web materialized turn (introspection evidence)
let ptyStatus = "spawning"; // spawning | ready | failed
let ptyError = null;
let inflight = null; // promise chain — turns serialize
let router = null; // Stage-A live routing layer (BRIEF U1), null = legacy single-session
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
const toolListeners = new Set(); // fn(payload) - sinks for the CURRENT /chat/stream turn
let askWatcher = null;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// S3d review R1: the cardId of the turn currently holding the operative session (parsed
// from the engine's dutyKey "cardId:phase"). broadcastTool STAMPS it onto each pending
// question so the HTTP-seam reply-as-answer can bind an answer to THIS card's live
// discuss picker - never a stale entry from another card. Null for a non-dispatch turn
// (web one-shot / plain chat), so those questions stay UNBOUND (conservative routing).
let currentTurnCardId = null;

// S3d review R1: drop pending questions bound to a turn that ENDED (answered elsewhere,
// timed out, or parked) so a stale entry can never hijack a later thread's reply.
function sweepPendingQuestions(cardId) {
  if (!cardId) return;
  for (const [id, entry] of pendingQuestions) {
    if (entry?.cardId === cardId) pendingQuestions.delete(id);
  }
}

function broadcastTool(payload) {
  if (payload?.tool_use_id) pendingQuestions.set(payload.tool_use_id, { questions: payload.questions, at: Date.now(), cardId: currentTurnCardId });
  broadcastRich("tool", payload); // rich /claude/stream observers
  for (const fn of toolListeners) {
    try {
      fn(payload);
    } catch {
      /* listener gone */
    }
  }
}

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
    onQuestion: (payload) => {
      logEvent("stdout", { kind: "ask-question", tool_use_id: payload.tool_use_id, questions: payload.questions?.length ?? 0 });
      broadcastTool(payload);
    },
    logFn: (e) => logEvent("stderr", e),
  });
  askWatcher.start();
}

// Drive the live TUI picker with an ordered list of key names (down/enter/escape).
// A short dwell between keys lets each keypress register in the picker.
async function drivePicker(keyNames) {
  for (const name of keyNames) {
    const bytes = keySequence(name);
    if (!bytes) continue;
    session.writeKeys(bytes);
    await sleepMs(140);
  }
}

// Answer an AskUserQuestion picker for the channel. Body: { tool_use_id, label? ,
// text?, dismiss? }. A matching option label drives arrow-down×index + Enter; a
// free-text ("Other...") answer types the text + Enter (best-effort - the picker
// may reject free text); dismiss sends Escape. Returns {status, body}.
async function handleAnswer(body) {
  const toolUseId = typeof body?.tool_use_id === "string" ? body.tool_use_id.trim() : "";
  const label = typeof body?.label === "string" ? body.label : "";
  const text = typeof body?.text === "string" ? body.text : "";
  const dismiss = body?.dismiss === true;
  if (!runtimeSessionAlive()) return { status: 503, body: { error: "operative not ready" } };
  if (!richPtyAvailable()) return { status: 503, body: richUnavailable() };

  if (dismiss) {
    await drivePicker(["escape"]);
    if (toolUseId) pendingQuestions.delete(toolUseId);
    return { status: 200, body: { ok: true, action: "dismiss" } };
  }
  if (!label && text) {
    session.writeKeys("\x15"); // Ctrl-U clear, in case the picker exposes a text field
    session.writeKeys(text);
    await sleepMs(140);
    await drivePicker(["enter"]);
    if (toolUseId) pendingQuestions.delete(toolUseId);
    return { status: 200, body: { ok: true, action: "text" } };
  }
  const pending = toolUseId ? pendingQuestions.get(toolUseId) : null;
  const question = pending?.questions?.[0] ?? null;
  const index = question ? resolveOptionIndex(question, label) : -1;
  if (index < 0) return { status: 404, body: { error: "unknown or expired question", tool_use_id: toolUseId } };
  await drivePicker(answerKeySequence(index));
  if (toolUseId) pendingQuestions.delete(toolUseId);
  return { status: 200, body: { ok: true, action: "select", index, label } };
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
// Wire the Dispatcher (D6/D9b) for the CLARITY judgment and steering's model
// path: { core, model, call, callOpts } for RoutedGateway opts.dispatcher.
// judgeClarity is the ONLY dispatchRoute caller, so wiring this changes no
// routing behavior beyond clarity + steer classification. Best-effort: any
// missing piece (dispatcher/garrison-call fittings, the control model) logs
// dispatcher-not-wired and returns null - short-circuits + default-clear
// remain, exactly the pre-wire behavior.
async function loadDispatcher() {
  try {
    const dispatcherDir = path.join(COMPOSITION_DIR, "apm_modules", "_local", "dispatcher");
    const core = await import(pathToFileURL(path.join(dispatcherDir, "lib", "dispatch-core.mjs")).href);
    const callScript = path.join(COMPOSITION_DIR, "apm_modules", "_local", "garrison-call", "scripts", "call.mjs");
    await fs.access(callScript);
    const { spawn } = await import("node:child_process");
    // The same spawn-and-pipe invoker the dispatcher CLI uses; never throws.
    const call = (spec) =>
      new Promise((resolve) => {
        let child;
        try {
          child = spawn(process.execPath, [callScript], { stdio: ["pipe", "pipe", "pipe"] });
        } catch (err) {
          resolve({ ok: false, error: `spawn garrison-call failed: ${err?.message || String(err)}` });
          return;
        }
        let out = "";
        let errOut = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (errOut += d.toString()));
        child.on("error", (err) => resolve({ ok: false, error: `garrison-call error: ${err?.message || String(err)}` }));
        child.on("close", () => {
          try {
            resolve(JSON.parse(out.trim()));
          } catch {
            resolve({ ok: false, error: `garrison-call returned non-JSON: ${(out || errOut).slice(0, 200)}` });
          }
        });
        child.stdin.write(JSON.stringify(spec));
        child.stdin.end();
      });
    // The DispatchModel (duties w/ descriptions + selection) from the runner's
    // garrison-control read model - the same source Muster and the board trust.
    const controlBase =
      process.env.GARRISON_CONTROL_URL ??
      process.env.GARRISON_BASE_URL ??
      `http://127.0.0.1:${process.env.GARRISON_APP_PORT ?? "7777"}`;
    const r = await fetch(`${controlBase}/api/garrison-control`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`garrison-control ${r.status}`);
    const j = await r.json();
    if (!j?.duties || !Array.isArray(j?.selectedDuties)) throw new Error("garrison-control returned no dispatch model");
    const model = { duties: j.duties, selectedDuties: j.selectedDuties };
    const callOpts = {
      shape: process.env.GARRISON_DISPATCH_SHAPE ?? "ollama",
      provider: process.env.GARRISON_DISPATCH_PROVIDER ?? "ollama-local",
      model: process.env.GARRISON_DISPATCH_MODEL ?? "qwen2.5:3b",
      maxTokens: Number(process.env.GARRISON_DISPATCH_MAX_TOKENS) || 256,
      timeoutMs: Number(process.env.GARRISON_DISPATCH_TIMEOUT_MS) || 30000,
      ...(process.env.GARRISON_DISPATCH_CLARITY_RUBRIC ? { clarityRubric: process.env.GARRISON_DISPATCH_CLARITY_RUBRIC } : {}),
    };
    logEvent("stdout", { kind: "dispatcher-wired", duties: Object.keys(model.duties).length, model: callOpts.model });
    return { core, model, call, callOpts };
  } catch (err) {
    logEvent("stdout", { kind: "dispatcher-not-wired", reason: String(err?.message ?? err) });
    return null;
  }
}

// Write/refresh the shared stdio MCP config for spawned claude sessions (the
// routed twin of the souls-mode writeSharedMcpConfig: same file, same contract).
// Returns the claude extraArgs, or [] when the mcp-gateway fitting is absent.
async function writeRoutedMcpConfig() {
  const gatewayScriptPath = path.join(COMPOSITION_DIR, "apm_modules", "_local", "mcp-gateway", "scripts", "gateway.mjs");
  try {
    await fs.access(gatewayScriptPath);
  } catch {
    logEvent("stdout", { kind: "mcp-config-skipped", reason: "mcp-gateway fitting not installed" });
    return [];
  }
  const filePath = path.join(COMPOSITION_DIR, ".garrison", "mcp.json");
  const cfg = {
    mcpServers: {
      garrison: {
        command: "node",
        args: [gatewayScriptPath, "stdio"],
        env: {
          GARRISON_COMPOSITION_DIR: COMPOSITION_DIR,
          GARRISON_HTTP_GATEWAY_BASE_URL: `http://${HOST}:${PORT}`,
        },
      },
    },
  };
  try {
    await fs.writeFile(filePath, JSON.stringify(cfg, null, 2), "utf8");
    logEvent("stdout", { kind: "mcp-config-written", path: filePath });
    return ["--mcp-config", filePath, "--strict-mcp-config"];
  } catch (err) {
    logEvent("stderr", { kind: "mcp-config-write-failed", error: String(err?.message ?? err) });
    return [];
  }
}

async function initRouting() {
  if (!resolveModelRouterDir(COMPOSITION_DIR)) {
    logEvent("stdout", { kind: "routing-absent", message: "model-router fitting not found — legacy single-session" });
    return false;
  }
  await fs.mkdir(path.join(COMPOSITION_DIR, ".garrison"), { recursive: true });
  // garrison-control MCP for the operative (WS5 prep): write/refresh the shared
  // stdio mcp.json (same contract as the souls-mode gateway) and pass it at
  // spawn so duty sessions can call fetch_evidence / create_continuation /
  // poll_origin_events. Graceful: no installed mcp-gateway -> no extra args.
  const mcpExtraArgs = await writeRoutedMcpConfig();
  const dispatcher = await loadDispatcher();
  const spawnFn = await loadStubSpawnFn();
  const continueSession = await hasPriorSession();
  router = await createRoutedGateway({
    compositionDir: COMPOSITION_DIR,
    compositionId: COMPOSITION_ID,
    appendSystemPromptFile: SYSTEM_PROMPT_PATH || undefined,
    permissionMode: PERMISSION_MODE,
    decisionsFile: path.join(COMPOSITION_DIR, ".garrison", "decisions.jsonl"),
    // Prefer the projected v4 Dispatcher built by createRoutedGateway below.
    // The control-plane loader remains a compatibility fallback when no
    // projected execution model is available.
    ...(dispatcher ? { fallbackDispatcher: dispatcher } : {}),
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
      extraArgs: mcpExtraArgs,
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
    // Pin the ROUTING BRAIN (Stage-A classification + the Dispatcher's
    // single-shot call) to the PRIMARY engine (gateway fitting config
    // `routing_on_primary`). Unset = the historical cheap claude-code haiku
    // classifier + garrison-call dispatch, byte-for-byte.
    ...(process.env.GARRISON_ROUTING_ON_PRIMARY === "1" ? { routingOnPrimary: true } : {}),
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
    workKinds:
      config?.workKinds && typeof config.workKinds === "object" && !Array.isArray(config.workKinds)
        ? Object.keys(config.workKinds)
        : [],
    phases: Array.isArray(config?.phases) ? config.phases.filter((p) => typeof p === "string") : []
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
  // The run-plan pins (RUN-SPEC-V1). `tier` and `workKind` are validated against the
  // COMPILED POLICY's own vocabulary rather than a hardcoded list here - the policy
  // is the thing that will actually be resolved against, so a value this edge
  // accepted but the matrix cannot key on would be a pin that dies silently later.
  if (raw.tier !== undefined && raw.tier !== null) {
    const tier = pinnedString(raw.tier, "tier", rejected);
    if (tier !== null && inVocab(vocabulary.tiers, tier, "tier")) out.tier = tier;
  }
  if (raw.workKind !== undefined && raw.workKind !== null) {
    const kind = pinnedString(raw.workKind, "workKind", rejected);
    if (kind !== null && inVocab(vocabulary.workKinds, kind, "workKind")) out.workKind = kind;
  }
  if (raw.phasesOff !== undefined && raw.phasesOff !== null) {
    const csv = pinnedString(raw.phasesOff, "phasesOff", rejected);
    if (csv !== null) {
      const ids = csv.split(",").map((s) => s.trim()).filter(Boolean);
      if (!vocabulary.phases.length) {
        rejected.push({ field: "phasesOff", reason: "policy-unavailable" });
      } else {
        const unknown = ids.filter((id) => !vocabulary.phases.includes(id));
        // ALL-or-nothing. Silently keeping the recognised half would turn "skip
        // these three gates" into "skip two of them" with nothing on the badge to
        // say so - and a phase the user believes is off would run.
        if (unknown.length) rejected.push({ field: "phasesOff", reason: `unknown-phase:${unknown[0]}` });
        else if (ids.length) out.phasesOff = ids.join(",");
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
    // RUN-SPEC-V1 run plan. `workKind`/`phasesOff` are reported from the RESOLVED
    // hints (the pin when the user set one, the gateway's inference otherwise) so
    // the badge shows an auto-chosen plan instead of leaving it invisible - which is
    // the whole point of "if it was auto, say what it chose".
    workKind: hints?.workKind ?? null,
    phasesOff: phaseTogglesToCsv(hints?.phases),
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

// ───────────────────────── cancel registry (§9)
// One entry per IN-FLIGHT turn, keyed by the conversation the turn belongs to.
// Turns are serialized on the inflight chain, so this holds at most one live
// entry; the key still matters because a stale client id must 404 rather than
// stop somebody else's turn. `stop` is filled in by the LANE (the primitives
// differ per runtime and are only knowable once the route resolved), so an
// interrupt arriving before then reports the honest "no cancel primitive yet".
const activeTurns = new Map(); // sessionId -> { lane, stop: fn|null, cancelled }
const INTERRUPT_FALLBACK_KEY = "operative";
let currentTurnEntry = null;

// Called by each lane once it owns something interruptible.
function registerTurnStop(lane, stop) {
  if (!currentTurnEntry) return;
  currentTurnEntry.lane = lane;
  currentTurnEntry.stop = stop;
}

/** POST /chat/interrupt {sessionId} → {ok, lane} | 404 | 409. */
export async function handleInterrupt(body, turns = activeTurns) {
  const sessionId =
    typeof body?.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : INTERRUPT_FALLBACK_KEY;
  const entry = turns.get(sessionId);
  if (!entry) return { status: 404, body: { ok: false, error: "no-active-turn", sessionId } };
  if (typeof entry.stop !== "function") {
    return { status: 409, body: { ok: false, error: "lane-has-no-cancel-primitive", lane: entry.lane } };
  }
  entry.cancelled = true;
  let stopped = false;
  try {
    stopped = (await entry.stop()) !== false;
  } catch (err) {
    logEvent("stderr", { kind: "interrupt-failed", lane: entry.lane, error: String(err?.message ?? err) });
    return { status: 500, body: { ok: false, error: "cancel-failed", lane: entry.lane } };
  }
  logEvent("stdout", { kind: "interrupt", lane: entry.lane, sessionId, stopped });
  // The turn now settles normally with its partial reply; runTurn stamps
  // stoppedByUser onto the done frame.
  return { status: 200, body: { ok: true, lane: entry.lane, stopped } };
}

// ───────────────────────── account → real auth env (§6)
// A pinned account is only real if the spawned process actually authenticates as
// it. The one-shot lane is a Claude spawn, so the vehicle is the Anthropic env
// block (mirror of src/lib/account-env.ts) built from the vault secret the runner
// already sealed. Returns null when nothing needs overriding - the turn then
// inherits the gateway env exactly as before.
//
// The claude-pty spawn keeps ANTHROPIC_AUTH_TOKEN (it only strips CLAUDECODE, an
// inherited ANTHROPIC_API_KEY and - without providerLaunch - ANTHROPIC_BASE_URL),
// so the token this returns survives to the CLI. Verified against
// stripNestingMarkers in packages/claude-pty/src/session.mjs.
function oneShotAccountEnv(account) {
  if (!account || account === process.env.GARRISON_ACCOUNT) return null;
  const resolved = resolveVaultAccount(COMPOSITION_DIR, account);
  if (!resolved || resolved.platform !== "anthropic") {
    logEvent("stderr", { kind: "account-env-unavailable", account, platform: resolved?.platform ?? null });
    return null;
  }
  return { ...process.env, ...anthropicAccountEnv(resolved.name, resolved.token) };
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
  const workKinds = vocab.workKinds
    .map((id) => {
      const kind = config.workKinds[id] ?? {};
      const plan = phasePlans[kind.phasePlan] ?? null;
      return {
        id,
        description: typeof kind.description === "string" ? kind.description : null,
        // The plan's phases IN PLAN ORDER: this doubles as the preview of what the
        // run will walk, so the order is load-bearing, not cosmetic.
        phases: Array.isArray(plan?.phases)
          ? plan.phases.map((p) => (typeof p === "string" ? p : p?.id)).filter((p) => typeof p === "string")
          : []
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
    workKinds,
    defaultWorkKind: typeof config?.defaultWorkKind === "string" ? config.defaultWorkKind : null,
    primaryRuntime: primaryRuntime(),
    activeProfile: config?.activeProfile ?? null,
    // Routing may be off entirely (no orchestrator fitting) - the rail then shows
    // the menus as read-only rather than pretending a pin would be honored.
    routing: !!router
  };
}

/** Run one turn through Stage-A routing: classify → resolve → log → switch →
 *  turn → honored check. The operative session is served by the routing pool.
 *  `opts.onPreRoute(pre)` fires the moment the route is known (the pre-turn
 *  `route` frame, §4); `opts.onActivity(payload)` carries tool activity. */
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
  await router.ensureOperative();
  // NOTE (S3d review R1): the Discuss reply-as-answer / explicit-go interception is NOT
  // here - it runs at the HTTP entry points BEFORE enqueueTurn (dispatchDiscussIntercept),
  // out-of-band from the serialized turn chain, so it can drive the LIVE picker while the
  // blocked discuss turn is holding the chain. Inside the chain it would deadlock.
  // hints (e.g. from the Kanban Loop) carry an EXPLICIT {taskType,tier} classification
  // so preRoute can honor §10 instead of re-classifying from scratch, plus the per-list
  // skill + suppressContinuations controls. Absent hints → classify as before.
  const pre = await router.preRoute(message, hints || {}); // classify/honor + resolve + LOG + switch
  // §4: emit the badge row NOW (pending), ~1s into the turn, instead of only at the
  // end. Everything the rail shows except the reply is already known here. The
  // client MERGES this frame with the one folded into `done`.
  if (typeof opts.onPreRoute === "function") {
    try {
      opts.onPreRoute(pre);
    } catch {
      /* a frame observer must never break the turn */
    }
  }
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
    const cardOriginated = origin === "kanban" || origin === "scheduler" || origin === "board" || origin === "garrison";
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
              ...turnAttribution(pre, hints, { card: card.id, cardUrl: card.url ?? null }),
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
        if (!inferredPhases && !hints?.workKind && cls.tier && router.core?.inferPhasePlan && router.core?.phaseTogglesFor) {
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
        const cardOpts = {
          workKind: hints?.workKind ?? null,
          phases: inferredPhases,
          project: hints?.project ?? null,
          duty: pre?.duty ?? pre?.route?.duty,
          level: pre?.level ?? pre?.route?.level,
          sequence: pre?.sequence ?? pre?.route?.sequence ?? pipelineSequence,
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
              workKind: hints?.workKind ?? null,
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
              ...turnAttribution(pre, hints, { card: card.id, cardUrl: card.url ?? null }),
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
  const result = await execRoutedTurn(pre, message, onChunk, hints, opts);
  // D19: a quick card runs inline; advance it Implement→Done now that the turn
  // finished — but ONLY if it finished honestly. An EMPTY reply is a FAILURE, not
  // a pass: route it to needs-attention with the failure contract instead of Done
  // (parity with the souls-mode completeQuickTurnCard). Either way, release the
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

/** Execute the resolved turn on its runtime (agent-sdk / secondary / workflow /
 *  claude-code PTY) and return the channel-shaped result. Split out of
 *  runRoutedTurn so the D19 quick-card completion runs on every runtime path. */
async function execRoutedTurn(pre, message, onChunk, hints, opts = {}) {
  // Local-vision lane (Evidence V2): an ollama-local target cannot Read image
  // files (its Anthropic-compat endpoint surfaces no tool_use), so a turn that
  // carries image paths executes natively via garrison-call's image-capable
  // ollama shape — never on the PTY/SDK session. Checked FIRST so cc-ollama-*
  // (PTY-lane) targets are covered too.
  if (typeof router.isOllamaVisionTurn === "function" && router.isOllamaVisionTurn(pre.route, hints?.images)) {
    broadcastRich("turn", { active: true });
    try {
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
    const r = await router.runAgentSdkTurn(pre.route, message, onChunk, {
      // §12: the warm SDK session is keyed by CONVERSATION as well as target, so
      // two web threads never share one session_id (and one transcript badge).
      sessionKey: hints?.sessionId ?? null,
      // §8: a pinned project is a REAL execution scope on every lane, not just the
      // web one-shot. The default composition routes web turns to agent-sdk
      // targets, so wiring cwd only into runWebOneShot made the project badge lie:
      // it reported /home/ggomes/dev/<repo> while the turn actually ran in the
      // composition dir (caught by asking a live turn to print its own pwd).
      cwd: pre.projectPath ?? undefined,
      onActivity: opts.onActivity,
      registerStop: (stop) => registerTurnStop("agent-sdk", stop)
    });
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
      cwd: pre.projectPath ?? undefined,
      registerStop: (stop) => registerTurnStop(pre.route.target.runtime, stop)
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
  // delegate lane. Do not call runTurn on the Codex/Gemini operative and then
  // mislabel it as Claude: the routing layer owns a real target-specific Claude
  // session and reports the provider/model/effort it launched.
  if (router.isClaudeDelegateTarget(pre.route)) {
    broadcastRich("turn", { active: true });
    const annotated = `${pre.annotation}\n${message}`;
    const r = await router.runClaudeDelegateTurn(pre.route, annotated, {
      onChunk,
      timeoutMs: hints?.timeoutMs,
      // §8: honor a pinned project here too, else the badge overstates the scope.
      cwd: pre.projectPath ?? undefined,
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
  const wfPrefix = router.isWorkflowTarget(pre.route) ? router.workflowTurnPrefix(pre.route) : "";
  const annotated = `${pre.annotation}\n${wfPrefix}${message}`;
  // S3b: a WEB conversational turn materializes as a one-shot. Internal
  // screenshot-grounded turns do too: they must not consume or overwrite a
  // human's draft in the standing operative input box. Other channels
  // (kanban/dev-env/…) keep the standing operative context.
  const oneShotChannel = shouldUseEphemeralSession(hints?.channel);
  if (oneShotChannel) {
    const isInternal = hints?.channel === "garrison";
    const ctxBlock = !isInternal && typeof hints?.context === "string" && hints.context.trim()
      ? hints.context.trim()
      : "";
    const oneShotMsg = ctxBlock ? `${ctxBlock}\n\n---\n\n${annotated}` : annotated;
    const model = pre.route?.target?.model ?? MODEL;
    let reply = "";
    let os1 = null;
    try {
      // Stream the disposable session's reply incrementally (same closure shape as
      // the standing path below); the final onChunk(reply, true) after the turn
      // remains the authoritative replace.
      let osSession = null;
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
      os1 = await router.runWebOneShot({
        message: oneShotMsg,
        model,
        // §8: a pinned project IS this turn's cwd (a confined dev-root repo,
        // already resolved by applyTurnOverride). Absent → the composition dir,
        // exactly as before. An unresolvable project never reaches here: it was
        // rejected at resolution time rather than silently falling back.
        cwd: pre.projectPath ?? undefined,
        // §6: a pinned account is real auth env for this spawn, not a label.
        env: oneShotAccountEnv(pre.route?.target?.account ?? null) ?? undefined,
        onScreen: osOnScreen,
        onSession: (s) => {
          osSession = s;
          // §9: ESC on the disposable session is the one-shot lane's stop
          // primitive; waitForTurnComplete's liveness check then settles the turn
          // with its partial reply instead of hanging to the 5-minute timeout.
          registerTurnStop("web-one-shot", () => {
            if (typeof s?.writeKeys !== "function") return false;
            s.writeKeys("\x1b");
            return true;
          });
        },
      });
      reply = os1.reply ?? "";
    } catch (err) {
      logEvent("stderr", { kind: "web-oneshot-failed", error: err?.message || String(err) });
    }
    if (!isInternal) {
      lastMaterialized = { at: new Date().toISOString(), threadId: hints?.sessionId ?? null, assembledChars: ctxBlock.length, oneShot: true };
      broadcastRich("status", {
        rows: [`Garrison orchestrator → runtime: claude-code · web materialized (one-shot) · model: ${model}`],
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
      effort: pre.decision?.effort ?? pre.route?.target?.effort ?? null,
      // Acceptance evidence: prove this turn ran one-shot (no standing session).
      materialized: { oneShot: true, assembledChars: ctxBlock.length, internal: isInternal },
    };
  }

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
  const outcome = await session.runTurn({ message: annotated, onScreen, timeoutMs: hints?.timeoutMs });
  const honored = await router.postTurn(pre.route, pre.decision, outcome.reply);
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
    taskType: pre.decision?.taskType ?? null,
    tier: pre.decision?.tier ?? null,
    ruleId: pre.decision?.ruleId ?? null,
    profile: pre.decision?.profile ?? null,
  };
}

/** Run one turn against the live operative. Spawns/respawns on demand.
 *  onChunk(text) streams the growing assistant reply (screen-derived).
 *  opts: { onPreRoute, onActivity } - the §4/§12 SSE frame sinks. */
async function runTurn(message, onChunk, hints, opts = {}) {
  // S3d review R1: bind AskUserQuestions raised during THIS turn to its card (the
  // engine's dutyKey = "cardId:phase"), and sweep any that outlive the turn. Turns are
  // serialized, so this module-level cursor is race-free.
  const turnCardId = typeof hints?.dutyKey === "string" ? (hints.dutyKey.split(":")[0] || null) : null;
  const prevTurnCardId = currentTurnCardId;
  currentTurnCardId = turnCardId;
  // §9: publish this turn in the cancel registry for the whole of its life. The
  // lane fills in the actual `stop` as soon as it owns something interruptible; an
  // interrupt before that answers "no cancel primitive yet" rather than lying.
  const turnKey = hints?.sessionId || INTERRUPT_FALLBACK_KEY;
  const entry = { lane: primaryRuntime(), stop: null, cancelled: false };
  const prevTurnEntry = currentTurnEntry;
  currentTurnEntry = entry;
  activeTurns.set(turnKey, entry);
  try {
    if (router) {
      const result = await runRoutedTurn(message, onChunk, hints, opts);
      // A cancelled turn settles NORMALLY with its partial reply - the stop is not
      // an error path - so the done frame is where the user learns it was stopped.
      return entry.cancelled
        ? { ...result, stoppedByUser: true, stoppedReason: result?.stoppedReason ?? "user-interrupt" }
        : result;
    }
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
    const outcome = await session.runTurn({ message, onScreen, timeoutMs: hints?.timeoutMs });
    await markPriorSession();
    return {
      reply: outcome.reply,
      session_id: outcome.sessionId,
      cost_usd: null,
      ...(entry.cancelled ? { stoppedByUser: true, stoppedReason: "user-interrupt" } : {})
    };
  } finally {
    // The turn ended (returned, timed out, or threw) - an unanswered question it raised
    // is now dead; drop it so it cannot answer a future thread's reply.
    sweepPendingQuestions(turnCardId);
    currentTurnCardId = prevTurnCardId;
    // Only clear the registry slot if it is still OURS (a later turn on the same
    // conversation key must not be un-cancellable because an older one finished).
    if (activeTurns.get(turnKey) === entry) activeTurns.delete(turnKey);
    currentTurnEntry = prevTurnEntry;
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

/** The inverse, for reporting a resolved plan back on the badge row. Only `false`
 *  entries count: `railForCard` reads nothing else, so a stray `true` in a toggle
 *  map means "on", not "off", and must not appear in the OFF list. */
export function phaseTogglesToCsv(toggles) {
  if (!toggles || typeof toggles !== "object" || Array.isArray(toggles)) return null;
  const off = Object.entries(toggles).filter(([, on]) => on === false).map(([id]) => id);
  return off.length ? off.join(",") : null;
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
    // (workKind / per-card phase toggles / project) for the created card.
    channel: typeof body?.channel === "string" ? body.channel : null,
    // The web channel names this `thread` (its opaque per-conversation key);
    // other hosts send `sessionId`. Accept both so a decision can be traced back
    // to its conversation whichever surface raised the turn.
    sessionId:
      (typeof body?.sessionId === "string" && body.sessionId) ||
      (typeof body?.thread === "string" && body.thread) ||
      null,
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
    // S3b: the web-channel's assembled materialized-turn context — prefixed onto a
    // web one-shot so the standing operative session holds no web context.
    context: typeof body?.context === "string" ? body.context : null,
    // The phase plan for a turn that becomes a card. TWO wire spellings reach the
    // same field: the board's long-standing top-level `workKind`/`phases`, and the
    // RUN-SPEC-V1 pin (`routing.workKind` / `routing.phasesOff`) that every rail
    // surface sends. The top-level form WINS - the board computes it from the card
    // it already owns, so it is a statement of fact, while the pin is an intent that
    // has to survive validation. The pin is only read after sanitizeRouting, so an
    // out-of-vocabulary work kind never arrives here at all.
    workKind:
      typeof body?.workKind === "string" ? body.workKind : (routing?.workKind ?? null),
    phases:
      body?.phases && typeof body.phases === "object"
        ? body.phases
        : phaseTogglesFromCsv(routing?.phasesOff),
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

function enqueueTurn(message, onChunk, hints, opts = {}) {
  const previous = inflight ?? Promise.resolve();
  const runP = previous.catch(() => {}).then(() => runTurn(message, onChunk, hints, opts));
  // Turn-boundary compaction check (S1b): chained AFTER the turn so the NEXT
  // enqueued turn waits for any compaction, while the caller only awaits the turn
  // result (runP). Never rejects the chain.
  inflight = runP.then((result) => maybeCompactAtTurnBoundary(hints, result)).catch(() => {});
  return runP;
}

// Enqueue an arbitrary boundary action (e.g. a duty-boundary compact check) onto
// the same serialized turn chain, so it can never overlap a turn. Returns the
// action's promise; the chain swallows its rejection so one failure never wedges
// the next turn.
function enqueue(fn) {
  const previous = inflight ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => fn());
  inflight = next.catch(() => {});
  return next;
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
      const r = await handleAnswer({ tool_use_id: decision.toolUseId, text: message });
      const reply =
        r?.status === 200
          ? "Got it - passing that to the discussion."
          : "Tried to pass that to the discussion, but the question may have already closed.";
      logEvent("stdout", { kind: "discuss-answer", card: decision.card.id, tool_use_id: decision.toolUseId, status: r?.status ?? null });
      return { reply, card: decision.card.id, action: "answer" };
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

    // §9: stop the in-flight turn for one conversation. The turn then settles
    // normally with its partial reply and stoppedByUser on the done frame - this
    // endpoint never ends the SSE stream itself.
    if (request.method === "POST" && url.pathname === "/chat/interrupt") {
      const body = await readJsonBody(request);
      const r = await handleInterrupt(body);
      return sendJson(response, r.status, r.body);
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
      const message = String(body.message ?? "").trim();
      if (!message) return sendJson(response, 400, { error: "message is required" });
      await readyPromise;
      // S3d review R1: intercept a Discuss answer / explicit-go BEFORE enqueueTurn.
      const intercepted = await dispatchDiscussIntercept(body);
      if (intercepted) {
        logEvent("stdout", { kind: "chat-intercept", action: intercepted.action, card: intercepted.card });
        sendJson(response, 200, { reply: intercepted.reply, session_id: null, cost_usd: null, card: intercepted.card, [intercepted.action]: true });
        return;
      }
      logEvent("stdout", { kind: "chat-in", message: message.slice(0, 200) });
      const result = await enqueueTurn(message, undefined, routeHintsFromBody(body));
      logEvent("stdout", { kind: "chat-out", reply: result.reply.slice(0, 200) });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat/stream") {
      const body = await readJsonBody(request);
      const message = String(body.message ?? "").trim();
      if (!message) return sendJson(response, 400, { error: "message is required" });

      // S3d review R1: intercept a Discuss answer / explicit-go BEFORE opening the stream
      // and BEFORE enqueueTurn - out-of-band, so it drives the live picker held by the
      // blocked discuss turn instead of queuing behind it. Emit a minimal open/done SSE.
      await readyPromise;
      const intercepted = await dispatchDiscussIntercept(body);
      if (intercepted) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("cache-control", "no-cache, no-transform");
        response.setHeader("connection", "keep-alive");
        response.setHeader("x-accel-buffering", "no");
        response.flushHeaders?.();
        sseWrite(response, "open", { ts: Date.now() });
        sseWrite(response, "done", { reply: intercepted.reply, session_id: null, cost_usd: null, card: intercepted.card, [intercepted.action]: true });
        logEvent("stdout", { kind: "chat-stream-intercept", action: intercepted.action, card: intercepted.card });
        response.end();
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders?.();
      sseWrite(response, "open", { ts: Date.now() });
      const heartbeat = setInterval(() => {
        try {
          response.write(": keepalive\n\n");
        } catch {
          /* ignore */
        }
      }, 15_000);

      // Forward AskUserQuestion tool events on THIS stream while the turn runs, so
      // the client renders tappable option buttons (answered via POST /chat/answer).
      const onTool = (payload) => {
        try {
          sseWrite(response, "tool", payload);
        } catch {
          /* client gone */
        }
      };
      toolListeners.add(onTool);

      const hints = routeHintsFromBody(body);
      // §4: the FIRST `route` frame, emitted the moment preRoute resolves, so the
      // badge row appears ~1s into the turn instead of after the reply. `pending`
      // marks it as refinable; the client merges the done frame over it and drops
      // any frame from an older turnSeq (§5).
      const onPreRoute = (pre) => {
        try {
          sseWrite(response, "route", {
            ...turnAttribution(pre, hints),
            ...routeFieldsFrom(pre),
            pending: true,
            turnSeq: hints.turnSeq
          });
        } catch {
          /* client gone */
        }
      };
      // §12: tool activity from a routed runtime, for the working-hint slot.
      const onActivity = (payload) => {
        try {
          sseWrite(response, "activity", payload);
        } catch {
          /* client gone */
        }
      };

      try {
        await readyPromise;
        const result = await enqueueTurn(message, (text, replace) => {
          try {
            // `replace` (the onChunk 2nd arg) marks a FULL re-emit of the reply after
            // a screen reflow/divergence — not a delta. Forward it so the client
            // REPLACES its accumulator instead of appending (the duplication bug that
            // turned a short reply into kilobytes of repeated text). Additive field:
            // older clients that ignore it are unaffected.
            sseWrite(response, "chunk", { type: "chunk", text, replace: replace === true });
          } catch {
            /* client gone */
          }
        }, hints, { onPreRoute, onActivity });
        // Additive context telemetry (D5b): the turn's live/peak context % + any
        // compactions, read off the operative session that just ran. A nested
        // `context` object so consumers (the kanban engine) opt in without any
        // change to the existing result shape.
        sseWrite(response, "done", { ...result, context: contextTelemetry() });
        logEvent("stdout", { kind: "chat-stream-out", reply: result.reply.slice(0, 200) });
      } catch (err) {
        sseWrite(response, "error", { error: err.message });
        logEvent("stderr", { kind: "chat-stream-failed", error: err.message });
      } finally {
        toolListeners.delete(onTool);
        clearInterval(heartbeat);
        response.end();
      }
      return;
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
      const description = typeof body.kind === "string" ? `Heartbeat job: ${body.kind}` : "Heartbeat tick";
      const jobMessage = `${description}\n\nPayload:\n${JSON.stringify(body)}`;
      readyPromise
        .then(() => enqueueTurn(jobMessage))
        .catch((err) => logEvent("stderr", { kind: "job-turn-failed", error: err.message }));
      sendJson(response, 202, { ack: true });
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
      const file = await appendFeedback(record);
      logEvent("stdout", { kind: "override-feedback", via: "endpoint", session_id: record.session_id ?? null });
      sendJson(response, 200, { ok: true, recorded: true, path: file });
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
        const text = String(body.text ?? body.message ?? "").trim();
        if (!text) return sendJson(response, 400, { error: "text is required" });
        // Non-blocking: enqueue the turn; the SSE reflects progress.
        enqueueTurn(text).catch((err) => logEvent("stderr", { kind: "claude-message-failed", error: err.message }));
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
    logEvent("stderr", { kind: "request-failed", method: request.method, path: url.pathname, error: err.message });
    sendJson(response, 500, { error: err.message });
  }
});

async function main() {
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
        // Unblock waiters so pending /chat calls fail fast instead of hanging.
        readyResolve();
      }
    })();
  });
}

async function shutdown(signal) {
  logEvent("stdout", { kind: "shutdown", signal });
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
