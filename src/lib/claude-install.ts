import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { claudeHome, garrisonDir } from "./claude-home";
import {
  writeSettingsMerged,
  appendGarrisonHookGroup,
  stripGarrisonGroupsForOwner
} from "./claude-settings-file";
import { purgeParkedHooksForOwner } from "./hooks-disable";

// Global install/ownership backend for the Claude Code installation (~/.claude).
//
// Materialises a fitting's artifacts into ~/.claude and uninstalls EXACTLY what
// it installed, tracked in a Garrison-owned lockfile (independent of APM's
// composition-local apm.lock.yaml). Guarantees:
//   - never clobber a path Garrison does not own (hand-authored collision),
//   - never delete a Garrison-installed file the user has since edited (drift),
//   - "adopt" an already-on-disk artifact into management without copying
//     (brown-field: the install is already there, e.g. an imported skill).

export type ArtifactKind = "skill-dir" | "command-file" | "rule-file" | "hook-group";

export interface HookGroupSpec {
  event: string; // e.g. "SessionStart"
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

export interface ArtifactSource {
  target: string; // relative to claudeHome, e.g. "skills/foo"; for hooks a synthetic label "hooks"
  kind: ArtifactKind;
  sourcePath?: string; // absolute path of the source to copy (file artifacts only)
  hookGroups?: HookGroupSpec[]; // hook-group artifacts only
}

export interface InstallManifest {
  fittingId: string;
  source: string; // provenance label (e.g. "fittings/seed/<id>")
  artifacts: ArtifactSource[];
}

export interface InstalledArtifact {
  target: string;
  kind: ArtifactKind;
  files: Record<string, string>; // relpath-under-claudeHome -> "sha256:<hex>" (file artifacts)
  owner?: string; // hook-group: the "_garrison" owner tag written into settings.json
  events?: string[]; // hook-group: events touched
}

export interface InstalledFitting {
  fittingId: string;
  source: string;
  installedAt: string;
  adopted: boolean;
  artifacts: InstalledArtifact[];
}

export interface InstallLock {
  version: 1;
  installs: Record<string, InstalledFitting>;
}

export interface InstallOpts {
  claudeHome?: string;
  lockPath?: string;
  now?: string;
}

export type InstallResult =
  | { ok: true; fittingId: string; adopted: boolean; targets: string[] }
  | { ok: false; code: "unowned-collision" | "no-artifacts" | "missing-source" | "missing-target"; target?: string };

export interface UninstallResult {
  ok: boolean;
  code?: "not-installed";
  removed: string[];
  driftedSkipped: string[];
}

export type DriftState = "clean" | "drifted" | "missing";
export interface DriftReport {
  fittingId: string;
  target: string;
  file: string;
  state: DriftState;
}

export function installLockPath(opts?: InstallOpts): string {
  return opts?.lockPath ?? path.join(garrisonDir(), "claude-install.lock.json");
}
function home(opts?: InstallOpts): string {
  return opts?.claudeHome ?? claudeHome();
}

export async function readInstallLock(opts?: InstallOpts): Promise<InstallLock> {
  try {
    const raw = await fs.readFile(installLockPath(opts), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.installs) return parsed as InstallLock;
  } catch {
    // none yet
  }
  return { version: 1, installs: {} };
}

export async function writeInstallLock(lock: InstallLock, opts?: InstallOpts): Promise<void> {
  const p = installLockPath(opts);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

export async function listInstalledFittings(opts?: InstallOpts): Promise<InstalledFitting[]> {
  const lock = await readInstallLock(opts);
  return Object.values(lock.installs).sort((a, b) => a.fittingId.localeCompare(b.fittingId));
}

// ---- helpers ----

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(abs: string): Promise<string> {
  const buf = await fs.readFile(abs);
  return `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`;
}

// Absolute file paths under a root (recursive). A file root returns itself.
async function walkFiles(absRoot: string): Promise<string[]> {
  const st = await fs.stat(absRoot);
  if (st.isFile()) return [absRoot];
  const out: string[] = [];
  const entries = await fs.readdir(absRoot, { withFileTypes: true });
  for (const e of entries) {
    const child = path.join(absRoot, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(child)));
    else if (e.isFile()) out.push(child);
  }
  return out.sort();
}

// Hash an artifact on disk -> { relpath-under-claudeHome: sha256 }.
async function hashArtifactOnDisk(h: string, target: string): Promise<Record<string, string>> {
  const abs = path.join(h, target);
  const files = await walkFiles(abs);
  const map: Record<string, string> = {};
  for (const f of files) {
    map[path.relative(h, f)] = await hashFile(f);
  }
  return map;
}

function ownedTargets(lock: InstallLock): Map<string, string> {
  const map = new Map<string, string>();
  for (const inst of Object.values(lock.installs)) {
    for (const a of inst.artifacts) map.set(a.target, inst.fittingId);
  }
  return map;
}

// ---- install / adopt / uninstall ----

export async function installFitting(manifest: InstallManifest, opts?: InstallOpts): Promise<InstallResult> {
  const h = home(opts);
  const fileArtifacts = manifest.artifacts.filter((a) => a.kind !== "hook-group");
  const hookArtifacts = manifest.artifacts.filter((a) => a.kind === "hook-group");
  if (manifest.artifacts.length === 0) return { ok: false, code: "no-artifacts" };

  const lock = await readInstallLock(opts);
  const owners = ownedTargets(lock);

  // Precheck (atomic at the fitting level): refuse the WHOLE install if any file
  // target exists on disk and is not already owned by THIS fitting. Write nothing.
  for (const a of fileArtifacts) {
    if (!a.sourcePath || !(await exists(a.sourcePath))) {
      return { ok: false, code: "missing-source", target: a.target };
    }
    const absTarget = path.join(h, a.target);
    if (await exists(absTarget)) {
      const owner = owners.get(a.target);
      if (owner !== manifest.fittingId) {
        return { ok: false, code: "unowned-collision", target: a.target };
      }
    }
  }

  // Copy each artifact (replacing our own prior copy) and record sha256.
  const records: InstalledArtifact[] = [];
  for (const a of fileArtifacts) {
    const absTarget = path.join(h, a.target);
    await fs.rm(absTarget, { recursive: true, force: true });
    await fs.mkdir(path.dirname(absTarget), { recursive: true });
    await fs.cp(a.sourcePath as string, absTarget, { recursive: true });
    records.push({ target: a.target, kind: a.kind, files: await hashArtifactOnDisk(h, a.target) });
  }

  // Hook-group artifacts -> owner-tagged groups in settings.json via the single
  // shared writer. Owner-scoped, so multiple hook fittings coexist and uninstall
  // strips ONLY this fitting's groups.
  if (hookArtifacts.length > 0) {
    const owner = `fitting:${manifest.fittingId}`;
    const events = new Set<string>();
    await writeSettingsMerged((draft) => {
      stripGarrisonGroupsForOwner(draft, owner); // idempotent re-install
      for (const a of hookArtifacts) {
        for (const g of a.hookGroups ?? []) {
          events.add(g.event);
          appendGarrisonHookGroup(draft, g.event, { matcher: g.matcher ?? "", hooks: g.hooks }, owner);
        }
      }
    }, h);
    records.push({ target: "hooks", kind: "hook-group", files: {}, owner, events: [...events].sort() });
  }

  lock.installs[manifest.fittingId] = {
    fittingId: manifest.fittingId,
    source: manifest.source,
    installedAt: opts?.now ?? new Date().toISOString(),
    adopted: false,
    artifacts: records
  };
  await writeInstallLock(lock, opts);
  return { ok: true, fittingId: manifest.fittingId, adopted: false, targets: records.map((r) => r.target) };
}

// Record an artifact that ALREADY exists on disk into the lockfile, using its
// current bytes as the owned baseline. No copy, no overwrite.
export async function adoptFitting(manifest: InstallManifest, opts?: InstallOpts): Promise<InstallResult> {
  const h = home(opts);
  const fileArtifacts = manifest.artifacts.filter((a) => a.kind !== "hook-group");
  if (fileArtifacts.length === 0) return { ok: false, code: "no-artifacts" };

  const lock = await readInstallLock(opts);
  const owners = ownedTargets(lock);

  for (const a of fileArtifacts) {
    const absTarget = path.join(h, a.target);
    if (!(await exists(absTarget))) return { ok: false, code: "missing-target", target: a.target };
    const owner = owners.get(a.target);
    if (owner && owner !== manifest.fittingId) {
      return { ok: false, code: "unowned-collision", target: a.target };
    }
  }

  const records: InstalledArtifact[] = [];
  for (const a of fileArtifacts) {
    records.push({ target: a.target, kind: a.kind, files: await hashArtifactOnDisk(h, a.target) });
  }
  lock.installs[manifest.fittingId] = {
    fittingId: manifest.fittingId,
    source: manifest.source,
    installedAt: opts?.now ?? new Date().toISOString(),
    adopted: true,
    artifacts: records
  };
  await writeInstallLock(lock, opts);
  return { ok: true, fittingId: manifest.fittingId, adopted: true, targets: records.map((r) => r.target) };
}

export async function uninstallFitting(fittingId: string, opts?: InstallOpts): Promise<UninstallResult> {
  const h = home(opts);
  const lock = await readInstallLock(opts);
  const inst = lock.installs[fittingId];
  if (!inst) return { ok: false, code: "not-installed", removed: [], driftedSkipped: [] };

  const removed: string[] = [];
  const driftedSkipped: string[] = [];

  for (const a of inst.artifacts) {
    if (a.kind === "hook-group") {
      if (a.owner) {
        await writeSettingsMerged((draft) => {
          stripGarrisonGroupsForOwner(draft, a.owner as string);
        }, h);
        // HV5: also drop any PARKED (disabled) groups this fitting owns, so a
        // re-install can't resurrect a stale disabled copy.
        await purgeParkedHooksForOwner(a.owner as string);
        removed.push(`hooks:${a.owner}`);
      }
      continue;
    }
    for (const [rel, recordedHash] of Object.entries(a.files)) {
      const abs = path.join(h, rel);
      if (!(await exists(abs))) continue; // already gone
      const current = await hashFile(abs);
      if (current === recordedHash) {
        await fs.rm(abs, { force: true });
        removed.push(rel);
      } else {
        driftedSkipped.push(rel); // user edited a Garrison-installed file: leave it
      }
    }
    // remove now-empty target dir for skill-dir artifacts
    if (a.kind === "skill-dir") {
      const absDir = path.join(h, a.target);
      await removeEmptyDirs(absDir, h);
    }
  }

  delete lock.installs[fittingId];
  await writeInstallLock(lock, opts);
  return { ok: true, removed, driftedSkipped };
}

async function removeEmptyDirs(dir: string, stopAt: string): Promise<void> {
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    try {
      const entries = await fs.readdir(cur);
      if (entries.length > 0) break;
      await fs.rmdir(cur);
      cur = path.dirname(cur);
    } catch {
      break;
    }
  }
}

export async function detectDrift(opts?: InstallOpts): Promise<DriftReport[]> {
  const h = home(opts);
  const lock = await readInstallLock(opts);
  const reports: DriftReport[] = [];
  for (const inst of Object.values(lock.installs)) {
    for (const a of inst.artifacts) {
      for (const [rel, recordedHash] of Object.entries(a.files)) {
        const abs = path.join(h, rel);
        let state: DriftState;
        if (!(await exists(abs))) state = "missing";
        else state = (await hashFile(abs)) === recordedHash ? "clean" : "drifted";
        if (state !== "clean") reports.push({ fittingId: inst.fittingId, target: a.target, file: rel, state });
      }
    }
  }
  return reports;
}
