import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { pathExists } from "./fs-utils";

// Composition v3 -> v4 migrator (MARATHON-V3 S3b1, migration discipline
// constraint 10). Backs up the original beside itself (apm.yml.v3.bak), stamps
// `schema: 4`, and extracts machine-local selection config values into a
// gitignored local.yml overlay so the committed manifest stays portable. Prints
// a unified diff. Refuses to run twice (the .v3.bak marker). Never touches
// routing.json — the router->duties migration is a separate slice.
//
// NOTE (YAML comments): compositions.ts and this migrator both use js-yaml,
// which does NOT preserve comments on load->dump. The committed default
// composition apm.yml carries no comments today, so nothing is lost there; a
// future hand-commented composition would lose its comments through this
// migrator. Flagged rather than solved (no round-tripping YAML lib in the repo).

export interface CompositionMigrationResult {
  ok: boolean;
  // true when the migrator refused because the .v3.bak marker already exists.
  skipped: boolean;
  reason?: string;
  apmPath: string;
  backupPath: string;
  localPath: string;
  // Unified diff of apm.yml (before -> after). Empty string when skipped.
  diff: string;
  // The local.yml body written, or null when no machine-local values were found.
  localYml: string | null;
}

const YAML_DUMP_OPTS: yaml.DumpOptions = { lineWidth: 100, noRefs: true, sortKeys: false };

interface SelectionItem {
  id?: unknown;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

type SelectionMap = Record<string, SelectionItem[]>;

export async function migrateCompositionV3ToV4(
  compositionDir: string
): Promise<CompositionMigrationResult> {
  const apmPath = path.join(compositionDir, "apm.yml");
  const backupPath = path.join(compositionDir, "apm.yml.v3.bak");
  const localPath = path.join(compositionDir, "local.yml");

  // (a) Idempotence: the backup file is the marker. Refuse loudly if present.
  if (await pathExists(backupPath)) {
    return {
      ok: false,
      skipped: true,
      reason:
        `refusing to migrate: ${backupPath} already exists (this composition was ` +
        `already migrated to v4). Delete the .v3.bak marker to force a re-run.`,
      apmPath,
      backupPath,
      localPath,
      diff: "",
      localYml: null
    };
  }

  const rawBefore = await fs.readFile(apmPath, "utf8");
  const manifest = yaml.load(rawBefore) as
    | { "x-garrison"?: { composition?: Record<string, unknown> } }
    | null;
  const composition = manifest?.["x-garrison"]?.composition;
  if (!manifest || !composition || typeof composition !== "object") {
    throw new Error(`${apmPath} has no x-garrison.composition block; not a composition manifest`);
  }

  const home = os.homedir();
  const overlaySelections: SelectionMap = {};
  const overlayGlobalConfig: Record<string, unknown> = {};

  // (d0) Extract machine-local PATHS out of global_config (codex S3b1 finding:
  // projects_root: ~/dev is a home path that must not stay in the committed
  // manifest). Only path-shaped values move; ports/scalars/nested config-objects
  // (guardrails, observability_config) are portable and stay. A moved key is
  // deleted from apm.yml and lands in the overlay's global_config.
  const globalConfig = composition.global_config;
  if (globalConfig && typeof globalConfig === "object") {
    for (const [key, value] of Object.entries(globalConfig as Record<string, unknown>)) {
      if (classifyConfigValue(key, value, home) === "path") {
        overlayGlobalConfig[key] = value;
        delete (globalConfig as Record<string, unknown>)[key];
      }
    }
  }

  // (d) Extract machine-local values out of selections[].config.
  const selections = (composition.selections ?? {}) as SelectionMap;
  for (const [faculty, items] of Object.entries(selections)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const config = item?.config;
      if (!config || typeof config !== "object") continue;
      for (const [key, value] of Object.entries(config)) {
        const classification = classifyConfigValue(key, value, home);
        if (classification === "keep") continue;
        // Both "port" (kept in apm.yml as a portable default) and "path"
        // (removed from apm.yml) are copied into the overlay.
        pushOverlayValue(overlaySelections, faculty, item.id, key, value);
        if (classification === "path") {
          delete config[key];
        }
      }
    }
  }

  // (c) Stamp schema: 4 first inside the composition block (readable ordering).
  const { schema: _priorSchema, ...compositionRest } = composition;
  void _priorSchema;
  const migratedComposition = { schema: 4, ...compositionRest };
  const migratedManifest = {
    ...manifest,
    "x-garrison": { ...manifest["x-garrison"], composition: migratedComposition }
  };

  const rawAfter = yaml.dump(migratedManifest, YAML_DUMP_OPTS);

