import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  validatePermissionRule,
  validateNumber,
  validateEnvKey,
  validateForKey,
  assembleObjectValue,
  missingRequired,
  passthroughKeys,
  parsePermissionRule,
  buildPermissionRule
} from "@/lib/settings-validate";
import { KNOWN_SETTINGS, PERMISSION_TOOL_PREFIXES, type FieldDesc } from "@/lib/settings-catalog";

const ROOT = path.resolve(__dirname, "..");
const schema = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src", "lib", "claude-settings-schema.json"), "utf8")
) as { $defs: { permissionRule: { examples: string[] } } };

function fieldsOf(key: string): FieldDesc[] {
  const entry = KNOWN_SETTINGS.find((s) => s.key === key);
  if (!entry?.fields) throw new Error(`no fields for ${key}`);
  return entry.fields;
}

describe("validatePermissionRule", () => {
  it("accepts every example the official schema ships (all 19)", () => {
    const examples = schema.$defs.permissionRule.examples;
    expect(examples.length).toBeGreaterThanOrEqual(19);
    for (const ex of examples) {
      expect(validatePermissionRule(ex), ex).toBeNull();
    }
  });

  it("rejects invalid rules with a message", () => {
    for (const bad of ["", "  ", "bash(ls)", "NotATool(x)", "Bash()", "Bash(unclosed", "Tool"]) {
      expect(validatePermissionRule(bad), JSON.stringify(bad)).toBeTypeOf("string");
    }
  });

  it("round-trips through parse + build for structured rules", () => {
    const parsed = parsePermissionRule("Bash(git add:*)", PERMISSION_TOOL_PREFIXES);
    expect(parsed).toEqual({ tool: "Bash", specifier: "git add:*" });
    expect(buildPermissionRule(parsed!.tool, parsed!.specifier)).toBe("Bash(git add:*)");
    expect(parsePermissionRule("WebFetch", PERMISSION_TOOL_PREFIXES)).toEqual({ tool: "WebFetch", specifier: "" });
    expect(buildPermissionRule("WebFetch", "")).toBe("WebFetch");
    // mcp__ rules are valid but NOT tool/specifier structured — render raw
    expect(validatePermissionRule("mcp__github__search_repositories")).toBeNull();
    expect(parsePermissionRule("mcp__github__search_repositories", PERMISSION_TOOL_PREFIXES)).toBeNull();
  });
});

describe("validateNumber / validateEnvKey", () => {
  it("enforces min, max and integer-ness", () => {
    expect(validateNumber(1, { min: 1, integer: true })).toBeNull();
    expect(validateNumber(0, { min: 1 })).toMatch(/at least 1/);
    expect(validateNumber(1.5, { integer: true })).toMatch(/integer/);
    expect(validateNumber(70000, { min: 1, max: 65535 })).toMatch(/at most 65535/);
    expect(validateNumber(0.5, { min: 0, max: 1 })).toBeNull();
    expect(validateNumber(NaN, {})).toMatch(/Not a number/);
  });

  it("validates env var names", () => {
    expect(validateEnvKey("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS")).toBeNull();
    expect(validateEnvKey("_PRIVATE")).toBeNull();
    for (const bad of ["lower", "1LEADING", "WITH-DASH", "WITH SPACE", ""]) {
      expect(validateEnvKey(bad), bad).toBeTypeOf("string");
    }
  });
});

