import fs from "node:fs/promises";
import path from "node:path";
import { assertGarrisonHome, claudeHome, garrisonDir, globalCompositionDir, userClaudeHome } from "./claude-home";
import { ensureGarrisonHome } from "./garrison-home";
import { snapshotClaudeConfig } from "./config-backup";
import { apmInstall, ensureClaudeSymlink, readApmLock } from "./global-composition";
import { HomeQuarantine, readJsonObject, statOrNull } from "./home-quarantine";
import { selectedSharedSet, type SharedSet } from "./home-ownership";
import { quarantineOwnedFiles } from "./shared-apm";
import { reconcileShared, type SharedReconcileOptions } from "./shared-fittings";
import { checkHomeLeaks, quarantineHomeLeaks } from "./home-leaks";
import { writeJsonAtomic } from "./atomic-write";
import { stateClient, stateEnrolled } from "./state-client";
import { readNodeIdentity } from "./node-identity";
import type { Composition } from "./types";

export interface HomesState {
  version: 2;
  garrisonHome: string;
  migratedAt: string;
  userConfigBackupDir: string;
  notificationSent?: boolean;
  report: {
    quarantineDir: string;
    moved: number;
    leftModified: string[];
    hooksStripped: number;
    mcpRemoved: number;
    shared: SharedSet;
    leaks: number;
    inventory?: { at: string | null; compared: boolean; unresolved: string[] };
  };
}
export function homesStatePath(): string { return path.join(garrisonDir(), "homes.json"); }
export async function readHomesState(): Promise<HomesState | null> {
  const data = await readJsonObject<Partial<HomesState>>(homesStatePath());
  return data.version === 2 ? data as HomesState : null;
}
async function notifyMigration(state: HomesState) {
  if (!stateEnrolled()) return;
  const node = readNodeIdentity().name;
  const count = new Set(Object.values(state.report.shared).flat()).size;
  const title = `Two homes: Garrison now runs from its own Claude home on ${node}. ${state.report.moved} items moved out of your Claude Code into quarantine, ${count} fittings shared. Details in Mesh › ${node}.`;
  const client = stateClient();
  const notification = await client.createNotification({ kind: "system", body: { title, body: title, href: "/mesh" } });
  await client.putConfig(`improver.notice.${notification.id}`, "global", { id: notification.id, title, text: title, at: state.migratedAt, link: "/mesh", source: "homes-migration" }, { ifMatchRev: 0 });
}
let migrationQueue: Promise<unknown> = Promise.resolve();
export function reconcileHomes(composition: Composition, options: SharedReconcileOptions & { notify?: (state: HomesState) => Promise<void> } = {}): Promise<HomesState> {
  const run = migrationQueue.then(() => reconcileHomesLocked(composition, options));
  migrationQueue = run.catch(() => undefined);
  return run;
}
async function reconcileHomesLocked(composition: Composition, options: SharedReconcileOptions & { notify?: (state: HomesState) => Promise<void> }): Promise<HomesState> {
  assertGarrisonHome();
  const existing = await readHomesState();
  if (existing) {
    if (!existing.notificationSent) {
      await (options.notify ?? notifyMigration)(existing);
      existing.notificationSent = true;
      await writeJsonAtomic(homesStatePath(), existing, { mode: 0o600 });
    }
    return { ...existing, report: { ...existing.report, moved: 0, hooksStripped: 0, mcpRemoved: 0 } };
  }
  const log = options.log ?? (() => undefined);
  for (const runtime of ["claude", "codex", "gemini"] as const) await ensureGarrisonHome({ runtime, log });
  const inventoryFile = path.join(garrisonDir(), "homes-inventory.json");
  const inventory = await readJsonObject<{ at?: string }>(inventoryFile);
  const journalFile = path.join(garrisonDir(), "homes-migration.json");
  const journal = await readJsonObject<{ quarantineDir?: string; backupDir?: string }>(journalFile);
  const snapshot = journal.backupDir ? { dir: journal.backupDir } : await snapshotClaudeConfig("pre-two-homes");
  if (journal.quarantineDir && !path.resolve(journal.quarantineDir).startsWith(path.join(path.resolve(garrisonDir()), "quarantine") + path.sep)) throw new Error("Invalid migration quarantine path");
  const q = options.quarantine ?? await HomeQuarantine.open(journal.quarantineDir);
  await writeJsonAtomic(journalFile, { version: 1, quarantineDir: q.dir, backupDir: snapshot.dir }, { mode: 0o600 });
  const priorLockFile = path.join(globalCompositionDir(), "apm.lock.pre-two-homes.yaml");
  if (!await statOrNull(priorLockFile)) {
    const current = path.join(globalCompositionDir(), "apm.lock.yaml");
    if (await statOrNull(current)) await fs.copyFile(current, priorLockFile, fs.constants.COPYFILE_EXCL);
  }
  const priorLock = await readApmLock(priorLockFile);
  log("Two homes: preserved ownership lock and user config snapshot");
  await ensureClaudeSymlink();
  // This is the destructive-work barrier: no user-home cleanup happens until
  // APM has successfully deployed the prior global project into its new home.
  await apmInstall({ runApm: options.runApm });
  log("Two homes: Garrison home installation succeeded");
  const shared = options.shared ?? selectedSharedSet(composition.selections);
  const sharedFiles = new Set(priorLock.deps.filter(dep => shared["claude-code"].includes(dep.name)).flatMap(dep => dep.deployedFiles));
  const removable = priorLock.deps.filter(dep => !shared["claude-code"].includes(dep.name));
  await quarantineOwnedFiles(userClaudeHome(), { deps: removable, allDeployedFiles: new Set(removable.flatMap(dep => dep.deployedFiles)) }, sharedFiles, q);
  await quarantineHomeLeaks({ shared, quarantine: q, onlyKinds: ["hook", "mcp"] });
  if (!shared["claude-code"].includes("basic-memory") && await statOrNull(path.join(userClaudeHome(), "basic-memory"))) await q.move("claude-code", userClaudeHome(), "basic-memory");
  await reconcileShared(composition, { ...options, shared, previousGlobalLock: priorLock, quarantine: q });
  // The user lock now identifies shared legacy-named skills. Sweep remaining
  // legacy names after that lock exists so sharing cannot be mistaken for a leak.
  await quarantineHomeLeaks({ shared, quarantine: q });
  const leaks = await checkHomeLeaks({ shared });
  const state: HomesState = {
    version: 2, garrisonHome: claudeHome(), migratedAt: new Date().toISOString(), userConfigBackupDir: snapshot.dir,
    report: { quarantineDir: q.dir, moved: q.moved.length, leftModified: q.leftModified,
      hooksStripped: q.removed.filter(item => item.kind === "hook").length,
      mcpRemoved: q.removed.filter(item => item.kind === "mcp").length, shared, leaks: leaks.leaks.length,
      inventory: { at: inventory.at ?? null, compared: !!inventory.at, unresolved: leaks.leaks.map(leak => `${leak.runtime}:${leak.kind}:${leak.ref}`) } }
  };
  await writeJsonAtomic(homesStatePath(), state, { mode: 0o600 });
  await (options.notify ?? notifyMigration)(state);
  state.notificationSent = true;
  await writeJsonAtomic(homesStatePath(), state, { mode: 0o600 });
  log(`Two homes: ${state.report.moved} moved, ${state.report.leaks} leaks, ${state.report.leftModified.length} modified items retained`);
  return state;
}
