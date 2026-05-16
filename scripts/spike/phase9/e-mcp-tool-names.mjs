#!/usr/bin/env node
// Spike E — verify MCP tool name format for --disallowedTools
// Spawn claude with mcp-gateway as MCP server, inspect the system/init event
// to capture exact tool name shape (e.g., mcp__garrison__classify_tier).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const COMPOSITION_DIR = "/Users/ggomes/Projects/agent-garrison/compositions/default";
const GATEWAY_SCRIPT = path.join(COMPOSITION_DIR, "apm_modules", "_local", "mcp-gateway", "scripts", "gateway.mjs");

// Write a temporary .mcp.json pointing at mcp-gateway in stdio mode
const mcpConfig = {
  mcpServers: {
    garrison: {
      command: "node",
      args: [GATEWAY_SCRIPT, "stdio"],
      env: { GARRISON_COMPOSITION_DIR: COMPOSITION_DIR }
    }
  }
};
const mcpConfigPath = path.join(os.tmpdir(), `spike-e-mcp-${randomUUID()}.json`);
await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");
console.log(`mcp-config: ${mcpConfigPath}`);

const c = spawn("claude", [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--permission-mode", "bypassPermissions",
  "--mcp-config", mcpConfigPath,
  "--strict-mcp-config",
  "--model", "claude-haiku-4-5"
], { stdio: ["pipe", "pipe", "pipe"] });

let buf = "";
let toolsCaptured = null;
let resultReceived = false;

c.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "system" && ev.subtype === "init") {
        console.log(`[init] session=${ev.session_id} model=${ev.model}`);
        if (ev.tools) {
          toolsCaptured = ev.tools;
          // Filter to MCP tools (anything containing garrison)
          const mcpTools = ev.tools.filter(t => typeof t === "string" && t.toLowerCase().includes("garrison"));
          console.log(`[tools] ${ev.tools.length} total; MCP/garrison-related:`);
          for (const t of mcpTools) console.log(`  - ${t}`);
        }
        if (ev.mcp_servers) {
          console.log(`[mcp_servers] ${JSON.stringify(ev.mcp_servers)}`);
        }
      } else if (ev.type === "result") {
        resultReceived = true;
        console.log(`[result] ${JSON.stringify(ev.result ?? "")}`);
      }
    } catch { /* ignore */ }
  }
});

c.stderr.on("data", d => process.stderr.write(`[err] ${d}`));

// Send one quick turn so init fires
c.stdin.write(JSON.stringify({
  type: "user",
  message: { role: "user", content: "Reply only: ok" }
}) + "\n");

// Wait for result then exit
const start = Date.now();
const tick = setInterval(async () => {
  if (resultReceived || Date.now() - start > 30000) {
    clearInterval(tick);
    if (!toolsCaptured) {
      console.log("\n[no tools captured in init event — checking via tools/list separately…]");
    }
    c.kill();
    await fs.unlink(mcpConfigPath).catch(() => {});
    setTimeout(() => process.exit(0), 200);
  }
}, 500);
