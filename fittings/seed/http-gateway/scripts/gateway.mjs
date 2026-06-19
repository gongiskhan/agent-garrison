#!/usr/bin/env node
/**
 * Agent Garrison HTTP gateway.
 *
 * When GARRISON_SOULS_CONFIG is set, this gateway operates in
 * "orchestrator + souls" mode:
 *   - Boots an interactive Claude Code PTY session for the Orchestrator.
 *   - On demand, spawns Soul PTY sessions or opens
 *     a TrenchesPanel-style tab via Garrison Next.js (interactive mode).
 *   - Multiplexes events to channel SSE subscribers.
 *   - Exposes /sessions/* and /worktrees/* endpoints used by the
 *     garrison-control MCP tools.
 *
 * When GARRISON_SOULS_CONFIG is not set, the gateway runs gateway-pty.mjs.
 *
 * Environment (orchestrator mode):
 *   GARRISON_SOULS_CONFIG          JSON blob with orchestratorFittingId, orchestrator, souls
 *   GARRISON_ORCHESTRATOR_FITTING_ID
 *   GARRISON_MCP_GATEWAY_BASE_URL  e.g. http://127.0.0.1:9876
 *   GARRISON_MCP_GATEWAY_TOKEN     bearer
 *   GARRISON_NEXT_BASE_URL         http://127.0.0.1:3000
 *   GARRISON_COMPOSITION_DIR       composition working directory
 *   GARRISON_GATEWAY_HOST          (default 127.0.0.1)
 *   GARRISON_GATEWAY_PORT          (default 4777)
 *
 * Single-operative mode respects:
 *   GARRISON_SYSTEM_PROMPT_PATH, GARRISON_MODEL, GARRISON_PERMISSION_MODE
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { logEvent } from "./lib/log.mjs";
import { ChannelHub } from "./lib/channels.mjs";
import { SessionRegistry } from "./lib/session-registry.mjs";
import { JsonlWatcher } from "./lib/jsonl-watcher.mjs";
import {
  spawnHeadless,
  spawnInteractiveTab,
  respawnInteractiveTab,
  writeUserTurn,
  writePromptTempFile
} from "./lib/spawn-soul.mjs";
import { WorktreesProxy } from "./lib/worktrees-passthrough.mjs";
import { buildOrchestratorTurn } from "./lib/orchestrator-prefix.mjs";
import { shouldRespawnForTier } from "./lib/tier-compare.mjs";

const HOST = process.env.GARRISON_GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GARRISON_GATEWAY_PORT ?? "4777");
const COMPOSITION_DIR = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();
const MCP_GATEWAY_BASE_URL = process.env.GARRISON_MCP_GATEWAY_BASE_URL ?? "";
const MCP_GATEWAY_TOKEN = process.env.GARRISON_MCP_GATEWAY_TOKEN ?? "";
const NEXT_BASE_URL = process.env.GARRISON_NEXT_BASE_URL ?? "";
const ORCHESTRATOR_FITTING_ID = process.env.GARRISON_ORCHESTRATOR_FITTING_ID ?? "";
const SOULS_CONFIG_RAW = process.env.GARRISON_SOULS_CONFIG ?? "";

const STARTED_AT = Date.now();
const ORCHESTRATOR_MODE = Boolean(SOULS_CONFIG_RAW);

// ─────────────────────────────────────────────────────────────── Module state
const registry = new SessionRegistry();
const channels = new ChannelHub();
const watcher = new JsonlWatcher();
// Proxies the dev-env Fitting's /worktrees endpoints (default 7086); the
// NEXT_BASE_URL argument is legacy and ignored by the proxy.
const worktrees = new WorktreesProxy(NEXT_BASE_URL);

let soulsConfig = null;
let orchestratorSessionId = null;
let orchestratorChild = null;
// The channel of the orchestrator's in-flight turn. Souls spawned via talk_to
// during that turn inherit it (instead of "main") so their output publishes to
// the same channel the caller is listening on (e.g. the voice UI's stream).
let currentOrchestratorChannel = "main";
let mcpConfigPath = null;

// ───────────────────────────────────────────────────────── HTTP plumbing

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
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function sseWrite(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ───────────────────────────────────────────────────────── Orchestrator mode

async function loadSoulsConfig() {
  if (!SOULS_CONFIG_RAW) return null;
  try {
    return JSON.parse(SOULS_CONFIG_RAW);
  } catch (err) {
    logEvent("stderr", { kind: "souls-config-parse-failed", error: err.message });
    return null;
  }
}

async function writeSharedMcpConfig() {
  // Claude Code's HTTP MCP transport assumes OAuth and doesn't always honour
  // raw Bearer headers; stdio is the proven-good transport (interactive uses
  // it). Spawn mcp-gateway as a child so the orchestrator + souls get a
  // local pipe-based MCP connection. Same set of tools as the HTTP sidecar.
  const gatewayScriptPath = path.join(COMPOSITION_DIR, "apm_modules", "_local", "mcp-gateway", "scripts", "gateway.mjs");
  const dir = path.join(COMPOSITION_DIR, ".garrison");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "mcp.json");
  const cfg = {
    mcpServers: {
      garrison: {
        command: "node",
        args: [gatewayScriptPath, "stdio"],
        env: {
          GARRISON_COMPOSITION_DIR: COMPOSITION_DIR,
          // mcp-gateway falls back to discovering tools from the composition
          // when this URL is set; keep it pointed at the http-gateway so
          // talk_to / create_worktree / list_worktrees etc. can dispatch
          // back through us.
          GARRISON_HTTP_GATEWAY_BASE_URL: `http://${HOST}:${PORT}`
        }
      }
    }
  };
  await fs.writeFile(filePath, JSON.stringify(cfg, null, 2), "utf8");
  logEvent("stdout", { kind: "mcp-config-written", path: filePath });
  return filePath;
}

async function loadOrchestratorSessionId() {
  const filePath = path.join(COMPOSITION_DIR, ".garrison", "orchestrator-session-id");
  try {
    const id = (await fs.readFile(filePath, "utf8")).trim();
    if (/^[0-9a-f-]{36}$/i.test(id)) return id;
  } catch { /* fresh start */ }
  return null;
}

