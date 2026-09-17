import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { apmProject, userComposition, type ApmLockView } from "./global-composition";
import type { ApmDependencyInput } from "./apm-manifest";
import type { ApmRunner } from "./apm-exec";
import { readUserProvenance } from "./home-ownership";
import { userClaudeHome } from "./claude-home";
import { confinedHomePath, contentHash, fileHash, hashMatches, HomeQuarantine, isPreserved, preservedHomeItems, preserveModified, statOrNull } from "./home-quarantine";

/** Expand APM's directory entries to leaf hashes in an isolated install. */
async function deployedLeafHashes(home: string, lock: ApmLockView): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (ref: string): Promise<void> => {
    const file = confinedHomePath(home, ref);
    const st = await statOrNull(file);
    if (!st) return;
    if (st.isSymbolicLink()) throw new Error(`Shared primitive cannot deploy a symlink: ${ref}`);
    if (st.isDirectory()) for (const child of await fs.readdir(file)) await walk(`${ref}/${child}`);
    else if (st.isFile()) files.set(ref, contentHash(await fs.readFile(file)));
  };
  for (const ref of lock.allDeployedFiles) await walk(ref);
  return files;
}

export async function installSharedApm(dependencies: ApmDependencyInput[], options: { runApm?: ApmRunner; previousGlobalLock?: ApmLockView; quarantine: HomeQuarantine }): Promise<ApmLockView> {
  const project = userComposition();
  const previous = await project.readLock();
  // Setup hooks may select another shipped variant after APM deploys. Only a
  // ledger hash on a path already owned by this lock can supersede its hash.
  const ledger = await readUserProvenance();
  for (const dep of previous.deps) for (const [ref] of Object.entries(dep.deployedHashes)) {
    const owner = ledger[`file:claude-code:${ref}`];
    if (owner?.lastWrittenHash && owner.fittingId && (dep.name === owner.fittingId || dep.repoUrl?.endsWith(`/${owner.fittingId}`))) dep.deployedHashes[ref] = owner.lastWrittenHash;
  }
  const ownedHashes = Object.assign({}, ...[...previous.deps, ...(options.previousGlobalLock?.deps ?? [])].map(dep => dep.deployedHashes)) as Record<string, string>;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "garrison-shared-apm-"));
  try {
    const preview = apmProject({ dir: path.join(scratch, "project"), home: path.join(scratch, "home"), name: "garrison-shared-preview" });
    await preview.writeManifest(dependencies);
    const proposed = await preview.install({ runApm: options.runApm });
    const nextFiles = await deployedLeafHashes(preview.home, proposed);
    for (const [ref, expected] of nextFiles) {
      const target = confinedHomePath(userClaudeHome(), ref);
      const st = await statOrNull(target);
      if (!st) continue;
      const actual = await fileHash(userClaudeHome(), ref);
      if (hashMatches(actual, ownedHashes[ref]) && !isPreserved(await preservedHomeItems(), "claude-code", ref)) continue;
      // An identical pre-existing user file may coexist, but is never claimed
      // for later removal merely because an install encountered it.
      if (actual === expected) {
        if (!ownedHashes[ref]) await preserveModified("claude-code", userClaudeHome(), ref, "present before sharing; retained as user-owned");
        continue;
      }
      await options.quarantine.retain("claude-code", userClaudeHome(), ref);
      throw new Error(`Sharing would overwrite your modified or unowned file: ${ref}. Your file was left untouched.`);
    }
    // Check every existing descendant of an APM directory too. A force-copy
    // must never replace a directory containing additional user-authored files.
    for (const ref of proposed.allDeployedFiles) {
      const target = confinedHomePath(userClaudeHome(), ref);
      const st = await statOrNull(target);
      if (st?.isSymbolicLink()) throw new Error(`Sharing refuses a symlink in your config: ${ref}`);
    }
    await project.writeManifest(dependencies);
    // A zero-dependency APM run leaves the previous lock untouched in current
    // APM. Preserve it outside the active lock slot before regenerating, so
    // an empty shared set has honest empty ownership and no orphan pruning.
    const lockBytes = await fs.readFile(project.lockPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
    });
    if (lockBytes) {
      const saved = path.join(options.quarantine.dir, "user-composition", "apm.lock.yaml");
      await fs.mkdir(path.dirname(saved), { recursive: true, mode: 0o700 });
      await fs.rename(project.lockPath, saved);
    }
    let installed: ApmLockView;
    try { installed = await project.install({ runApm: options.runApm }); }
    catch (error) {
      if (lockBytes) await fs.writeFile(project.lockPath, lockBytes);
      throw error;
    }
    const currentFiles = await deployedLeafHashes(project.home, installed);
    // Cleanup only the previous lock's hash-owned leaves. Missing hashes and
    // edited content stay in place; directory entries are never rm -rf'd.
    await quarantineOwnedFiles(project.home, previous, new Set(currentFiles.keys()), options.quarantine);
    return installed;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/** Quarantine whole owned directories only when every leaf is hash-owned and
 * unchanged; otherwise preserve extra/edited leaves and move only known files. */
export async function quarantineOwnedFiles(home: string, previous: ApmLockView, keep: Set<string>, q: HomeQuarantine): Promise<void> {
  const hashes = Object.assign({}, ...previous.deps.map(dep => dep.deployedHashes)) as Record<string, string>;
  const roots = [...new Set([...previous.allDeployedFiles, ...Object.keys(hashes)])].sort((a, b) => a.length - b.length);
  const inspect = async (ref: string): Promise<boolean> => {
    const file = confinedHomePath(home, ref); const st = await statOrNull(file);
    if (!st) return true;
    if (st.isDirectory()) {
      let safe = true;
      for (const child of await fs.readdir(file)) if (!await inspect(`${ref}/${child}`)) safe = false;
      return safe;
    }
    if (keep.has(ref)) return false;
    if (hashMatches(await fileHash(home, ref), hashes[ref])) return true;
    await q.retain("claude-code", home, ref); return false;
  };
  for (const ref of roots) {
    if ([...keep].some(item => item === ref || item.startsWith(`${ref}/`))) continue;
    const st = await statOrNull(confinedHomePath(home, ref)); if (!st) continue;
    if (st.isDirectory()) { if (await inspect(ref)) await q.move("claude-code", home, ref); }
    else if (hashes[ref]) await q.move("claude-code", home, ref, hashes[ref]);
    else await q.retain("claude-code", home, ref);
  }
}
