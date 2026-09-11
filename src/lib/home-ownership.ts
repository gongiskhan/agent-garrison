import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { userClaudeHome, userClaudeJsonPath, userCodexHome, userGeminiHome, userCompositionDir, userProvenanceLedgerPath } from "./claude-home";
import { contentHash, HomeQuarantine, readJsonObject } from "./home-quarantine";
import { writeFileAtomic } from "./atomic-write";
import { sharedRuntimes, type FittingSelectionMap, type SharedRuntime } from "./types";

export type SharedSet = Record<SharedRuntime, string[]>;
export interface SharedState { version: 1; byRuntime: SharedSet; at: string; }
export function emptySharedSet(): SharedSet { return { "claude-code": [], codex: [], gemini: [] }; }
export function selectedSharedSet(selections: FittingSelectionMap): SharedSet {
  const result = emptySharedSet();
  for (const selection of Object.values(selections).flat()) {
    if (!selection) continue;
    for (const runtime of selection.shared ?? []) {
      if (!sharedRuntimes.includes(runtime)) throw new Error(`Unknown shared runtime: ${runtime}`);
      if (!result[runtime].includes(selection.id)) result[runtime].push(selection.id);
    }
  }
  return result;
}
export async function readSharedState(): Promise<SharedState> {
  const data = await readJsonObject<Partial<SharedState>>(path.join(userCompositionDir(), "shared-state.json"));
  return { version: 1, byRuntime: { ...emptySharedSet(), ...data.byRuntime }, at: data.at ?? "" };
}
export function userRuntimeHome(runtime: SharedRuntime): string {
  return runtime === "claude-code" ? userClaudeHome() : runtime === "codex" ? userCodexHome() : userGeminiHome();
}
export function userMcpFile(runtime: SharedRuntime): string {
  return runtime === "claude-code" ? userClaudeJsonPath() : path.join(userRuntimeHome(runtime), runtime === "codex" ? "config.toml" : "settings.json");
}
export function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalValue(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function valueHash(value: unknown): string { return contentHash(canonicalValue(value)); }
export interface HomeProvenanceEntry {
  runtime?: SharedRuntime;
  surface?: string;
  kind?: "file" | "mcp" | "hook" | "rule";
  ref?: string;
  fittingId?: string;
  lastWrittenHash?: string;
}
export type HomeProvenance = Record<string, HomeProvenanceEntry>;
export async function readUserProvenance(): Promise<HomeProvenance> { return readJsonObject(userProvenanceLedgerPath()); }
export async function readMcpServers(runtime: SharedRuntime): Promise<Record<string, unknown>> {
  const file = userMcpFile(runtime);
  if (runtime !== "codex") return (await readJsonObject<{ mcpServers?: Record<string, unknown> }>(file)).mcpServers ?? {};
  let bytes: string;
  try { bytes = await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  return (parseToml(bytes).mcp_servers ?? {}) as Record<string, unknown>;
}

/** Remove one native registration while preserving every unrelated TOML byte. */
export function withoutTomlMcp(bytes: string, name: string): { bytes: string; removed: string } {
  const original = parseToml(bytes);
  const expected = structuredClone(original);
  const servers = expected.mcp_servers as Record<string, unknown> | undefined;
  if (!servers || !(name in servers)) return { bytes, removed: "" };
  delete servers[name];
  const lines = bytes.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let removing = false; let removed = ""; let kept = "";
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      try {
        const probe = parseToml(`${line.trim()}\n__garrison_section_probe__ = true\n`);
        const block = probe.mcp_servers as Record<string, unknown> | undefined;
        removing = !!block && Object.prototype.hasOwnProperty.call(block, name);
      } catch { /* A multiline-string body is not a TOML table header. */ }
    }
    if (removing) removed += line; else kept += line;
  }
  // Empty table syntax need not remain, but every unrelated value must.
  const normalize = (value: Record<string, unknown>) => {
    const mcp = value.mcp_servers as Record<string, unknown> | undefined;
    if (mcp && Object.keys(mcp).length === 0) delete value.mcp_servers;
    return value;
  };
  if (!removed || canonicalValue(normalize(parseToml(kept))) !== canonicalValue(normalize(expected))) {
    throw new Error(`Cannot safely remove MCP ${name} from this TOML layout; config was left untouched`);
  }
  return { bytes: kept, removed };
}
export async function quarantineMcp(q: HomeQuarantine, runtime: SharedRuntime, name: string, expectedHash?: string): Promise<boolean> {
  const file = userMcpFile(runtime);
  const servers = await readMcpServers(runtime);
  if (!(name in servers)) return false;
  if (expectedHash && ![valueHash(servers[name]), contentHash(JSON.stringify(servers[name]))].includes(expectedHash.replace(/^sha256:/, ""))) {
    q.leftModified.push(`mcp:${runtime}:${name}`);
    return false;
  }
  const entry = { runtime, kind: "mcp" as const, ref: name, source: file, value: servers[name] };
  if (runtime === "codex") {
    const before = await fs.readFile(file, "utf8");
    const next = withoutTomlMcp(before, name);
    await q.record({ ...entry, value: { registration: servers[name], toml: next.removed } });
    await writeFileAtomic(file, next.bytes, { cas: { priorContent: before } });
  } else {
    await q.editJson(file, [entry], draft => { if (canonicalValue(draft.mcpServers?.[name]) !== canonicalValue(servers[name])) throw new Error("MCP config changed during quarantine; retry"); delete draft.mcpServers[name]; });
  }
  return true;
}
