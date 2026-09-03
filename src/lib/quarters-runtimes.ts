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
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import yaml from "js-yaml";
import { writeFileAtomic } from "./atomic-write";
import { assertClaudeWritable } from "./install-state";
import { readComposition } from "./compositions";
import { readLibrary } from "./library";
import { isRestrictedQuartersGlob } from "./metadata";
import type { QuartersDescriptor, QuartersFileSet, QuartersSettingsFile } from "./types";

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
  /** G5: one summary row per declared file_sets entry, home-scoped sets pre-counted. */
  fileSets?: FileSetAvailability[];
}

export interface FileSetAvailability {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  /** Home-scoped sets only - a project-scoped set's count depends on which
   *  project the caller picks, resolved lazily by listFileSet instead. */
  count?: number;
}

export function expandHome(p: string, homeDir: string = os.homedir()): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return path.join(homeDir, p.slice(2));
  return p;
}

// The env var a test (or an operator isolating a machine's own real config
// from an experiment) uses to redirect a runtime's home dir without touching
// the real one - GARRISON_CURSOR_HOME for descriptor id "cursor", etc. Mirrors
// the identical convention the Shells listers already use for this same
// runtime (fittings/seed/remote-shell-runtime/lib/listers/cursor.mjs).
export function runtimeHome(descriptorId: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = `GARRISON_${descriptorId.toUpperCase().replace(/-/g, "_")}_HOME`;
  const override = env[key];
  return override && override.trim() ? override : os.homedir();
}

// Resolve the selected runtimes of the composition to their Quarters entries.
// Runtimes without a descriptor are simply absent (a runtime is not obliged to
// be configurable); malformed situations surface as warnings on the entry.
export async function resolveRuntimeQuarters(compositionId?: string): Promise<RuntimeQuartersEntry[]> {
  // READ-ONLY guard (S7 review): readComposition ensure-creates a composition
  // dir on miss — a GET must never materialize state from a typo'd
  // ?composition= param. Unknown ids fail loud instead.
  if (compositionId !== undefined) {
    if (!/^[a-z][a-z0-9-]*$/.test(compositionId)) {
      throw new Error(`invalid composition id ${JSON.stringify(compositionId)}`);
    }
    const manifest = path.join(process.cwd(), "compositions", compositionId, "apm.yml");
    if (!existsSync(manifest)) {
      throw new Error(`composition "${compositionId}" does not exist`);
    }
  }
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
    if (descriptor.file_sets?.length) {
      item.fileSets = await Promise.all(
        descriptor.file_sets.map(async (decl): Promise<FileSetAvailability> => {
          if (decl.platform && decl.platform !== process.platform) {
            return { id: decl.id, label: decl.label, available: false, reason: `only available on ${decl.platform}` };
          }
          if (decl.scope === "project") {
            return { id: decl.id, label: decl.label, available: true };
          }
          try {
            const rows = await listFileSet(descriptor, decl.id);
            return { id: decl.id, label: decl.label, available: true, count: rows.length };
          } catch (err) {
            return { id: decl.id, label: decl.label, available: false, reason: err instanceof Error ? err.message : String(err) };
          }
        })
      );
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
  await assertClaudeWritable(`write the runtime config ${declaredPath}`);
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

// ── Generic-tier file SETS (G5) ─────────────────────────────────────────────
// A file_sets entry is a DIRECTORY of files (Cursor's rules/skills/agents/
// hooks/desktop settings/project rules), unlike settings_files/context_file/
// mcp_config above which are each exactly one file. The safety model is the
// same shape as the log tail below: containment by path.resolve prefix match
// AND a realpath re-check (a symlink planted inside the set's root must not
// walk the read/write out of it), plus the glob itself is the second gate - a
// `rel` that is lexically inside the root but does not match the declared
// glob is refused just as loudly as one that escapes it.

export { isRestrictedQuartersGlob as isRestrictedGlob };

/** Does `rel` (POSIX-joined, relative to a file set's root) match `glob`? Both
 *  sides are compared segment-by-segment, so segment COUNT must match too -
 *  "*.mdc" (1 segment) never matches "sub/thing.mdc" (2 segments). */
export function matchRestrictedGlob(glob: string, rel: string): boolean {
  const globSegs = glob.split("/");
  const relSegs = rel.split("/");
  if (globSegs.length !== relSegs.length) return false;
  return globSegs.every((g, i) => matchGlobSegment(g, relSegs[i]));
}

function matchGlobSegment(g: string, seg: string): boolean {
  if (!seg) return false;
  if (g === "*") return true;
  const extWildcard = /^\*\.([A-Za-z0-9]+)$/.exec(g);
  if (extWildcard) {
    const ext = `.${extWildcard[1]}`;
    return seg.endsWith(ext) && seg.length > ext.length;
  }
  const brace = /^\{([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)+)\}\.([A-Za-z0-9]+)$/.exec(g);
  if (brace) {
    const names = brace[1].split(",");
    const ext = brace[2];
    return names.some((n) => seg === `${n}.${ext}`);
  }
  return seg === g;
}

// Children of the composition's global_config.projects_root (default ~/dev) -
// the candidate roots a project-scoped file set (Cursor's project rules) can
// browse. SCOPED DOWN from the fuller design (which also folds in cwds the
// local Shells fitting already knows about via its live index): that would
// add a same-machine HTTP round trip to a path Quarters needs to stay fast
// and dependency-free, for a marginal discovery win the manual "type a path"
// fallback already covers. Revisit if project-scoped sets turn out hard to
// find in practice.
export async function knownProjectRoots(compositionId?: string): Promise<string[]> {
  const composition = await readComposition(compositionId);
  const projectsRootDecl = composition.globalConfig?.projects_root ?? "~/dev";
  const projectsRoot = expandHome(projectsRootDecl);
  const roots: string[] = [];
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".")) roots.push(path.join(projectsRoot, e.name));
    }
  } catch {
    /* projects_root absent on this machine - no candidates, not an error */
  }
  return roots.sort();
}

