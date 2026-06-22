import fs from "node:fs/promises";
import path from "node:path";
import { COMPOSITIONS_DIR, ROOT_DIR } from "./paths";
import { ensureDir, pathExists, slugify } from "./fs-utils";
import { authorApmDependencies } from "./apm-manifest";
import { readLibrary } from "./library";
import { validateSelection } from "./metadata";
import { resolveCapabilities, serializeCapabilityGraph } from "./capabilities";
import { facultyIds, type CapabilityIssue, type FittingSelectionMap, type Composition, type GlobalConfig, type LibraryEntry, type FacultyId, type SelectedFitting, type SerializedCapabilityGraph, type SoulDefinition } from "./types";
import { readYamlFile, writeYamlFile } from "./yaml";

const DEFAULT_COMPOSITION_ID = "default";

const DEFAULT_ORCHESTRATOR_PROMPT = [
  "<!--",
  "Verification milestone: this prompt mandates ending every reply with the literal token",
  "[orchestrator-active] on its own line. The token is load-bearing for scripts/integration-check.mjs",
  "and tests/orchestrator-integration.test.ts. It is VISIBLE TO USERS in every chat reply until the",
  "next milestone removes the marker — that's expected, not a debug leak.",
  "",
  "Changes to this prompt only take effect on operative restart (Stop → Run). The HTTP gateway",
  "passes systemPrompt.append on the first SDK turn only; subsequent turns use resume:sessionId,",
  "and the SDK V1 API cannot update systemPrompt mid-session.",
  "-->",
  "",
  "# Agent Garrison Orchestrator",
  "",
  "You are the behavior spine for a local Agent Garrison operative.",
  "Coordinate installed Faculties, respect configured guardrails, report every meaningful action, and verify before claiming success.",
  "",
  "## Operating discipline",
  "",
  "- Be concise. State the result first; details follow only if useful.",
  "- Surface what you are about to do before doing it when the action is non-trivial.",
  "- If a request is ambiguous, ask one focused question rather than guessing.",
  "- If you cannot complete something, say so directly and explain what's blocking you.",
  "",
  "## Tools and Faculties available in this Operative",
  "",
  "Treat this list as the authoritative inventory of what's installed in this Composition — each provider's usage guidance is indented under its line:",
  "",
  // Load-bearing: the runner substitutes the resolved providers (with their
  // for_consumers guidance) here at assembly time — the locality principle.
  // Without it, assembleSystemPrompt warns and the Operative flies blind.
  "{{capabilities}}",
  "",
  "If a Faculty isn't in that list, the capability is not installed — say so and surface the missing Faculty as an installation suggestion. Don't fabricate tools.",
  "",
  "## Reply contract",
  "",
  "End every reply with the following token on its own line:",
  "",
  "    [orchestrator-active]",
  "",
  "This is a verification marker proving this prompt reached the model. Do not omit it, even on short replies.",
  ""
].join("\n");

const DEFAULT_SOUL_PROMPT = [
  "# Agent Garrison Soul",
  "",
  "You are called **Verity**. When asked your name, identify yourself as Verity.",
  "",
  "Your character:",
  "",
  "- Direct and transparent. Prefer inspectable steps over hidden behavior.",
  "- Local-first and dogfood-oriented; you live on the user's machine, not in the cloud.",
  "- You do not perform enthusiasm and do not over-apologize.",
  "- You push back kindly when it matters — when a request looks like it'll cause harm, waste effort, or rest on a wrong premise.",
  "- You keep the user informed without theatrics.",
  ""
].join("\n");

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
      souls?: SoulDefinition[];
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
  const dependencies = authorApmDependencies(
    selectedEntries.map((entry) =>
      entry.localPath ? { absPath: path.join(ROOT_DIR, entry.localPath) } : { repo: entry.repo }
    ),
    getCompositionDirectory(id)
  );

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
    await fs.writeFile(orchestratorPath, DEFAULT_ORCHESTRATOR_PROMPT, "utf8");
  }

  const soulPath = path.join(compositionDir, ".garrison", "prompts", "soul.md");
  if (!(await pathExists(soulPath))) {
    await fs.writeFile(soulPath, DEFAULT_SOUL_PROMPT, "utf8");
  }

  const manifestPath = getCompositionManifestPath(id);
  if (!(await pathExists(manifestPath))) {
    await writeYamlFile(manifestPath, createManifest(id, "Dogfood Operative"));
  }
}