  const hasGlobalOverlay = Object.keys(overlayGlobalConfig).length > 0;
  const hasSelectionOverlay = Object.keys(overlaySelections).length > 0;
  const hasOverlay = hasGlobalOverlay || hasSelectionOverlay;
  const localYml = hasOverlay
    ? yaml.dump(
        {
          // A partial mirror of x-garrison.composition, deep-merged over apm.yml
          // at read (see compositions.readLocalOverlay). Machine-local; gitignored.
          ...(hasGlobalOverlay ? { global_config: overlayGlobalConfig } : {}),
          ...(hasSelectionOverlay ? { selections: overlaySelections } : {})
        },
        YAML_DUMP_OPTS
      )
    : null;

  // (b) Back up the exact original bytes, then write the migrated file.
  await fs.writeFile(backupPath, rawBefore, "utf8");
  await fs.writeFile(apmPath, rawAfter, "utf8");
  if (localYml) {
    const banner =
      `# Machine-local overlay for this composition. Gitignored; deep-merged over\n` +
      `# apm.yml at read (overlay wins). Holds host-specific ports/paths so the\n` +
      `# committed apm.yml stays portable. Safe to edit or delete.\n`;
    await fs.writeFile(localPath, banner + localYml, "utf8");
  }

  const diff = unifiedDiff("apm.yml", rawBefore, rawAfter);

  return {
    ok: true,
    skipped: false,
    apmPath,
    backupPath,
    localPath,
    diff,
    localYml
  };
}

type ValueClassification = "keep" | "port" | "path";

// Decide whether a selection config value is machine-local, and how the
// committed apm.yml should treat it:
//   "keep" - portable/shared config, untouched.
//   "port" - port / bind_host / localhost URL: copied to local.yml, but the
//            value stays in apm.yml as a portable default.
//   "path" - a filesystem path (home dir / absolute / tilde): moved to
//            local.yml and removed from apm.yml.
function classifyConfigValue(key: string, value: unknown, home: string): ValueClassification {
  if (key === "port" || key.endsWith("_port") || key === "bind_host") {
    return "port";
  }
  if (typeof value === "string") {
    if (key.endsWith("_url") && isLocalhostUrl(value)) {
      return "port";
    }
    if (isPathShaped(value, home)) {
      return "path";
    }
  }
  return "keep";
}

function isLocalhostUrl(value: string): boolean {
  return /^\w+:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)([:/]|$)/.test(value);
}

function isPathShaped(value: string, home: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith("~") || value.startsWith("/")) return true;
  if (home.length > 0 && value.includes(home)) return true;
  return false;
}

function pushOverlayValue(
  overlay: SelectionMap,
  faculty: string,
  id: unknown,
  key: string,
  value: unknown
): void {
  const items = (overlay[faculty] ??= []);
  let entry = items.find((candidate) => candidate.id === id);
  if (!entry) {
    entry = { id: id as string, config: {} };
    items.push(entry);
  }
  (entry.config ??= {})[key] = value;
}

// Minimal LCS-based unified diff (the repo has no `diff` dependency). Groups
// changed lines into hunks with 3 lines of surrounding context. Adequate for
// the migrator's before/after, which differ only by the added schema line and a
// handful of removed path keys.
export function unifiedDiff(label: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a, b);

  const context = 3;
  const changedIndexes = ops
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => op.type !== "equal")
    .map(({ index }) => index);
  if (changedIndexes.length === 0) {
    return `--- a/${label}\n+++ b/${label}\n(no changes)`;
  }

  // Build hunk boundaries in op-index space, merging ranges within 2*context.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }

  const lines: string[] = [`--- a/${label}`, `+++ b/${label}`];
  for (const range of ranges) {
    let aStart = 0;
    let bStart = 0;
    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let i = range.start; i <= range.end; i++) {
      const op = ops[i];
      if (op.type === "equal") {
        if (aCount === 0 && bCount === 0) {
          aStart = op.aIndex;
          bStart = op.bIndex;
        }
        aCount++;
        bCount++;
        body.push(` ${op.line}`);
      } else if (op.type === "del") {
        if (aCount === 0 && bCount === 0) {
          aStart = op.aIndex;
          bStart = op.bIndex;
        }
        aCount++;
        body.push(`-${op.line}`);
      } else {
        if (aCount === 0 && bCount === 0) {
          aStart = op.aIndex;
          bStart = op.bIndex;
        }
        bCount++;
        body.push(`+${op.line}`);
      }
    }
    lines.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`);
    lines.push(...body);
  }
  return lines.join("\n");
}

type DiffOp =
  | { type: "equal"; line: string; aIndex: number; bIndex: number }
  | { type: "del"; line: string; aIndex: number; bIndex: number }
  | { type: "add"; line: string; aIndex: number; bIndex: number };

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i], aIndex: i, bIndex: j });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: "del", line: a[i], aIndex: i, bIndex: j });
      i++;
    } else {
      ops.push({ type: "add", line: b[j], aIndex: i, bIndex: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "del", line: a[i], aIndex: i, bIndex: j });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", line: b[j], aIndex: i, bIndex: j });
    j++;
  }
  return ops;
}
