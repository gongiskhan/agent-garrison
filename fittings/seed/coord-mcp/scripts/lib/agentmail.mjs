// Best-effort agent_mail liveness for the digest + observability. agent_mail's
// rich lease/message data is exposed to the agent directly via its MCP tools
// (http /mcp); coord-mcp only needs to know whether the shared server is UP (for
// the liveness layer + a digest note). All functions degrade to "down"/[] on any
// failure — coordination is advisory and must never error.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function garrisonHome() {
  const o = process.env.GARRISON_HOME;
  return o && o.trim().length > 0 ? o : path.join(os.homedir(), ".garrison");
}

export function agentMailStatusFile() {
  return path.join(garrisonHome(), "ui-fittings", "coord-agentmail.json");
}

// Read the own-port status file (written by coord-agentmail/start.mjs).
export function agentMailRecord() {
  try {
    const r = JSON.parse(fs.readFileSync(agentMailStatusFile(), "utf8"));
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

// Liveness ping with latency. Returns { up, url, mcpUrl, latencyMs } or { up:false }.
export async function agentMailLiveness(timeoutMs = 2000) {
  const rec = agentMailRecord();
  if (!rec || !rec.url) return { up: false, reason: "no-status-file" };
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${rec.url}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return { up: res.ok || res.status === 404, url: rec.url, mcpUrl: rec.mcpUrl, latencyMs: Date.now() - started };
  } catch {
    return { up: false, url: rec.url, mcpUrl: rec.mcpUrl, reason: "unreachable" };
  }
}