async function persistOrchestratorSessionId(id) {
  const filePath = path.join(COMPOSITION_DIR, ".garrison", "orchestrator-session-id");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, id, "utf8");
}

async function bootOrchestrator() {
  const orchSpawn = soulsConfig?.orchestrator;
  if (!orchSpawn) {
    logEvent("stderr", { kind: "orchestrator-missing", message: "soulsConfig.orchestrator absent" });
    return null;
  }
  const priorId = await loadOrchestratorSessionId();
  const sessionUuid = priorId ?? randomUUID();
  const resume = Boolean(priorId);
  const promptTempPath = await writePromptTempFile(sessionUuid, orchSpawn.promptPath);

  const state = registry.register({
    sessionId: sessionUuid,
    soul: ORCHESTRATOR_FITTING_ID || "orchestrator",
    mode: "headless",
    status: "spawning",
    cwd: orchSpawn.resolvedBasePath || COMPOSITION_DIR,
    channel: "main",
    tier: null,
    tierFlags: []
  });
  channels.bindSession(sessionUuid, "main");

  state.child = spawnHeadless({
    sessionUuid,
    spawnConfig: orchSpawn,
    promptPath: promptTempPath,
    cwd: state.cwd,
    tierFlags: [],
    mcpConfigPath,
    isOrchestrator: true,
    resume,
    onEvent: (ev) => handleOrchestratorEvent(state, ev),
    onResult: (text) => handleOrchestratorResult(state, text),
    onExit: (code) => {
      logEvent("stdout", { kind: "orchestrator-exit", code });
      state.status = code === 0 ? "completed" : "killed";
      registry.resolveWaiters(sessionUuid);
    }
  });
  state.status = "running";
  orchestratorChild = state.child;
  orchestratorSessionId = sessionUuid;
  await persistOrchestratorSessionId(sessionUuid);
  logEvent("stdout", { kind: "orchestrator-booted", session_id: sessionUuid, resume });
  return state;
}

