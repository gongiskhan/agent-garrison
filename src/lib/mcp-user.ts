import { readClaudeJson, applyMcpDelta, applyMcpMutation } from "./claude-json";
import { normalizeServerConfig, type McpServerConfig, type McpWriteResult } from "./mcp-writer";
import { readParkedMcp, writeParkedMcp } from "./parked-config";

// User-scope MCP manager over the REAL ~/.claude.json (HV6). Add / update /
// remove + enable/disable(park). Every mutation goes through the guarded
// claude-json delta writer (compare-and-swap + retry + abort-untouched), so a
// concurrent Claude Code write is never silently clobbered. Disabled servers are
// parked in ~/.garrison/parked/mcp.json so they still surface (presence:"parked")
// and can be re-enabled. The legacy mcp-writer.ts stays only for the in-home
// ~/.claude/mcp.json (which Claude Code does not read); we reuse its PURE
// normalizeServerConfig here.

function validateName(name: string): string | null {
  if (!name || !name.trim()) return "server name is required";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "server name may contain only letters, digits, dot, dash, underscore";
  return null;
}
function validateConfig(config: McpServerConfig): string | null {
  const hasStdio = typeof config.command === "string" && config.command.trim().length > 0;
  const hasUrl = typeof config.url === "string" && config.url.trim().length > 0;
  if (!hasStdio && !hasUrl) return "an stdio server needs a command, an http/sse server needs a url";
  return null;
}
function raceResult(err: unknown): McpWriteResult {
  return { ok: false, code: "invalid", error: err instanceof Error ? err.message : String(err) };
}
function has(map: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, name);
}

export async function getUserMcpServer(name: string): Promise<McpServerConfig | null> {
  const { mcpServers } = await readClaudeJson();
  return has(mcpServers, name) ? (mcpServers[name] as McpServerConfig) : null;
}

export async function addUserMcpServer(name: string, config: McpServerConfig): Promise<McpWriteResult> {
  const clean = normalizeServerConfig(config);
  const err = validateName(name) ?? validateConfig(clean);
  if (err) return { ok: false, code: "invalid", error: err };
  const { mcpServers } = await readClaudeJson();
  if (has(mcpServers, name)) return { ok: false, code: "exists", error: `an MCP server named "${name}" already exists` };
  try {
    await applyMcpDelta({ op: "set", name, config: clean });
  } catch (e) {
    return raceResult(e);
  }
  return { ok: true, name };
}

export async function updateUserMcpServer(name: string, config: McpServerConfig, newName?: string): Promise<McpWriteResult> {
  const target = (newName ?? name).trim();
  const clean = normalizeServerConfig(config);
  const err = validateName(target) ?? validateConfig(clean);
  if (err) return { ok: false, code: "invalid", error: err };
  const { mcpServers } = await readClaudeJson();
  if (!has(mcpServers, name)) return { ok: false, code: "not-found", error: `no MCP server named "${name}"` };
  if (target !== name && has(mcpServers, target)) {
    return { ok: false, code: "exists", error: `an MCP server named "${target}" already exists` };
  }
  try {
    // Rename in ONE atomic write so it can't half-apply (delete old, then abort
    // before set) and lose the server.
    await applyMcpMutation((servers) => {
      if (target !== name) delete servers[name];
      servers[target] = clean;
    });
  } catch (e) {
    return raceResult(e);
  }
  return { ok: true, name: target };
}

export async function removeUserMcpServer(name: string): Promise<McpWriteResult> {
  const { mcpServers } = await readClaudeJson();
  if (!has(mcpServers, name)) return { ok: false, code: "not-found", error: `no MCP server named "${name}"` };
  try {
    await applyMcpDelta({ op: "remove", name });
  } catch (e) {
    return raceResult(e);
  }
  return { ok: true, name };
}

// ---- enable/disable = a real PARK move (HV6) ----
//
// Disable: park the config FIRST (so a crash can't lose it), then remove it from
// the live file via the guarded writer. If the guarded write aborts on a
// persistent race, roll the park entry back so we never leave a phantom parked
// duplicate of a still-active server (preserves the active-XOR-parked invariant).
export async function disableMcpServer(name: string): Promise<McpWriteResult> {
  const { mcpServers } = await readClaudeJson();
  if (!has(mcpServers, name)) return { ok: false, code: "not-found", error: `no active MCP server named "${name}"` };
  const snapshot = mcpServers[name] as McpServerConfig;
  // Park a snapshot FIRST so a crash can't lose the config (worst case: a
  // slightly stale parked copy — never data loss).
  const parked = await readParkedMcp();
  await writeParkedMcp({ ...parked, [name]: snapshot });
  let removed: McpServerConfig | undefined;
  try {
    await applyMcpMutation((servers) => {
      // Capture the FRESH config actually removed (covers a concurrent Claude
      // edit between our snapshot read and this guarded remove).
      removed = (servers[name] as McpServerConfig) ?? snapshot;
      delete servers[name];
    });
  } catch (e) {
    // Roll back the park so we never leave a phantom parked dup of a still-active
    // server (the active-XOR-parked invariant). The live file is untouched.
    const rollback = await readParkedMcp();
    delete rollback[name];
    await writeParkedMcp(rollback);
    return raceResult(e);
  }
  // Reconcile the parked copy to the fresh config that was actually removed.
  if (removed && JSON.stringify(removed) !== JSON.stringify(snapshot)) {
    const cur = await readParkedMcp();
    cur[name] = removed;
    await writeParkedMcp(cur);
  }
  return { ok: true, name };
}

// Enable: write the parked config back into the live file FIRST, then drop it
// from the parked store (so a crash can't lose it).
export async function enableMcpServer(name: string): Promise<McpWriteResult> {
  const parked = await readParkedMcp();
  if (!has(parked, name)) return { ok: false, code: "not-found", error: `no parked MCP server named "${name}"` };
  try {
    await applyMcpDelta({ op: "set", name, config: parked[name] });
  } catch (e) {
    return raceResult(e);
  }
  const remaining = await readParkedMcp();
  delete remaining[name];
  await writeParkedMcp(remaining);
  return { ok: true, name };
}
