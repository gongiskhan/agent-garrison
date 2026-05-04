import fs from "node:fs/promises";
import path from "node:path";
import { LIBRARY_PATH, ROOT_DIR } from "./paths";
import { parseGarrisonMetadata } from "./metadata";
import type { LibraryEntry } from "./types";
import { readYamlFile } from "./yaml";

interface RawLibraryEntry {
  id: string;
  name: string;
  repo: string;
  localPath?: string;
  summary: string;
  platforms: string[];
  ratings?: LibraryEntry["ratings"];
}

interface RawManifest {
  "x-garrison"?: unknown;
}

export async function readLibrary(): Promise<LibraryEntry[]> {
  const raw = await fs.readFile(LIBRARY_PATH, "utf8");
  const entries = JSON.parse(raw) as RawLibraryEntry[];
  const resolved = await Promise.all(entries.map(resolveLibraryEntry));
  return resolved.sort((left, right) => left.id.localeCompare(right.id));
}

export async function getLibraryEntry(id: string): Promise<LibraryEntry | undefined> {
  const entries = await readLibrary();
  return entries.find((entry) => entry.id === id);
}

async function resolveLibraryEntry(entry: RawLibraryEntry): Promise<LibraryEntry> {
  const manifestPath = entry.localPath
    ? path.join(ROOT_DIR, entry.localPath, "apm.yml")
    : undefined;
  if (!manifestPath) {
    throw new Error(`Library entry ${entry.id} does not have a localPath in v1 bootstrap mode`);
  }
  const manifest = await readYamlFile<RawManifest>(manifestPath);
  const metadata = parseGarrisonMetadata(manifest?.["x-garrison"]);
  return {
    ...entry,
    faculty: metadata.faculty,
    platforms: entry.platforms,
    ratings: entry.ratings ?? {},
    metadata
  };
}
