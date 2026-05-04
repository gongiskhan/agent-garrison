import fs from "node:fs/promises";
import path from "node:path";
import { COMPOSITIONS_DIR, ROOT_DIR } from "./paths";
import { ensureDir, pathExists, slugify, toPosixPath } from "./fs-utils";
import { readLibrary } from "./library";
import { validateSelection } from "./metadata";
import { resolveCapabilities } from "./capabilities";
import { facultyIds, type CapabilityIssue, type FittingSelectionMap, type Composition, type GlobalConfig, type LibraryEntry, type FacultyId, type SelectedFitting } from "./types";
import { readYamlFile, writeYamlFile } from "./yaml";

const DEFAULT_COMPOSITION_ID = "default";

interface CompositionManifest {
  name: string;
  version: string;
  target: string;
  dependencies?: {
    apm?: Array<string | { path: string }>;
  };
  "x-garrison"?: {
    composition?: {
      id?: string;
      name?: string;
      global_config?: GlobalConfig;
      selections?: FittingSelectionMap;
      prompt_sources?: {
        orchestrator: string;
        soul: string;
      };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function defaultGlobalConfig(): GlobalConfig {
  return {
    projects_root: "~/dev",
    vault: "default",
    platform: "claude-code",
    guardrails: {
      max_tasks_per_tick: 5,
      max_spend_per_day: 25,
      max_tool_calls_per_tick: 30
    },
    permissions_mode: "auto",
    observability_config: {
      log_sink: "runner"
    }
  };
}

export async function listCompositions(): Promise<Composition[]> {
  await ensureDefaultComposition();
  await ensureDir(COMPOSITIONS_DIR);
  const entries = await fs.readdir(COMPOSITIONS_DIR, { withFileTypes: true });
  const compositions = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readComposition(entry.name))
  );
  return compositions.sort((left, right) => left.name.localeCompare(right.name));
}

export async function readComposition(id = DEFAULT_COMPOSITION_ID): Promise<Composition> {
  await ensureComposition(id);
  const manifestPath = getCompositionManifestPath(id);
  const manifest = await readYamlFile<CompositionManifest>(manifestPath);
  if (!manifest) {
    throw new Error(`Missing manifest for composition ${id}`);
  }
  return manifestToComposition(id, manifest);
}

export async function writeComposition(
  id: string,
  update: {
    name?: string;
    selections?: FittingSelectionMap;
    globalConfig?: GlobalConfig;
  }
): Promise<Composition> {
  await ensureComposition(id);
  const manifestPath = getCompositionManifestPath(id);
  const manifest = (await readYamlFile<CompositionManifest>(manifestPath)) ?? createManifest(id, id);
  const current = manifestToComposition(id, manifest);
  const nextName = update.name ?? current.name;
  const nextSelections = normalizeSelections(update.selections ?? current.selections);
  const nextGlobalConfig = update.globalConfig ?? current.globalConfig;
  await validateCompositionSelections(nextSelections);

  const selectedEntries = await selectedLibraryEntries(nextSelections);
  const dependencies = selectedEntries.map((entry) => {
    if (!entry.localPath) {
      return entry.repo;
    }
    const relative = path.relative(getCompositionDirectory(id), path.join(ROOT_DIR, entry.localPath));
    return { path: toPosixPath(relative) };
  });

  manifest.name = slugify(nextName) || id;
  manifest.version = manifest.version ?? "0.1.0";
  manifest.target = "claude";
  manifest.dependencies = { ...(manifest.dependencies ?? {}), apm: dependencies };
  manifest["x-garrison"] = {
    ...(manifest["x-garrison"] ?? {}),
    composition: {
      id,
      name: nextName,
      global_config: nextGlobalConfig,
      selections: nextSelections,
      prompt_sources: {
        orchestrator: ".garrison/prompts/orchestrator.md",
        soul: ".garrison/prompts/soul.md"
      }
    }
  };
  await writeYamlFile(manifestPath, manifest);
  return readCompositionWithDerivedTasks(id);
}

export function getCompositionDirectory(id: string): string {
  return path.join(COMPOSITIONS_DIR, slugify(id) || DEFAULT_COMPOSITION_ID);
}

export function getCompositionManifestPath(id: string): string {
  return path.join(getCompositionDirectory(id), "apm.yml");
}

export async function ensureDefaultComposition(): Promise<void> {
  await ensureComposition(DEFAULT_COMPOSITION_ID);
}

export async function ensureComposition(id: string): Promise<void> {
  await ensureDir(COMPOSITIONS_DIR);
  const compositionDir = getCompositionDirectory(id);
  await ensureDir(compositionDir);
  await ensureDir(path.join(compositionDir, ".garrison", "prompts"));

  const orchestratorPath = path.join(compositionDir, ".garrison", "prompts", "orchestrator.md");
  if (!(await pathExists(orchestratorPath))) {
    await fs.writeFile(
      orchestratorPath,
      [
        "# Agent Garrison Orchestrator",
        "",
        "You are the behavior spine for a local Agent Garrison operative.",
        "Coordinate installed Faculties, respect configured guardrails, report every meaningful action, and verify before claiming success.",
        ""
      ].join("\n"),
      "utf8"
    );
  }

  const soulPath = path.join(compositionDir, ".garrison", "prompts", "soul.md");
  if (!(await pathExists(soulPath))) {
    await fs.writeFile(
      soulPath,
      [
        "# Agent Garrison Soul",
        "",
        "You are direct, transparent, local-first, and dogfood-oriented.",
        "Prefer inspectable steps over hidden behavior and keep the user informed without theatrics.",
        ""
      ].join("\n"),
      "utf8"
    );
  }

  const manifestPath = getCompositionManifestPath(id);
  if (!(await pathExists(manifestPath))) {
    await writeYamlFile(manifestPath, createManifest(id, "Dogfood Operative"));
  }
}

function createManifest(id: string, name: string): CompositionManifest {
  return {
    name: slugify(name) || id,
    version: "0.1.0",
    target: "claude",
    dependencies: {
      apm: []
    },
    "x-garrison": {
      composition: {
        id,
        name,
        global_config: defaultGlobalConfig(),
        selections: {},
        prompt_sources: {
          orchestrator: ".garrison/prompts/orchestrator.md",
          soul: ".garrison/prompts/soul.md"
        }
      }
    }
  };
}

function manifestToComposition(id: string, manifest: CompositionManifest): Composition {
  const composition = manifest["x-garrison"]?.composition;
  const selections = normalizeSelections(composition?.selections ?? {});
  const derived = deriveTasks(selections, []);
  return {
    id: composition?.id ?? id,
    name: composition?.name ?? manifest.name,
    directory: getCompositionDirectory(id),
    manifestPath: getCompositionManifestPath(id),
    selections,
    globalConfig: composition?.global_config ?? defaultGlobalConfig(),
    derivedTasks: derived,
    capabilityIssues: []
  };
}

export async function readCompositionWithDerivedTasks(id = DEFAULT_COMPOSITION_ID): Promise<Composition> {
  await ensureComposition(id);
  const manifest = await readYamlFile<CompositionManifest>(getCompositionManifestPath(id));
  if (!manifest) {
    throw new Error(`Missing manifest for composition ${id}`);
  }
  const composition = manifestToComposition(id, manifest);
  const entries = await selectedLibraryEntries(composition.selections);
  return {
    ...composition,
    derivedTasks: deriveTasks(composition.selections, entries),
    capabilityIssues: computeCapabilityIssues(entries)
  };
}

export function computeCapabilityIssues(entries: LibraryEntry[]): CapabilityIssue[] {
  const result = resolveCapabilities(
    entries.map((entry) => ({ id: entry.id, metadata: entry.metadata }))
  );
  if (result.ok) {
    return [];
  }
  return result.errors.map((error) => ({
    fittingId: error.fittingId,
    code: error.code,
    kind: error.kind,
    name: error.name,
    message: error.message
  }));
}

export async function selectedLibraryEntries(selections: FittingSelectionMap): Promise<LibraryEntry[]> {
  const library = await readLibrary();
  const selectedIds = new Set(
    Object.values(selections)
      .flatMap((items) => items ?? [])
      .map((item) => item.id)
  );
  return library.filter((entry) => selectedIds.has(entry.id));
}

export async function validateCompositionSelections(selections: FittingSelectionMap): Promise<void> {
  const library = await readLibrary();
  const byId = new Map(library.map((entry) => [entry.id, entry]));
  for (const facultyId of facultyIds) {
    const selected = selections[facultyId] ?? [];
    const metadata = selected.map((item) => {
      const entry = byId.get(item.id);
      if (!entry) {
        throw new Error(`Unknown fitting ${item.id}`);
      }
      return entry.metadata;
    });
    validateSelection(facultyId, selected.length, metadata);
  }
}

function normalizeSelections(selections: FittingSelectionMap): FittingSelectionMap {
  const normalized: FittingSelectionMap = {};
  for (const facultyId of facultyIds) {
    const items = selections[facultyId];
    if (!items || items.length === 0) {
      continue;
    }
    normalized[facultyId] = items.map((item) => ({
      id: item.id,
      config: item.config ?? {}
    }));
  }
  return normalized;
}

function deriveTasks(
  selections: FittingSelectionMap,
  entries: LibraryEntry[]
): Composition["derivedTasks"] {
  const dataSources = selections["data-sources"] ?? [];
  for (const selected of dataSources) {
    const entry = entries.find((candidate) => candidate.id === selected.id);
    if (entry?.metadata.tasks) {
      return {
        source: entry.metadata.tasks.source,
        truthFile: entry.metadata.tasks.truth_file,
        fittingId: entry.id
      };
    }
  }
  return undefined;
}

export function defaultConfigForEntry(entry: LibraryEntry): SelectedFitting {
  return {
    id: entry.id,
    config: Object.fromEntries(
      entry.metadata.config_schema
        .filter((field) => field.default !== undefined)
        .map((field) => [field.key, field.default as string | number | boolean])
    )
  };
}
