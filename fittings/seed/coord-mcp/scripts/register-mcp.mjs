#!/usr/bin/env node
// Register / unregister the coord-mcp STDIO MCP server in ~/.claude.json at USER
// scope, so a direct `claude` run in any repo and the orchestrator session both
// get the planning-gate tools. Guarded: a corrupt ~/.claude.json is NEVER
// clobbered. GARRISON_CLAUDE_JSON overrides the path (sandbox/testability).
//
//   node register-mcp.mjs add      # { command: "node", args: ["<abs server.mjs>"] }
//   node register-mcp.mjs remove
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "coord-mcp";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "server.mjs");
const HOME = os.homedir();

function claudeJsonPath() {
  const o = process.env.GARRISON_CLAUDE_JSON;
  return o && o.trim().length > 0 ? o : path.join(HOME, ".claude.json");
}
function parseObjOrNull(text) {
  const t = text.trim();
  if (t.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

// One-time durable snapshot of ~/.claude.json BEFORE first registration, under
// the standard ~/.garrison/snapshots/ convention (NOT /tmp). Idempotent.
function snapshotOnce(srcPath) {
  const gh = process.env.GARRISON_HOME && process.env.GARRISON_HOME.trim().length > 0 ? process.env.GARRISON_HOME : path.join(HOME, ".garrison");
  const dir = path.join(gh, "snapshots");
  const snap = path.join(dir, "claude-json.before-coord-mcp.json");
  try {
    if (fs.existsSync(srcPath) && !fs.existsSync(snap)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(srcPath, snap);
      console.log(`[coord-mcp] snapshot ${srcPath} → ${snap}`);
    }
  } catch {
    /* snapshot is best-effort; never block registration */
  }
}

async function main() {
  const mode = process.argv[2];
  const p = claudeJsonPath();
  let root = {};
  if (fs.existsSync(p)) {
    const parsed = parseObjOrNull(await fsp.readFile(p, "utf8"));
    if (parsed === null) {
      console.error(`[coord-mcp] refusing to write: ${p} is not valid JSON; leaving it untouched`);
      process.exit(1);
    }
    root = parsed;
  }
  if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) root.mcpServers = {};

  if (mode === "add") {
    snapshotOnce(p);
    root.mcpServers[NAME] = { command: process.execPath, args: [SERVER] };
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(root, null, 2));
    console.log(`[coord-mcp] registered stdio MCP ${NAME} → ${SERVER} in ${p}`);
  } else if (mode === "remove") {
    if (root.mcpServers[NAME]) {
      delete root.mcpServers[NAME];
      await fsp.writeFile(p, JSON.stringify(root, null, 2));
      console.log(`[coord-mcp] unregistered MCP ${NAME} from ${p}`);
    } else {
      console.log(`[coord-mcp] MCP ${NAME} not present in ${p}`);
    }
  } else {
    console.error("usage: register-mcp.mjs add | remove");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[coord-mcp] register-mcp failed:", err.message);
  process.exit(1);
});
