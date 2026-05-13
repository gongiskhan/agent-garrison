import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { readYamlFile } from "./yaml";
import { parseGarrisonMetadata } from "./metadata";
import type { SpawnConfig } from "./types";

interface RawManifest {
  "x-garrison"?: unknown;
}

export interface ResolvedSoulSpawnConfig extends SpawnConfig {
  fittingId: string;
  promptPath: string;
  resolvedBasePath: string;
}

export interface SoulsConfigBlob {
  orchestratorFittingId: string | null;
  orchestrator?: ResolvedSoulSpawnConfig;
  souls: Record<string, ResolvedSoulSpawnConfig>;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export async function loadSoulSpawnConfig(
  fittingId: string,
  installedDir: string,
  configOverrides?: Record<string, string | number | boolean>
): Promise<ResolvedSoulSpawnConfig> {
  const apmYmlPath = path.join(installedDir, "apm.yml");
  if (!fs.existsSync(apmYmlPath)) {
    throw new Error(`soul-spawn-config: ${fittingId} apm.yml not found at ${apmYmlPath}`);
  }

  const manifest = await readYamlFile<RawManifest>(apmYmlPath);
  if (!manifest) throw new Error(`soul-spawn-config: failed to parse ${apmYmlPath}`);
  const metadata = parseGarrisonMetadata(manifest["x-garrison"]);

  const spawn = metadata.spawn ?? { preset: "claude_code", exclude_dynamic_sections: false };

  const basePath =
    (configOverrides?.base_path as string | undefined) ?? spawn.base_path ?? os.homedir();
  const resolvedBasePath = expandHome(basePath);

  const promptFile = `${fittingId}.prompt.md`;
  const promptPath = path.join(installedDir, ".apm", "prompts", promptFile);
  if (!fs.existsSync(promptPath)) {
    throw new Error(`soul-spawn-config: prompt file not found at ${promptPath}`);
  }

  return {
    fittingId,
    preset: spawn.preset,
    allowed_tools: spawn.allowed_tools,
    disallowed_tools: spawn.disallowed_tools,
    exclude_dynamic_sections: spawn.exclude_dynamic_sections ?? false,
    base_path: spawn.base_path,
    mcp: spawn.mcp,
    promptPath,
    resolvedBasePath
  };
}

export async function buildSoulsConfigBlob(
  compositionDir: string,
  orchestratorFittingId: string | null,
  soulFittingIds: string[],
  configMap?: Record<string, Record<string, string | number | boolean>>
): Promise<SoulsConfigBlob> {
  const modulesBase = path.join(compositionDir, "apm_modules", "_local");
  const souls: Record<string, ResolvedSoulSpawnConfig> = {};

  for (const fittingId of soulFittingIds) {
    const installedDir = path.join(modulesBase, fittingId);
    const overrides = configMap?.[fittingId];
    souls[fittingId] = await loadSoulSpawnConfig(fittingId, installedDir, overrides);
  }

  let orchestrator: ResolvedSoulSpawnConfig | undefined;
  if (orchestratorFittingId) {
    const installedDir = path.join(modulesBase, orchestratorFittingId);
    const overrides = configMap?.[orchestratorFittingId];
    orchestrator = await loadSoulSpawnConfig(orchestratorFittingId, installedDir, overrides);
  }

  return { orchestratorFittingId, orchestrator, souls };
}