export async function refreshDefaultPrompts(id: string): Promise<{ orchestratorPath: string; soulPath: string }> {
  const compositionDir = getCompositionDirectory(id);
  await ensureDir(path.join(compositionDir, ".garrison", "prompts"));
  const orchestratorPath = path.join(compositionDir, ".garrison", "prompts", "orchestrator.md");
  const soulPath = path.join(compositionDir, ".garrison", "prompts", "soul.md");
  await fs.writeFile(orchestratorPath, DEFAULT_ORCHESTRATOR_PROMPT, "utf8");
  await fs.writeFile(soulPath, DEFAULT_SOUL_PROMPT, "utf8");
  return { orchestratorPath, soulPath };
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
    souls: composition?.souls ?? [],
    derivedTasks: derived,
    capabilityIssues: [],
    capabilityGraph: { consumers: [] }
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
  // Self-heal selections grouped under a stale faculty key (e.g. fittings
  // saved under `sessions` before the 2026-06-18 split). The UI then always
  // sees the current grouping, and the next save persists it.
  const selections = migrateSelectionsByFaculty(composition.selections, entries);
  const { issues, graph } = computeCapabilityResolution(entries);
  return {
    ...composition,
    selections,
    derivedTasks: deriveTasks(selections, entries),
    capabilityIssues: issues,
    capabilityGraph: graph
  };
}

export function computeCapabilityIssues(entries: LibraryEntry[]): CapabilityIssue[] {
  return computeCapabilityResolution(entries).issues;
}

export function computeCapabilityResolution(entries: LibraryEntry[]): {
  issues: CapabilityIssue[];
  graph: SerializedCapabilityGraph;
} {
  const result = resolveCapabilities(
    entries.map((entry) => ({ id: entry.id, metadata: entry.metadata }))
  );
  const graph = serializeCapabilityGraph(result.graph);
  if (result.ok) {
    return { issues: [], graph };
  }
  const issues = result.errors.map((error) => ({
    fittingId: error.fittingId,
    code: error.code,
    kind: error.kind,
    name: error.name,
    message: error.message
  }));
  return { issues, graph };
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

/**
 * Re-bucket each selected fitting under its CURRENT library faculty (by id),
 * preserving config. Self-heals compositions saved before a faculty move — e.g.
 * the 2026-06-18 sessions -> sessions/runtimes/surfaces split: a fitting left
 * under a stale role key migrates to its real role on read, and the next save
 * persists the correction. Unknown ids keep their stored key so validation can
 * still surface them. Returns the original map unchanged when nothing moved.
 */
export function migrateSelectionsByFaculty(
  selections: FittingSelectionMap,
  entries: LibraryEntry[]
): FittingSelectionMap {
  const facultyById = new Map(entries.map((entry) => [entry.id, entry.faculty]));
  const migrated: FittingSelectionMap = {};
  let moved = false;
  for (const [key, items] of Object.entries(selections)) {
    for (const item of items ?? []) {
      const target = (facultyById.get(item.id) ?? key) as FacultyId;
      if (target !== key) moved = true;
      (migrated[target] ??= []).push(item);
    }
  }
  return moved ? migrated : selections;
}

function deriveTasks(
  selections: FittingSelectionMap,
  entries: LibraryEntry[]
): Composition["derivedTasks"] {
  // The data-sources faculty folded out; derived-task backing is now found by
  // any selected Fitting that declares `tasks`, regardless of role.
  const candidates = Object.values(selections).flat().filter(Boolean) as SelectedFitting[];
  for (const selected of candidates) {
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
