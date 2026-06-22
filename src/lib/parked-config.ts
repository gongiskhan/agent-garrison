import path from "node:path";
import { parkedStoreDir } from "./claude-home";
import { writeJsonAtomic, readFileTolerant } from "./atomic-write";
import type { HookGroup } from "./claude-settings-file";
import type { McpServerConfig } from "./claude-json";

// Off-disk parked store for the CONFIG-ENTRY primitives (MCP servers + hook
// groups). Disabling such a primitive removes it from the live config file
// (~/.claude.json mcpServers / settings.json hooks) and records it here verbatim;
// primitive-state reads `active ∪ parked` so a disabled entry still surfaces as a
// `presence: "parked"` record — the disable→enable loop is round-trippable from
// the UI and the "M parked" count is real. Lives under ~/.garrison/parked/
// (honors GARRISON_HOME), beside the parked-skill fittings. File primitives
// (skills/commands/rules) keep using the existing promote/park fitting store.

export function parkedMcpPath(): string {
  return path.join(parkedStoreDir(), "mcp.json");
}
export function parkedHooksPath(): string {
  return path.join(parkedStoreDir(), "hooks.json");
}

export interface ParkedHookEntry {
  event: string;
  // The hook group verbatim — including any `_garrison` owner tag — so re-enable
  // restores it unchanged and a fitting uninstall can still find + purge it.
  group: HookGroup;
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  const { exists, text } = await readFileTolerant(file);
  if (!exists) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ---- MCP parked store: { "<serverName>": { ...config } } (mirrors mcpServers) ----
export async function readParkedMcp(): Promise<Record<string, McpServerConfig>> {
  const v = await readJsonFile<Record<string, McpServerConfig>>(parkedMcpPath(), {});
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
export async function writeParkedMcp(map: Record<string, McpServerConfig>): Promise<void> {
  await writeJsonAtomic(parkedMcpPath(), map);
}

// ---- Hook parked store: [ { event, group } ] (preserves the group verbatim) ----
export async function readParkedHooks(): Promise<ParkedHookEntry[]> {
  const v = await readJsonFile<ParkedHookEntry[]>(parkedHooksPath(), []);
  return Array.isArray(v) ? v.filter((e) => e && typeof e.event === "string" && e.group != null) : [];
}
export async function writeParkedHooks(entries: ParkedHookEntry[]): Promise<void> {
  await writeJsonAtomic(parkedHooksPath(), entries);
}
