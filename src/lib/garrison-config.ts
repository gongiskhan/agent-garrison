import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readYamlFile } from "./yaml";

export const CONFIG_FILE_NAME = "config.yml";
export const CONFIG_PATH = path.join(os.homedir(), ".garrison", CONFIG_FILE_NAME);

export const URL_SCHEMES = ["http", "https"] as const;
export type UrlScheme = (typeof URL_SCHEMES)[number];

export interface GarrisonConfig {
  urlScheme: UrlScheme;
}

const RawConfigSchema = z
  .object({
    urlScheme: z.enum(URL_SCHEMES).optional(),
    url_scheme: z.enum(URL_SCHEMES).optional()
  })
  .passthrough();

export function defaultGarrisonConfig(): GarrisonConfig {
  return {
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
  const urlScheme = data.urlScheme ?? data.url_scheme;
  const merged: GarrisonConfig = {
    urlScheme: urlScheme ?? fallback.urlScheme
  };
  cached = merged;
  return cached;
}

export function resetGarrisonConfigCache(): void {
  cached = null;
}
