import fsp from "node:fs/promises";
import path from "node:path";
import { claudeHome, capturedFittingsDir, parkedStoreDir } from "./claude-home";
import { pathExists } from "./fs-utils";
import {
  writeGlobalApmManifest,
  apmInstall,
  readGlobalLock,
  type ApmLockDepView
} from "./global-composition";
import { computeStateModel } from "./primitive-state";
import { emitFitting, primitiveHash } from "./reconcile";
import { recordWritten, parkEntry, unparkEntry, reattributeEntry } from "./provenance";
import type { ApmRunner } from "./apm-exec";
import type { ApmDependencyInput } from "./apm-manifest";

// State transitions over the global composition. APM is the single writer for the
// package files; Garrison owns the parts APM won't do (orphan cleanup on park).
//
//   promote: loose -> owned  (package + add dep + apm install)
//   park:    owned -> parked (drop dep + apm install + Garrison cleans orphans)
//   unpark:  parked -> owned | loose

export interface TransitionOpts {
  runApm?: ApmRunner;
  claudeHome?: string;
}

export interface TransitionResult {
  ok: boolean;
  fittingId?: string;
  deployed: string[]; // files apm deployed (promote / unpark-owned)
  cleanedOrphans: string[]; // files Garrison removed (park)
  code?: "not-found" | "collision" | "already";
}

function depToInput(dep: ApmLockDepView): ApmDependencyInput | null {
  return dep.localPath ? { absPath: dep.localPath } : dep.repoUrl ? { repo: dep.repoUrl } : null;
}

// loose -> owned. Package the loose primitive into a fitting (reusing reconcile's
// emission), append it as a dep, apm install (which claims the on-disk file into
// the lock), then snapshot the ledger to pre-suppress the watcher echo.
export async function promote(primitiveId: string, opts: TransitionOpts = {}): Promise<TransitionResult> {
  const home = opts.claudeHome ?? claudeHome();
  const model = await computeStateModel({ claudeHome: home });
  const rec = model.records.find((r) => r.id === primitiveId);
  if (!rec || !rec.path) return { ok: false, code: "not-found", deployed: [], cleanedOrphans: [] };
  if (rec.state === "owned") return { ok: true, fittingId: rec.name, deployed: [], cleanedOrphans: [] };

  // Collision guard (relocated S2 never-clobber): refuse if a DIFFERENT owned dep
  // already deploys to this primitive's path.
  const lock = await readGlobalLock();
  const conflict = lock.deps.find((d) => d.name !== rec.name && d.deployedFiles.includes(rec.path!));
  if (conflict) return { ok: false, code: "collision", deployed: [], cleanedOrphans: [] };

  // Package the loose primitive (idempotent — reuse an existing captured fitting).
  const store = capturedFittingsDir();
  let fittingDir = path.join(store, rec.name);
  if (!(await pathExists(fittingDir))) {
    fittingDir = await emitFitting(home, store, rec);
  }

  // Author deps = existing local deps + the new one, then install.
  const inputs: ApmDependencyInput[] = lock.deps
    .map(depToInput)
    .filter((i): i is ApmDependencyInput => i !== null);
  inputs.push({ absPath: fittingDir });
  await writeGlobalApmManifest(inputs);
  const nextLock = await apmInstall({ runApm: opts.runApm });

  const dep = nextLock.deps.find((d) => d.name === rec.name);
  await recordWritten(primitiveId, await primitiveHash(home, rec), {
    surface: rec.surface,
    fittingId: rec.name
  });
  return { ok: true, fittingId: rec.name, deployed: dep?.deployedFiles ?? [], cleanedOrphans: [] };
}

// owned -> parked. Drop the dep + reinstall; APM leaves the deployed files on disk
// as loose orphans (verified), so Garrison saves the captured fitting to the
// parked store and deletes the orphaned disk files itself.
export async function park(fittingId: string, opts: TransitionOpts = {}): Promise<TransitionResult> {
  const home = opts.claudeHome ?? claudeHome();
  const prevLock = await readGlobalLock();
  const dep = prevLock.deps.find((d) => d.name === fittingId);
  if (!dep) return { ok: false, code: "not-found", deployed: [], cleanedOrphans: [] };
  const depFiles = dep.deployedFiles;

  // Orphans = this dep's files that no OTHER dep also deploys. Computed from
  // prevLock so it's robust to how apm handles the reinstall (notably: a
  // zero-dep `apm install` may not rewrite the lock at all).
  const siblings = prevLock.deps.filter((d) => d.name !== fittingId);
  const orphans = depFiles.filter((f) => !siblings.some((d) => d.deployedFiles.includes(f)));

  // Re-author apm.yml WITHOUT this dep, then install (best-effort lock update).
  const remaining: ApmDependencyInput[] = siblings
    .map(depToInput)
    .filter((i): i is ApmDependencyInput => i !== null);
  await writeGlobalApmManifest(remaining);
  await apmInstall({ runApm: opts.runApm });

  // Save the captured fitting to the parked store (the off-disk copy).
  const captured = path.join(capturedFittingsDir(), fittingId);
  const parked = path.join(parkedStoreDir(), fittingId);
  if (await pathExists(captured)) {
    await fsp.rm(parked, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(parked), { recursive: true });
    await fsp.cp(captured, parked, { recursive: true });
    await fsp.rm(captured, { recursive: true, force: true });
  }

  // Delete the on-disk orphans APM left behind, and ARCHIVE their ledger entries
  // (drop the live ownership hash so echo-suppression behaves as before, but keep
  // the history and record a "parked" event — lineage survives the park).
  for (const rel of orphans) {
    await fsp.rm(path.join(home, rel), { recursive: true, force: true });
    await parkEntry(`${surfaceForRel(rel)}:${nameForRel(rel)}`);
  }

  // NON-orphan files (still deployed by a sibling) that the ledger attributes to
  // the parked fitting must be REATTRIBUTED to a surviving owner (codex S3f1
  // finding) — otherwise the ledger keeps naming a removed fitting. Pick the
  // first sibling that deploys the file as the new owner; a "moved" event
  // preserves lineage.
  const shared = depFiles.filter((f) => !orphans.includes(f));
  for (const rel of shared) {
    const newOwner = siblings.find((d) => d.deployedFiles.includes(rel))?.name;
    if (newOwner) await reattributeEntry(`${surfaceForRel(rel)}:${nameForRel(rel)}`, newOwner);
  }

  return { ok: true, fittingId, deployed: [], cleanedOrphans: orphans };
}

