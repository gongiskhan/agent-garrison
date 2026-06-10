import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  KNOWN_SETTINGS,
  GROUP_ORDER,
  PERMISSION_RULE_PATTERN,
  PERMISSION_TOOL_PREFIXES,
  HOOK_EVENT_NAMES,
  type FieldDesc,
  type KnownSetting
} from "@/lib/settings-catalog";

// The sync gate: settings-catalog.ts must mirror the VENDORED official schema
// (src/lib/claude-settings-schema.json). On a Claude Code version bump, run
// `npm run refresh:settings-schema` and let the failures here name exactly
// which catalog lines to edit. The schema is read with fs — runtime code must
// never import it (guard spec at the bottom).

const ROOT = path.resolve(__dirname, "..");
const SCHEMA_PATH = path.join(ROOT, "src", "lib", "claude-settings-schema.json");

interface SchemaNode {
  type?: string | string[];
  description?: string;
  enum?: string[];
  const?: string;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
  required?: string[];
  anyOf?: SchemaNode[];
  $defs?: Record<string, SchemaNode & { pattern?: string; examples?: string[] }>;
}

const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as SchemaNode & {
  $defs: Record<string, { pattern: string; examples: string[] }>;
};
const schemaProps = schema.properties as Record<string, SchemaNode>;

// `hooks` is deliberately not a catalog row: Settings renders it read-only and
// CRUD lives in Quarters > Hooks. `$schema` is the schema's own self-reference.
const NON_CATALOG_KEYS = new Set(["$schema", "hooks"]);

// Keys whose descriptions do not carry the literal managed-only marker but are
// enterprise controls all the same (schema says "Enterprise allow/denylist").
const EXTRA_MANAGED_TOP = new Set(["allowedMcpServers", "deniedMcpServers"]);
// Nested fields with a non-standard marker phrasing ("Only honored from
// managed (policy) settings").
const EXTRA_MANAGED_FIELDS = new Set(["sandbox.enabledPlatforms"]);

