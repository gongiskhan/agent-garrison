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
    expect(c.portPool.start).toBe(50000);
    expect(c.portPool.end).toBe(54999);
    expect(c.urlScheme).toBe("http");
  });

  it("loads camelCase keys", async () => {
    const file = await writeTempYaml(
      "portPool:\n  start: 4000\n  end: 4099\nurlScheme: https\n"
    );
    const c = await loadGarrisonConfig(file);
    expect(c.portPool).toEqual({ start: 4000, end: 4099 });
    expect(c.urlScheme).toBe("https");
  });

  it("accepts snake_case keys too", async () => {
    const file = await writeTempYaml(
      "port_pool:\n  start: 6100\n  end: 6199\nurl_scheme: http\n"
    );
    const c = await loadGarrisonConfig(file);
    expect(c.portPool).toEqual({ start: 6100, end: 6199 });
    expect(c.urlScheme).toBe("http");
  });

  it("falls back to defaults when start >= end", async () => {
    const file = await writeTempYaml("portPool:\n  start: 5000\n  end: 5000\n");
    const c = await loadGarrisonConfig(file);
    expect(c.portPool).toEqual({ start: 50000, end: 54999 });
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
