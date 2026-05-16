#!/usr/bin/env node
// Phase 9C smoke test: spawn claude with mcp-gateway in HTTP-forwarder mode
// and confirm the new 9 garrison-control tools appear in system/init.tools.
//
// We use a fake GARRISON_HTTP_GATEWAY_BASE_URL — no actual forwarding fires
// during a list-tools query, just discovery.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const COMPOSITION_DIR = "/Users/ggomes/Projects/agent-garrison/compositions/default";
const GATEWAY_SCRIPT = path.join(COMPOSITION_DIR, "apm_modules", "_local", "mcp-gateway", "scripts", "gateway.mjs");

const mcpConfig = {
  mcpServers: {
    garrison: {
      command: "node",
      args: [GATEWAY_SCRIPT, "stdio"],
      env: {
        GARRISON_COMPOSITION_DIR: COMPOSITION_DIR,
        GARRISON_HTTP_GATEWAY_BASE_URL: "http://127.0.0.1:65000"
      }
    }
  }
};
const mcpConfigPath = path.join(os.tmpdir(), `spike-c-mcp-${randomUUID()}.json`);
await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

const c = spawn("claude", [
  "--print", "--input-format", "stream-json", "--output-format", "stream-json",
  "--verbose", "--permission-mode", "bypassPermissions",
  "--mcp-config", mcpConfigPath, "--strict-mcp-config",
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
        toolsCaptured = (ev.tools ?? []).filter((t) => typeof t === "string" && t.toLowerCase().includes("garrison"));
      } else if (ev.type === "result") {
        resultReceived = true;
      }
    } catch { /* ignore */ }
  }
});
c.stderr.on("data", d => process.stderr.write(`[err] ${d}`));
c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "ok" } }) + "\n");

const tick = setInterval(async () => {
  if (resultReceived || (toolsCaptured && toolsCaptured.length > 0)) {
    clearInterval(tick);
    console.log(`Tools discovered (garrison-prefixed): ${toolsCaptured?.length ?? 0}`);
    for (const t of (toolsCaptured ?? [])) console.log(`  - ${t}`);
    const want = [
      "mcp__garrison__classify_tier", "mcp__garrison__run_tests",
      "mcp__garrison__talk_to", "mcp__garrison__wait_for",
      "mcp__garrison__list_active_sessions", "mcp__garrison__end_session",
      "mcp__garrison__list_workdirs", "mcp__garrison__list_worktrees",
      "mcp__garrison__create_worktree", "mcp__garrison__get_worktree",
      "mcp__garrison__close_worktree"
    ];
    const missing = want.filter(w => !toolsCaptured?.includes(w));
    if (missing.length === 0) console.log("\nSPIKE C RESULT: all 11 tools present.");
    else console.log(`\nSPIKE C RESULT: missing ${missing.length} tools — ${missing.join(", ")}`);
    c.kill();
    await fs.unlink(mcpConfigPath).catch(() => {});
    setTimeout(() => process.exit(0), 200);
  }
}, 500);

setTimeout(() => {
  if (!resultReceived) {
    console.log("timeout — killing");
    c.kill();
    process.exit(1);
  }
}, 30000);
