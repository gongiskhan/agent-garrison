// quarters-runtimes.ts — the Quarters runtime dimension (GARRISON-RUNTIMES-V1
// P5/D5/D6).
//
// Each runtime Fitting ships a Quarters descriptor in its x-garrison metadata.
// This module resolves the CURRENT composition's selected runtimes to their
// descriptors (tier "deep" maps to a registered implementation — claude-code's
// existing full surface, untouched; tier "generic" drives the descriptor-
// rendered surface), and owns the GENERIC tier's file I/O: reads/writes are
// confined to the descriptor's DECLARED files only (never arbitrary paths),
// with format validation (json via JSON.parse, toml via smol-toml) and a
// baseline-sha guard on writes. Loud, not silent: a descriptor pointing at a
// nonexistent home dir, an undeclared path, or a malformed payload is an
// explicit error, never a fallback.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { writeFileAtomic } from "./atomic-write";
import { readComposition } from "./compositions";
import { readLibrary } from "./library";
import type { QuartersDescriptor, QuartersSettingsFile } from "./types";

// tier "deep" descriptors map to a REGISTERED implementation by id. The only
// deep implementation is the existing claude-code Quarters surface at
// /quarters/[type] — registered as-is, never rendered from the descriptor.
export const DEEP_QUARTERS_REGISTRY: Record<string, { routeBase: string }> = {
  "claude-code": { routeBase: "/quarters" }
};

