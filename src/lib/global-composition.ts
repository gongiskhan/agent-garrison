import fs from "node:fs/promises";
import path from "node:path";
import {
  claudeHome,
  globalCompositionDir,
  globalCompositionClaudeLink
} from "./claude-home";
import { readYamlFile, writeYamlFile } from "./yaml";
import { pathExists } from "./fs-utils";
import { authorApmDependencies, type ApmDependencyInput } from "./apm-manifest";
import { defaultApmRunner, type ApmRunner } from "./apm-exec";

// The APM engine that drives the REAL ~/.claude install.
//
// `~/.garrison/global-composition/` holds `apm.yml` + `apm_modules/` + a `.claude`
// symlink -> claudeHome(). Running `apm install` here deploys THROUGH the link
// into the real ~/.claude (verified) while keeping APM's project files confined.
// This is the single writer for the package-file surface (skills/rules/commands/
// plugins). Hooks and scalar settings are NOT APM's (verified) — they stay on the
// Garrison-direct writers.

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

function manifestPath(): string {
  return path.join(globalCompositionDir(), "apm.yml");
}

function lockPath(): string {
  return path.join(globalCompositionDir(), "apm.lock.yaml");
}

async function lstatOrNull(p: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Ensure `<global-composition>/.claude` is a symlink pointing at claudeHome().
// Repoint-safe: if the link is missing it creates it; if it points elsewhere
// (e.g. a test swapped GARRISON_CLAUDE_HOME) it repoints. NEVER touches the
// target (the real ~/.claude) — only the occupant under the Garrison-owned
// global-composition dir.
export async function ensureClaudeSymlink(): Promise<{ created: boolean; repointed: boolean }> {
  const link = globalCompositionClaudeLink();
  const target = path.resolve(claudeHome());
  await fs.mkdir(globalCompositionDir(), { recursive: true });
  await fs.mkdir(target, { recursive: true });

  const st = await lstatOrNull(link);
  if (st === null) {
    await fs.symlink(target, link, "dir");
    return { created: true, repointed: false };
  }
  if (st.isSymbolicLink()) {
    const current = path.resolve(path.dirname(link), await fs.readlink(link));
    if (current === target) return { created: false, repointed: false };
    await fs.unlink(link);
    await fs.symlink(target, link, "dir");
    return { created: false, repointed: true };
  }
  // A real dir/file occupies the link path (unexpected — this dir is
  // Garrison-owned). Replace it. Only ever touches ~/.garrison/global-composition.
  await fs.rm(link, { recursive: true, force: true });
  await fs.symlink(target, link, "dir");
  return { created: false, repointed: true };
}

// Idempotent: mkdir the tree, ensure-and-repoint the symlink, author a minimal
// apm.yml if absent. Safe to call before every op.
export async function ensureGlobalComposition(): Promise<void> {
  await fs.mkdir(globalCompositionDir(), { recursive: true });
  await ensureClaudeSymlink();
  if (!(await pathExists(manifestPath()))) {
    await writeYamlFile(manifestPath(), {
      name: "garrison-global",
      version: "0.1.0",
      target: "claude",
      dependencies: { apm: [] }
    } satisfies GlobalApmManifest);
  }
}

// Author the global apm.yml dependency set (local fittings + remote repos),
// preserving any non-dependency keys already in the manifest.
export async function writeGlobalApmManifest(deps: ApmDependencyInput[]): Promise<void> {
  await ensureGlobalComposition();
  const existing =
    (await readYamlFile<GlobalApmManifest>(manifestPath())) ?? ({} as GlobalApmManifest);
  existing.name = existing.name ?? "garrison-global";
  existing.version = existing.version ?? "0.1.0";
  existing.target = "claude";
  existing.dependencies = {
    ...(existing.dependencies ?? {}),
    apm: authorApmDependencies(deps, globalCompositionDir(), { absolute: true })
  };
  await writeYamlFile(manifestPath(), existing);
}

// Run `apm install --force` in the global composition, deploying THROUGH the
// symlink into the real ~/.claude. The ONLY function that mutates the package
// surface. Returns the parsed post-install lock.
export async function apmInstall(opts: GcOpts = {}): Promise<ApmLockView> {
  await ensureGlobalComposition();
  const runApm = opts.runApm ?? defaultApmRunner;
  const result = await runApm(["install", "--force"], globalCompositionDir(), { env: process.env });
  if (!result.ok) {
    throw new Error(`apm install failed (code ${result.code}): ${result.stderr || result.stdout}`.trim());
  }
  return readGlobalLock();
}

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

export async function readGlobalLock(): Promise<ApmLockView> {
  const raw = (await readYamlFile<RawApmLock>(lockPath())) ?? {};
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
