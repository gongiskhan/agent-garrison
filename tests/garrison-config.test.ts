import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  defaultGarrisonConfig,
  loadGarrisonConfig,
  resetGarrisonConfigCache,
  URL_SCHEMES
} from "../src/lib/garrison-config";

const tempFiles: string[] = [];

beforeEach(() => {
  resetGarrisonConfigCache();
});

afterEach(async () => {
  for (const f of tempFiles.splice(0)) await fsp.unlink(f).catch(() => null);
  resetGarrisonConfigCache();
});

async function writeTempYaml(content: string): Promise<string> {
  const file = path.join(os.tmpdir(), `garrison-config-test-${Date.now()}-${Math.random()}.yml`);
  await fsp.writeFile(file, content);
  tempFiles.push(file);
  return file;
}

describe("loadGarrisonConfig", () => {
  it("returns the default config when no config file exists", async () => {
    const c = await loadGarrisonConfig("/tmp/garrison-config-this-does-not-exist.yml");
    expect(c).toEqual(defaultGarrisonConfig());
    expect(c.urlScheme).toBe("http");
  });

  it("loads camelCase keys", async () => {
    const file = await writeTempYaml("urlScheme: https\n");
    const c = await loadGarrisonConfig(file);
    expect(c.urlScheme).toBe("https");
  });

  it("accepts snake_case keys too", async () => {
    const file = await writeTempYaml("url_scheme: https\n");
    const c = await loadGarrisonConfig(file);
    expect(c.urlScheme).toBe("https");
  });

  it("URL_SCHEMES enum has the expected values", () => {
    expect(URL_SCHEMES).toEqual(["http", "https"]);
  });

  it("falls back to defaults when YAML is malformed", async () => {
    const file = await writeTempYaml("not: [valid: yaml");
    const c = await loadGarrisonConfig(file);
    expect(c).toEqual(defaultGarrisonConfig());
  });
});