export interface RuntimeQuartersEntry {
  /** The runtime fitting id (e.g. codex-runtime). */
  fittingId: string;
  /** The engine name from provides (e.g. codex). */
  engine: string;
  descriptor: QuartersDescriptor;
  /** For deep descriptors: the registered route base. */
  deepRouteBase?: string;
  /** Generic tier: whether the declared home dir exists on disk. */
  homeDirExists?: boolean;
  /** Explicit problems (nonexistent home, unregistered deep id) — shown, never swallowed. */
  warnings: string[];
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Resolve the selected runtimes of the composition to their Quarters entries.
// Runtimes without a descriptor are simply absent (a runtime is not obliged to
// be configurable); malformed situations surface as warnings on the entry.
export async function resolveRuntimeQuarters(compositionId?: string): Promise<RuntimeQuartersEntry[]> {
  const [composition, library] = await Promise.all([readComposition(compositionId), readLibrary()]);
  const byId = new Map(library.map((entry) => [entry.id, entry]));
  const out: RuntimeQuartersEntry[] = [];
  for (const sel of composition.selections.runtimes ?? []) {
    const entry = byId.get(sel.id);
    const descriptor = entry?.metadata.quarters_descriptor;
    if (!entry || !descriptor) continue;
    const engine =
      entry.metadata.provides.find((p) => p.kind === "runtime")?.name ?? sel.id;
    const warnings: string[] = [];
    const item: RuntimeQuartersEntry = { fittingId: sel.id, engine, descriptor, warnings };
    if (descriptor.tier === "deep") {
      const deep = DEEP_QUARTERS_REGISTRY[descriptor.id];
      if (deep) {
        item.deepRouteBase = deep.routeBase;
      } else {
        warnings.push(
          `deep quarters descriptor "${descriptor.id}" has no registered implementation — known: ${Object.keys(DEEP_QUARTERS_REGISTRY).join(", ")}`
        );
      }
    } else {
      const home = expandHome(descriptor.home_dir);
      try {
        const stat = await fs.stat(home);
        item.homeDirExists = stat.isDirectory();
        if (!stat.isDirectory()) warnings.push(`declared home_dir ${descriptor.home_dir} is not a directory`);
      } catch {
        item.homeDirExists = false;
        warnings.push(
          `declared home_dir ${descriptor.home_dir} does not exist — is the ${engine} CLI installed? Its native config appears after first run`
        );
      }
    }
    out.push(item);
  }
  return out;
}

// ── Generic-tier file I/O (declared files ONLY) ─────────────────────────────

export interface DeclaredFile {
  kind: "settings" | "context" | "mcp";
  path: string; // as declared (may be ~-prefixed)
  format?: "json" | "toml";
  label?: string;
}

// The complete set of files a descriptor DECLARES. The file API serves exactly
// these — an undeclared path is rejected loudly (path containment by
// allowlist, not by prefix math).
export function declaredFiles(descriptor: QuartersDescriptor): DeclaredFile[] {
  const files: DeclaredFile[] = [];
  for (const sf of descriptor.settings_files ?? []) {
    files.push({ kind: "settings", path: sf.path, format: sf.format, label: (sf as QuartersSettingsFile).label });
  }
  if (descriptor.context_file) {
    // Context files are conventionally relative to the home dir (AGENTS.md).
    const p = descriptor.context_file.includes("/")
      ? descriptor.context_file
      : descriptor.home_dir
        ? `${descriptor.home_dir}/${descriptor.context_file}`
        : descriptor.context_file;
    files.push({ kind: "context", path: p });
  }
  if (descriptor.mcp_config) {
    files.push({ kind: "mcp", path: descriptor.mcp_config.path, format: descriptor.mcp_config.format });
  }
  return files;
}

function findDeclared(descriptor: QuartersDescriptor, declaredPath: string): DeclaredFile {
  const files = declaredFiles(descriptor);
  const match = files.find((f) => f.path === declaredPath);
  if (!match) {
    // No allowlist enumeration in the error: the list is manifest data the UI
    // shows anyway, but an API error needs only the refusal, not a map.
    throw new Error(
      `path ${JSON.stringify(declaredPath)} is not declared by the ${descriptor.id} quarters descriptor (${files.length} declared file(s) are served)`
    );
  }
  return match;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Marker the per-primary orchestrator projection (P8) stamps on files it
// manages. The generic context panel shows provenance instead of a bare
// editor when present.
export const PROJECTION_MARKER = "GARRISON-PROJECTED";

export interface RuntimeFileView {
  path: string;
  kind: DeclaredFile["kind"];
  format?: "json" | "toml";
  label?: string;
  exists: boolean;
  content: string;
  sha: string | null;
  /** Set when the file carries the Garrison projection marker (ownership-respected). */
  projected: boolean;
}

export async function readRuntimeFile(
  descriptor: QuartersDescriptor,
  declaredPath: string
): Promise<RuntimeFileView> {
  const decl = findDeclared(descriptor, declaredPath);
  const abs = expandHome(decl.path);
  let content = "";
  let exists = true;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch {
    exists = false;
  }
  return {
    path: decl.path,
    kind: decl.kind,
    format: decl.format,
    label: decl.label,
    exists,
    content,
    sha: exists ? sha256(content) : null,
    projected: exists && content.includes(PROJECTION_MARKER)
  };
}

export function validateRuntimeFileContent(format: "json" | "toml" | undefined, content: string): string | null {
  try {
    if (format === "json") JSON.parse(content);
    if (format === "toml") parseToml(content);
    return null;
  } catch (err) {
    return `${format} invalid: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Sha-guarded, format-validated write to a DECLARED file. Refuses to clobber a
// Garrison-projected file (ownership-respected: the projection writer owns it)
// and refuses when the on-disk content moved past the caller's baseline.
export async function writeRuntimeFile(
  descriptor: QuartersDescriptor,
  declaredPath: string,
  content: string,
  baselineSha: string | null
): Promise<RuntimeFileView> {
  const decl = findDeclared(descriptor, declaredPath);
  const invalid = validateRuntimeFileContent(decl.format, content);
  if (invalid) throw new Error(invalid);
  const current = await readRuntimeFile(descriptor, declaredPath);
  if (current.projected) {
    throw new Error(
      `${decl.path} is a Garrison-managed projection (${PROJECTION_MARKER}) — edit the source it is projected from, not the projection`
    );
  }
  if (current.exists && current.sha !== baselineSha) {
    throw new Error(`${decl.path} changed on disk since it was loaded — reload before editing (sha mismatch)`);
  }
  const abs = expandHome(decl.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Atomic (temp+rename): a crash mid-write must never leave a truncated
  // native config (review minor — matches the repo-wide write discipline).
  await writeFileAtomic(abs, content);
  return readRuntimeFile(descriptor, declaredPath);
}

// ── Generic-tier log tails (descriptor log_paths only) ──────────────────────

const LOG_MAX_ENTRIES = 200;
const LOG_WALK_DEPTH = 3;
const LOG_TAIL_BYTES = 128 * 1024;
const LOG_TAIL_LINES = 400;

export interface RuntimeLogEntry {
  root: string; // the declared log path this entry sits under
  rel: string;
  bytes: number;
  mtime: string;
}

export async function listRuntimeLogs(descriptor: QuartersDescriptor): Promise<RuntimeLogEntry[]> {
  const out: RuntimeLogEntry[] = [];
  for (const declared of descriptor.log_paths ?? []) {
    const root = expandHome(declared);
    const walk = async (dir: string, depth: number, prefix: string) => {
      if (depth > LOG_WALK_DEPTH || out.length >= LOG_MAX_ENTRIES) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // a missing log dir is normal pre-first-run; the panel says so
      }
      for (const e of entries) {
        if (out.length >= LOG_MAX_ENTRIES) return;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs, depth + 1, rel);
        else if (e.isFile()) {
          try {
            const st = await fs.stat(abs);
            out.push({ root: declared, rel, bytes: st.size, mtime: st.mtime.toISOString() });
          } catch {
            /* raced deletion — skip */
          }
        }
      }
    };
    await walk(root, 0, "");
  }
  return out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

export async function tailRuntimeLog(
  descriptor: QuartersDescriptor,
  declaredRoot: string,
  rel: string
): Promise<{ root: string; rel: string; content: string; truncated: boolean }> {
  if (!(descriptor.log_paths ?? []).includes(declaredRoot)) {
    throw new Error(
      `log root ${JSON.stringify(declaredRoot)} is not declared by the ${descriptor.id} quarters descriptor`
    );
  }
  const rootAbs = path.resolve(expandHome(declaredRoot));
  const abs = path.resolve(rootAbs, rel);
  // STRICTLY inside the root — never the root entry itself (a root that is a
  // file/symlink would otherwise be tailed as a whole), and never lexical-only:
  // realpath both ends so a symlink planted inside the log dir cannot walk out.
  if (!abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`log path ${JSON.stringify(rel)} escapes the declared root ${declaredRoot}`);
  }
  const [realRoot, realAbs] = await Promise.all([fs.realpath(rootAbs), fs.realpath(abs)]);
  if (!realAbs.startsWith(realRoot + path.sep)) {
    throw new Error(`log path ${JSON.stringify(rel)} resolves outside the declared root ${declaredRoot} (symlink)`);
  }
  const handle = await fs.open(realAbs, "r");
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(stat.size, LOG_TAIL_BYTES));
    await handle.read(buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    const lines = text.split("\n");
    const truncated = start > 0 || lines.length > LOG_TAIL_LINES;
    if (lines.length > LOG_TAIL_LINES) text = lines.slice(-LOG_TAIL_LINES).join("\n");
    return { root: declaredRoot, rel, content: text, truncated };
  } finally {
    await handle.close();
  }
}
