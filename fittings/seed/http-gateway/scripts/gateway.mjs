#!/usr/bin/env node
/**
 * Agent Garrison HTTP gateway.
 *
 * Owns the Claude session for the operative. Garrison's runner spawns this
 * script as a child process; this script imports @anthropic-ai/claude-agent-sdk
 * and runs Claude in-process across multiple turns using session resume.
 *
 * Endpoints:
 *   POST /chat   { message: string }   → { reply: string, session_id }
 *   POST /jobs   { kind, ...payload }  → { ack: true } (heartbeat dispatch)
 *   GET  /health                       → { ok, session_id, uptime_ms }
 *
 * Environment:
 *   GARRISON_GATEWAY_HOST          bind host (default 127.0.0.1)
 *   GARRISON_GATEWAY_PORT          bind port (default 4777)
 *   GARRISON_SYSTEM_PROMPT_PATH    path to assembled system prompt file
 *   GARRISON_VAULT_ENV_PATH        path to materialised vault .env (optional)
 *   GARRISON_COMPOSITION_DIR       composition working directory
 *   GARRISON_PERMISSION_MODE       "default" | "acceptEdits" | "bypassPermissions"
 *                                  (default: "bypassPermissions" for local dev)
 *   GARRISON_MODEL                 model id (default: "opus")
 *
 * stdout/stderr are tailed by Garrison's runner and surfaced in the Run tab.
 * Logs are emitted as JSON lines so they can be parsed downstream if needed.
 */

import http from "node:http";
import fs from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";

const HOST = process.env.GARRISON_GATEWAY_HOST ?? "127.0.0.1";
const PORT = Number(process.env.GARRISON_GATEWAY_PORT ?? "4777");
const SYSTEM_PROMPT_PATH = process.env.GARRISON_SYSTEM_PROMPT_PATH ?? "";
const COMPOSITION_DIR = process.env.GARRISON_COMPOSITION_DIR ?? process.cwd();
const PERMISSION_MODE = process.env.GARRISON_PERMISSION_MODE ?? "bypassPermissions";
const MODEL = process.env.GARRISON_MODEL ?? "opus";

const STARTED_AT = Date.now();

// Module-level session state. Single conversation per gateway lifetime.
let sessionId = null;
let systemPrompt = null;
let inflight = null; // Promise chain to serialize turns

function logEvent(stream, payload) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    component: "http-gateway",
    stream,
    ...payload
  });
  if (stream === "stderr") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

async function loadSystemPrompt() {
  if (!SYSTEM_PROMPT_PATH) {
    return null;
  }
  try {
    const contents = await fs.readFile(SYSTEM_PROMPT_PATH, "utf8");
    return contents.trim() || null;
  } catch (error) {
    logEvent("stderr", {
      kind: "system-prompt-read-failed",
      path: SYSTEM_PROMPT_PATH,
      error: error.message
    });
    return null;
  }
}

/**
 * Run one turn against the agent. Returns the assembled assistant text reply
 * and updates the module-level sessionId so subsequent turns resume it.
 */
async function runTurn(message) {
  const options = {
    model: MODEL,
    permissionMode: PERMISSION_MODE,
    cwd: COMPOSITION_DIR,
    maxTurns: 50
  };

  if (sessionId) {
    options.resume = sessionId;
  } else if (systemPrompt) {
    // First turn only: append the assembled prompt to Claude Code's preset.
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: systemPrompt
    };
  }

  let assistantText = "";
  let turnSessionId = sessionId;
  let resultSubtype = null;
  let totalCost = null;

  for await (const event of query({ prompt: message, options })) {
    if (event.type === "system" && event.subtype === "init") {
      turnSessionId = event.session_id ?? turnSessionId;
      logEvent("stdout", {
        kind: "session-init",
        session_id: turnSessionId,
        resumed: Boolean(sessionId)
      });
    } else if (event.type === "assistant" && event.message?.content) {
      const blocks = Array.isArray(event.message.content)
        ? event.message.content
        : [];
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          assistantText += block.text;
          logEvent("stdout", { kind: "assistant-text", text: block.text });
        } else if (block.type === "tool_use") {
          logEvent("stdout", {
            kind: "tool-use",
            name: block.name,
            input: block.input
          });
        }
      }
    } else if (event.type === "result") {
      resultSubtype = event.subtype;
      totalCost = event.total_cost_usd ?? null;
      turnSessionId = event.session_id ?? turnSessionId;
      logEvent("stdout", {
        kind: "turn-result",
        subtype: resultSubtype,
        cost_usd: totalCost
      });
    }
  }

  if (turnSessionId) {
    sessionId = turnSessionId;
  }

  if (resultSubtype && resultSubtype !== "success") {
    throw new Error(`Agent turn ended with subtype="${resultSubtype}"`);
  }

  return { reply: assistantText.trim(), session_id: sessionId };
}

/**
 * Serialize turns. The Agent SDK's session resume model does not support
 * concurrent turns against the same session — they would race the underlying
 * transcript. Queue them.
 */
function enqueueTurn(message) {
  const previous = inflight ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => runTurn(message));
  inflight = next;
  return next;
}

async function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        session_id: sessionId,
        uptime_ms: Date.now() - STARTED_AT
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      const body = await readJsonBody(request);
      const message = String(body.message ?? "").trim();
      if (!message) {
        sendJson(response, 400, { error: "message is required" });
        return;
      }
      logEvent("stdout", { kind: "chat-in", message });
      const result = await enqueueTurn(message);
      logEvent("stdout", { kind: "chat-out", reply: result.reply });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/jobs") {
      const body = await readJsonBody(request);
      logEvent("stdout", { kind: "job-received", payload: body });
      // Heartbeat fan-in: dispatch as a turn so the operative reacts.
      const description =
        typeof body.kind === "string"
          ? `Heartbeat job: ${body.kind}`
          : "Heartbeat tick";
      const payloadJson = JSON.stringify(body);
      const jobMessage = `${description}\n\nPayload:\n${payloadJson}`;
      // Don't await — return ack immediately, run the turn in background.
      enqueueTurn(jobMessage).catch((error) => {
        logEvent("stderr", {
          kind: "job-turn-failed",
          error: error.message
        });
      });
      sendJson(response, 202, { ack: true });
      return;
    }

    sendJson(response, 404, { error: "not found", path: url.pathname });
  } catch (error) {
    logEvent("stderr", {
      kind: "request-failed",
      method: request.method,
      path: url.pathname,
      error: error.message
    });
    sendJson(response, 500, { error: error.message });
  }
});

async function main() {
  systemPrompt = await loadSystemPrompt();

  server.listen(PORT, HOST, () => {
    logEvent("stdout", {
      kind: "listening",
      host: HOST,
      port: PORT,
      model: MODEL,
      permission_mode: PERMISSION_MODE,
      composition_dir: COMPOSITION_DIR,
      system_prompt_loaded: Boolean(systemPrompt)
    });
  });
}

function shutdown(signal) {
  logEvent("stdout", { kind: "shutdown", signal });
  server.close(() => process.exit(0));
  // Hard exit if we don't close cleanly.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((error) => {
  logEvent("stderr", { kind: "boot-failed", error: error.message });
  process.exit(1);
});
