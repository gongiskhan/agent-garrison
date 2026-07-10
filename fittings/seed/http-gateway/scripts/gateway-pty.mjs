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
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  OperativePtySession,
  extractReply,
  openRichStream,
  richStatus,
  keySequence,
  cycleMode,
  enumerateCommandsCached,
} from "@garrison/claude-pty";
import { createRoutedGateway, resolveModelRouterDir } from "./lib/gateway-routing.mjs";

const HOST = process.env.GARRISON_GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GARRISON_GATEWAY_PORT ?? "4777");
const SYSTEM_PROMPT_PATH = process.env.GARRISON_SYSTEM_PROMPT_PATH ?? "";
const COMPOSITION_DIR = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();
const PERMISSION_MODE = process.env.GARRISON_PERMISSION_MODE ?? "bypassPermissions";
const MODEL = process.env.GARRISON_MODEL ?? "opus";
const CLAUDE_BINARY = process.env.GARRISON_CLAUDE_BINARY ?? "claude";
// When the primary runtime selects a non-default provider, the runner sets
// ANTHROPIC_BASE_URL/AUTH_TOKEN + GARRISON_PROVIDER(_LAUNCH). providerLaunch keeps
// those vars through the orchestrator spawn instead of stripping them for Max-plan.
const PROVIDER_LAUNCH = process.env.GARRISON_PROVIDER_LAUNCH === "1";
const PRIMARY_PROVIDER = process.env.GARRISON_PROVIDER ?? "anthropic-plan";

const STARTED_AT = Date.now();
const SESSION_ID_FILE = path.join(COMPOSITION_DIR, ".garrison", "operative-session-id");

