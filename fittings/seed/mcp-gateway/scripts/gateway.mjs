#!/usr/bin/env node
/**
 * Garrison MCP gateway — exposes installed Faculties as MCP tools to
 * Claude Code sessions launched in orchestrator-mode compositions.
 *
 * Usage:
 *   node gateway.mjs --probe
 *   node gateway.mjs stdio
 *   node gateway.mjs http --port N --token T [--host H]
 *
 * Environment:
 *   GARRISON_COMPOSITION_DIR   composition working directory (required)
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  checkProbe,
  callClassifyTier,
  callRunTests,
  isGarrisonControlEnabled,
  callTalkTo,
  callWaitFor,
  callListActiveSessions,
  callEndSession,
  callListWorkdirs,
  automationsAvailable,
  callListAutomations,
  callRunAutomation,
  callRecordImproverFeedback
} from "./lib/tools.mjs";

// ─────────────────────────────────────────── dynamic tool discovery
async function discoverTools() {
  const tools = [];
  const [tierOk, testingOk] = await Promise.all([
    checkProbe("tier-classifier", "classify_tier.mjs"),
    checkProbe("testing", "run_tests.mjs"),
  ]);
  if (tierOk) {
    tools.push({
      name: "classify_tier",
      description: "Classify a prompt into tier 1-7. Use before committing to a plan.",
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string", description: "The user prompt to classify." } },
        required: ["prompt"]
      }
    });
  }
  if (testingOk) {
    tools.push({
      name: "run_tests",
      description: "Run the project's native test command (npm/pytest/cargo/go).",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Absolute path to the project directory." },
          pattern: { type: "string", description: "Optional test filter/pattern." }
        },
        required: ["cwd"]
      }
    });
  }

  if (automationsAvailable()) {
    tools.push(
      {
        name: "list_automations",
        description: "List saved Garrison automations (id, name, step count, trigger). Use before run_automation.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "run_automation",
        description: "Run a saved automation by id and return its run status + per-step outcomes. Pass inputs for the automation's declared inputs.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The automation id (from list_automations)." },
            inputs: { type: "object", description: "Values for the automation's declared inputs." }
          },
          required: ["id"]
        }
      }
    );
  }

  // Improver Probe capture-fallback (GARRISON-FLOW-V2 S8, D26/E13). Always
  // available: it writes directly to ~/.garrison/improver/feedback-queue.jsonl, so
  // it does not depend on garrison-control (the http gateway). The PostToolUse
  // AskUserQuestion capture is the primary path; this tool is the belt for surfaces
  // that carry no PostToolUse hook.
  tools.push({
    name: "record_improver_feedback",
    description:
      "Record one Improver Probe answer as evidence (fallback capture path). Appends a single record to the Improver feedback queue. Only for relaying a probe answer the user gave — never fabricate answers.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "The Claude session id the probe was asked in." },
        area: { type: "string", description: "orchestrator | went-well (the probe area)." },
        question: { type: "string", description: "The exact question that was asked." },
        answer: { type: "string", description: "The option label the user selected (or their free-text 'Other')." }
      },
      required: ["area", "question", "answer"]
    }
  });

  if (isGarrisonControlEnabled()) {
    tools.push(
      {
        name: "talk_to",
        description: "Delegate work to a Soul sub-session. Defaults spawn mode from the current turn's origin (ui-tab -> interactive; channel -> headless). Pass project (or an explicit cwd) to run the session at that repo root on its current branch; pass tier_hint from classify_tier so the Gateway respawns with the right model when the tier changes.",
        inputSchema: {
          type: "object",
          properties: {
            soul: { type: "string", description: "engineer | architect | assistant | researcher | companion" },
            message: { type: "string", description: "What the Soul should do." },
            project: { type: "string", description: "Project label (e.g. 'agent-garrison') resolved to its repo root under the dev-root; the session runs there on the current branch." },
            mode: { type: "string", enum: ["headless", "interactive"], description: "Override the origin-derived default." },
            tier_hint: { type: "object", description: "Result of classify_tier — { model, effort, needs_testing, needs_agents_team }." },
            task_title: { type: "string", description: "Short human-readable summary for UI display." },
            channel: { type: "string", description: "Channel id (default 'main')." },
            cwd: { type: "string", description: "Absolute working-directory override (wins over project)." }
          },
          required: ["soul", "message"]
        }
      },
      {
        name: "wait_for",
        description: "Block until a sub-session's current turn completes. Times out (chunked) so you can call again on long work.",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            timeout_seconds: { type: "number", description: "Max wait (default 30, max 300)." }
          },
          required: ["session_id"]
        }
      },
      {
        name: "list_active_sessions",
        description: "Enumerate active Soul sub-sessions. Optional filters: parent, mode, soul.",
        inputSchema: {
          type: "object",
          properties: {
            parent: { type: "string" },
            mode: { type: "string" },
            soul: { type: "string" }
          }
        }
      },
      {
        name: "end_session",
        description: "Kill the active sub-session for a Soul (SIGTERM).",
        inputSchema: {
          type: "object",
          properties: { soul: { type: "string" } },
          required: ["soul"]
        }
      },
      {
        name: "list_workdirs",
        description: "List directories under a Soul's configured base_path. Use to pick a cwd before talk_to.",
        inputSchema: {
          type: "object",
          properties: { soul: { type: "string" } },
          required: ["soul"]
        }
      }
    );
  }

  return tools;
}

// ─────────────────────────────────────────── tool dispatcher
async function dispatchTool(name, input) {
  if (name === "classify_tier") return callClassifyTier(input);
  if (name === "run_tests") return callRunTests(input);
  if (name === "record_improver_feedback") return callRecordImproverFeedback(input);
  if (name === "list_automations") return callListAutomations(input);
  if (name === "run_automation") return callRunAutomation(input);
  if (name === "talk_to") return callTalkTo(input);
  if (name === "wait_for") return callWaitFor(input);
  if (name === "list_active_sessions") return callListActiveSessions(input);
  if (name === "end_session") return callEndSession(input);
  if (name === "list_workdirs") return callListWorkdirs(input);
  throw new Error(`unknown tool: ${name}`);
}

// ─────────────────────────────────────────── MCP server builder
async function buildServer(tools) {
  const server = new Server(
    { name: "garrison-mcp-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await dispatchTool(name, args ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true
      };
    }
  });

  return server;
}

// ─────────────────────────────────────────── subcommand: --probe
async function runProbe({ strict = false } = {}) {
  const [tierOk, testingOk] = await Promise.all([
    checkProbe("tier-classifier", "classify_tier.mjs"),
    checkProbe("testing", "run_tests.mjs"),
  ]);

  if (strict) {
    if (!tierOk || !testingOk) {
      const missing = [
        tierOk ? null : "classify_tier",
        testingOk ? null : "run_tests"
      ].filter(Boolean).join(", ");
      process.stderr.write(
        `mcp-gateway --probe --strict: missing underlying probe(s): ${missing}\n`
      );
      return 1;
    }
    process.stdout.write("ok (strict; classify_tier=ready, run_tests=ready)\n");
    return 0;
  }

  // Lenient default: succeed even if no tools are available yet — gateway
  // itself is healthy. See docs/DECISIONS.md (2026-05-16
  // "`mcp-gateway --probe` stays lenient by default; `--strict` opt-in").
  process.stdout.write(
    `ok (classify_tier=${tierOk ? "ready" : "absent"}, run_tests=${testingOk ? "ready" : "absent"})\n`
  );
  return 0;
}

// ─────────────────────────────────────────── subcommand: stdio
async function runStdio() {
  const tools = await discoverTools();
  const server = await buildServer(tools);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep process alive — stdio transport manages its own lifecycle
}

// ─────────────────────────────────────────── subcommand: http
async function runHttp(argv) {
  const flags = parseFlags(argv);
  const port = Number(flags.port ?? 9876);
  const token = flags.token ?? "";
  const host = flags.host ?? "0.0.0.0";

  if (!token) {
    process.stderr.write("mcp-gateway: --token is required for HTTP mode\n");
    return 1;
  }

  const tools = await discoverTools();
  const server = await buildServer(tools);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });

  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    // Bearer token auth
    const authHeader = req.headers["authorization"] ?? "";
    if (authHeader !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Health endpoint
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, tools: tools.map(t => t.name) }));
      return;
    }

    // Collect body for POST
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    try {
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  httpServer.listen(port, host, () => {
    process.stdout.write(
      JSON.stringify({ ts: new Date().toISOString(), status: "listening", host, port, tools: tools.map(t => t.name) }) + "\n"
    );
  });

  // Keep alive
  return new Promise(() => { /* never resolves — HTTP server runs until killed */ });
}

// ─────────────────────────────────────────── CLI
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}

async function main(argv) {
  const cmd = argv[0];

  if (cmd === "--probe") {
    const strict = argv.slice(1).includes("--strict");
    return runProbe({ strict });
  }
  if (cmd === "stdio") return runStdio();
  if (cmd === "http") return runHttp(argv.slice(1));

  process.stderr.write(`mcp-gateway: unknown command "${cmd}". Use: --probe [--strict] | stdio | http\n`);
  return 1;
}

main(process.argv.slice(2)).then((code) => {
  if (typeof code === "number") process.exit(code);
}).catch((err) => {
  process.stderr.write(`mcp-gateway: ${err.message}\n`);
  process.exit(1);
});
