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

// Parse a streamable-http MCP response body (plain JSON or SSE `data:` frames).
function parseMcpBody(text, contentType) {
  if (contentType && contentType.includes("text/event-stream")) {
    for (const line of text.split("\n").reverse()) {
      const m = line.match(/^data:\s*(.*)$/);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch {
          /* keep scanning up */
        }
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Fetch agent_mail's ACTIVE file reservations (leases) for a repo, repo-scoped,
// via the MCP resource `resource://file_reservations/{slug}` (the only programmatic
// read path — there is no REST endpoint). Folds the second coordination channel
// (leases) into the same awareness surface as intents. GRACEFUL: returns [] on ANY
// failure — server down, repo never used agent_mail ("project not found"), parse
// error — leases are advisory awareness, never an error path. Bounded by timeoutMs.
export async function fetchActiveLeases(repo, { timeoutMs = 2500 } = {}) {
  const rec = agentMailRecord();
  const base = rec && rec.mcpUrl ? rec.mcpUrl : null;
  if (!base) return [];
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const post = async (body) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      return parseMcpBody(await res.text(), res.headers.get("content-type"));
    } finally {
      clearTimeout(t);
    }
  };
  try {
    // Session-less streamable-http: initialize then read (proven against the live server).
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "coord-mcp", version: "0.1" } } });
    const slug = encodeURIComponent(repo);
    const r = await post({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: `resource://file_reservations/${slug}?active_only=true` } });
    if (!r || r.error) return []; // project-not-found / unknown resource -> no leases
    const text = r.result && r.result.contents && r.result.contents[0] && r.result.contents[0].text;
    if (!text) return [];
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
    return list
      .filter((l) => l && typeof l === "object" && !l.released_ts)
      .map((l) => ({
        id: l.id,
        agent: l.agent,
        pathPattern: l.path_pattern,
        exclusive: Boolean(l.exclusive),
        reason: l.reason || "",
        createdTs: l.created_ts,
        expiresTs: l.expires_ts,
        stale: Boolean(l.stale)
      }));
  } catch {
    return [];
  }
}
