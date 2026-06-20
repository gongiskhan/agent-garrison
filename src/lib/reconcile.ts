import fsp from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { claudeHome, capturedFittingsDir } from "./claude-home";
import { pathExists } from "./fs-utils";
import { writeYamlFile } from "./yaml";
import { hashFile } from "./claude-scan";
import { computeStateModel, type PrimitiveRecord, type PrimitiveSurface } from "./primitive-state";
import { readLedger } from "./provenance";

// Reconcile = the scoped importer, promoted from a one-time script to a reusable
// lib. It captures LOOSE primitives (on disk under ~/.claude, not in the lock) as
// minimal APM-package fittings so they can be promoted to owned. Callable at:
//   - bootstrap        — first run: capture the whole existing install
//   - post-authoring   — after a Garrison-hosted authoring op + apm install
//   - on-demand        — user-triggered "re-sync ~/.claude"
//
// Echo suppression is HASH-COMPARE (not ignore-next): a loose primitive whose
// current on-disk hash equals the provenance ledger's lastWrittenHash is our own
// recent write echoing back, so it's skipped rather than re-captured.
//
// Surfaces: skill/command/rule are emitted (known .apm source mapping). hook/mcp/
// plugin are counted as deferred — hooks live in settings.json (the S3 writer
// owns them), MCP/plugin emission are discovery-gated (SP1/SP6).

export type ReconcileTrigger = "bootstrap" | "post-authoring" | "on-demand";

export interface ReconcileOpts {
  trigger: ReconcileTrigger;
  claudeHome?: string;
  storeDir?: string;
  surfaces?: PrimitiveSurface[];
}

export interface ReconcileReport {
  imported: string[]; // primitive ids newly captured as fittings
  skipped: string[]; // already captured (fitting dir exists)
  suppressedEchoes: string[]; // ids whose on-disk hash == ledger lastWrittenHash
  adopted: string[]; // HV7: present + ENABLED presence-managed ids (hook/mcp/plugin), parked store untouched
  deferred: Record<string, number>; // surface -> count not yet emittable
  table: string;
}

export function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const obj = yaml.load(text.slice(3, end));
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface ParsedHookGroup {
  event: string; // e.g. "SessionStart"
  matcher: string; // "" when the group has no matcher
  hooks: { type: string; command: string; timeout?: number }[];
}

// Read the UNTAGGED hook groups from ~/.claude/settings.json — the hand-authored
// groups with no `_garrison` owner tag. These are the loose-hook analogue of a
// loose skill: capturable as installable `component_shape: hook` fittings (S5
// follow-up). Garrison-owned groups (tagged) are skipped; the keep-both decision
// keeps the untagged originals on disk untouched — capture is emit-only.
export async function readUntaggedHookGroups(home: string = claudeHome()): Promise<ParsedHookGroup[]> {
  let settings: unknown;
  try {
    settings = JSON.parse(await fsp.readFile(path.join(home, "settings.json"), "utf8"));
  } catch {
    return [];
  }
  const hooks = (settings as { hooks?: Record<string, unknown> })?.hooks;
  if (!hooks || typeof hooks !== "object") return [];

  const out: ParsedHookGroup[] = [];
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      if (!g || typeof g !== "object") continue;
      const group = g as { _garrison?: unknown; matcher?: unknown; hooks?: unknown };
      if (group._garrison !== undefined) continue; // Garrison-owned -> not loose
      const rawHooks = Array.isArray(group.hooks) ? group.hooks : [];
      const parsed = rawHooks
        .filter((h): h is { command: string; type?: unknown; timeout?: unknown } =>
          Boolean(h) && typeof (h as { command?: unknown }).command === "string"
        )
        .map((h) => ({
          type: typeof h.type === "string" ? h.type : "command",
          command: String(h.command),
          ...(typeof h.timeout === "number" ? { timeout: h.timeout } : {})
        }));
      if (parsed.length === 0) continue;
      out.push({
        event,
        matcher: typeof group.matcher === "string" ? group.matcher : "",
        hooks: parsed
      });
    }
  }
  return out;
}