// parked -> owned | loose.
export async function unpark(
  slug: string,
  target: "owned" | "loose",
  opts: TransitionOpts = {}
): Promise<TransitionResult> {
  const home = opts.claudeHome ?? claudeHome();
  const parked = path.join(parkedStoreDir(), slug);
  if (!(await pathExists(parked))) return { ok: false, code: "not-found", deployed: [], cleanedOrphans: [] };

  if (target === "owned") {
    // Restore the fitting to the captured store, add it as a dep, install.
    const captured = path.join(capturedFittingsDir(), slug);
    await fsp.rm(captured, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(captured), { recursive: true });
    await fsp.cp(parked, captured, { recursive: true });
    await fsp.rm(parked, { recursive: true, force: true });

    const lock = await readGlobalLock();
    const inputs: ApmDependencyInput[] = lock.deps
      .map(depToInput)
      .filter((i): i is ApmDependencyInput => i !== null);
    inputs.push({ absPath: captured });
    await writeGlobalApmManifest(inputs);
    const nextLock = await apmInstall({ runApm: opts.runApm });
    const dep = nextLock.deps.find((d) => d.name === slug);
    const deployed = dep?.deployedFiles ?? [];
    for (const rel of deployed) {
      await unparkEntry(`${surfaceForRel(rel)}:${nameForRel(rel)}`);
    }
    return { ok: true, fittingId: slug, deployed, cleanedOrphans: [] };
  }

  // target === "loose": deploy the parked fitting's files back onto disk WITHOUT
  // adding to apm.yml, then drop it from the parked store.
  const deployed = await deployFittingToDisk(parked, home);
  await fsp.rm(parked, { recursive: true, force: true });
  for (const rel of deployed) {
    await unparkEntry(`${surfaceForRel(rel)}:${nameForRel(rel)}`);
  }
  return { ok: true, fittingId: slug, deployed, cleanedOrphans: [] };
}

// ---- helpers ----

function surfaceForRel(rel: string): string {
  if (rel.startsWith("skills/")) return "skill";
  if (rel.startsWith("commands/")) return "command";
  if (rel.startsWith("rules/")) return "rule";
  return "file";
}
function nameForRel(rel: string): string {
  const base = rel.replace(/^(skills|commands|rules)\//, "");
  return base.replace(/\.md$/, "").replace(/\/.*$/, "");
}

// Manually deploy a captured/parked fitting's .apm content to ~/.claude (the
// "loose" unpark path — no apm.yml dep, so apm install won't do it).
async function deployFittingToDisk(fittingDir: string, home: string): Promise<string[]> {
  const deployed: string[] = [];
  const apmSkills = path.join(fittingDir, ".apm", "skills");
  for (const name of await safeReaddir(apmSkills)) {
    const target = path.join(home, "skills", name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.cp(path.join(apmSkills, name), target, { recursive: true });
    deployed.push(`skills/${name}`);
  }
  const apmPrompts = path.join(fittingDir, ".apm", "prompts");
  for (const file of await safeReaddir(apmPrompts)) {
    const name = file.replace(/\.prompt\.md$/, "");
    const target = path.join(home, "commands", `${name}.md`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.cp(path.join(apmPrompts, file), target);
    deployed.push(`commands/${name}.md`);
  }
  const apmInstr = path.join(fittingDir, ".apm", "instructions");
  for (const file of await safeReaddir(apmInstr)) {
    const name = file.replace(/\.instructions\.md$/, "");
    const target = path.join(home, "rules", `${name}.md`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.cp(path.join(apmInstr, file), target);
    deployed.push(`rules/${name}.md`);
  }
  return deployed;
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await fsp.readdir(p);
  } catch {
    return [];
  }
}
