import fs from "node:fs/promises";
import path from "node:path";
import { scanClaudeFiles } from "./claude-scan";
import { userCompositionDir, capturedFittingsDir, userClaudeHome } from "./claude-home";
import { readApmLock } from "./global-composition";
import { readMcpServers, readSharedState, readUserProvenance, userRuntimeHome, userHookFile } from "./home-ownership";
import { confinedHomePath, ownerId, readJsonObject, statOrNull } from "./home-quarantine";
import { checkHomeLeaks, quarantineHomeLeaks, type HomeLeak } from "./home-leaks";
import { sharedRuntimes, type SharedRuntime } from "./types";
import { promote, type TransitionOpts } from "./state-transitions";
import { readYamlFile, writeYamlFile } from "./yaml";
import { resolveActiveComposition } from "./active-composition";
import { readComposition, writeComposition } from "./compositions";
import { reconcileSavedSharing } from "./shared-selection-sync";

export interface UserPrimitiveRow {
  id: string; kind: HomeLeak["kind"]; name: string; ref: string;
  sharedOwner?: string; leak?: HomeLeak; canPromote: boolean;
}
export interface UserQuartersState { runtime: SharedRuntime; rows: UserPrimitiveRow[]; checkedAt: string; }
export function parseUserRuntime(value: unknown): SharedRuntime {
  if (!sharedRuntimes.includes(value as SharedRuntime)) throw new Error("Unknown user runtime");
  return value as SharedRuntime;
}
export async function getUserQuartersState(runtime: SharedRuntime): Promise<UserQuartersState> {
  const home = userRuntimeHome(runtime);
  const [lock, ledger, state, report] = await Promise.all([readApmLock(path.join(userCompositionDir(), "apm.lock.yaml")), readUserProvenance(), readSharedState(), checkHomeLeaks()]);
  const shared = state.byRuntime[runtime];
  const rows: UserPrimitiveRow[] = [];
  const add = (kind: UserPrimitiveRow["kind"], ref: string, name: string, taggedOwner?: string) => {
    const dep = runtime === "claude-code" ? lock.deps.find(dep => shared.includes(dep.name) && dep.deployedFiles.some(file => file === ref || file.startsWith(ref + "/"))) : undefined;
    const entry = Object.values(ledger).find(entry => (entry.runtime ?? "claude-code") === runtime && entry.fittingId && shared.includes(ownerId(entry.fittingId)!) && (entry.ref === ref || (entry.kind !== "mcp" && entry.ref?.startsWith(ref + "/"))) && (kind === "mcp" ? entry.kind === "mcp" || entry.surface === "mcp" : entry.kind !== "mcp"));
    const sharedOwner = dep?.name ?? (entry ? ownerId(entry.fittingId) : undefined) ?? (taggedOwner && shared.includes(taggedOwner) ? taggedOwner : undefined);
    const leak = report.leaks.find(item => item.runtime === runtime && item.kind === kind && (item.ref === ref || item.ref.startsWith(ref + "/")));
    rows.push({ id: `${kind}:${ref}`, kind, ref, name, sharedOwner, leak, canPromote: runtime === "claude-code" && ["skill", "command", "rule"].includes(kind) && !sharedOwner && !leak });
  };
  for (const file of await scanClaudeFiles(home)) add(file.surface, file.relPath, file.name);
  for (const item of await fs.readdir(path.join(home, "agents"), { withFileTypes: true }).catch(() => [])) if (item.isFile()) add("agent", `agents/${item.name}`, item.name);
  const settingsFile = userHookFile(runtime);
  const settings = await readJsonObject<{ hooks?: Record<string, Array<{ _garrison?: unknown }>> }>(settingsFile);
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) if (Array.isArray(groups)) groups.forEach((group, index) => add("hook", `${event}#${index}`, event, ownerId(group?._garrison) ?? undefined));
  for (const name of Object.keys(await readMcpServers(runtime))) add("mcp", name, name);
  for (const leak of report.leaks.filter(item => item.runtime === runtime)) if (!rows.some(row => row.leak === leak || (row.kind === leak.kind && (row.ref === leak.ref || leak.ref.startsWith(row.ref + "/"))))) add(leak.kind, leak.ref, leak.name);
  return { runtime, rows: rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)), checkedAt: report.checkedAt };
}
export async function runUserQuartersAction(runtime: SharedRuntime, action: string, id: string, opts: TransitionOpts = {}) {
  const row = (await getUserQuartersState(runtime)).rows.find(item => item.id === id);
  if (!row) throw new Error("Primitive is no longer present; refresh Quarters");
  if (action === "quarantine") {
    if (!row.leak) throw new Error("Only a reported leak can be quarantined");
    return quarantineHomeLeaks({ only: row.leak });
  }
  if (action !== "promote") throw new Error("Your runtime config is read-only");
  if (!row.canPromote) throw new Error("This primitive cannot be promoted");
  // Resolve the server-read row, never a client-supplied filesystem path. A
  // symlinked primitive is left in place; importing it could capture another home.
  if (!/^[a-z][a-z0-9-]*$/.test(row.name)) throw new Error("Use a lowercase fitting name with letters, numbers and hyphens before promoting");
  const source = confinedHomePath(userClaudeHome(), row.ref);
  const checkSource = async (file: string): Promise<void> => {
    const st = await statOrNull(file);
    if (st?.isSymbolicLink()) throw new Error("A linked primitive must be promoted from its source project");
    if (st?.isDirectory()) for (const name of await fs.readdir(file)) await checkSource(path.join(file, name));
  };
  await checkSource(source);
  const result = await promote(`${row.kind}:${row.name}`, { ...opts, claudeHome: userClaudeHome() });
  if (!result.ok || !result.fittingId) throw new Error(`Promotion failed: ${result.code ?? "unknown"}`);
  const manifestPath = path.join(capturedFittingsDir(), result.fittingId, "apm.yml");
  const manifest = await readYamlFile<Record<string, unknown>>(manifestPath);
  if (!manifest) throw new Error("Promoted fitting manifest is missing");
  manifest["x-garrison"] ??= { faculty: "building", component_shape: "skill", cardinality_hint: "multi", platforms: ["all"], summary: `Promoted ${row.kind}: ${row.name}`, provides: [], consumes: [], shared_default: ["claude-code"], verify: { command: `test -f apm_modules/_local/${row.name}/.apm/${row.kind === "skill" ? `skills/${row.name}/SKILL.md` : row.kind === "command" ? `prompts/${row.name}.prompt.md` : `instructions/${row.name}.instructions.md`} && echo ok`, expect: "ok" }, ui: { views: [{ id: "main", placement: "faculty-tab", entry: "garrison:manage", route: "main" }] } };
  await writeYamlFile(manifestPath, manifest);
  const active = await resolveActiveComposition(); const composition = await readComposition(active.id);
  const selections = { ...composition.selections, building: [...(composition.selections.building ?? []).filter(item => item.id !== result.fittingId), { id: result.fittingId, config: {}, shared: ["claude-code" as const] }] };
  const next = await writeComposition(active.id, { name: composition.name, selections, globalConfig: composition.globalConfig });
  await reconcileSavedSharing(next);
  return result;
}