function handleOrchestratorEvent(state, ev) {
  channels.publish(state.sessionId, state.soul, ev);
}

function handleOrchestratorResult(state, text) {
  state.lastSummary = text;
  state.lastResultAt = new Date().toISOString();
  registry.resolveWaiters(state.sessionId);
}

// ─────────────────────────────────────────────────── Soul spawn / respawn

async function spawnSoulSession(opts) {
  const {
    soul,
    message,
    tier,
    tierFlags = [],
    mode,
    cwd,
    worktreeId,
    parentSessionId,
    // Default to the orchestrator's current turn channel so a delegated soul
    // streams back to whoever is listening (voice/web), not the dead "main".
    channel = currentOrchestratorChannel,
    sessionUuid: providedUuid,
    origin
  } = opts;

  if (!soulsConfig?.souls?.[`soul-${soul}`] && !soulsConfig?.souls?.[soul]) {
    throw new Error(`unknown soul: ${soul}`);
  }
  const spawnConfig = soulsConfig.souls[`soul-${soul}`] ?? soulsConfig.souls[soul];
  const resolvedMode = mode ?? (origin === "interactive" ? "interactive" : "headless");

  const existing = registry.bySoul(soul);
  if (existing && existing.status === "running") {
    // Tier mismatch → respawn. Otherwise pipe the new message in.
    if (shouldRespawnForTier(existing.tier, tier)) {
      return await respawnExisting(existing, { tier, tierFlags, message, soul, spawnConfig });
    }
    if (message) writeUserTurn(existing.child, message);
    return {
      session_id: existing.sessionId,
      status: existing.status,
      mode: existing.mode,
      channel: existing.channel,
      worktree_id: existing.worktreeId
    };
  }

  const sessionUuid = providedUuid ?? randomUUID();
  // Resolve cwd in priority: explicit cwd → worktree path lookup → base_path.
  // Without this, a soul bound to a worktree would spawn in its base_path
  // (e.g. ~/code) and write changes in the wrong place.
  let resolvedCwd = cwd;
  if (!resolvedCwd && worktreeId) {
    try {
      const wt = await worktrees.getById(worktreeId);
      if (wt?.worktreePath) resolvedCwd = wt.worktreePath;
    } catch (err) {
      logEvent("stderr", { kind: "worktree-cwd-lookup-failed", worktree_id: worktreeId, error: err?.message });
    }
  }
  if (!resolvedCwd) resolvedCwd = spawnConfig.resolvedBasePath;
  const promptTempPath = await writePromptTempFile(sessionUuid, spawnConfig.promptPath);

  const state = registry.register({
    sessionId: sessionUuid,
    soul,
    mode: resolvedMode,
    status: "spawning",
    cwd: resolvedCwd,
    channel,
    parentSessionId,
    worktreeId,
    tier,
    tierFlags
  });
  channels.bindSession(sessionUuid, channel);

  if (resolvedMode === "interactive") {
    try {
      const result = await spawnInteractiveTab({
        nextBaseUrl: NEXT_BASE_URL,
        sessionUuid,
        spawnConfig,
        cwd: resolvedCwd,
        tierFlags,
        message,
        mcpConfigPath,
        soul,
        worktreeId,
        resume: false,
        promptPath: promptTempPath
      });
      state.terminalTabId = result?.terminal_tab_id ?? null;
      state.status = "running";
      watcher.install({
        sessionId: sessionUuid,
        cwd: resolvedCwd,
        onIdleSummary: (text) => {
          state.lastSummary = text;
          state.lastResultAt = new Date().toISOString();
          state.pendingSummaries.push({ summary: text, at: state.lastResultAt, acknowledged: false });
          channels.publish(sessionUuid, soul, { type: "summary", text });
        }
      });
    } catch (err) {
      state.status = "failed";
      throw err;
    }
  } else {
    state.child = spawnHeadless({
      sessionUuid,
      spawnConfig,
      promptPath: promptTempPath,
      cwd: resolvedCwd,
      tierFlags,
      mcpConfigPath,
      isOrchestrator: false,
      resume: false,
      // Don't stream raw stream-JSON events to the voice channel (they'd be
      // spoken as fragments / tool noise). Publish the clean final answer once on
      // result, which is what the voice UI speaks.
      onEvent: () => {},
      onResult: (text) => {
        state.lastSummary = text;
        state.lastResultAt = new Date().toISOString();
        state.pendingSummaries.push({ summary: text, at: state.lastResultAt, acknowledged: false });
        channels.publish(sessionUuid, soul, { type: "assistant", message: { content: [{ type: "text", text }] } });
        registry.resolveWaiters(sessionUuid);
      },
      onExit: (code) => {
        state.status = code === 0 ? "completed" : "killed";
        registry.resolveWaiters(sessionUuid);
      }
    });
    state.status = "running";
    if (message) writeUserTurn(state.child, message);
  }

  // If this soul is bound to a worktree, persist the binding into the
  // session state so the Monitor (and Interactive session-view) can surface
  // soul/tier/branch metadata on top of raw PIDs.
  if (worktreeId) {
    void persistWorktreeBinding({
      worktreeId,
      soul,
      sessionId: sessionUuid,
      mode: resolvedMode,
      tier,
      tierFlags,
      terminalTabId: state.terminalTabId
    });
  }

  return {
    session_id: sessionUuid,
    status: state.status,
    mode: state.mode,
    channel: state.channel,
    worktree_id: state.worktreeId,
    terminal_tab_id: state.terminalTabId
  };
}

