import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removePlugin } from "@/lib/plugin-writer";
import { runQuartersAction, type CrudResult } from "@/lib/quarters";

let claudeRoot: string;
let priorClaude: string | undefined;

function manifestPath(): string {
  return path.join(claudeRoot, "plugins", "installed_plugins.json");
}
function writeManifest(obj: unknown): void {
  fs.mkdirSync(path.dirname(manifestPath()), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify(obj, null, 2));
}
function readManifest(): { version?: number; plugins: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
}

beforeEach(() => {
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-plug-"));
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
});
afterEach(() => {
  if (priorClaude === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = priorClaude;
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe("plugin-writer removePlugin", () => {
  it("drops the manifest entry + removes a cache dir UNDER plugins/, preserving version + siblings", () => {
    const inHomeDir = path.join(claudeRoot, "plugins", "cache", "mkt", "demo", "v1");
    fs.mkdirSync(inHomeDir, { recursive: true });
    fs.writeFileSync(path.join(inHomeDir, "file"), "x");
    writeManifest({
      version: 2,
      plugins: {
        "demo@mkt": [{ scope: "user", installPath: inHomeDir, version: "v1" }],
        "keep@mkt": [{ scope: "user", installPath: "/elsewhere/keep", version: "v9" }]
      }
    });

    return removePlugin("demo@mkt").then((r) => {
      expect(r.ok).toBe(true);
      expect(r.removedDirs).toEqual([path.resolve(inHomeDir)]);
      const m = readManifest();
      expect(m.version).toBe(2); // preserved
      expect(Object.keys(m.plugins)).toEqual(["keep@mkt"]); // demo gone, keep intact
      expect(fs.existsSync(inHomeDir)).toBe(false); // cache dir cleaned
    });
  });

  it("PATH GUARD: never removes an installPath outside <home>/plugins/", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gar-outside-"));
    writeManifest({ version: 2, plugins: { "ext@mkt": [{ installPath: outside }] } });
    const r = await removePlugin("ext@mkt");
    expect(r.ok).toBe(true);
    expect(r.removedDirs).toEqual([]); // skipped — outside the guard
    expect(fs.existsSync(outside)).toBe(true); // untouched
    expect(Object.keys(readManifest().plugins)).toEqual([]);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("reports not-found for a missing key (and via the dispatch)", async () => {
    writeManifest({ version: 2, plugins: { "a@m": [{}] } });
    expect((await removePlugin("nope@m")).code).toBe("not-found");
    const viaDispatch = (await runQuartersAction({ action: "plugin.remove", key: "nope@m" })) as CrudResult;
    expect(viaDispatch.ok).toBe(false);
    expect(viaDispatch.code).toBe("not-found");
  });

  it("dispatch round-trip removes a plugin and returns its id", async () => {
    writeManifest({ version: 2, plugins: { "gone@m": [{ installPath: "/x" }] } });
    const r = (await runQuartersAction({ action: "plugin.remove", key: "gone@m" })) as CrudResult;
    expect(r.ok).toBe(true);
    expect(r.id).toBe("plugin:gone@m");
    expect(Object.keys(readManifest().plugins)).toEqual([]);
  });
});
