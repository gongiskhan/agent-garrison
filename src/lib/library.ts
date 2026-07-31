import fs from "node:fs/promises";
import path from "node:path";
import { FITTINGS_DIR, LIBRARY_PATH, ROOT_DIR } from "./paths";
import { parseGarrisonMetadata } from "./metadata";
import { writeFileAtomic } from "./atomic-write";
import { CATEGORY_BY_FACULTY, type LibraryEntry } from "./types";
import { readYamlFile } from "./yaml";

export interface RawLibraryEntry {
  id: string;
  name: string;
  repo: string;
  localPath?: string;
  summary: string;
  platforms: string[];
  ratings?: LibraryEntry["ratings"];
  // Set on clones (S3): "<sourceId>@<version>" — the upstream this was copied
  // from. Carried through to the resolved LibraryEntry so the composer/editor
  // can mark it and read its clone.json drift baseline.
  cloned_from?: string;
}

interface RawManifest {
  "x-garrison"?: unknown;
}

export async function readRawLibrary(): Promise<RawLibraryEntry[]> {
  const raw = await fs.readFile(LIBRARY_PATH, "utf8");
  return JSON.parse(raw) as RawLibraryEntry[];
}

export async function writeRawLibrary(entries: RawLibraryEntry[]): Promise<void> {
  // Match the on-disk style so an append (a clone, a newly registered seed
  // fitting) is a few added lines and not a whole-file reformat. The registry
  // is now 2-space indented with a trailing newline and literal UTF-8 - the
  // earlier 1-space/\uXXXX-escaped style this function used had drifted from
  // the file, so every write through the UI rewrote all 768 lines.
  const json = `${JSON.stringify(entries, null, 2)}\n`;
  // Atomic (temp + rename) so a concurrent reader never catches a torn file.
  await writeFileAtomic(LIBRARY_PATH, json);
}

// Serialize read-modify-write of the registry. writeRawLibrary is atomic, so a
// reader never sees a torn file, but two concurrent appends could each read the
// pre-write registry and the second rename would drop the first's entry (lost
// update). This in-process queue makes each append's read+write one critical
// section. (Single-process app; a cross-process guard would need a file lock.)
let libraryWriteQueue: Promise<unknown> = Promise.resolve();
function withLibraryWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = libraryWriteQueue.then(fn, fn);
  libraryWriteQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// Append a new entry (idempotent by id — a duplicate id throws so a clone can
// never silently overwrite an existing registry entry).
export async function appendRawLibraryEntry(entry: RawLibraryEntry): Promise<void> {
  return withLibraryWriteLock(async () => {
    const entries = await readRawLibrary();
    if (entries.some((e) => e.id === entry.id)) {
      throw new Error(`Library already has an entry with id ${entry.id}`);
    }
    entries.push(entry);
    await writeRawLibrary(entries);
  });
}

/**
 * Every Fitting on disk is registered, always.
 *
 * The registry (data/library.json) used to be an opt-in allow-list, so a
 * Fitting could exist under fittings/ and be invisible in the Armory with
 * nothing to indicate why — that is how 17 seed Fittings ended up unlisted.
 * Discovery is now automatic and the registry is a CURATION layer: an entry
 * there overrides the derived name/summary and carries ratings/cloned_from.
 *
 * To unregister, add the id to data/library-excluded.json (a JSON array).
 * That is the single manual lever, and it is explicit rather than an absence.
 */
const AUTO_REGISTER_CAP = 300;
const EXCLUDED_PATH = path.join(path.dirname(LIBRARY_PATH), "library-excluded.json");

async function readExcludedIds(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(EXCLUDED_PATH, "utf8");
    const ids = JSON.parse(raw);
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}

/** Directories under fittings/{seed,local} that hold an apm.yml. */
async function discoverFittingDirs(): Promise<{ id: string; localPath: string }[]> {
  const found: { id: string; localPath: string }[] = [];
  for (const group of ["seed", "local"]) {
    const dir = path.join(FITTINGS_DIR, group);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const id of names) {
      const localPath = path.join("fittings", group, id);
      try {
        await fs.access(path.join(ROOT_DIR, localPath, "apm.yml"));
        found.push({ id, localPath });
      } catch {
        // not a fitting directory
      }
    }
  }
  return found;
}

