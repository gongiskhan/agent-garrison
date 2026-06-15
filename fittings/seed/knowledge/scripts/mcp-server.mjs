#!/usr/bin/env node
// mcp-server.mjs — a minimal stdio MCP server for the Knowledge vault. Exposes a
// `recall` tool that searches the vault's markdown for a query. Newline-delimited
// JSON-RPC 2.0 over stdin/stdout (the MCP stdio transport). Intentionally small:
// the Knowledge faculty federates this alongside CodeGraph + Serena.
import { createInterface } from "node:readline";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.KNOWLEDGE_VAULT || path.join(HERE, "..", "vault");

function recall(query) {
  if (!existsSync(VAULT)) return [];
  const q = String(query || "").toLowerCase();
  const hits = [];
  for (const f of readdirSync(VAULT).filter((x) => x.endsWith(".md"))) {
    const content = readFileSync(path.join(VAULT, f), "utf8");
    for (const line of content.split("\n")) {
      if (q && line.toLowerCase().includes(q)) hits.push({ file: f, line: line.trim() });
    }
  }
  return hits.slice(0, 20);
}

const TOOLS = [
  {
    name: "recall",
    description: "Search the Knowledge vault (prescriptive conventions + harvested notes) for a query.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
  }
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "knowledge", version: "0.1.0" } } });
  }
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    if (name === "recall") {
      const hits = recall(args?.query);
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(hits) }] } });
    }
    return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } });
  }
  if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
}

function runStdioServer() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore malformed */
    }
  });
}

// Only act when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--probe")) {
    send({ ok: true, tools: TOOLS.map((t) => t.name) });
    process.exit(0);
  } else {
    runStdioServer();
  }
}

export { recall, TOOLS, handle };
