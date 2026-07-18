#!/usr/bin/env node
// Own-port entry for coord-agentmail. Garrison's own-port lifecycle spawns this
// (`node scripts/start.mjs`) and tracks THIS process's pid via the status file.
//
// Responsibilities:
//   1. Supervise the arm's-length external agent_mail server
//      (`uv run python -m mcp_agent_mail.http`) from ~/.garrison/external — never
//      imported into this MIT tree.
//   2. Wait for it to be reachable, then write the status file
//      ~/.garrison/ui-fittings/coord-agentmail.json (port/url/mcpUrl/pid).
//   3. Register the http MCP server in ~/.claude.json (user scope) so direct +
//      orchestrator sessions reach it. (Unregistration is a DESELECT action,
//      handled by Garrison's coord teardown — not on plain stop.)
//   4. On SIGTERM/SIGINT: kill the child + remove the status file + exit.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const GARRISON_HOME =
  process.env.GARRISON_HOME && process.env.GARRISON_HOME.trim().length > 0
    ? process.env.GARRISON_HOME
    : path.join(HOME, ".garrison");
const EXT_DIR = path.join(GARRISON_HOME, "external", "mcp_agent_mail");
const STATUS_DIR = path.join(GARRISON_HOME, "ui-fittings");
const STATUS_FILE = path.join(STATUS_DIR, "coord-agentmail.json");
const PORT = Number(process.env.COORD_AGENTMAIL_PORT || process.env.COORD_AGENTMAIL_PORT_OVERRIDE || 28765);
const HOST = "127.0.0.1";

function log(msg) {
  console.log(`[coord-agentmail] ${msg}`);
}

if (!fs.existsSync(EXT_DIR)) {
  console.error(`[coord-agentmail] external clone missing at ${EXT_DIR} — run setup first`);
  process.exit(1);
}

// Spawn the external FastMCP server (arm's-length; uv manages its own venv).
// detached:true makes the child its own process-group leader so we can SIGTERM
// the WHOLE group (uv + its python child) — killing only `uv` would orphan python.
const child = spawn("uv", ["run", "python", "-m", "mcp_agent_mail.http", "--host", HOST, "--port", String(PORT), "--log-level", "warning"], {
  cwd: EXT_DIR,
  stdio: ["ignore", "inherit", "inherit"],
  detached: true,
  env: { ...process.env }
});

function waitChildExit(ms) {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) return resolve(true);
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, ms);
    child.once("exit", () => {
      if (!done) {
        done = true;
        clearTimeout(t);
        resolve(true);
      }
    });
  });
}

// Kill the child's whole process group (uv + python), tolerating either a
// detached group leader or a plain child.
function killTree(signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

// Single shared cleanup so SIGTERM + the child `exit` handler converge on ONE
// run; both await the same promise before exiting, so the status-file removal can
// never be truncated by a racing process.exit() (Codex CO2 #2). Status removal is
// synchronous so it always completes.
let cleanupPromise = null;
function cleanup() {
  if (!cleanupPromise) cleanupPromise = doCleanup();
  return cleanupPromise;
}
async function doCleanup() {
  try {
    if (child.pid && child.exitCode == null && child.signalCode == null) {
      killTree("SIGTERM");
      const exited = await waitChildExit(5000);
      if (!exited) {
        killTree("SIGKILL");
        await waitChildExit(2000);
      }
    }
  } catch {}
  try {
    fs.rmSync(STATUS_FILE, { force: true });
  } catch {}
}

process.on("SIGTERM", async () => {
  log("SIGTERM — stopping agent_mail server");
  await cleanup();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(0);
});
// If the child fails to spawn at all (e.g. uv missing), reap + exit.
child.on("error", async (err) => {
  console.error(`[coord-agentmail] failed to spawn agent_mail: ${err.message}`);
  await cleanup();
  process.exit(1);
});
child.on("exit", async (code) => {
  log(`agent_mail server exited (code ${code})`);
  await cleanup();
  process.exit(code ?? 0);
});

async function reachable() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/health`, { method: "GET" });
    return res.ok || res.status === 404; // any HTTP response = listening
  } catch {
    return false;
  }
}

async function main() {
  // Wait up to 30s for the server to listen.
  let up = false;
  for (let i = 0; i < 30; i++) {
    if (await reachable()) {
      up = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) {
    console.error("[coord-agentmail] server did not become reachable in 30s");
    await cleanup();
    process.exit(1);
  }

  await fsp.mkdir(STATUS_DIR, { recursive: true });
  await fsp.writeFile(
    STATUS_FILE,
    JSON.stringify(
      {
        fittingId: "coord-agentmail",
        port: PORT,
        url: `http://${HOST}:${PORT}`,
        mcpUrl: `http://${HOST}:${PORT}/mcp`,
        webUrl: `http://${HOST}:${PORT}/mail`,
        pid: process.pid,
        startedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
  log(`up on ${HOST}:${PORT} (MCP /mcp, UI /mail) — status ${STATUS_FILE}`);

  // Register the http MCP server (standing user-scope; removed on deselect).
  const reg = spawnSync(process.execPath, [path.join(__dirname, "register-mcp.mjs"), "add", String(PORT)], {
    stdio: "inherit",
    env: { ...process.env }
  });
  if (reg.status !== 0) {
    log("WARN: MCP registration failed (server still running) — see above");
  }
}

// Wrap main so a mkdir/write/register failure can never terminate the parent
// while leaving the spawned server orphaned (Codex CO2 #2).
main().catch(async (err) => {
  console.error(`[coord-agentmail] start failed: ${err.message}`);
  await cleanup();
  process.exit(1);
});
