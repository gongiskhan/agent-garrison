import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readYamlFile } from "./yaml";
import {
  DEFAULT_PORT_RANGE_END,
  DEFAULT_PORT_RANGE_START,
  type PortRange
} from "./worktree/ports";

export const CONFIG_FILE_NAME = "config.yml";
export const CONFIG_PATH = path.join(os.homedir(), ".garrison", CONFIG_FILE_NAME);

export const URL_SCHEMES = ["http", "https"] as const;
export type UrlScheme = (typeof URL_SCHEMES)[number];

export interface GarrisonConfig {
  portPool: PortRange;
  urlScheme: UrlScheme;
}

const PortPoolSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive()
});

const RawConfigSchema = z
  .object({
    portPool: PortPoolSchema.optional(),
    port_pool: PortPoolSchema.optional(),
    urlScheme: z.enum(URL_SCHEMES).optional(),
    url_scheme: z.enum(URL_SCHEMES).optional()
  })
  .passthrough();

export function defaultGarrisonConfig(): GarrisonConfig {
  return {
    portPool: { start: DEFAULT_PORT_RANGE_START, end: DEFAULT_PORT_RANGE_END },
    urlScheme: "http"
  };
}

let cached: GarrisonConfig | null = null;

export async function loadGarrisonConfig(configPath = CONFIG_PATH): Promise<GarrisonConfig> {
  if (cached) return cached;
  const fallback = defaultGarrisonConfig();
  let exists = true;
  try {
    await fsp.access(configPath);
  } catch {
    exists = false;
  }
  if (!exists) {
    cached = fallback;
    return cached;
  }
  let raw: unknown;
  try {
    raw = await readYamlFile(configPath);
  } catch {
    cached = fallback;
    return cached;
  }
  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) {
    cached = fallback;
    return cached;
  }
  const data = parsed.data;
  const portPool = data.portPool ?? data.port_pool;
  const urlScheme = data.urlScheme ?? data.url_scheme;
  const merged: GarrisonConfig = {
    portPool:
      portPool && portPool.start < portPool.end
        ? { start: portPool.start, end: portPool.end }
        : fallback.portPool,
    urlScheme: urlScheme ?? fallback.urlScheme
  };
  cached = merged;
  return cached;
}

export function resetGarrisonConfigCache(): void {
  cached = null;
}
