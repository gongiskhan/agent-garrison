import path from "node:path";
import { claudeHome } from "./claude-home";
import { readFileTolerant, writeJsonAtomic } from "./atomic-write";

// The writer-of-record for ~/.claude/mcp.json. Garrison owns this file outright
// (no APM ownership model for MCP servers yet — every server is "loose"), so the
// Quarters MCP surface can freely add / update / remove servers here.
//
// Two invariants:
//  1. WRAPPER SHAPE IS PRESERVED. The reader tolerates both `{ mcpServers: {…} }`
//     and a bare top-level `{ <name>: {…} }` map; we round-trip whichever shape
//     the file already uses (and any sibling keys under the wrapped form), so we
//     never reformat a user's file out from under them.
//  2. BOTH TRANSPORTS round-trip. stdio servers carry command/args/env; http/sse
//     servers carry url/headers (+ a `type` discriminator). Bespoke keys on a
//     server object survive by value.

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerConfig {
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http / sse transport
  type?: string; // "stdio" | "http" | "sse"
  url?: string;
  headers?: Record<string, string>;
  // bespoke keys survive untouched
  [key: string]: unknown;
}

export interface McpWriteResult {
  ok: boolean;
  name?: string;
  code?: "exists" | "not-found" | "invalid";
  error?: string;
}

function mcpPath(home: string): string {
  return path.join(home, "mcp.json");
}

interface McpFile {
  wrapped: boolean; // true => `{ mcpServers: {…} }`; false => bare top-level map
  raw: Record<string, unknown>; // the full parsed document (sibling keys live here when wrapped)
  servers: Record<string, McpServerConfig>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function readMcpFile(home: string): Promise<McpFile> {
  const res = await readFileTolerant(mcpPath(home));
  if (!res.exists) return { wrapped: true, raw: {}, servers: {} };
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = {};
  }
  if (!isObject(parsed)) return { wrapped: true, raw: {}, servers: {} };
  if (isObject(parsed.mcpServers)) {
    return { wrapped: true, raw: parsed, servers: parsed.mcpServers as Record<string, McpServerConfig> };
  }
  return { wrapped: false, raw: parsed, servers: parsed as Record<string, McpServerConfig> };
}

async function writeMcpFile(home: string, file: McpFile, servers: Record<string, McpServerConfig>): Promise<void> {
  const doc = file.wrapped ? { ...file.raw, mcpServers: servers } : servers;
  await writeJsonAtomic(mcpPath(home), doc);
}

// Normalise a form/API payload into a clean server config: keep only the fields
// that apply to the chosen transport, drop empties, and preserve bespoke keys.
export function normalizeServerConfig(input: McpServerConfig): McpServerConfig {
  const transport: McpTransport =
    input.type === "http" || input.type === "sse"
      ? input.type
      : input.url && !input.command
        ? "http"
        : "stdio";

  const out: McpServerConfig = {};
  // carry over bespoke keys first (anything we don't manage explicitly)
  for (const [k, v] of Object.entries(input)) {
    if (["command", "args", "env", "type", "url", "headers"].includes(k)) continue;
    out[k] = v;
  }

  if (transport === "stdio") {
    if (typeof input.command === "string" && input.command.trim()) out.command = input.command.trim();
    if (Array.isArray(input.args) && input.args.length) out.args = input.args.filter((a) => a !== "");
    if (input.env && Object.keys(input.env).length) out.env = input.env;
  } else {
    out.type = transport;
    if (typeof input.url === "string" && input.url.trim()) out.url = input.url.trim();
    if (input.headers && Object.keys(input.headers).length) out.headers = input.headers;
  }
  return out;
}

function validate(name: string, config: McpServerConfig): string | null {
  if (!name || !name.trim()) return "server name is required";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "server name may contain only letters, digits, dot, dash, underscore";
  const hasStdio = typeof config.command === "string" && config.command.trim().length > 0;
  const hasUrl = typeof config.url === "string" && config.url.trim().length > 0;
  if (!hasStdio && !hasUrl) return "an stdio server needs a command, an http/sse server needs a url";
  return null;
}

export async function listMcpServers(home: string = claudeHome()): Promise<Record<string, McpServerConfig>> {
  return (await readMcpFile(home)).servers;
}

export async function getMcpServer(name: string, home: string = claudeHome()): Promise<McpServerConfig | null> {
  const { servers } = await readMcpFile(home);
  return Object.prototype.hasOwnProperty.call(servers, name) ? servers[name] : null;
}

// Create a new server. Refuses to clobber an existing name (update is explicit).
export async function addMcpServer(
  name: string,
  config: McpServerConfig,
  home: string = claudeHome()
): Promise<McpWriteResult> {
  const clean = normalizeServerConfig(config);
  const err = validate(name, clean);
  if (err) return { ok: false, code: "invalid", error: err };
  const file = await readMcpFile(home);
  if (Object.prototype.hasOwnProperty.call(file.servers, name)) {
    return { ok: false, code: "exists", error: `an MCP server named "${name}" already exists` };
  }
  await writeMcpFile(home, file, { ...file.servers, [name]: clean });
  return { ok: true, name };
}

// Replace an existing server's config. Supports rename (newName differs from
// name) — the old key is dropped and the new one written, refusing a collision.
export async function updateMcpServer(
  name: string,
  config: McpServerConfig,
  home: string = claudeHome(),
  newName?: string
): Promise<McpWriteResult> {
  const target = (newName ?? name).trim();
  const clean = normalizeServerConfig(config);
  const err = validate(target, clean);
  if (err) return { ok: false, code: "invalid", error: err };
  const file = await readMcpFile(home);
  if (!Object.prototype.hasOwnProperty.call(file.servers, name)) {
    return { ok: false, code: "not-found", error: `no MCP server named "${name}"` };
  }
  if (target !== name && Object.prototype.hasOwnProperty.call(file.servers, target)) {
    return { ok: false, code: "exists", error: `an MCP server named "${target}" already exists` };
  }
  const next: Record<string, McpServerConfig> = {};
  for (const [k, v] of Object.entries(file.servers)) {
    if (k === name) next[target] = clean;
    else next[k] = v;
  }
  await writeMcpFile(home, file, next);
  return { ok: true, name: target };
}

export async function removeMcpServer(name: string, home: string = claudeHome()): Promise<McpWriteResult> {
  const file = await readMcpFile(home);
  if (!Object.prototype.hasOwnProperty.call(file.servers, name)) {
    return { ok: false, code: "not-found", error: `no MCP server named "${name}"` };
  }
  const next = { ...file.servers };
  delete next[name];
  await writeMcpFile(home, file, next);
  return { ok: true, name };
}