async function persistWorktreeBinding(binding) {
  if (!NEXT_BASE_URL) return;
  try {
    await fetch(new URL("/api/interactive/sessions/binding", NEXT_BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worktreeId: binding.worktreeId,
        soul: binding.soul,
        sessionId: binding.sessionId,
        mode: binding.mode,
        tier: binding.tier,
        tierFlags: binding.tierFlags,
        terminalTabId: binding.terminalTabId,
        spawnedAt: new Date().toISOString()
      })
    });
  } catch (err) {
    logEvent("stderr", { kind: "binding-persist-failed", error: err?.message });
  }
}

async function respawnExisting(existing, { tier, tierFlags, message, soul, spawnConfig }) {
  logEvent("stdout", { kind: "respawn-start", session: existing.sessionId, old_tier: existing.tier, new_tier: tier });
  const promptTempPath = await writePromptTempFile(existing.sessionId, spawnConfig.promptPath);
  if (existing.mode === "interactive") {
    await respawnInteractiveTab({
      nextBaseUrl: NEXT_BASE_URL,
      sessionUuid: existing.sessionId,
      terminalTabId: existing.terminalTabId,
      spawnConfig,
      tierFlags,
      mcpConfigPath,
      message,
      promptPath: promptTempPath
    });
    existing.tier = tier;
    existing.tierFlags = tierFlags;
    return {
      session_id: existing.sessionId,
      status: "running",
      mode: existing.mode,
      channel: existing.channel,
      worktree_id: existing.worktreeId,
      terminal_tab_id: existing.terminalTabId,
      respawned: true
    };
  }
  // headless: kill + new spawn with --resume
  try { existing.child?.kill("SIGTERM"); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 200));
  if (existing.child?.exitCode === null) {
    try { existing.child?.kill("SIGKILL"); } catch { /* ignore */ }
  }
  existing.child = spawnHeadless({
    sessionUuid: existing.sessionId,
    spawnConfig,
    promptPath: promptTempPath,
    cwd: existing.cwd,
    tierFlags,
    mcpConfigPath,
    isOrchestrator: false,
    resume: true,
    onEvent: () => {},
    onResult: (text) => {
      existing.lastSummary = text;
      existing.lastResultAt = new Date().toISOString();
      existing.pendingSummaries.push({ summary: text, at: existing.lastResultAt, acknowledged: false });
      channels.publish(existing.sessionId, soul, { type: "assistant", message: { content: [{ type: "text", text }] } });
      registry.resolveWaiters(existing.sessionId);
    },
    onExit: (code) => {
      existing.status = code === 0 ? "completed" : "killed";
      registry.resolveWaiters(existing.sessionId);
    }
  });
  existing.status = "running";
  existing.tier = tier;
  existing.tierFlags = tierFlags;
  if (message) writeUserTurn(existing.child, message);
  return {
    session_id: existing.sessionId,
    status: "running",
    mode: existing.mode,
    channel: existing.channel,
    worktree_id: existing.worktreeId,
    respawned: true
  };
}