// Content hash for echo suppression: the canonical file of the primitive.
// Exported so state-transitions can snapshot the same hash into the ledger after
// a Garrison-initiated write (pre-suppressing the watcher echo).
export async function primitiveHash(home: string, rec: PrimitiveRecord): Promise<string> {
  const rel = rec.path!;
  if (rec.surface === "skill") return hashFile(path.join(home, rel, "SKILL.md"));
  return hashFile(path.join(home, rel));
}

// Package a single loose primitive into a minimal APM fitting in `storeDir`,
// reversing APM's .apm -> .claude deploy mapping. Returns the fitting dir.
export async function emitFitting(
  home: string,
  storeDir: string,
  rec: PrimitiveRecord
): Promise<string> {
  const fittingDir = path.join(storeDir, rec.name);
  const rel = rec.path!;
  let type: string;

  if (rec.surface === "skill") {
    const dest = path.join(fittingDir, ".apm", "skills", rec.name);
    await fsp.mkdir(dest, { recursive: true });
    await fsp.cp(path.join(home, rel), dest, { recursive: true });
    type = "skill";
  } else if (rec.surface === "command") {
    const dest = path.join(fittingDir, ".apm", "prompts", `${rec.name}.prompt.md`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(path.join(home, rel), dest);
    type = "hybrid";
  } else if (rec.surface === "rule") {
    const dest = path.join(fittingDir, ".apm", "instructions", `${rec.name}.instructions.md`);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.cp(path.join(home, rel), dest);
    type = "hybrid";
  } else {
    throw new Error(`emitFitting: unsupported surface ${rec.surface}`);
  }

  await writeYamlFile(path.join(fittingDir, "apm.yml"), {
    name: rec.name,
    version: "0.1.0",
    target: "claude",
    type,
    includes: "auto"
  });
  return fittingDir;
}

const EMITTABLE: PrimitiveSurface[] = ["skill", "command", "rule"];

export async function reconcile(opts: ReconcileOpts): Promise<ReconcileReport> {
  const home = opts.claudeHome ?? claudeHome();
  const storeDir = opts.storeDir ?? capturedFittingsDir();
  const surfaces = opts.surfaces ?? EMITTABLE;
  const model = await computeStateModel({ claudeHome: home });
  const ledger = await readLedger();

  const imported: string[] = [];
  const skipped: string[] = [];
  const suppressedEchoes: string[] = [];
  const adopted: string[] = [];
  const deferred: Record<string, number> = { hook: 0, mcp: 0, plugin: 0 };

  for (const rec of model.records) {
    if (rec.state !== "loose") continue;
    if (!EMITTABLE.includes(rec.surface)) {
      // HV7: hook/mcp/plugin are presence-managed (no file to emit). An ENABLED
      // one is ADOPTED as-is — it already surfaces with no Garrison install, and
      // we PARK NOTHING (a fresh bootstrap leaves the parked store empty). Parked
      // records are skipped; anything else still counts as deferred.
      // Drift (a primitive in BOTH active and parked) never reaches here as a
      // separate record — computeStateModel resolves active-wins — and is
      // surfaced separately by checkCompositionInvariants (HV9), not masked here.
      if (rec.presence === "enabled") adopted.push(rec.id);
      else if (rec.presence !== "parked") deferred[rec.surface] = (deferred[rec.surface] ?? 0) + 1;
      continue;
    }
    if (!surfaces.includes(rec.surface)) continue;

    const curHash = await primitiveHash(home, rec);
    if (ledger[rec.id]?.lastWrittenHash && ledger[rec.id].lastWrittenHash === curHash) {
      suppressedEchoes.push(rec.id);
      continue;
    }

    if (await pathExists(path.join(storeDir, rec.name))) {
      skipped.push(rec.id);
      continue;
    }

    await emitFitting(home, storeDir, rec);
    imported.push(rec.id);
  }

  const table = `trigger=${opts.trigger} imported=${imported.length} skipped=${skipped.length} echoes=${suppressedEchoes.length} adopted=${adopted.length} deferred=${JSON.stringify(deferred)}`;
  return { imported, skipped, suppressedEchoes, adopted, deferred, table };
}
