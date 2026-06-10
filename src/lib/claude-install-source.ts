import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { SEED_FITTINGS_DIR, COMPOSITIONS_DIR } from "./paths";
import type { ArtifactKind, ArtifactSource, HookGroupSpec, InstallManifest } from "./claude-install";

// Resolve a fitting's installable artifacts to copy into ~/.claude.
//
// PRIMARY (authoritative, all kinds): reuse APM's already-computed deployment.
// `apm install` materialises real file copies into `<composition>/.claude/` and
// records them in `apm.lock.yaml` as `dependencies[].deployed_files`. We read
// that list (the authoritative APM shape->path mapping) and copy from the
// composition's `.claude/` tree. This avoids re-implementing APM's deploy engine
// AND avoids guessing the `.apm/{prompts,instructions}` -> `.claude/{commands,
// rules}` source mapping (which is APM-internal, not a simple mirror).
//
// FALLBACK (skills only): when the fitting is in no composition lock, scan its
// own `.apm/skills/<name>` source (the one shape that IS a clean 1:1 mirror).

interface ApmLockDep {
  repo_url?: string;
  local_path?: string;
  package_type?: string;
  deployed_files?: string[];
}
interface ApmLock {
  dependencies?: ApmLockDep[];
}

export interface ResolveOpts {
  compositionDir?: string;
  seedDir?: string;
}

function kindForTarget(target: string): ArtifactKind | null {
  if (target.startsWith("skills/")) return "skill-dir";
  if (target.startsWith("commands/")) return "command-file";
  if (target.startsWith("rules/")) return "rule-file";
  return null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveFromLock(fittingId: string, compositionDir: string): Promise<ArtifactSource[]> {
  const lockPath = path.join(compositionDir, "apm.lock.yaml");
  let lock: ApmLock;
  try {
    lock = (yaml.load(await fs.readFile(lockPath, "utf8")) as ApmLock) ?? {};
  } catch {
    return [];
  }
  const dep = (lock.dependencies ?? []).find(
    (d) => d.repo_url === `_local/${fittingId}` || (d.local_path ?? "").replace(/\/+$/, "").endsWith(`/${fittingId}`)
  );
  if (!dep || !Array.isArray(dep.deployed_files)) return [];

  const out: ArtifactSource[] = [];
  for (const deployed of dep.deployed_files) {
    const target = deployed.replace(/^\.claude\//, "");
    const kind = kindForTarget(target);
    if (!kind) continue;
    const sourcePath = path.join(compositionDir, deployed);
    if (await exists(sourcePath)) out.push({ target, kind, sourcePath });
  }
  return out;
}

// Resolve a `component_shape: hook` fitting's `x-garrison.hook_groups` payload
// into a single hook-group artifact. installFitting routes it through the shared
// owner-scoped settings.json writer (hooks are NOT apm-deployed — ground truth
// #7 — so there is nothing in apm.lock for them; the source IS the manifest).
async function resolveHookFitting(fittingId: string, seedDir: string): Promise<ArtifactSource[]> {
  const apmPath = path.join(seedDir, fittingId, "apm.yml");
  let manifest: { "x-garrison"?: { component_shape?: string; hook_groups?: unknown } } | null;
  try {
    manifest = (yaml.load(await fs.readFile(apmPath, "utf8")) as typeof manifest) ?? null;
  } catch {
    return [];
  }
  const xg = manifest?.["x-garrison"];
  if (!xg || xg.component_shape !== "hook") return [];
  const groups = Array.isArray(xg.hook_groups) ? xg.hook_groups : [];

  const hookGroups: HookGroupSpec[] = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const grp = g as { event?: unknown; matcher?: unknown; hooks?: unknown };
    if (typeof grp.event !== "string") continue;
    const rawHooks = Array.isArray(grp.hooks) ? grp.hooks : [];
    const hooks = rawHooks
      .filter((h): h is { command: string; type?: unknown; timeout?: unknown } =>
        Boolean(h) && typeof (h as { command?: unknown }).command === "string"
      )
      .map((h) => ({
        type: typeof h.type === "string" ? h.type : "command",
        command: String(h.command),
        ...(typeof h.timeout === "number" ? { timeout: h.timeout } : {})
      }));
    if (hooks.length === 0) continue;
    hookGroups.push({
      event: grp.event,
      ...(typeof grp.matcher === "string" ? { matcher: grp.matcher } : {}),
      hooks
    });
  }
  if (hookGroups.length === 0) return [];
  return [{ target: "hooks", kind: "hook-group", hookGroups }];
}

async function resolveFromApmSkills(fittingId: string, seedDir: string): Promise<ArtifactSource[]> {
  const skillsDir = path.join(seedDir, fittingId, ".apm", "skills");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      target: `skills/${e.name}`,
      kind: "skill-dir" as ArtifactKind,
      sourcePath: path.join(skillsDir, e.name)
    }));
}

export async function resolveArtifacts(fittingId: string, opts?: ResolveOpts): Promise<InstallManifest> {
  const compositionDir = opts?.compositionDir ?? path.join(COMPOSITIONS_DIR, "default");
  const seedDir = opts?.seedDir ?? SEED_FITTINGS_DIR;

  let artifacts = await resolveFromLock(fittingId, compositionDir);
  if (artifacts.length === 0) {
    artifacts = await resolveFromApmSkills(fittingId, seedDir);
  }
  if (artifacts.length === 0) {
    artifacts = await resolveHookFitting(fittingId, seedDir);
  }

  return {
    fittingId,
    source: `fittings/seed/${fittingId}`,
    artifacts: artifacts.sort((a, b) => a.target.localeCompare(b.target))
  };
}
