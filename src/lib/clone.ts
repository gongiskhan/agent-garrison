import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ROOT_DIR } from "./paths";
import { pathExists } from "./fs-utils";
import {
  appendRawLibraryEntry,
  getLibraryEntry,
  readLibrary,
  readRawLibrary,
  type RawLibraryEntry
} from "./library";
import { readYamlFile, writeYamlFile } from "./yaml";
import type { LibraryEntry } from "./types";

// S3 — Clone and edit Fittings.
//
// A clone is a full, independent copy of a source Fitting under a `local`
// namespace (`fittings/local/<id>`), registered as a first-class library entry.
// It is meant to DIVERGE from upstream: the upstream is pinned once in the
// copy's clone.json and never auto-updated, and every local edit reads as drift
// from that clone-time baseline. Nothing here ever writes back to the source.

const LOCAL_FITTINGS_SUBDIR = "fittings/local";
const CLONE_MANIFEST = "clone.json";

// Build/VCS artifacts — never authored content, so never copied.
//
// NOTE: `.apm` is intentionally NOT skipped. For skill/hook Fittings the
// authored primitive content lives under `.apm/` (e.g. `taste` ships its
// SKILL.md files at `.apm/skills/<name>/SKILL.md`); dropping it would produce a
// broken clone whose verify hook fails. `apm_modules` (the install output) is
// the artifact that gets skipped, not `.apm` (the source).
const COPY_SKIP = new Set(["node_modules", "apm_modules", ".git", ".DS_Store"]);

// A clone id becomes both a directory name and a library id, so it is
// constrained to a filesystem- and slug-safe shape (no path separators, no
// leading dot).
const CLONE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export class CloneError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "CloneError";
  }
}

// The upstream pin + per-file drift baseline, written into each clone's copy.
export interface CloneProvenance {
  // "<sourceId>@<version>" — the upstream this was copied from.
  cloned_from: string;
  clonedAt: string;
  // relPath (posix) -> sha256 at clone time. The drift baseline.
  files: Record<string, string>;
}

