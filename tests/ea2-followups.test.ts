import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic, writeJsonAtomic } from "@/lib/atomic-write";
import { readInstalledPlugins } from "@/lib/claude-scan";
import { computeStateModel } from "@/lib/primitive-state";

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "garrison-ea2-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

describe("EA2 (a): writeFileAtomic preserves/honors file mode", () => {
  it("honors an explicit 0600 mode exactly (defeats umask)", async () => {
    const p = path.join(dir, "secret.json");
    await writeFileAtomic(p, "{}", { mode: 0o600 });
    expect(modeOf(p)).toBe(0o600);
  });

  it("preserves an existing 0600 file's mode on overwrite (no widening)", async () => {
    const p = path.join(dir, "vault.json");
    await fsp.writeFile(p, "old");
    await fsp.chmod(p, 0o600);
    expect(modeOf(p)).toBe(0o600);

    await writeFileAtomic(p, "new-contents"); // no opts.mode
    expect(modeOf(p)).toBe(0o600); // would have been 0o644 before the fix
    expect(await fsp.readFile(p, "utf8")).toBe("new-contents");
  });

  it("preserves a 0640 file's mode on overwrite", async () => {
    const p = path.join(dir, "data.json");
    await fsp.writeFile(p, "x");
    await fsp.chmod(p, 0o640);
    await writeJsonAtomic(p, { a: 1 });
    expect(modeOf(p)).toBe(0o640);
  });

  it("writeJsonAtomic honors an explicit 0600 on a new file", async () => {
    const p = path.join(dir, "fresh-secret.json");
    await writeJsonAtomic(p, { k: "v" }, { mode: 0o600 });
    expect(modeOf(p)).toBe(0o600);
  });
});

describe("EA2 (b): plugins classification from installed_plugins.json", () => {
  function seedPlugins(home: string): void {
    fs.mkdirSync(path.join(home, "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "frontend-design@claude-plugins-official": [
            { scope: "user", version: "08de64fff891", installPath: "/x" }
          ],
          "ralph-loop@claude-plugins-official": [{ scope: "user", version: "1.0.0", installPath: "/y" }]
        }
      })
    );
  }

  it("reads installed plugins with name/marketplace/version", async () => {
    seedPlugins(dir);
    const plugins = await readInstalledPlugins(dir);
    expect(plugins.map((p) => p.key)).toEqual([
      "frontend-design@claude-plugins-official",
      "ralph-loop@claude-plugins-official"
    ]);
    const fd = plugins.find((p) => p.name === "frontend-design");
    expect(fd?.marketplace).toBe("claude-plugins-official");
    expect(fd?.version).toBe("08de64fff891");
  });

  it("returns [] when installed_plugins.json is absent or unparseable", async () => {
    expect(await readInstalledPlugins(dir)).toEqual([]);
  });

  it("surfaces plugins in the Quarters state model (loose, Claude-Code-managed)", async () => {
    seedPlugins(dir);
    const model = await computeStateModel({ claudeHome: dir });
    const pluginRecords = model.bySurface.plugin;
    expect(pluginRecords).toHaveLength(2);
    expect(pluginRecords.every((r) => r.state === "loose")).toBe(true);
    expect(pluginRecords.map((r) => r.name)).toContain("frontend-design@claude-plugins-official");
  });
});
