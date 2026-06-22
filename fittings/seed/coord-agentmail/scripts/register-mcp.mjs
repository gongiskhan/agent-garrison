#!/usr/bin/env node
// Register / unregister the coord-agentmail http MCP server in ~/.claude.json at
// USER scope, so a direct `claude` run in any repo and the orchestrator session
// both reach the shared agent-mail server. Guarded: a corrupt ~/.claude.json is
// NEVER clobbered (abort + leave untouched).
//
//   node register-mcp.mjs add [port]      # add { type:"http", url:".../mcp" }
//   node register-mcp.mjs remove          # remove the entry
//
// GARRISON_CLAUDE_JSON overrides the path (sandbox/testability).

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const NAME = "coord-agentmail";
const HOME = os.homedir();

function claudeJsonPath() {
  const o = process.env.GARRISON_CLAUDE_JSON;
  if (o && o.trim().length > 0) return o;
  return path.join(HOME, ".claude.json");
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
// ~/.garrison/snapshots/ (NOT /tmp). Idempotent, best-effort.
function snapshotOnce(srcPath) {
  const gh = process.env.GARRISON_HOME && process.env.GARRISON_HOME.trim().length > 0 ? process.env.GARRISON_HOME : path.join(HOME, ".garrison");
  const dir = path.join(gh, "snapshots");
  const snap = path.join(dir, "claude-json.before-coord-agentmail.json");
  try {
    if (fs.existsSync(srcPath) && !fs.existsSync(snap)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(srcPath, snap);
      console.log(`[coord-agentmail] snapshot ${srcPath} → ${snap}`);
    }
  } catch {
    /* best-effort */
  }
}

async function main() {
  const mode = process.argv[2];
  const port = Number(process.argv[3] || process.env.COORD_AGENTMAIL_PORT || 8765);
  const p = claudeJsonPath();

  let root = {};
  if (fs.existsSync(p)) {
    const parsed = parseObjOrNull(await fsp.readFile(p, "utf8"));
    if (parsed === null) {
      console.error(`[coord-agentmail] refusing to write: ${p} is not valid JSON; leaving it untouched`);
      process.exit(1);
    }
    root = parsed;
  }
  if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) {
    root.mcpServers = {};
  }

  if (mode === "add") {
    snapshotOnce(p);
    root.mcpServers[NAME] = { type: "http", url: `http://127.0.0.1:${port}/mcp` };
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(root, null, 2));
    console.log(`[coord-agentmail] registered MCP ${NAME} → http://127.0.0.1:${port}/mcp in ${p}`);
  } else if (mode === "remove") {
    if (root.mcpServers[NAME]) {
      delete root.mcpServers[NAME];
      await fsp.writeFile(p, JSON.stringify(root, null, 2));
      console.log(`[coord-agentmail] unregistered MCP ${NAME} from ${p}`);
    } else {
      console.log(`[coord-agentmail] MCP ${NAME} not present in ${p}`);
    }
  } else {
    console.error("usage: register-mcp.mjs add [port] | remove");
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[coord-agentmail] register-mcp failed:", err.message);
  process.exit(1);
});
