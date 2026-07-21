import fs from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "./claude-home";
import { writeJsonAtomic } from "./atomic-write";
import { COMPOSITIONS_DIR } from "./paths";
import {
  DEFAULT_COMPOSITION_ID,
  getCompositionDirectory,
  getCompositionManifestPath
} from "./compositions";

// The persisted active-composition pointer (WS4 / D6).
//
// Before this, "active" was a runtime heuristic (AppShell picked the running
// composition, else the first by sorted name). It now lives in
// ~/.garrison/config.json as a durable pointer so a switch survives reloads and
// a CLI can drive it. The pointer accepts BOTH a composition id (resolved under
// compositions/) AND a filesystem path to an apm.yml (or a dir containing one),
// per D6's "pointing at a different apm.yml".
//
// NOTE: this lives in active-composition.ts rather than garrison-config.ts
// because that module name is already taken by the unrelated ~/.garrison/
// config.yml url-scheme feature. Keeping the two concerns in separate modules
// avoids mixing a YAML url-scheme store with this JSON pointer store.

export interface ActiveCompositionConfig {
  active_composition: string;
}

export function activeCompositionConfigPath(): string {
  return path.join(garrisonDir(), "config.json");
}

// Read the config, defaulting a missing/blank/corrupt file to the default
// composition pointer. Never throws — an unreadable config must not brick the
// app's ability to pick a composition.
export async function readActiveConfig(): Promise<ActiveCompositionConfig> {
  try {
    const raw = await fs.readFile(activeCompositionConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<ActiveCompositionConfig>;
    const active =
      typeof parsed.active_composition === "string" && parsed.active_composition.trim().length > 0
        ? parsed.active_composition.trim()
        : DEFAULT_COMPOSITION_ID;
    return { active_composition: active };
  } catch {
    return { active_composition: DEFAULT_COMPOSITION_ID };
  }
}

export async function getActiveComposition(): Promise<string> {
  return (await readActiveConfig()).active_composition;
}

// Persist the active-composition pointer with an atomic write (temp-file+rename
// so a concurrent reader never catches a torn file). Preserves any other keys
// already present in the config document.
export async function setActiveComposition(idOrPath: string): Promise<void> {
  const value = (idOrPath ?? "").trim();
  if (value.length === 0) {
    throw new Error("active composition pointer cannot be empty");
  }
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(activeCompositionConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
  } catch {
    existing = {};
  }
  await writeJsonAtomic(activeCompositionConfigPath(), { ...existing, active_composition: value });
}

export interface ResolvedComposition {
  id: string;
  dir: string;
  manifestPath: string;
  // true when the pointer is a filesystem path OUTSIDE compositions/. The runner
  // resolves a composition by id under compositions/, so an external pointer can
  // only be run when its own directory basename also happens to name a
  // compositions/ entry. Callers surface this so the limitation is never silent.
  external: boolean;
}

// Map a pointer to its resolved {id, dir, manifestPath}. A plain id (no path
// separator, not absolute, no .yml/.yaml suffix) resolves under compositions/;
// anything else is treated as a filesystem path to an apm.yml or a directory
// containing one. A path that lands on a DIRECT child of compositions/ is folded
// back to that child's id so the existing id-based runner path drives it.
export function resolveCompositionPointer(pointer: string): ResolvedComposition {
  const value = (pointer ?? "").trim() || DEFAULT_COMPOSITION_ID;
  const looksLikePath =
    value.includes("/") || value.includes(path.sep) || path.isAbsolute(value) || /\.ya?ml$/i.test(value);

  if (!looksLikePath) {
    return {
      id: value,
      dir: getCompositionDirectory(value),
      manifestPath: getCompositionManifestPath(value),
      external: false
    };
  }

  const abs = path.resolve(value);
  const isManifestFile = /\.ya?ml$/i.test(abs);
  const dir = isManifestFile ? path.dirname(abs) : abs;
  const manifestPath = isManifestFile ? abs : path.join(dir, "apm.yml");

  const rel = path.relative(COMPOSITIONS_DIR, dir);
  const insideCompositions =
    rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep);

  return {
    id: insideCompositions ? rel : path.basename(dir),
    dir,
    manifestPath,
    external: !insideCompositions
  };
}

// Convenience: the currently-active pointer, resolved.
export async function resolveActiveComposition(): Promise<ResolvedComposition> {
  return resolveCompositionPointer(await getActiveComposition());
}
