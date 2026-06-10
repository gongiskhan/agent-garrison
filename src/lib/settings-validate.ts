import { PERMISSION_RULE_PATTERN, type FieldDesc, type KnownSetting } from "./settings-catalog";

// Pure validation + object-form assembly for the Settings editors. UI courtesy
// ONLY: the server (writeSettingsPatch / PUT /api/settings) stays permissive —
// validation here keeps invalid input out of the autosave patch queue, it never
// gates what may be written (bespoke keys must always round-trip).

const PERMISSION_RULE_RE = new RegExp(PERMISSION_RULE_PATTERN);

export const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

const MARKETPLACE_SOURCES = new Set([
  "url",
  "hostPattern",
  "github",
  "git",
  "npm",
  "file",
  "directory",
  "pathPattern"
]);

const CUSTOMIZATION_SURFACES = new Set(["skills", "agents", "hooks", "mcp"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// null = valid; a string is the user-facing error message.
export function validatePermissionRule(rule: string): string | null {
  if (rule.trim() === "") return "Rule cannot be empty.";
  if (!PERMISSION_RULE_RE.test(rule)) {
    return 'Not a valid rule — expected Tool, Tool(specifier), or an mcp__ name (e.g. Bash(git add:*)).';
  }
  return null;
}

export function validateNumber(
  value: number,
  d: { min?: number; max?: number; integer?: boolean }
): string | null {
  if (!Number.isFinite(value)) return "Not a number.";
  if (d.integer && !Number.isInteger(value)) return "Must be an integer.";
  if (d.min !== undefined && value < d.min) return `Must be at least ${d.min}.`;
  if (d.max !== undefined && value > d.max) return `Must be at most ${d.max}.`;
  return null;
}

export function validateEnvKey(key: string): string | null {
  if (!ENV_KEY_PATTERN.test(key)) {
    return "Env var names are UPPER_SNAKE_CASE (letters, digits, underscores; no leading digit).";
  }
  return null;
}

// Structural checks for the keys that stay on the raw-JSON control (deep
// unions / maps-of-objects the schema models with anyOf). Mirrors the vendored
// schema's shapes; tests/settings-validate.test.ts keeps them honest.
function validateMcpServerList(value: unknown): string | null {
  if (!Array.isArray(value)) return "Expected an array of server entries.";
  for (const item of value) {
    if (!isPlainObject(item)) return "Each entry must be an object.";
    const keys = Object.keys(item);
    const discriminators = keys.filter((k) => ["serverName", "serverCommand", "serverUrl"].includes(k));
    if (discriminators.length !== 1) {
      return "Each entry needs exactly one of serverName, serverCommand, serverUrl.";
    }
    const [d] = discriminators;
    if (d === "serverCommand") {
      if (!Array.isArray(item[d]) || !(item[d] as unknown[]).every((s) => typeof s === "string")) {
        return "serverCommand must be an array of strings.";
      }
    } else if (typeof item[d] !== "string") {
      return `${d} must be a string.`;
    }
  }
  return null;
}

function validateMarketplaceSourceList(value: unknown): string | null {
  if (!Array.isArray(value)) return "Expected an array of marketplace-source entries.";
  for (const item of value) {
    if (!isPlainObject(item)) return "Each entry must be an object.";
    const source = item.source;
    if (typeof source !== "string" || !MARKETPLACE_SOURCES.has(source)) {
      return `Each entry needs a source of: ${[...MARKETPLACE_SOURCES].join(", ")}.`;
    }
  }
  return null;
}

export function validateForKey(
  entry: Pick<KnownSetting, "key" | "control">,
  value: unknown
): string | null {
  if (value === undefined) return null; // unset is always fine
  switch (entry.key) {
    case "enabledPlugins": {
      if (!isPlainObject(value)) return 'Expected an object map of "plugin@marketplace" to true/false or a component array.';
      for (const [k, v] of Object.entries(value)) {
        if (!k.includes("@")) return `"${k}" should be a plugin@marketplace ID.`;
        const ok = typeof v === "boolean" || (Array.isArray(v) && v.every((s) => typeof s === "string"));
        if (!ok) return `Value for "${k}" must be true/false or an array of component names.`;
      }
      return null;
    }
    case "pluginConfigs": {
      if (!isPlainObject(value)) return "Expected an object map of plugin@marketplace IDs to config objects.";
      for (const [k, v] of Object.entries(value)) {
        if (!isPlainObject(v)) return `Config for "${k}" must be an object.`;
      }
      return null;
    }
    case "extraKnownMarketplaces": {
      if (!isPlainObject(value)) return "Expected an object map of marketplace names to { source: ... } entries.";
      for (const [k, v] of Object.entries(value)) {
        if (!isPlainObject(v) || !isPlainObject(v.source)) {
          return `"${k}" must be an object with a source object.`;
        }
      }
      return null;
    }
    case "allowedMcpServers":
    case "deniedMcpServers":
      return validateMcpServerList(value);
    case "strictKnownMarketplaces":
    case "blockedMarketplaces":
      return validateMarketplaceSourceList(value);
    case "strictPluginOnlyCustomization": {
      if (typeof value === "boolean") return null;
      if (Array.isArray(value) && value.every((s) => typeof s === "string" && CUSTOMIZATION_SURFACES.has(s))) {
        return null;
      }
      return 'Expected true/false or an array of "skills", "agents", "hooks", "mcp".';
    }
    default: {
      // Generic structural floor by control type, for json-mode fallbacks.
      if (entry.control === "string-list" || entry.control === "permission-rules") {
        if (!Array.isArray(value) || !value.every((s) => typeof s === "string")) {
          return "Expected an array of strings.";
        }
        return null;
      }
      if (entry.control === "string-map" || entry.control === "enum-map" || entry.control === "string-list-map") {
        if (!isPlainObject(value)) return "Expected an object map.";
        return null;
      }
      if (entry.control === "object-form" && !isPlainObject(value)) return "Expected an object.";
      return null;
    }
  }
}

// ── Object-form assembly ────────────────────────────────────────────────────
//
// The correctness core of the structured editors: editing one subfield
// assembles the WHOLE new top-level object by spreading the current one, so
// unrecognized subkeys (a future Claude Code version's additions, bespoke
// experiments) round-trip untouched — the bespoke-passthrough invariant one
// level down. The caller queues { <topLevelKey>: assembled } exactly like the
// JSON control always has, which is what writeSettingsPatch merges.

export function assembleObjectValue(
  fields: FieldDesc[],
  current: unknown,
  key: string,
  next: unknown
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  if (next === undefined) {
    delete base[key];
  } else {
    base[key] = next;
  }
  const constKeys = new Set(fields.filter((f) => f.constValue !== undefined).map((f) => f.key));
  const realKeys = Object.keys(base).filter((k) => base[k] !== undefined && !constKeys.has(k));
  // Clearing the last real subfield unsets the whole key (const-only objects
  // like { type: "command" } carry no information).
  if (realKeys.length === 0) return undefined;
  for (const f of fields) {
    if (f.constValue !== undefined) base[f.key] = f.constValue;
  }
  return base;
}

// Required subfields absent from the value (only meaningful while the object
// exists — an unset top-level key is always valid).
export function missingRequired(fields: FieldDesc[], value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  return fields
    .filter((f) => f.required && f.constValue === undefined)
    .filter((f) => value[f.key] === undefined)
    .map((f) => f.key);
}

// Subkeys present in the value that the catalog's field list does not know —
// surfaced as a muted "passthrough subkeys" note in the editor, preserved by
// assembleObjectValue's spread.
export function passthroughKeys(fields: FieldDesc[], value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  const known = new Set(fields.map((f) => f.key));
  return Object.keys(value).filter((k) => !known.has(k));
}

// Parse one permission rule into its tool + specifier when it matches the
// Tool(specifier) shape; mcp__ rules and legacy non-matching strings return
// null and render as raw text (never silently rewritten).
export function parsePermissionRule(
  rule: string,
  toolPrefixes: string[]
): { tool: string; specifier: string } | null {
  const m = rule.match(/^([A-Za-z]+)(?:\((.+)\))?$/);
  if (!m || !toolPrefixes.includes(m[1])) return null;
  return { tool: m[1], specifier: m[2] ?? "" };
}

export function buildPermissionRule(tool: string, specifier: string): string {
  const spec = specifier.trim();
  return spec === "" ? tool : `${tool}(${spec})`;
}
