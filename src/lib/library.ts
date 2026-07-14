import fs from "node:fs/promises";
import path from "node:path";
import { LIBRARY_PATH, ROOT_DIR } from "./paths";
import { parseGarrisonMetadata } from "./metadata";
import { writeFileAtomic } from "./atomic-write";
import type { LibraryEntry } from "./types";
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
  // Match the existing on-disk style byte-for-byte: 1-space indent, non-ASCII
  // escaped to \uXXXX, no trailing newline. Keeps an append (e.g. a clone) to a
  // one-line diff instead of reformatting the whole registry.
  const json = JSON.stringify(entries, null, 1).replace(
    /[^\x00-\x7f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
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

export async function readLibrary(): Promise<LibraryEntry[]> {
  const entries = await readRawLibrary();
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
    platforms: entry.platforms,
    ratings: entry.ratings ?? {},
    metadata,
    cloned_from: entry.cloned_from
  };
}
