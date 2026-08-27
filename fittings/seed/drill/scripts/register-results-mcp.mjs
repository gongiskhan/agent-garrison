#!/usr/bin/env node
// Register / unregister the drill-results STDIO MCP server at USER scope, so a
// direct `claude` run in any repo and the orchestrator session both get the
// results-reporting tools without any per-project setup.
//
// The registering INSTANCE's app URL is baked into the server entry's env:
// each profile writes its own Claude config file (the launcher exports
// GARRISON_CLAUDE_JSON per profile - prod ~/.claude.json, dev
// ~/.claude-garrison-dev/.claude.json), so dev's registration points at dev's
// app and prod's at prod's. Never hardcode the port: it arrives as
// GARRISON_APP_URL from the runner's setup-hook env.
//
// Guarded: a corrupt Claude config is NEVER clobbered.
//
//   node register-results-mcp.mjs add
//   node register-results-mcp.mjs remove
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "drill-results";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "results-mcp.mjs");
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

// One-time durable snapshot before the first registration, under the standard
// ~/.garrison/snapshots convention (NOT /tmp). Idempotent.
function snapshotOnce(srcPath) {
  const gh = process.env.GARRISON_HOME?.trim() ? process.env.GARRISON_HOME : path.join(HOME, ".garrison");
  const snap = path.join(gh, "snapshots", "claude-json.before-drill-results.json");
  try {
    if (fs.existsSync(srcPath) && !fs.existsSync(snap)) {
      fs.mkdirSync(path.dirname(snap), { recursive: true });
      fs.copyFileSync(srcPath, snap);
      console.log(`[drill-results] snapshot ${srcPath} -> ${snap}`);
    }
  } catch {
    /* snapshot is best-effort; never block registration */
  }
}

export function serverEntry(env = process.env, execPath = process.execPath, server = SERVER) {
  const api = (env.GARRISON_APP_URL || env.GARRISON_BASE_URL || "").trim().replace(/\/+$/, "");
  return {
    command: execPath,
    args: [server],
    // No app URL in the env (a hand-run setup outside the runner) means the
    // server falls back to its own resolution rather than being pinned to a
    // wrong instance by an empty string.
    ...(api ? { env: { GARRISON_RESULTS_API: api } } : {})
  };
}

async function main() {
  const mode = process.argv[2];
  const p = claudeJsonPath();
  let root = {};
  if (fs.existsSync(p)) {
    const parsed = parseObjOrNull(await fsp.readFile(p, "utf8"));
    if (parsed === null) {
      console.error(`[drill-results] refusing to write: ${p} is not valid JSON; leaving it untouched`);
      process.exit(1);
    }
    root = parsed;
  }
  if (!root.mcpServers || typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers)) root.mcpServers = {};

  if (mode === "add") {
    snapshotOnce(p);
    root.mcpServers[NAME] = serverEntry();
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, JSON.stringify(root, null, 2));
    console.log(`[drill-results] registered stdio MCP ${NAME} -> ${SERVER} in ${p}`);
    console.log("[drill-results] a session started BEFORE now must restart (claude --resume) to see the tools, or report over HTTP with curl");
  } else if (mode === "remove") {
    if (root.mcpServers[NAME]) {
      delete root.mcpServers[NAME];
      await fsp.writeFile(p, JSON.stringify(root, null, 2));
      console.log(`[drill-results] unregistered MCP ${NAME} from ${p}`);
    } else {
      console.log(`[drill-results] MCP ${NAME} not present in ${p}`);
    }
  } else {
    console.error("usage: register-results-mcp.mjs add | remove");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[drill-results] register failed:", err.message);
    process.exit(1);
  });
}

export { NAME, SERVER };
