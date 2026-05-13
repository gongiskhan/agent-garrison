#!/usr/bin/env node
/**
 * Garrison MCP gateway — exposes installed Faculties as MCP tools to
 * Claude Code sessions launched from the workbench.
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

import { checkProbe, callClassifyTier, callRunTests } from "./lib/tools.mjs";

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
      description: "Run the worktree project's native test command (npm/pytest/cargo/go).",
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
  return tools;
}

// ─────────────────────────────────────────── tool dispatcher
async function dispatchTool(name, input) {
  if (name === "classify_tier") return callClassifyTier(input);
  if (name === "run_tests") return callRunTests(input);
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
async function runProbe() {
  const [tierOk, testingOk] = await Promise.all([
    checkProbe("tier-classifier", "classify_tier.mjs"),
    checkProbe("testing", "run_tests.mjs"),
  ]);
  // Probe succeeds even if no tools are available yet — gateway itself is healthy.
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

  if (cmd === "--probe") return runProbe();
  if (cmd === "stdio") return runStdio();
  if (cmd === "http") return runHttp(argv.slice(1));

  process.stderr.write(`mcp-gateway: unknown command "${cmd}". Use: --probe | stdio | http\n`);
  return 1;
}

main(process.argv.slice(2)).then((code) => {
  if (typeof code === "number") process.exit(code);
}).catch((err) => {
  process.stderr.write(`mcp-gateway: ${err.message}\n`);
  process.exit(1);
});