function findFileSet(descriptor: QuartersDescriptor, setId: string): QuartersFileSet {
  const found = (descriptor.file_sets ?? []).find((f) => f.id === setId);
  if (!found) {
    throw new Error(`file set ${JSON.stringify(setId)} is not declared by the ${descriptor.id} quarters descriptor`);
  }
  return found;
}

async function fileSetRootAbs(decl: QuartersFileSet, descriptorId: string, project?: string): Promise<string> {
  if (decl.scope === "project") {
    if (!project) throw new Error(`file set "${decl.id}" is project-scoped; a project root is required`);
    const roots = await knownProjectRoots();
    if (!roots.includes(project)) throw new Error(`${JSON.stringify(project)} is not a known project root`);
    return path.resolve(project, decl.root);
  }
  return path.resolve(expandHome(decl.root, runtimeHome(descriptorId)));
}

async function fileSetEntryAbs(
  decl: QuartersFileSet,
  descriptorId: string,
  rel: string,
  project?: string
): Promise<{ rootAbs: string; abs: string }> {
  if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
    throw new Error(`path ${JSON.stringify(rel)} is not a relative path inside the file set`);
  }
  if (!matchRestrictedGlob(decl.glob, rel)) {
    throw new Error(`path ${JSON.stringify(rel)} does not match the ${decl.id} file set's glob (${decl.glob})`);
  }
  const rootAbs = path.resolve(await fileSetRootAbs(decl, descriptorId, project));
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new Error(`path ${JSON.stringify(rel)} escapes the ${decl.id} file set's root`);
  }
  return { rootAbs, abs };
}

// Symlink-safe containment, meaningful only once the target exists (a
// not-yet-created path has nothing to resolve) - same discipline as
// tailRuntimeLog below.
async function assertRealpathContained(rootAbs: string, abs: string, rel: string, setId: string): Promise<string> {
  const [realRoot, realAbs] = await Promise.all([fs.realpath(rootAbs), fs.realpath(abs)]);
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    throw new Error(`path ${JSON.stringify(rel)} resolves outside the ${setId} file set's root (symlink)`);
  }
  return realAbs;
}

export interface FileSetRow {
  rel: string;
  bytes: number;
  mtime: string;
}

export async function listFileSet(
  descriptor: QuartersDescriptor,
  setId: string,
  project?: string
): Promise<FileSetRow[]> {
  const decl = findFileSet(descriptor, setId);
  if (decl.platform && decl.platform !== process.platform) return [];
  // A bad SCOPE (project-scoped with no/unknown project) is a caller mistake
  // and must throw; only a validly-resolved root that simply has no directory
  // on disk YET (normal pre-first-use state) reads as an empty list.
  const rootAbs = await fileSetRootAbs(decl, descriptor.id, project);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootAbs);
  } catch {
    return [];
  }
  const maxDepth = decl.glob.split("/").length - 1;
  const out: FileSetRow[] = [];
  const walk = async (dir: string, depth: number, prefix: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(abs, depth + 1, rel);
      } else if (e.isFile() && matchRestrictedGlob(decl.glob, rel)) {
        try {
          const st = await fs.stat(abs);
          out.push({ rel, bytes: st.size, mtime: st.mtime.toISOString() });
        } catch {
          /* raced deletion - skip */
        }
      }
    }
  };
  await walk(realRoot, 0, "");
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export interface FileSetFileView {
  rel: string;
  format: "markdown" | "json";
  exists: boolean;
  content: string;
  sha: string | null;
  frontmatter?: Record<string, unknown> | null;
  projected: boolean;
}

// Non-throwing: malformed YAML in a frontmatter block reads as "no
// frontmatter" rather than blowing up the whole file view, since the body is
// still perfectly readable/editable either way.
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown> | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { frontmatter: null, body: content };
  try {
    const parsed = yaml.load(m[1]);
    const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { frontmatter, body: content.slice(m[0].length) };
  } catch {
    return { frontmatter: null, body: content };
  }
}