// ─────────────────────────────────────────────────────── module state
let session = null;
let ptyStatus = "spawning"; // spawning | ready | failed
let ptyError = null;
let inflight = null; // promise chain — turns serialize
let router = null; // Stage-A live routing layer (BRIEF U1), null = legacy single-session
let readyResolve;
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve;
});

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
async function initRouting() {
  if (!resolveModelRouterDir(COMPOSITION_DIR)) {
    logEvent("stdout", { kind: "routing-absent", message: "model-router fitting not found — legacy single-session" });
    return false;
  }
  await fs.mkdir(path.join(COMPOSITION_DIR, ".garrison"), { recursive: true });
  const spawnFn = await loadStubSpawnFn();
  const continueSession = await hasPriorSession();
  router = await createRoutedGateway({
    compositionDir: COMPOSITION_DIR,
    appendSystemPromptFile: SYSTEM_PROMPT_PATH || undefined,
    permissionMode: PERMISSION_MODE,
    decisionsFile: path.join(COMPOSITION_DIR, ".garrison", "decisions.jsonl"),
    spawnFn,
    operativeSpawnConfig: {
      compositionDir: COMPOSITION_DIR,
      appendSystemPromptFile: SYSTEM_PROMPT_PATH || undefined,
      model: MODEL,
      permissionMode: PERMISSION_MODE,
      continueSession,
      claudeBinary: CLAUDE_BINARY,
      providerLaunch: PROVIDER_LAUNCH,
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
  ptyStatus = "ready";
  await markPriorSession();
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
    await fs.writeFile(SESSION_ID_FILE, session?.getClaudeSessionId() ?? "continue", "utf8");
  } catch (err) {
    logEvent("stderr", { kind: "persist-session-marker-failed", error: err.message });
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
  ptyStatus = "ready";
  await markPriorSession();
  logEvent("stdout", { kind: "ready", session_id: session.getClaudeSessionId(), continued: continueSession });
  readyResolve();
}

/** Run one turn through Stage-A routing: classify → resolve → log → switch →
 *  turn → honored check. The operative session is served by the routing pool. */
async function runRoutedTurn(message, onChunk, hints) {
  await router.ensureOperative();
  // hints (e.g. from the Kanban Loop) carry an EXPLICIT {taskType,tier} classification
  // so preRoute can honor §10 instead of re-classifying from scratch, plus the per-list
  // skill + suppressContinuations controls. Absent hints → classify as before.
  const pre = await router.preRoute(message, hints || {}); // classify/honor + resolve + LOG + switch
  // D8: significant autonomous work is never done inline — it becomes a card in
  // the Plan list and the reply carries the card link. Card-/scheduler-originated
  // turns (the run engine's own worker dispatches) run inline as before.
  {
    const cls = pre.classification || {};
    const origin = String(hints?.channel || "").toLowerCase();
    const cardOriginated = origin === "kanban" || origin === "scheduler" || origin === "board";
    if (
      cls.execution === "autonomous" &&
      !cardOriginated &&
      typeof router.core?.isSignificantAutonomous === "function" &&
      router.core.isSignificantAutonomous(cls)
    ) {
      const card = await router.createAutonomousCard(message, cls, {
        workKind: hints?.workKind ?? null,
        phases: hints?.phases ?? null,
        project: hints?.project ?? null,
      });
      if (card) {
        const reply =
          `Registered as an autonomous run — the board's run engine will drive it through the pipeline.\n` +
          `Card: ${card.url}`;
        broadcastRich("assistant", { text: reply });
        logEvent("stdout", { kind: "autonomous-card", id: card.id, url: card.url });
        return { reply, session_id: null, cost_usd: null, route: pre.route?.targetId ?? null, card: card.id, cardUrl: card.url };
      }
      // board unavailable → fall through inline (never hard-block on the window)
    }
  }
  // Agent SDK runtime (non-Anthropic model via the Claude Agent SDK): the turn
  // runs on the SDK adapter session, NOT the claude-code PTY operative.
  if (router.isAgentSdkTarget(pre.route)) {
    broadcastRich("turn", { active: true }); // rich UI shows "thinking"
    const r = await router.runAgentSdkTurn(pre.route, message, onChunk);
    // Inject the off-screen agent-sdk reply + a status badge into rich clients so
    // the channel UI clearly shows the routed runtime/model (not the idle operative).
    broadcastRich("status", {
      rows: [`Garrison orchestrator → runtime: agent-sdk · provider: ${r.provider} · model: ${r.model} · fenced (non-Anthropic)`],
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
    });
    return { reply: r.reply, session_id: r.session_id, cost_usd: null, route: pre.route.targetId, runtime: "agent-sdk", model: r.model };
  }
  // Secondary runtime (gpt/codex or gemini): the orchestrator delegates this step
  // to the secondary; the gateway executes it directly (not the PTY operative).
  if (router.isSecondaryTarget(pre.route)) {
    broadcastRich("turn", { active: true });
    const r = await router.runSecondaryTurn(pre.route, message);
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
    });
    return { reply: r.reply, session_id: null, cost_usd: null, route: pre.route.targetId, runtime: r.runtime, model: r.model };
  }
  session = router.getOperativeSession();
  // A resolved `workflow` target runs the named Claude Code workflow ON the
  // operative (via its Workflow tool) — prepend the instruction; else a plain turn.
  const wfPrefix = router.isWorkflowTarget(pre.route) ? router.workflowTurnPrefix(pre.route) : "";
  const annotated = `${pre.annotation}\n${wfPrefix}${message}`;
  let lastEmitted = "";
  const onScreen =
    onChunk && session.handle
      ? () => {
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
  logEvent("stdout", { kind: "routed-turn", target: pre.route.targetId, role: pre.route.role, runtime: "claude-code", model: pre.route?.target?.model ?? MODEL, honored: honored.honored });
  return {
    // Fall back to the operative's claude session id so a routed turn always
    // reports a session (outcome.sessionId is null for the pooled PTY operative).
    reply: outcome.reply,
    session_id: outcome.sessionId ?? session.getClaudeSessionId?.() ?? null,
    cost_usd: null,
    route: pre.route.targetId,
    honored: honored.honored,
  };
}

/** Run one turn against the live operative. Spawns/respawns on demand.
 *  onChunk(text) streams the growing assistant reply (screen-derived). */
async function runTurn(message, onChunk, hints) {
  if (router) return runRoutedTurn(message, onChunk, hints);
  if (!session || session.isDisposed() || !session.isAlive()) {
    logEvent("stdout", { kind: "respawn-before-turn" });
    ptyStatus = "spawning";
    await spawnOperative({ resume: true });
  }
  let lastEmitted = "";
  const onScreen = onChunk
    ? () => {
        const current = extractReply(session.handle, message);
        if (current && current.length > lastEmitted.length && current.startsWith(lastEmitted)) {
          onChunk(current.slice(lastEmitted.length));
          lastEmitted = current;
        } else if (current && current !== lastEmitted) {
          // Reflow / divergence — re-emit the whole thing as a correction.
          onChunk(current, true);
          lastEmitted = current;
        }
      }
    : undefined;
  const outcome = await session.runTurn({ message, onScreen, timeoutMs: hints?.timeoutMs });
  await markPriorSession();
  return { reply: outcome.reply, session_id: outcome.sessionId, cost_usd: null };
}

/** Serialize turns — the TUI is one-turn-at-a-time. */
// Extract optional routing hints from a request body (the Kanban Loop sends these):
// an EXPLICIT {taskType,tier} classification preRoute can honor instead of
// re-classifying, the per-list skill, and a suppress-continuations flag. Validated so a
// malformed classification simply falls back to normal classification (never trusted blindly).
function routeHintsFromBody(body) {
  const c = body?.classification;
  const classification =
    c && typeof c === "object" && typeof c.taskType === "string" && typeof c.tier === "string"
      ? { taskType: c.taskType, tier: c.tier, ...(c.matchedException ? { matchedException: c.matchedException } : {}) }
      : null;
  return {
    classification,
    skill: typeof body?.skill === "string" ? body.skill : null,
    suppressContinuations: body?.suppressContinuations === true,
    // D8 autonomy inputs: the channel name (kanban/scheduler dispatches run
    // inline; other channels' significant autonomous work becomes a card), the
    // explicit autonomous marker (web-channel toggle / autothing doorway), the
    // resolved mode (Gary conversation floors interactive), and optional card
    // fields (workKind / per-card phase toggles / project) for the created card.
    channel: typeof body?.channel === "string" ? body.channel : null,
    autonomous: body?.autonomous === true,
    execution: typeof body?.execution === "string" ? body.execution : undefined,
    mode: typeof body?.mode === "string" ? body.mode : undefined,
    workKind: typeof body?.workKind === "string" ? body.workKind : null,
    phases: body?.phases && typeof body.phases === "object" ? body.phases : null,
    project: typeof body?.project === "string" ? body.project : null,
    // An EXPLICIT per-turn timeout (ms). The Kanban Loop sends a generous one because a
    // real autothing-* turn (plan/implement/review/…) runs far longer than the default
    // 5-min turn timeout, which otherwise kills the turn → HTTP 500 → the card parks.
    // Absent (e.g. web chat) → session.runTurn uses its default, so other channels are
    // unaffected. Only honored when finite + positive.
    timeoutMs:
      typeof body?.timeoutMs === "number" && Number.isFinite(body.timeoutMs) && body.timeoutMs > 0
        ? body.timeoutMs
        : undefined,
  };
}

function enqueueTurn(message, onChunk, hints) {
  const previous = inflight ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => runTurn(message, onChunk, hints));
  inflight = next;
  return next;
}

// ─────────────────────────────────────────────────────── HTTP plumbing

const UPLOADS_DIR = path.join(COMPOSITION_DIR, ".garrison", "uploads");
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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
      sendJson(response, 200, {
        ok: ptyStatus !== "failed",
        session_id: session?.getClaudeSessionId() ?? null,
        uptime_ms: Date.now() - STARTED_AT,
        engine: "pty",
        pty_status: ptyStatus,
        error: ptyError,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      const body = await readJsonBody(request);
      const message = String(body.message ?? "").trim();
      if (!message) return sendJson(response, 400, { error: "message is required" });
      await readyPromise;
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
        }, routeHintsFromBody(body));
        sseWrite(response, "done", result);
        logEvent("stdout", { kind: "chat-stream-out", reply: result.reply.slice(0, 200) });
      } catch (err) {
        sseWrite(response, "error", { error: err.message });
        logEvent("stderr", { kind: "chat-stream-failed", error: err.message });
      } finally {
        clearInterval(heartbeat);
        response.end();
      }
      return;
    }

    if (request.method === "POST" && url.pathname === "/attachments") {
      const body = await readJsonBody(request, MAX_UPLOAD_BYTES + 256_000);
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

    // ───────────────────────── rich chat surface (/claude/*)
    if (url.pathname.startsWith("/claude/")) {
      if (!session || !session.isAlive()) {
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
      if (request.method === "GET" && url.pathname === "/claude/stream") {
        openRichStream(session.handle, response, {
          onEmit: (emit) => {
            richClients.add(emit);
            response.on("close", () => richClients.delete(emit));
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/claude/status") {
        return sendJson(response, 200, richStatus(session.handle));
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
    }

    sendJson(response, 404, { error: "not found", path: url.pathname });
  } catch (err) {
    logEvent("stderr", { kind: "request-failed", method: request.method, path: url.pathname, error: err.message });
    sendJson(response, 500, { error: err.message });
  }
});

async function main() {
  // Node's http.Server defaults requestTimeout to 5 min — that would abort a long
  // /chat turn (a real Kanban autothing-* turn runs longer) at the socket layer,
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
      try {
        if (ROUTING_ENABLED && (await initRouting())) {
          readyResolve();
          return;
        }
        await spawnOperative({ resume: true }); // calls readyResolve internally
      } catch (err) {
        ptyStatus = "failed";
        ptyError = err.message;
        logEvent("stderr", { kind: "spawn-failed", error: err.message });
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
    if (session && session.isAlive() && !session.isTurnActive()) {
      session.writeKeys("\x03");
      await new Promise((r) => setTimeout(r, 200));
      session.writeKeys("\x03");
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch {
    /* best effort */
  }
  try {
    router?.shutdown();
  } catch {
    /* ignore */
  }
  try {
    session?.dispose();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  logEvent("stderr", { kind: "boot-failed", error: err.message });
  process.exit(1);
});