const MANAGED_MARKER = /\((Managed setting|Admin\/managed|Windows managed)/;

function describesManaged(desc: string | undefined, pathKey: string, extra: Set<string>): boolean {
  return extra.has(pathKey) || MANAGED_MARKER.test(desc ?? "");
}

function nodeAt(parts: string[]): SchemaNode | undefined {
  let node: SchemaNode | undefined = schemaProps[parts[0]];
  for (const part of parts.slice(1)) {
    node = node?.properties?.[part];
  }
  return node;
}

// Walk every catalog entry + nested field with its dotted path and schema node.
function* walkFields(
  fields: FieldDesc[] | undefined,
  prefix: string
): Generator<{ pathKey: string; field: FieldDesc; node: SchemaNode | undefined }> {
  for (const f of fields ?? []) {
    const pathKey = `${prefix}.${f.key}`;
    const node = nodeAt(pathKey.split("."));
    yield { pathKey, field: f, node };
    if (f.control === "object-form") yield* walkFields(f.fields, pathKey);
  }
}

describe("settings catalog <-> vendored schema sync", () => {
  it("covers every schema key and carries no stale keys (completeness, both directions)", () => {
    const schemaKeys = Object.keys(schemaProps).filter((k) => !NON_CATALOG_KEYS.has(k));
    const catalogKeys = KNOWN_SETTINGS.map((s) => s.key);
    expect([...catalogKeys].sort()).toEqual([...schemaKeys].sort());
    // no duplicates
    expect(new Set(catalogKeys).size).toBe(catalogKeys.length);
  });

  it("nested object-form fields mirror the schema properties at each level (both directions)", () => {
    for (const entry of KNOWN_SETTINGS.filter((s) => s.control === "object-form")) {
      const check = (fields: FieldDesc[], node: SchemaNode, at: string): void => {
        const schemaKeys = Object.keys(node.properties ?? {});
        const fieldKeys = fields.map((f) => f.key);
        expect([...fieldKeys].sort(), `field set at ${at}`).toEqual([...schemaKeys].sort());
        for (const f of fields) {
          if (f.control === "object-form") {
            const sub = node.properties?.[f.key];
            expect(sub?.properties, `schema object at ${at}.${f.key}`).toBeTruthy();
            check(f.fields ?? [], sub as SchemaNode, `${at}.${f.key}`);
          }
        }
      };
      check(entry.fields ?? [], schemaProps[entry.key], entry.key);
    }
  });

  it("enum values match the schema exactly (order included)", () => {
    for (const entry of KNOWN_SETTINGS) {
      const node = schemaProps[entry.key];
      if (entry.control === "enum") {
        expect(entry.enumValues, `enumValues for ${entry.key}`).toEqual(node.enum);
      }
      if (entry.control === "enum-map") {
        const ap = node.additionalProperties as SchemaNode;
        expect(entry.enumValues, `value enum for ${entry.key}`).toEqual(ap.enum);
      }
      for (const { pathKey, field, node: fnode } of walkFields(entry.fields, entry.key)) {
        if (field.control === "enum") {
          expect(field.enumValues, `enumValues at ${pathKey}`).toEqual(fnode?.enum);
        }
        if (field.control === "string-list" && field.enumValues) {
          expect(field.enumValues, `items enum at ${pathKey}`).toEqual(fnode?.items?.enum);
        }
      }
    }
  });

  it("number bounds and integer-ness match the schema", () => {
    const checkBounds = (
      pathKey: string,
      d: { min?: number; max?: number; integer?: boolean; control: string },
      node: SchemaNode | undefined
    ): void => {
      if (d.control !== "number") return;
      expect(d.min, `min at ${pathKey}`).toBe(node?.minimum);
      expect(d.max, `max at ${pathKey}`).toBe(node?.maximum);
      expect(Boolean(d.integer), `integer at ${pathKey}`).toBe(node?.type === "integer");
    };
    for (const entry of KNOWN_SETTINGS) {
      checkBounds(entry.key, entry, schemaProps[entry.key]);
      for (const { pathKey, field, node } of walkFields(entry.fields, entry.key)) {
        checkBounds(pathKey, field, node);
      }
    }
  });

  it("required and const field markers match the schema", () => {
    for (const entry of KNOWN_SETTINGS.filter((s) => s.control === "object-form")) {
      const walk = (fields: FieldDesc[], node: SchemaNode, at: string): void => {
        const required = new Set(node.required ?? []);
        for (const f of fields) {
          expect(Boolean(f.required), `required at ${at}.${f.key}`).toBe(required.has(f.key));
          const sub = node.properties?.[f.key];
          expect(f.constValue, `const at ${at}.${f.key}`).toBe(sub?.const);
          if (f.control === "object-form") walk(f.fields ?? [], sub as SchemaNode, `${at}.${f.key}`);
        }
      };
      walk(entry.fields ?? [], schemaProps[entry.key], entry.key);
    }
  });

  it("managedOnly flags match the schema's managed-only description markers", () => {
    for (const entry of KNOWN_SETTINGS) {
      const expected = describesManaged(schemaProps[entry.key].description, entry.key, EXTRA_MANAGED_TOP);
      expect(Boolean(entry.managedOnly), `managedOnly for ${entry.key}`).toBe(expected);
      for (const { pathKey, field, node } of walkFields(entry.fields, entry.key)) {
        const expectedField = describesManaged(node?.description, pathKey, EXTRA_MANAGED_FIELDS);
        expect(Boolean(field.managedOnly), `managedOnly at ${pathKey}`).toBe(expectedField);
      }
    }
  });

  it("deprecated flags match DEPRECATED markers in schema descriptions", () => {
    for (const entry of KNOWN_SETTINGS) {
      const expected = /DEPRECATED/.test(schemaProps[entry.key].description ?? "");
      expect(Boolean(entry.deprecated), `deprecated for ${entry.key}`).toBe(expected);
    }
  });

  it("docsUrl, when set, is lifted verbatim from the schema description", () => {
    for (const entry of KNOWN_SETTINGS) {
      if (!entry.docsUrl) continue;
      expect(schemaProps[entry.key].description ?? "", `docsUrl for ${entry.key}`).toContain(entry.docsUrl);
    }
  });

  it("PERMISSION_RULE_PATTERN is byte-equal to the schema's permissionRule pattern", () => {
    expect(PERMISSION_RULE_PATTERN).toBe(schema.$defs.permissionRule.pattern);
    // and the prefix list is exactly the pattern's alternation
    const m = schema.$defs.permissionRule.pattern.match(/^\^\(\(([A-Za-z|]+)\)/);
    expect(m, "pattern alternation parse").toBeTruthy();
    expect(PERMISSION_TOOL_PREFIXES).toEqual(m![1].split("|"));
  });

  it("HOOK_EVENT_NAMES matches the schema's hooks block", () => {
    const events = Object.keys((schemaProps.hooks.properties ?? {}) as Record<string, unknown>);
    expect([...HOOK_EVENT_NAMES].sort()).toEqual([...events].sort());
  });

  it("control shapes are internally coherent", () => {
    const checkShape = (d: KnownSetting | FieldDesc, at: string): void => {
      if (d.control === "object-form") expect(d.fields?.length, `fields at ${at}`).toBeGreaterThan(0);
      if (d.control === "enum" || d.control === "enum-map") {
        expect(d.enumValues?.length, `enumValues at ${at}`).toBeGreaterThan(0);
      }
      if (d.control !== "object-form") expect(d.fields, `stray fields at ${at}`).toBeUndefined();
    };
    for (const entry of KNOWN_SETTINGS) {
      checkShape(entry, entry.key);
      expect(GROUP_ORDER.some((g) => g.id === entry.group), `group of ${entry.key}`).toBe(true);
      for (const { pathKey, field } of walkFields(entry.fields, entry.key)) checkShape(field, pathKey);
    }
  });

  it("the vendored schema is never imported by runtime code (bundle hygiene)", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs);
        } else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = fs.readFileSync(abs, "utf8");
          if (/(from\s+["'][^"']*claude-settings-schema|require\([^)]*claude-settings-schema|import\([^)]*claude-settings-schema)/.test(src)) {
            offenders.push(abs);
          }
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });
});