/** Synthesize a registry entry for a Fitting that has no curated one. */
async function deriveRawEntry(
  id: string,
  localPath: string
): Promise<RawLibraryEntry | null> {
  const manifest = await readYamlFile<Record<string, unknown>>(
    path.join(ROOT_DIR, localPath, "apm.yml")
  );
  if (!manifest) return null;
  const description =
    typeof manifest.description === "string" ? manifest.description.trim() : "";
  return {
    id,
    name: typeof manifest.name === "string" && manifest.name ? manifest.name : id,
    repo: `local:${localPath}`,
    localPath,
    summary: description.replace(/\s+/g, " ").slice(0, 300) || `The ${id} fitting.`,
    platforms: ["claude-code"],
  };
}

export async function readLibrary(): Promise<LibraryEntry[]> {
  const curated = await readRawLibrary();
  const excluded = await readExcludedIds();
  const byId = new Map(curated.map((entry) => [entry.id, entry]));

  for (const { id, localPath } of await discoverFittingDirs()) {
    if (byId.has(id)) continue;
    const derived = await deriveRawEntry(id, localPath);
    if (derived) byId.set(id, derived);
  }

  let entries = [...byId.values()].filter((entry) => !excluded.has(entry.id));
  if (entries.length > AUTO_REGISTER_CAP) {
    console.warn(
      `[garrison] ${entries.length} fittings exceeds the ${AUTO_REGISTER_CAP} auto-register cap; ` +
        "listing the first " +
        `${AUTO_REGISTER_CAP} by id. Curate data/library-excluded.json or raise AUTO_REGISTER_CAP.`
    );
    entries = entries.sort((a, b) => a.id.localeCompare(b.id)).slice(0, AUTO_REGISTER_CAP);
  }

  const resolved = await Promise.all(entries.map(resolveLibraryEntry));
  const skipped = entries.filter((_, i) => resolved[i] === null).map((e) => e.id);
  if (skipped.length > 0) {
    console.warn(
      `[garrison] library entries with no manifest on disk skipped: ${skipped.join(", ")} ` +
        "(fitting removed while registered - re-clone or remove the registry entry)"
    );
  }
  return resolved
    .filter((entry): entry is LibraryEntry => entry !== null)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function getLibraryEntry(id: string): Promise<LibraryEntry | undefined> {
  const entries = await readLibrary();
  return entries.find((entry) => entry.id === id);
}

// Resolve one raw registry entry against its on-disk manifest. Returns null
// when the manifest is MISSING (a clone removed mid-read, a hand-deleted local
// fitting) - the registry listing must not brick every library consumer over a
// vanished member. A PRESENT manifest that fails metadata validation still
// throws: that is an authoring error to surface, never to skip.
async function resolveLibraryEntry(entry: RawLibraryEntry): Promise<LibraryEntry | null> {
  const manifestPath = entry.localPath
    ? path.join(ROOT_DIR, entry.localPath, "apm.yml")
    : undefined;
  if (!manifestPath) {
    throw new Error(`Library entry ${entry.id} does not have a localPath in v1 bootstrap mode`);
  }
  const manifest = await readYamlFile<RawManifest>(manifestPath);
  if (!manifest) return null;
  const metadata = parseGarrisonMetadata(manifest["x-garrison"]);
  return {
    ...entry,
    faculty: metadata.faculty,
    // Hoisted alongside faculty so the Fittings views can group without
    // reaching into `metadata`. Presentation only — resolved from the faculty
    // when a manifest omits it, so no entry is ever uncategorised.
    category: metadata.category ?? CATEGORY_BY_FACULTY[metadata.faculty],
    platforms: entry.platforms,
    ratings: entry.ratings ?? {},
    metadata,
    cloned_from: entry.cloned_from
  };
}