describe("validateForKey — structural checks for json-control keys", () => {
  const entry = (key: string) => {
    const e = KNOWN_SETTINGS.find((s) => s.key === key);
    if (!e) throw new Error(`unknown ${key}`);
    return e;
  };

  it("enabledPlugins: plugin@marketplace map to boolean | string[]", () => {
    const e = entry("enabledPlugins");
    expect(validateForKey(e, { "formatter@anthropic-tools": true })).toBeNull();
    expect(validateForKey(e, { "a@m": ["skills", "hooks"] })).toBeNull();
    expect(validateForKey(e, ["formatter@anthropic-tools"])).toMatch(/object map/);
    expect(validateForKey(e, { noMarketplace: true })).toMatch(/plugin@marketplace/);
    expect(validateForKey(e, { "a@m": "yes" })).toMatch(/true\/false or an array/);
  });

  it("pluginConfigs: map of objects", () => {
    const e = entry("pluginConfigs");
    expect(validateForKey(e, { "a@m": { options: { x: 1 } } })).toBeNull();
    expect(validateForKey(e, { "a@m": "nope" })).toMatch(/must be an object/);
  });

  it("extraKnownMarketplaces: map of { source: {...} }", () => {
    const e = entry("extraKnownMarketplaces");
    expect(validateForKey(e, { mine: { source: { source: "github", repo: "o/r" } } })).toBeNull();
    expect(validateForKey(e, { mine: { repo: "o/r" } })).toMatch(/source object/);
  });

  it("allowed/deniedMcpServers: exactly one discriminator per entry", () => {
    for (const key of ["allowedMcpServers", "deniedMcpServers"]) {
      const e = entry(key);
      expect(validateForKey(e, [{ serverName: "github" }])).toBeNull();
      expect(validateForKey(e, [{ serverCommand: ["npx", "x"] }])).toBeNull();
      expect(validateForKey(e, [{ serverUrl: "https://x" }])).toBeNull();
      expect(validateForKey(e, [{}])).toMatch(/exactly one/);
      expect(validateForKey(e, [{ serverName: "a", serverUrl: "b" }])).toMatch(/exactly one/);
      expect(validateForKey(e, [{ serverCommand: "npx x" }])).toMatch(/array of strings/);
      expect(validateForKey(e, { serverName: "a" })).toMatch(/array/);
    }
  });

  it("strict/blocked marketplaces: items carry a known source discriminator", () => {
    for (const key of ["strictKnownMarketplaces", "blockedMarketplaces"]) {
      const e = entry(key);
      expect(validateForKey(e, [{ source: "github", repo: "o/r" }])).toBeNull();
      expect(validateForKey(e, [{ source: "hostPattern", hostPattern: "*.corp" }])).toBeNull();
      expect(validateForKey(e, [{ source: "ftp" }])).toMatch(/source of/);
      expect(validateForKey(e, ["github"])).toMatch(/must be an object/);
    }
  });

  it("strictPluginOnlyCustomization: boolean or surface array", () => {
    const e = entry("strictPluginOnlyCustomization");
    expect(validateForKey(e, true)).toBeNull();
    expect(validateForKey(e, false)).toBeNull();
    expect(validateForKey(e, ["skills", "mcp"])).toBeNull();
    expect(validateForKey(e, ["plugins"])).toMatch(/skills/);
    expect(validateForKey(e, "all")).toMatch(/true\/false/);
  });

  it("unset is always valid; generic floors catch shape mismatches", () => {
    expect(validateForKey(entry("enabledPlugins"), undefined)).toBeNull();
    expect(validateForKey(entry("availableModels"), "not-a-list")).toMatch(/array of strings/);
    expect(validateForKey(entry("env"), [])).toMatch(/object map/);
  });
});

describe("assembleObjectValue — round-trip sanctity (the correctness core)", () => {
  it("preserves unknown future subkeys when editing a sibling (sandbox)", () => {
    const fields = fieldsOf("sandbox");
    const current = { enabled: false, someFutureSubkey: { keep: "me" } };
    const next = assembleObjectValue(fields, current, "enabled", true);
    expect(next).toEqual({ enabled: true, someFutureSubkey: { keep: "me" } });
  });

  it("clearing the last real subfield unsets the whole key", () => {
    const fields = fieldsOf("sandbox");
    expect(assembleObjectValue(fields, { enabled: true }, "enabled", undefined)).toBeUndefined();
    // ...but NOT when an unknown passthrough subkey remains (round-trip sanctity)
    expect(assembleObjectValue(fields, { enabled: true, future: 1 }, "enabled", undefined)).toEqual({
      future: 1
    });
  });

  it("auto-injects const subfields when a sibling is set (statusLine.type)", () => {
    const fields = fieldsOf("statusLine");
    const next = assembleObjectValue(fields, undefined, "command", "~/bin/line.sh");
    expect(next).toEqual({ type: "command", command: "~/bin/line.sh" });
    // and a const-only remainder collapses to unset
    expect(assembleObjectValue(fields, { type: "command", command: "x" }, "command", undefined)).toBeUndefined();
  });

  it("missingRequired names absent required subfields (statusLine without command)", () => {
    const fields = fieldsOf("statusLine");
    expect(missingRequired(fields, { padding: 2, type: "command" })).toEqual(["command"]);
    expect(missingRequired(fields, { command: "x" })).toEqual([]);
    expect(missingRequired(fields, undefined)).toEqual([]);
    // spinnerVerbs.verbs is required (object-form with a required list)
    expect(missingRequired(fieldsOf("spinnerVerbs"), { mode: "append" })).toEqual(["verbs"]);
  });

  it('keeps a meaningful empty string (attribution.commit = "")', () => {
    const fields = fieldsOf("attribution");
    const next = assembleObjectValue(fields, { pr: "x" }, "commit", "");
    expect(next).toEqual({ pr: "x", commit: "" });
  });

  it("lists passthrough subkeys for the muted editor note", () => {
    const fields = fieldsOf("sandbox");
    expect(passthroughKeys(fields, { enabled: true, future: 1, other: 2 })).toEqual(["future", "other"]);
    expect(passthroughKeys(fields, undefined)).toEqual([]);
  });
});