export interface CloneDrift {
  drifted: string[];
  clean: string[];
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// Every file under `root` as posix relative paths, skipping COPY_SKIP dirs and
// the clone.json provenance file itself (provenance is not fitting content).
async function walkFiles(root: string, rel = ""): Promise<string[]> {
  const dirents = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  const out: string[] = [];
  for (const dirent of dirents) {
    if (COPY_SKIP.has(dirent.name)) continue;
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (childRel === CLONE_MANIFEST) continue;
    if (dirent.isDirectory()) {
      out.push(...(await walkFiles(root, childRel)));
    } else if (dirent.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

async function hashTree(root: string): Promise<Record<string, string>> {
  const files = await walkFiles(root);
  const out: Record<string, string> = {};
  for (const rel of files) {
    out[rel] = sha256(await fs.readFile(path.join(root, rel)));
  }
  return out;
}

async function cloneIdTaken(id: string): Promise<boolean> {
  const entries = await readRawLibrary();
  if (entries.some((entry) => entry.id === id)) return true;
  return pathExists(path.join(ROOT_DIR, LOCAL_FITTINGS_SUBDIR, id));
}

async function resolveNewId(sourceId: string, requested?: string): Promise<string> {
  if (requested !== undefined) {
    if (!CLONE_ID_RE.test(requested)) {
      throw new CloneError(400, `Invalid clone id "${requested}" (use lowercase letters, digits, ., -, _)`);
    }
    if (await cloneIdTaken(requested)) {
      throw new CloneError(409, `A Fitting with id "${requested}" already exists`);
    }
    return requested;
  }
  const base = `${sourceId}-copy`;
  if (!(await cloneIdTaken(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!(await cloneIdTaken(candidate))) return candidate;
  }
  throw new CloneError(409, `Could not find a free clone id for "${sourceId}"`);
}

// Re-key a copied manifest as an independent APM package: rewrite any
// `_local/<oldName>` reference (e.g. the verify path, which APM materialises at
// `apm_modules/_local/<name>/`) to the new id. Applied to every string value.
function repointLocalRefs<T>(value: T, oldName: string, newName: string): T {
  if (typeof value === "string") {
    return value.split(`_local/${oldName}`).join(`_local/${newName}`) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => repointLocalRefs(item, oldName, newName)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = repointLocalRefs(val, oldName, newName);
    }
    return out as T;
  }
  return value;
}

export async function cloneFitting(
  sourceId: string,
  opts: { newId?: string } = {}
): Promise<LibraryEntry> {
  const source = await getLibraryEntry(sourceId);
  if (!source) throw new CloneError(404, `Unknown fitting: ${sourceId}`);
  if (!source.localPath) {
    throw new CloneError(400, `Fitting ${sourceId} is not local — nothing to clone`);
  }
  const srcAbs = path.resolve(ROOT_DIR, source.localPath);

  const newId = await resolveNewId(sourceId, opts.newId);
  const destRel = `${LOCAL_FITTINGS_SUBDIR}/${newId}`;
  const destAbs = path.join(ROOT_DIR, LOCAL_FITTINGS_SUBDIR, newId);

  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  try {
    // Recursive copy; the filter skips build/VCS artifacts (a skipped directory
    // takes its whole subtree with it). Authored `.apm/` content is preserved.
    // dereference: true copies symlink TARGETS as real bytes, so the clone is
    // genuinely independent — a later upstream edit can't change what the clone
    // reads through a shared link.
    await fs.cp(srcAbs, destAbs, {
      recursive: true,
      dereference: true,
      filter: (src) => !COPY_SKIP.has(path.basename(src))
    });

    // Re-key the copied manifest so it installs/verifies as its own package.
    const manifestPath = path.join(destAbs, "apm.yml");
    const manifest = (await readYamlFile<Record<string, unknown>>(manifestPath)) ?? {};
    const oldName = typeof manifest.name === "string" ? manifest.name : sourceId;
    const version = typeof manifest.version === "string" ? manifest.version : "0.1.0";
    const rewritten = repointLocalRefs(manifest, oldName, newId);
    rewritten.name = newId;
    await writeYamlFile(manifestPath, rewritten);

    const clonedFrom = `${sourceId}@${version}`;

    // Snapshot the drift baseline AFTER the re-key writes so the clone starts
    // clean; any later user edit then reads as divergence from upstream.
    const provenance: CloneProvenance = {
      cloned_from: clonedFrom,
      clonedAt: new Date().toISOString(),
      files: await hashTree(destAbs)
    };
    await fs.writeFile(
      path.join(destAbs, CLONE_MANIFEST),
      `${JSON.stringify(provenance, null, 2)}\n`,
      "utf8"
    );

    const rawEntry: RawLibraryEntry = {
      id: newId,
      name: `${source.name} (copy)`,
      repo: `local:${destRel}`,
      localPath: destRel,
      summary: source.summary,
      platforms: source.platforms,
      ratings: {},
      cloned_from: clonedFrom
    };
    await appendRawLibraryEntry(rawEntry);
  } catch (error) {
    // Leave no half-made clone behind if any step after the copy fails.
    await fs.rm(destAbs, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const resolved = (await readLibrary()).find((entry) => entry.id === newId);
  if (!resolved) {
    throw new CloneError(500, `Clone ${newId} was created but did not resolve from the library`);
  }
  return resolved;
}

export async function readCloneProvenance(id: string): Promise<CloneProvenance | null> {
  const entry = await getLibraryEntry(id);
  if (!entry?.localPath) return null;
  const provPath = path.join(ROOT_DIR, entry.localPath, CLONE_MANIFEST);
  try {
    const parsed = JSON.parse(await fs.readFile(provPath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.cloned_from === "string" &&
      parsed.files &&
      typeof parsed.files === "object"
    ) {
      return parsed as CloneProvenance;
    }
    return null;
  } catch {
    return null;
  }
}

// Compare each of the clone's current files against the clone-time baseline.
// A local edit, a newly-created file, or a deleted file all read as drift —
// this is the CORRECT, expected signal: a clone is meant to diverge.
export async function cloneDrift(id: string): Promise<CloneDrift> {
  const entry = await getLibraryEntry(id);
  if (!entry?.localPath) throw new CloneError(404, `Unknown or non-local fitting: ${id}`);
  const provenance = await readCloneProvenance(id);
  if (!provenance) throw new CloneError(404, `Fitting ${id} is not a clone`);

  const root = path.resolve(ROOT_DIR, entry.localPath);
  const current = await hashTree(root);
  const drifted: string[] = [];
  const clean: string[] = [];
  const seen = new Set<string>();

  for (const [rel, hash] of Object.entries(current)) {
    seen.add(rel);
    const baseline = provenance.files[rel];
    if (baseline === undefined || baseline !== hash) drifted.push(rel);
    else clean.push(rel);
  }
  for (const rel of Object.keys(provenance.files)) {
    if (!seen.has(rel)) drifted.push(rel); // present at clone time, now removed
  }

  drifted.sort();
  clean.sort();
  return { drifted, clean };
}
