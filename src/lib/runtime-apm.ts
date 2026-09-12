import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { claudeHome, garrisonDir, globalCompositionDir, assertGarrisonHome, capturedFittingsDir } from "./claude-home";
import { globalComposition, readGlobalLock, type ApmLockView } from "./global-composition";
import { readLibrary } from "./library";
import { ROOT_DIR } from "./paths";
import { confinedHomePath, fileHash, hashMatches, statOrNull, readJsonObject } from "./home-quarantine";
import { readYamlFile, writeYamlFile } from "./yaml";
import { writeJsonAtomic } from "./atomic-write";
import type { ApmDependencyInput } from "./apm-manifest";
import type { Composition, LibraryEntry } from "./types";

export interface PreparedRuntimeApm { previous: ApmLockView; compositionId: string; selectedIds: string[]; }
// The runner's composition project installs package code. This second project
// deploys those same packages' primitives into the managed runtime home.
export async function prepareRuntimeApm(composition: Composition, library: LibraryEntry[] | Promise<LibraryEntry[]> = readLibrary()): Promise<PreparedRuntimeApm> {
  assertGarrisonHome();
  const entries = await library;
  const previous = await readGlobalLock();
  const selectedIds = [...new Set(Object.values(composition.selections).flatMap(items => items ?? []).map(item => item.id))];
  const selected = selectedIds.map(id => { const entry = entries.find(item => item.id === id); if (!entry) throw new Error(`Unknown fitting: ${id}`); return entry; });
  const input = (entry: LibraryEntry): ApmDependencyInput => entry.localPath ? { absPath: path.resolve(ROOT_DIR, entry.localPath) } : { repo: entry.repo };
  // Quarters promotions already owned by the global project remain installed.
  // Equipped library fittings follow the composition, so deselection removes
  // their primitives on the next successful reconcile.
  const managed = await readJsonObject<{ fittingIds?: string[] }>(path.join(globalCompositionDir(), "active-fittings.json"));
  const retained = previous.deps.filter(dep => !selectedIds.includes(dep.name) && (!(managed.fittingIds ?? []).includes(dep.name) || !!dep.localPath?.startsWith(capturedFittingsDir() + path.sep)));
  for (const dep of retained) if (!dep.localPath && (!dep.repoUrl || dep.repoUrl.startsWith("_local/"))) throw new Error(`Cannot resolve previously owned fitting: ${dep.name}; its manifest was left unchanged`);
  const dependencies: ApmDependencyInput[] = retained.flatMap<ApmDependencyInput>(dep => dep.localPath ? [{ absPath: dep.localPath }] : dep.repoUrl && !dep.repoUrl.startsWith("_local/") ? [{ repo: dep.repoUrl }] : []);
  dependencies.push(...selected.map(input));
  await globalComposition().writeManifest(dependencies);
  return { previous, compositionId: composition.id, selectedIds };
}
export async function completeRuntimeApm(prepared: PreparedRuntimeApm, log: (line: string) => void = () => undefined): Promise<void> {
  const manifest = await readYamlFile<{ dependencies?: { apm?: unknown[] } }>(globalComposition().manifestPath);
  // APM leaves an old lock in place when the final dependency is removed.
  // Normalise that generated ownership record only after install succeeded.
  if (manifest?.dependencies?.apm?.length === 0) await writeYamlFile(globalComposition().lockPath, { dependencies: [] });
  const next = await readGlobalLock();
  const home = claudeHome();
  const quarantined: string[] = [], modified: string[] = [];
  const destination = path.join(garrisonDir(), "quarantine", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`, "garrison-home");
  for (const dep of prepared.previous.deps) for (const ref of dep.deployedFiles) {
    if (next.allDeployedFiles.has(ref)) continue;
    const source = confinedHomePath(home, ref); const st = await statOrNull(source);
    // Leaf files only. An undeclared child in an old package directory stays.
    if (!st?.isFile() || st.isSymbolicLink()) continue;
    if (!hashMatches(await fileHash(home, ref), dep.deployedHashes[ref])) { modified.push(ref); continue; }
    const target = path.join(destination, ref);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target); quarantined.push(ref);
  }
  await writeJsonAtomic(path.join(globalCompositionDir(), "active-fittings.json"), { version: 1, composition: prepared.compositionId, fittingIds: prepared.selectedIds, at: new Date().toISOString(), quarantined, leftModified: modified }, { mode: 0o600 });
  if (quarantined.length || modified.length) log(`Garrison home: ${quarantined.length} obsolete primitive files quarantined, ${modified.length} modified files retained`);
}

/** A matching composition fingerprint cannot prove a removed home still exists. */
export async function runtimeApmReady(compositionId: string): Promise<boolean> {
  const state = await readJsonObject<{ composition?: string }>(path.join(globalCompositionDir(), "active-fittings.json"));
  if (state.composition !== compositionId) return false;
  try {
    if (await fs.realpath(globalComposition().link) !== await fs.realpath(claudeHome())) return false;
    const lock = await readGlobalLock();
    for (const ref of lock.allDeployedFiles) if (!await statOrNull(confinedHomePath(claudeHome(), ref))) return false;
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
