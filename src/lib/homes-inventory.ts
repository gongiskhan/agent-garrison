import fs from "node:fs/promises";
import path from "node:path";
import { garrisonDir, provenanceLedgerPath, userProvenanceLedgerPath } from "./claude-home";
import { readGlobalLock, readApmLock } from "./global-composition";
import { userCompositionDir } from "./claude-home";
import { readNodeIdentity } from "./node-identity";
import { sharedRuntimes, type SharedRuntime } from "./types";
import { contentHash, confinedHomePath, ownerId, readJsonObject, statOrNull, preservedHomeItems, isPreserved } from "./home-quarantine";
import { hookOwner, hookValueHash, readMcpServers, userRuntimeHome, userHookFile, valueHash, type HomeProvenance, type SharedSet } from "./home-ownership";
import { writeJsonAtomic } from "./atomic-write";
import { isLegacyHomeHook, type HomeLeak } from "./home-leaks";

export interface InventoryItem {
  runtime: SharedRuntime; kind: HomeLeak["kind"]; ref: string; name: string;
  owner: string | null; hash: string | null;
}
export interface HomesInventory { version: 1; at: string; node: string; homes: Record<SharedRuntime, string>; items: InventoryItem[]; }
export const homesInventoryPath = () => path.join(garrisonDir(), "homes-inventory.json");
async function treeHash(home: string, ref: string): Promise<string | null> {
  const file = confinedHomePath(home, ref); const st = await statOrNull(file);
  if (!st) return null;
  if (st.isSymbolicLink()) return contentHash(`link:${await fs.readlink(file)}`);
  if (st.isFile()) return contentHash(await fs.readFile(file));
  if (!st.isDirectory()) return null;
  const entries = await Promise.all((await fs.readdir(file)).sort().map(async name => [name, await treeHash(home, `${ref}/${name}`)]));
  return valueHash(entries);
}
function kindFor(ref: string): HomeLeak["kind"] { return ({ skills: "skill", commands: "command", agents: "agent", rules: "rule" } as const)[ref.split("/")[0] as "skills"] ?? "file"; }
async function hooks(runtime: SharedRuntime) {
  const config = await readJsonObject<{ hooks?: Record<string, unknown[]> }>(userHookFile(runtime));
  return Object.entries(config.hooks ?? {}).flatMap(([event, groups]) => Array.isArray(groups) ? groups.map((group, index) => ({ event, index, group })) : []);
}
export async function captureHomesInventory({ write = true }: { write?: boolean } = {}): Promise<HomesInventory> {
  const items = new Map<string, InventoryItem>();
  const put = (item: InventoryItem) => { const key = `${item.runtime}:${item.kind}:${item.ref}`; const prior = items.get(key); items.set(key, { ...item, owner: item.owner ?? prior?.owner ?? null }); };
  const lock = await readGlobalLock();
  for (const dep of lock.deps) for (const ref of dep.deployedFiles) {
    const hash = await treeHash(userRuntimeHome("claude-code"), ref);
    if (hash) put({ runtime: "claude-code", kind: kindFor(ref), ref, name: path.basename(ref), owner: dep.name, hash });
  }
  const ledger = { ...await readJsonObject<HomeProvenance>(provenanceLedgerPath()), ...await readJsonObject<HomeProvenance>(userProvenanceLedgerPath()) };
  for (const runtime of sharedRuntimes) {
    const home = userRuntimeHome(runtime);
    for (const category of ["skills", "commands", "agents"]) {
      for (const item of await fs.readdir(path.join(home, category), { withFileTypes: true }).catch(() => [])) {
        if (!/^(garrison|autothing)/i.test(item.name)) continue;
        const ref = `${category}/${item.name}`;
        put({ runtime, kind: kindFor(ref), ref, name: item.name, owner: null, hash: await treeHash(home, ref) });
      }
    }
    for (const { event, index, group } of await hooks(runtime)) {
      const owner = hookOwner(runtime, event, group, ledger);
      const legacy = (group as { hooks?: Array<{ command?: string }> })?.hooks?.some(hook => isLegacyHomeHook(hook.command ?? ""));
      if (owner || legacy) put({ runtime, kind: "hook", ref: `${event}#${index}`, name: event, owner, hash: hookValueHash(group) });
    }
    const servers = await readMcpServers(runtime);
    for (const [key, entry] of Object.entries(ledger)) {
      if ((entry.runtime ?? "claude-code") !== runtime || !entry.fittingId || entry.kind === "hook") continue;
      const mcp = entry.kind === "mcp" || entry.surface === "mcp";
      const ref = entry.ref ?? key.replace(/^mcp:/, "");
      const hash = mcp ? ref in servers ? valueHash(servers[ref]) : null : await treeHash(home, ref);
      if (hash) put({ runtime, kind: mcp ? "mcp" : kindFor(ref), ref, name: path.basename(ref), owner: ownerId(entry.fittingId), hash });
    }
  }
  if (await statOrNull(path.join(userRuntimeHome("claude-code"), "basic-memory"))) put({ runtime: "claude-code", kind: "file", ref: "basic-memory", name: "basic-memory", owner: "basic-memory", hash: await treeHash(userRuntimeHome("claude-code"), "basic-memory") });
  const inventory: HomesInventory = { version: 1, at: new Date().toISOString(), node: readNodeIdentity().id, homes: Object.fromEntries(sharedRuntimes.map(runtime => [runtime, userRuntimeHome(runtime)])) as HomesInventory["homes"], items: [...items.values()].sort((a, b) => `${a.runtime}:${a.ref}`.localeCompare(`${b.runtime}:${b.ref}`)) };
  if (write) await writeJsonAtomic(homesInventoryPath(), inventory, { mode: 0o600 });
  return inventory;
}
export async function compareHomesInventory(inventory: Partial<HomesInventory>, shared: SharedSet) {
  const removed: string[] = [], retainedShared: string[] = [], leftModified: string[] = [], unresolved: string[] = [];
  const preserved = await preservedHomeItems();
  const userLock = await readApmLock(path.join(userCompositionDir(), "apm.lock.yaml"));
  for (const item of inventory.items ?? []) {
    const key = `${item.runtime}:${item.kind}:${item.ref}`;
    let hash: string | null;
    if (item.kind === "hook") hash = (await hooks(item.runtime)).some(row => hookValueHash(row.group) === item.hash) ? item.hash : null;
    else if (item.kind === "mcp") { const servers = await readMcpServers(item.runtime); hash = item.ref in servers ? valueHash(servers[item.ref]) : null; }
    else hash = await treeHash(userRuntimeHome(item.runtime), item.ref);
    const sharedOwner = item.owner && shared[item.runtime].includes(item.owner) || item.runtime === "claude-code" && userLock.deps.some(dep => shared["claude-code"].includes(dep.name) && dep.deployedFiles.some(ref => ref === item.ref || ref.startsWith(item.ref + "/")));
    if (!hash) removed.push(key);
    else if (sharedOwner) retainedShared.push(key);
    else if (hash !== item.hash || isPreserved(preserved, item.runtime, item.ref)) leftModified.push(key);
    else unresolved.push(key);
  }
  return { at: inventory.at ?? null, compared: !!inventory.at, expected: inventory.items?.length ?? 0, removed, retainedShared, leftModified, unresolved };
}
