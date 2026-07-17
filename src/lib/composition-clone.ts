import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { COMPOSITIONS_DIR } from "./paths";
import { ensureDir, pathExists, slugify } from "./fs-utils";
import {
  getCompositionDirectory,
  getCompositionManifestPath,
  readCompositionWithDerivedTasks,
  type CompositionV4
} from "./compositions";
import { readYamlFile, writeYamlFile } from "./yaml";

interface CloneManifest {
  name?: string;
  "x-garrison"?: {
    composition?: {
      id?: string;
      name?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CloneCompositionInput {
  sourceId: string;
  name: string;
  id?: string;
}

// These paths are products of install/run, not composition authoring. A clone
// deliberately keeps authored prompts, local.yml, custom root files, and the
// composition-scoped .garrison/routing.json policy, while making the new
// composition install and launch into clean runtime state.
const GENERATED_TOP_LEVEL = new Set([
  "apm_modules",
  "node_modules",
  ".claude",
  ".next",
  ".env",
  "apm.lock.yaml"
]);

const GENERATED_GARRISON_PATHS = new Set([
  "assembled-system-prompt.md",
  "decisions.jsonl",
  "mcp.json",
  "operative-session-id",
  "orchestrator-session-id",
  "policy.json",
  "run-evidence.json"
]);

export function compositionClonePathAllowed(relativePath: string): boolean {
  if (!relativePath || relativePath === ".") return true;
  const normalized = relativePath.split(path.sep).join("/");
  const [top, ...rest] = normalized.split("/");
  if (GENERATED_TOP_LEVEL.has(top)) return false;
  if (top === ".garrison") {
    const nested = rest.join("/");
    if (GENERATED_GARRISON_PATHS.has(nested)) return false;
    if (/^(logs|runs|sessions|tmp)(\/|$)/.test(nested)) return false;
  }
  const base = path.posix.basename(normalized);
  if (base.includes(".garrison-tmp-") || base.includes(".tmp-")) return false;
  return true;
}

function assertSourceId(raw: string): string {
  const id = raw.trim();
  if (!id || slugify(id) !== id) {
    throw new Error("sourceId must be an existing kebab-case composition id");
  }
  return id;
}

// Clone through a hidden sibling and rename only after the copied manifest has
// been rewritten. Readers therefore see either no clone or a complete clone;
// source files are never edited and a failed copy is cleaned up.
export async function cloneComposition(input: CloneCompositionInput): Promise<CompositionV4> {
  const sourceId = assertSourceId(input.sourceId);
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  const id = slugify(input.id?.trim() || name);
  if (!id) throw new Error("composition id must contain a letter or number");
  if (id === sourceId) throw new Error(`composition "${id}" already exists`);

  await ensureDir(COMPOSITIONS_DIR);
  const sourceDir = getCompositionDirectory(sourceId);
  const sourceManifest = getCompositionManifestPath(sourceId);
  if (!(await pathExists(sourceManifest))) {
    throw new Error(`source composition "${sourceId}" does not exist`);
  }
  // Parse/validate before copying. The source must be a real composition, not
  // merely a directory containing an arbitrary apm.yml.
  await readCompositionWithDerivedTasks(sourceId);

  const destinationDir = getCompositionDirectory(id);
  if (await pathExists(destinationDir)) {
    throw new Error(`composition "${id}" already exists`);
  }

  const stageDir = path.join(
    COMPOSITIONS_DIR,
    `.${id}.clone-${process.pid}-${randomBytes(6).toString("hex")}`
  );
  let committed = false;
  try {
    await fs.cp(sourceDir, stageDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (source) => compositionClonePathAllowed(path.relative(sourceDir, source))
    });

    const stagedManifestPath = path.join(stageDir, "apm.yml");
    const manifest = await readYamlFile<CloneManifest>(stagedManifestPath);
    const block = manifest?.["x-garrison"]?.composition;
    if (!manifest || !block) {
      throw new Error(`source composition "${sourceId}" has no x-garrison.composition block`);
    }
    manifest.name = slugify(name) || id;
    block.id = id;
    block.name = name;
    await writeYamlFile(stagedManifestPath, manifest);

    // A concurrent clone of the same id wins cleanly; rename onto a populated
    // directory fails rather than merging two partial copies.
    if (await pathExists(destinationDir)) {
      throw new Error(`composition "${id}" already exists`);
    }
    await fs.rename(stageDir, destinationDir);
    committed = true;
    return await readCompositionWithDerivedTasks(id);
  } finally {
    if (!committed) await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}
