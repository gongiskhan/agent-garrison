import fs from "node:fs/promises";
import path from "node:path";
import { userClaudeHome, userClaudeJsonPath, userCodexHome, userGeminiHome, userCompositionDir, userProvenanceLedgerPath, provenanceLedgerPath } from "./claude-home";
import { readLibrary } from "./library";
import { writeJsonAtomic } from "./atomic-write";
import { applyPortOffsetToConfig } from "./instance-profile";
import type { ApmRunner } from "./apm-exec";
import type { ApmLockView } from "./global-composition";
import { installSharedApm } from "./shared-apm";
import { HomeQuarantine, confinedHomePath, fileHash, hashMatches, ownerId, readJsonObject, statOrNull } from "./home-quarantine";
import { canonicalValue, readMcpServers, readSharedState, readUserProvenance, selectedSharedSet, quarantineMcp, userRuntimeHome, valueHash, type HomeProvenance, type SharedSet } from "./home-ownership";
import { sharedRuntimes, type Composition, type LibraryEntry, type SelectedFitting, type SharedRuntime } from "./types";

export interface SharedSetupResult { ok: boolean; stdout: string; stderr: string; exitCode: number | null; }
export type SharedSetup = (entry: LibraryEntry, compositionDir: string, config: Record<string, unknown>, env: Record<string, string>) => Promise<SharedSetupResult>;
export interface SharedReconcileOptions {
  runApm?: ApmRunner;
  runSetup?: SharedSetup;
  library?: LibraryEntry[];
  shared?: SharedSet;
  previousGlobalLock?: ApmLockView;
  quarantine?: HomeQuarantine;
  log?: (line: string) => void;
}
export function sharedFittingEnv(runtimes: SharedRuntime[]): Record<string, string> {
  return {
    GARRISON_CLAUDE_HOME: userClaudeHome(), GARRISON_CLAUDE_JSON: userClaudeJsonPath(),
    CLAUDE_CONFIG_DIR: userClaudeHome(), GARRISON_CLAUDE_SETTINGS_PATH: path.join(userClaudeHome(), "settings.json"),
    CLAUDE_SETTINGS_FILE: path.join(userClaudeHome(), "settings.json"),
    CODEX_HOME: userCodexHome(), GEMINI_CLI_HOME: userGeminiHome(),
    GARRISON_SHARE_TARGET: "user", GARRISON_SHARE_RUNTIMES: runtimes.join(","),
    GARRISON_USER_PROVENANCE: userProvenanceLedgerPath()
  };
}
async function userPrimitiveSnapshot(runtime: SharedRuntime): Promise<HomeProvenance> {
  const out: HomeProvenance = {};
  const home = userRuntimeHome(runtime);
  const walk = async (ref: string): Promise<void> => {
    const file = confinedHomePath(home, ref); const st = await statOrNull(file);
    if (!st || st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const name of await fs.readdir(file)) await walk(`${ref}/${name}`);
    else if (st.isFile()) out[`file:${runtime}:${ref}`] = { runtime, kind: "file", surface: ref.split("/")[0], ref, lastWrittenHash: (await fileHash(home, ref))! };
  };
  for (const category of ["skills", "commands", "agents", "rules", "hooks", "scripts", "basic-memory"]) await walk(category);
  for (const [name, value] of Object.entries(await readMcpServers(runtime))) out[`mcp:${runtime}:${name}`] = { runtime, kind: "mcp", surface: "mcp", ref: name, lastWrittenHash: valueHash(value) };
  return out;
}
async function removeSharedOwner(runtime: SharedRuntime, fittingId: string, ledger: HomeProvenance, q: HomeQuarantine) {
  for (const [key, entry] of Object.entries(ledger)) {
    if ((entry.runtime ?? "claude-code") !== runtime || ownerId(entry.fittingId) !== fittingId) continue;
    const ref = entry.ref ?? key.replace(/^mcp:/, "");
    if (entry.kind === "mcp" || entry.surface === "mcp") await quarantineMcp(q, runtime, ref, entry.lastWrittenHash);
    else if (entry.ref && entry.lastWrittenHash) await q.move(runtime, userRuntimeHome(runtime), entry.ref, entry.lastWrittenHash);
    // Removed or changed: Garrison relinquishes ownership either way. A user's
    // later edit must never remain eligible for a future uninstall sweep.
    delete ledger[key];
  }
  const file = path.join(userRuntimeHome(runtime), "settings.json");
  const config = await readJsonObject<{ hooks?: Record<string, Array<{ _garrison?: unknown }>> }>(file);
  const entries = Object.entries(config.hooks ?? {}).flatMap(([event, groups]) => Array.isArray(groups) ? groups.flatMap((value, index) => ownerId(value?._garrison) === fittingId ? [{ event, index, value }] : []) : []);
  if (entries.length) await q.editJson(file, entries.map(item => ({ runtime, kind: "hook", ref: `${item.event}#${item.index}`, source: file, value: item.value })), draft => {
    for (const item of entries) if (canonicalValue(draft.hooks?.[item.event]?.[item.index]) !== canonicalValue(item.value)) throw new Error("Hook config changed during unshare; retry");
    for (const event of new Set(entries.map(item => item.event))) draft.hooks[event] = draft.hooks[event].filter((group: { _garrison?: unknown }) => ownerId(group?._garrison) !== fittingId);
  });
}
let sharedQueue: Promise<unknown> = Promise.resolve();
export function reconcileShared(composition: Composition, options: SharedReconcileOptions = {}) {
  const run = sharedQueue.then(() => reconcileSharedLocked(composition, options));
  sharedQueue = run.catch(() => undefined);
  return run;
}
async function reconcileSharedLocked(composition: Composition, options: SharedReconcileOptions) {
  const q = options.quarantine ?? new HomeQuarantine();
  const log = options.log ?? (() => undefined);
  const shared = options.shared ?? selectedSharedSet(composition.selections);
  const previous = await readSharedState();
  const library = options.library ?? await readLibrary();
  const selected = new Map(Object.values(composition.selections).flatMap(items => items ?? []).map(item => [item.id, item]));
  const entryById = new Map(library.map(entry => [entry.id, entry]));
  const allIds = [...new Set(Object.values(shared).flat())];
  for (const id of allIds) if (!entryById.has(id) || !selected.has(id)) throw new Error(`Shared fitting is not equipped: ${id}`);
  const dependencies = shared["claude-code"].map(id => {
    const entry = entryById.get(id)!;
    return entry.localPath ? { absPath: path.resolve(entry.localPath) } : { repo: entry.repo };
  });
  const ledger = await readUserProvenance();
  // Existing shared registrations retain their old ownership during migration.
  for (const [key, entry] of Object.entries(await readJsonObject<HomeProvenance>(provenanceLedgerPath()))) {
    if (entry.fittingId && shared[entry.runtime ?? "claude-code"].includes(ownerId(entry.fittingId)!)) ledger[key] ??= entry;
  }
  await installSharedApm(dependencies, { runApm: options.runApm, previousGlobalLock: options.previousGlobalLock, quarantine: q });
  const setup = options.runSetup ?? (await import("./runner")).runFittingSetup;
  const removed = new Map<string, SharedRuntime[]>();
  for (const runtime of sharedRuntimes) for (const id of previous.byRuntime[runtime]) {
    if (!shared[runtime].includes(id)) {
      await removeSharedOwner(runtime, id, ledger, q);
      removed.set(id, [...(removed.get(id) ?? []), runtime]);
    }
  }
  for (const [id, runtimes] of removed) {
    const entry = entryById.get(id);
    if (!entry?.metadata.uninstall?.length) continue;
    const result = await setup({ ...entry, metadata: { ...entry.metadata, setup: entry.metadata.uninstall } }, composition.directory, selected.get(id)?.config ?? {}, { ...sharedFittingEnv(runtimes), GARRISON_SHARE_ACTION: "uninstall" });
    if (!result.ok) throw new Error(`Shared uninstall ${id} failed: ${result.stderr || result.stdout || result.exitCode}`);
  }
  // Save cleanup progress before a subsequent setup failure so a retry cannot
  // mistake a retained user's edit for a still-owned registration.
  await writeJsonAtomic(userProvenanceLedgerPath(), ledger, { mode: 0o600 });
  for (const id of allIds) {
    const runtimes = sharedRuntimes.filter(runtime => shared[runtime].includes(id));
    const before = Object.assign({}, ...await Promise.all(runtimes.map(userPrimitiveSnapshot))) as HomeProvenance;
    const entry = entryById.get(id)!;
    const config = applyPortOffsetToConfig(selected.get(id)!.config);
    const result = await setup(entry, composition.directory, config, sharedFittingEnv(runtimes));
    if (!result.ok) throw new Error(`Shared setup ${id} failed: ${result.stderr || result.stdout || result.exitCode}`);
    const after = Object.assign({}, ...await Promise.all(runtimes.map(userPrimitiveSnapshot))) as HomeProvenance;
    for (const [key, item] of Object.entries(after)) {
      if (!before[key] || (ledger[key]?.fittingId === id && !hashMatches(item.lastWrittenHash ?? null, before[key].lastWrittenHash))) ledger[key] = { ...item, fittingId: id };
    }
    await writeJsonAtomic(userProvenanceLedgerPath(), ledger, { mode: 0o600 });
    log(`Shared ${id}: ${runtimes.join(", ")}`);
  }
  const state = { version: 1, byRuntime: shared, at: new Date().toISOString() };
  await writeJsonAtomic(path.join(userCompositionDir(), "shared-state.json"), state, { mode: 0o600 });
  return { shared, quarantineDir: q.dir, moved: q.moved.length, leftModified: q.leftModified, hooksStripped: q.removed.filter(item => item.kind === "hook").length, mcpRemoved: q.removed.filter(item => item.kind === "mcp").length };
}