export async function readFileSetEntry(
  descriptor: QuartersDescriptor,
  setId: string,
  rel: string,
  project?: string
): Promise<FileSetFileView> {
  const decl = findFileSet(descriptor, setId);
  const { rootAbs, abs } = await fileSetEntryAbs(decl, descriptor.id, rel, project);
  let content = "";
  let exists = true;
  try {
    const realAbs = await assertRealpathContained(rootAbs, abs, rel, decl.id);
    content = await fs.readFile(realAbs, "utf8");
  } catch (err) {
    if (err instanceof Error && err.message.includes("resolves outside")) throw err;
    exists = false;
  }
  const fm = decl.format === "markdown" && exists ? parseFrontmatter(content).frontmatter : undefined;
  return {
    rel,
    format: decl.format,
    exists,
    content,
    sha: exists ? sha256(content) : null,
    frontmatter: fm,
    projected: exists && content.includes(PROJECTION_MARKER)
  };
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// merge semantics for write:"merge" json file sets (Cursor's hooks.json,
// merged with whatever the operator hand-authored): objects merge key by key,
// arrays are unioned (dedup by deep-equal JSON), keys are never removed, and
// on a genuine shape clash (e.g. base has an object where incoming has a
// scalar) incoming wins for that one key rather than the merge failing.
function deepMergeJson(base: unknown, incoming: unknown): unknown {
  if (Array.isArray(base) && Array.isArray(incoming)) {
    const seen = new Set(base.map((v) => JSON.stringify(v)));
    const merged = [...base];
    for (const item of incoming) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        merged.push(item);
        seen.add(key);
      }
    }
    return merged;
  }
  if (isPlainObj(base) && isPlainObj(incoming)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(incoming)) {
      out[k] = k in out ? deepMergeJson(out[k], v) : v;
    }
    return out;
  }
  return incoming;
}

// Sha-guarded, format-validated write to an EXISTING file set entry - the
// same discipline as writeRuntimeFile above (projection refusal, baseline-sha
// guard), plus the merge semantics write:"merge" json sets need.
export async function writeFileSetEntry(
  descriptor: QuartersDescriptor,
  setId: string,
  rel: string,
  content: string,
  baselineSha: string | null,
  project?: string
): Promise<FileSetFileView> {
  await assertClaudeWritable(`write the quarters file ${rel}`);
  const decl = findFileSet(descriptor, setId);
  const invalid = decl.format === "json" ? validateRuntimeFileContent("json", content) : null;
  if (invalid) throw new Error(invalid);
  const current = await readFileSetEntry(descriptor, setId, rel, project);
  if (!current.exists) {
    throw new Error(`${rel} does not exist in the ${decl.id} file set - use createFileSetEntry to add a new file`);
  }
  if (current.projected) {
    throw new Error(
      `${rel} is a Garrison-managed projection (${PROJECTION_MARKER}) — edit the source it is projected from, not the projection`
    );
  }
  if (current.sha !== baselineSha) {
    throw new Error(`${rel} changed on disk since it was loaded — reload before editing (sha mismatch)`);
  }
  const { abs } = await fileSetEntryAbs(decl, descriptor.id, rel, project);
  let finalContent = content;
  if (decl.write === "merge" && decl.format === "json") {
    const onDisk = current.content.trim() ? JSON.parse(current.content) : {};
    const incoming = JSON.parse(content);
    finalContent = `${JSON.stringify(deepMergeJson(onDisk, incoming), null, 2)}\n`;
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, finalContent);
  return readFileSetEntry(descriptor, setId, rel, project);
}

export async function createFileSetEntry(
  descriptor: QuartersDescriptor,
  setId: string,
  rel: string,
  content: string,
  project?: string
): Promise<FileSetFileView> {
  await assertClaudeWritable(`create the quarters file ${rel}`);
  const decl = findFileSet(descriptor, setId);
  if (!decl.create) throw new Error(`the ${decl.id} file set does not allow creating new files`);
  const invalid = decl.format === "json" ? validateRuntimeFileContent("json", content) : null;
  if (invalid) throw new Error(invalid);
  const { abs } = await fileSetEntryAbs(decl, descriptor.id, rel, project);
  if (existsSync(abs)) throw new Error(`${rel} already exists in the ${decl.id} file set`);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, content);
  return readFileSetEntry(descriptor, setId, rel, project);
}

export async function deleteFileSetEntry(
  descriptor: QuartersDescriptor,
  setId: string,
  rel: string,
  project?: string
): Promise<void> {
  await assertClaudeWritable(`delete the quarters file ${rel}`);
  const decl = findFileSet(descriptor, setId);
  if (!decl.create) throw new Error(`the ${decl.id} file set does not allow deleting files`);
  const current = await readFileSetEntry(descriptor, setId, rel, project);
  if (!current.exists) throw new Error(`${rel} does not exist in the ${decl.id} file set`);
  if (current.projected) {
    throw new Error(`${rel} is a Garrison-managed projection (${PROJECTION_MARKER}) — it cannot be deleted here`);
  }
  const { abs } = await fileSetEntryAbs(decl, descriptor.id, rel, project);
  await fs.unlink(abs);
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
