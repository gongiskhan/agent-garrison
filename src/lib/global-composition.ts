import fs from "node:fs/promises";
import path from "node:path";
import {
  claudeHome,
  globalCompositionDir,
  userCompositionDir,
  userClaudeHome,
  garrisonDir,
  assertGarrisonHome
} from "./claude-home";
import { readYamlFile, writeYamlFile } from "./yaml";
import { pathExists } from "./fs-utils";
import { authorApmDependencies, type ApmDependencyInput } from "./apm-manifest";
import { defaultApmRunner, type ApmRunner } from "./apm-exec";
import { assertClaudeWritable } from "./install-state";

// APM deploys package files through an explicit project-to-home link. The
// global project owns the Garrison home; the user project owns only shared
// primitives. Hooks and MCP registrations retain separate provenance.

export interface GcOpts {
  runApm?: ApmRunner;
}

interface GlobalApmManifest {
  name?: string;
  version?: string;
  target?: string;
  dependencies?: { apm?: unknown[] };
  [key: string]: unknown;
}

export interface ApmProjectOptions { dir: string; home: string; name: string; }

async function lstatOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try { return await fs.lstat(p); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** One APM project and its explicit deployment home. */
export function apmProject({ dir, home, name }: ApmProjectOptions) {
  const manifest = path.join(dir, "apm.yml");
  const lock = path.join(dir, "apm.lock.yaml");
  const link = path.join(dir, ".claude");
  const target = path.resolve(home);
  const ensureLink = async (): Promise<{ created: boolean; repointed: boolean }> => {
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(target, { recursive: true });
    const st = await lstatOrNull(link);
    if (!st) {
      await fs.symlink(target, link, "dir");
      return { created: true, repointed: false };
    }
    if (st.isSymbolicLink()) {
      if (path.resolve(path.dirname(link), await fs.readlink(link)) === target) return { created: false, repointed: false };
      await fs.unlink(link);
    } else {
      // Preserve an unexpected occupant of the project-owned link slot.
      const saved = path.join(garrisonDir(), "quarantine", new Date().toISOString().replace(/[:.]/g, "-"), path.basename(dir), ".claude");
      await fs.mkdir(path.dirname(saved), { recursive: true });
      await fs.rename(link, saved);
    }
    await fs.symlink(target, link, "dir");
    return { created: false, repointed: true };
  };
  const ensure = async () => {
    await ensureLink();
    if (!await pathExists(manifest)) await writeYamlFile(manifest, { name, version: "0.1.0", target: "claude", dependencies: { apm: [] } } satisfies GlobalApmManifest);
  };
  const writeManifest = async (deps: ApmDependencyInput[]) => {
    await ensure();
    const existing = await readYamlFile<GlobalApmManifest>(manifest) ?? {};
    existing.name ??= name;
    existing.version ??= "0.1.0";
    existing.target = "claude";
    existing.dependencies = { ...(existing.dependencies ?? {}), apm: authorApmDependencies(deps, dir, { absolute: true }) };
    await writeYamlFile(manifest, existing);
  };
  const readLock = () => readApmLock(lock);
  const install = async (opts: GcOpts = {}): Promise<ApmLockView> => {
    await assertClaudeWritable(`install fitting primitives in ${name}`);
    await ensure();
    const result = await (opts.runApm ?? defaultApmRunner)(["install", "--force"], dir, { env: process.env });
    if (!result.ok) throw new Error(`apm install failed (code ${result.code}): ${result.stderr || result.stdout}`.trim());
    return readLock();
  };
  return { dir, home: target, manifestPath: manifest, lockPath: lock, link, ensureLink, ensure, writeManifest, install, readLock };
}

export function globalComposition() {
  assertGarrisonHome();
  return apmProject({ dir: globalCompositionDir(), home: claudeHome(), name: "garrison-global" });
}
export function userComposition() {
  return apmProject({ dir: userCompositionDir(), home: userClaudeHome(), name: "garrison-user" });
}
// Preserve the existing API for Quarters and Orchestrator writers.
export function ensureClaudeSymlink() { return globalComposition().ensureLink(); }
export function ensureGlobalComposition(): Promise<void> { return globalComposition().ensure(); }
export function writeGlobalApmManifest(deps: ApmDependencyInput[]): Promise<void> { return globalComposition().writeManifest(deps); }
export function apmInstall(opts: GcOpts = {}): Promise<ApmLockView> { return globalComposition().install(opts); }

// ---- lock reading ----

interface RawApmLockDep {
  repo_url?: string;
  local_path?: string;
  package_type?: string;
  deployed_files?: string[];
  deployed_file_hashes?: Record<string, string>;
}
interface RawApmLock {
  dependencies?: RawApmLockDep[];
}

export interface ApmLockDepView {
  name: string;
  repoUrl?: string;
  localPath?: string;
  packageType?: string;
  deployedFiles: string[]; // claudeHome-relative (".claude/" stripped)
  deployedHashes: Record<string, string>; // keyed by claudeHome-relative path
}

export interface ApmLockView {
  deps: ApmLockDepView[];
  allDeployedFiles: Set<string>; // union of every dep's deployedFiles
}

function stripClaudePrefix(p: string): string {
  return p.replace(/^\.claude\//, "");
}

function depName(dep: RawApmLockDep): string {
  if (dep.repo_url?.startsWith("_local/")) return dep.repo_url.slice("_local/".length);
  if (dep.local_path) return path.basename(dep.local_path.replace(/\/+$/, ""));
  return dep.repo_url ?? "";
}

export async function readApmLock(file: string): Promise<ApmLockView> {
  const raw = (await readYamlFile<RawApmLock>(file)) ?? {};
  const deps: ApmLockDepView[] = [];
  const allDeployedFiles = new Set<string>();
  for (const dep of raw.dependencies ?? []) {
    const deployedFiles = (dep.deployed_files ?? []).map(stripClaudePrefix);
    const deployedHashes: Record<string, string> = {};
    for (const [k, v] of Object.entries(dep.deployed_file_hashes ?? {})) {
      deployedHashes[stripClaudePrefix(k)] = v;
    }
    deployedFiles.forEach((f) => allDeployedFiles.add(f));
    deps.push({
      name: depName(dep),
      repoUrl: dep.repo_url,
      localPath: dep.local_path,
      packageType: dep.package_type,
      deployedFiles,
      deployedHashes
    });
  }
  return { deps, allDeployedFiles };
}

export function readGlobalLock(): Promise<ApmLockView> { return globalComposition().readLock(); }