function killSessionBySoul(soul) {
  const existing = registry.bySoul(soul);
  if (!existing) return false;
  try { existing.child?.kill("SIGTERM"); } catch { /* ignore */ }
  existing.status = "killed";
  registry.resolveWaiters(existing.sessionId);
  watcher.uninstall(existing.sessionId);
  return true;
}

// ─────────────────────────────────────────────────── /chat → Orchestrator

async function forwardChatToOrchestrator({ origin, channel, message }) {
  if (!orchestratorChild || !orchestratorSessionId) {
    throw new Error("orchestrator not booted");
  }
  // Remember this turn's channel so souls delegated during it inherit it.
  currentOrchestratorChannel = channel;
  const pending = registry.drainPendingSummaries().map((p) => ({
    soul: p.soul,
    sessionId: p.sessionId,
    summary: p.summary
  }));
  const turn = buildOrchestratorTurn({ origin, channel, message, pendingSummaries: pending });
  const orchState = registry.get(orchestratorSessionId);
  if (orchState) orchState.lastSummary = null;
  writeUserTurn(orchestratorChild, turn);
  // Caller may wait for result; otherwise fire-and-forget.
  return orchState ? registry.addWaiter(orchestratorSessionId) : null;
}

// ────────────────────────────────────────────────────────────── HTTP server

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const method = request.method ?? "GET";

  try {
    if (method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        mode: ORCHESTRATOR_MODE ? "orchestrator" : "legacy",
        orchestrator_session_id: orchestratorSessionId,
        sessions_count: registry.sessions.size,
        channels_count: channels.channels.size,
        uptime_ms: Date.now() - STARTED_AT
      });
      return;
    }

    if (method === "POST" && url.pathname === "/chat") {
      const body = await readJsonBody(request);
      const message = String(body.message ?? "").trim();
      if (!message) return sendJson(response, 400, { error: "message is required" });
      const origin = (request.headers["x-garrison-origin"] ?? "channel").toString();
      const channel = String(body.channel ?? "main");
      const waiter = await forwardChatToOrchestrator({ origin, channel, message });
      if (waiter) {
        const result = await waiter;
        sendJson(response, 200, { reply: result.summary, session_id: orchestratorSessionId });
      } else {
        sendJson(response, 200, { ack: true, session_id: orchestratorSessionId });
      }
      return;
    }

    if (method === "POST" && url.pathname === "/chat/stream") {
      const body = await readJsonBody(request);
      const message = String(body.message ?? "").trim();
      if (!message) return sendJson(response, 400, { error: "message is required" });
      const origin = (request.headers["x-garrison-origin"] ?? "channel").toString();
      const channel = String(body.channel ?? "main");

      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders?.();
      sseWrite(response, "open", { ts: Date.now() });

      const heartbeat = setInterval(() => {
        try { response.write(": keepalive\n\n"); } catch { /* ignore */ }
      }, 15_000);

      const unsubscribe = channels.subscribe(channel, (wrapped) => {
        if (wrapped.session_id !== orchestratorSessionId) return;
        const ev = wrapped.event;
        if (ev?.type === "assistant") {
          for (const block of ev.message?.content ?? []) {
            if (block?.type === "text") sseWrite(response, "chunk", { text: block.text });
          }
        }
      });

      try {
        const waiter = await forwardChatToOrchestrator({ origin, channel, message });
        if (waiter) {
          const result = await waiter;
          sseWrite(response, "done", { reply: result.summary });
        }
      } catch (err) {
        sseWrite(response, "error", { error: err.message });
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        response.end();
      }
      return;
    }

    if (method === "POST" && url.pathname === "/jobs") {
      const body = await readJsonBody(request);
      const description = typeof body.kind === "string" ? `Heartbeat job: ${body.kind}` : "Heartbeat tick";
      const payloadJson = JSON.stringify(body);
      const message = `${description}\n\nPayload:\n${payloadJson}`;
      // Channel origin, channel=heartbeat. Fire-and-forget.
      forwardChatToOrchestrator({ origin: "channel", channel: "heartbeat", message }).catch((err) => {
        logEvent("stderr", { kind: "job-forward-failed", error: err.message });
      });
      sendJson(response, 202, { ack: true });
      return;
    }

    if (method === "POST" && url.pathname === "/sessions/spawn") {
      const body = await readJsonBody(request);
      const result = await spawnSoulSession({
        soul: String(body.soul ?? ""),
        message: body.message ? String(body.message) : undefined,
        tier: body.tier_hint ?? body.tier,
        tierFlags: Array.isArray(body.tier_flags) ? body.tier_flags : [],
        mode: body.mode,
        cwd: body.cwd,
        worktreeId: body.worktree_id,
        parentSessionId: body.parent_session_id,
        channel: body.channel,
        sessionUuid: body.session_id,
        origin: body.origin
      });
      sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && /^\/sessions\/([^/]+)\/wait$/.test(url.pathname)) {
      const sessionId = url.pathname.split("/")[2];
      const body = await readJsonBody(request).catch(() => ({}));
      const timeoutSec = Math.min(Number(body.timeout_seconds ?? 30), 300);
      const state = registry.get(sessionId);
      if (!state) return sendJson(response, 404, { error: "session not found" });
      if (state.status === "completed") {
        return sendJson(response, 200, { status: "completed", summary: state.lastSummary ?? "" });
      }
      const result = await Promise.race([
        registry.addWaiter(sessionId),
        new Promise((r) => setTimeout(() => r({ status: "still_running" }), timeoutSec * 1000))
      ]);
      sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && /^\/sessions\/by-soul\/([^/]+)\/end$/.test(url.pathname)) {
      const soul = url.pathname.split("/")[3];
      const ok = killSessionBySoul(soul);
      sendJson(response, ok ? 200 : 404, { ok });
      return;
    }

    if (method === "GET" && url.pathname === "/sessions") {
      const filter = {
        parent: url.searchParams.get("parent") || undefined,
        worktreeId: url.searchParams.get("worktree_id") || undefined,
        mode: url.searchParams.get("mode") || undefined,
        soul: url.searchParams.get("soul") || undefined
      };
      sendJson(response, 200, { sessions: registry.list(filter) });
      return;
    }

    if (method === "GET" && /^\/channels\/([^/]+)\/stream$/.test(url.pathname)) {
      const channelId = url.pathname.split("/")[2];
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders?.();
      sseWrite(response, "open", { ts: Date.now(), channel: channelId });
      const heartbeat = setInterval(() => {
        try { response.write(": keepalive\n\n"); } catch { /* ignore */ }
      }, 15_000);
      // ?live=1 → no ring replay (live consumers that speak each event don't want
      // old replies re-delivered on connect/reconnect).
      const replay = url.searchParams.get("live") !== "1";
      const unsubscribe = channels.subscribe(channelId, (wrapped) => {
        sseWrite(response, "event", wrapped);
      }, { replay });
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    if (method === "GET" && url.pathname === "/workdirs") {
      const soul = url.searchParams.get("soul") ?? "";
      const config = soulsConfig?.souls?.[`soul-${soul}`] ?? soulsConfig?.souls?.[soul];
      if (!config) return sendJson(response, 404, { error: "unknown soul" });
      const dirs = [];
      try {
        const entries = await fs.readdir(config.resolvedBasePath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith(".")) continue;
          const full = path.join(config.resolvedBasePath, entry.name);
          const stat = await fs.stat(full).catch(() => null);
          dirs.push({ name: entry.name, path: full, last_modified: stat?.mtimeMs ?? 0 });
        }
        dirs.sort((a, b) => b.last_modified - a.last_modified);
      } catch (err) {
        logEvent("stderr", { kind: "workdirs-failed", soul, error: err.message });
      }
      sendJson(response, 200, { workdirs: dirs });
      return;
    }

    if (method === "GET" && url.pathname === "/worktrees") {
      const project = url.searchParams.get("project") || undefined;
      const id = url.searchParams.get("id") || undefined;
      try {
        const data = id ? await worktrees.getById(id) : await worktrees.list(project);
        sendJson(response, 200, data);
      } catch (err) { sendJson(response, 502, { error: err.message }); }
      return;
    }

    if (method === "POST" && url.pathname === "/worktrees") {
      const body = await readJsonBody(request);
      try {
        const data = await worktrees.create(body);
        sendJson(response, 201, data);
      } catch (err) { sendJson(response, 502, { error: err.message }); }
      return;
    }

    if (method === "POST" && /^\/worktrees\/([^/]+)\/close$/.test(url.pathname)) {
      const id = url.pathname.split("/")[2];
      const body = await readJsonBody(request).catch(() => ({}));
      try {
        const data = await worktrees.close({ id, ...body });
        sendJson(response, 200, data);
      } catch (err) { sendJson(response, 502, { error: err.message }); }
      return;
    }

    sendJson(response, 404, { error: "not found", path: url.pathname });
  } catch (err) {
    logEvent("stderr", { kind: "request-failed", path: url.pathname, error: err.message });
    sendJson(response, 500, { error: err.message });
  }
});

// ────────────────────────────────────────────────────────────── Boot

async function main() {
  if (!ORCHESTRATOR_MODE) {
    logEvent("stdout", { kind: "engine-select", engine: "pty", message: "running gateway-pty.mjs (interactive claude TUI)" });
    await import("./gateway-pty.mjs");
    return;
  }
  logEvent("stdout", { kind: "orchestrator-mode-note", message: "souls use PTY-backed sessions" });
  soulsConfig = await loadSoulsConfig();
  mcpConfigPath = await writeSharedMcpConfig();
  server.listen(PORT, HOST, async () => {
    logEvent("stdout", {
      kind: "listening",
      host: HOST,
      port: PORT,
      mode: "orchestrator",
      composition_dir: COMPOSITION_DIR
    });
    // Boot orchestrator after server is listening so /health works while it spins up.
    try { await bootOrchestrator(); } catch (err) {
      logEvent("stderr", { kind: "orchestrator-boot-failed", error: err.message });
    }
  });
}

function shutdown(signal) {
  logEvent("stdout", { kind: "shutdown", signal });
  for (const state of registry.sessions.values()) {
    try { state.child?.kill("SIGTERM"); } catch { /* ignore */ }
    watcher.uninstall(state.sessionId);
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
