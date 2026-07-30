import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { COMPOSITIONS_DIR } from "./paths";
import { ensureDir, pathExists, slugify, toPosixPath } from "./fs-utils";
import { readLibrary } from "./library";
import { vaultViewMasked } from "./vault";
import { currentProfile } from "./instance-profile";
import {
  ensureComposition,
  getCompositionDirectory,
  getCompositionManifestPath,
  manifestToComposition,
  readCompositionWithDerivedTasks,
  type CompositionV4
} from "./compositions";
import { readYamlFile, writeYamlFile } from "./yaml";
import { facultyIds, type FacultyId, type FittingSelectionMap, type LibraryEntry } from "./types";

// Composition transfer — export a composition as ONE portable document and
// import it back, on this machine or another.
//
// The unit of transfer is a single JSON file (`<id>.garrison.json`) rather than
// an archive: a composition is entirely text, and a plain JSON document can be
// downloaded, pasted into a box, committed to a repo, diffed in a review, and
// validated with a schema. A tarball can do none of those.
//
// The bundle carries what a human AUTHORED and nothing a machine generated:
// the apm.yml manifest (selections + per-fitting config, duties, targets,
// global config), the orchestrator/soul prompts, the routing policy, and the
// composition's own markdown. It never carries secrets, the materialised .env,
// the machine-local overlay, the lockfile, installed packages, or session state
// — see EXPORT_FILE_RULES and NEVER_TRANSFER below, both of which are pinned by
// tests.

export const COMPOSITION_BUNDLE_KIND = "garrison.composition.bundle";
export const COMPOSITION_BUNDLE_VERSION = 1;

// ── the authored-file allow-list ────────────────────────────────────────────
// An ALLOW-list, deliberately, where composition-clone.ts uses a deny-list. A
// clone stays on this machine, so "copy everything except known runtime junk"
// is safe there. A bundle is a SHARE artifact: an unrecognised file in a
// composition directory must never ride along by default, because the failure
// mode is leaking a credential someone dropped beside their manifest. A new
// authored file type therefore needs a rule here — and the export UI lists
// every included file, so nothing travels invisibly.
interface ExportFileRule {
  // Directory relative to the composition root ("" = the root itself). Only
  // these three directories are ever read; apm_modules/ and .claude/ hold tens
  // of thousands of installed files and are never walked.
  dir: string;
  pattern: RegExp;
  label: string;
}

const EXPORT_FILE_RULES: readonly ExportFileRule[] = [
  { dir: "", pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, label: "composition doc" },
  { dir: "", pattern: /^routing\.[A-Za-z0-9._-]+\.json$/, label: "alternate routing policy" },
  { dir: ".garrison", pattern: /^routing\.json$/, label: "routing policy" },
  { dir: ".garrison", pattern: /^orchestrator-authored\.json$/, label: "authored orchestrator blocks" },
  { dir: ".garrison/prompts", pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/, label: "authored prompt" }
];

// Defence in depth. Every one of these is already unmatched by the rules above
// (they are .yml/.env/.yaml, or a directory), but a future rule edit must not be
// able to let one through by accident, so the check is explicit and tested.
//   .env           - materialised vault secrets (mode 0600)
//   local.yml      - the machine-local overlay: home paths and machine ports,
//                    which is exactly what must NOT travel between machines
//   apm.lock.yaml  - resolved against THIS machine's checkout; `apm install` on
//                    the importing machine re-resolves it
//   apm.yml        - carried as `manifest`, not as a file entry
const NEVER_TRANSFER = new Set([".env", "local.yml", "apm.lock.yaml", "apm.yml"]);

// Human-readable, shown in the UI and embedded in every bundle so a recipient
// knows what they still have to provide. Not machine-read.
export const BUNDLE_EXCLUSIONS: readonly string[] = [
  ".env (materialised vault secrets)",
  "vault contents - the bundle names the keys it needs, never their values",
  "local.yml (machine-local overlay: home paths, machine ports)",
  "apm.lock.yaml (re-resolved by apm install on import)",
  "apm_modules/ and .claude/ (installed by apm install)",
  ".garrison/souls/ and assembled-system-prompt.md (regenerated at launch)",
  "session ids, decisions.jsonl, run-evidence.json, owner.json (runtime state)"
];

// Per-file and whole-bundle ceilings. A composition's authored text is a few
// hundred KB; anything past these is a file that does not belong in a bundle,
// and is SKIPPED with a warning rather than silently truncated.
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

// Is this composition-relative path one a bundle may carry? Used BOTH when
// enumerating files to export and when validating a bundle on import, so an
// untrusted bundle can only ever write paths the exporter could have produced.
export function compositionExportPathAllowed(relativePath: string): boolean {
  if (!relativePath) return false;
  const normalized = toPosixPath(relativePath);
  if (normalized.startsWith("/") || normalized.includes("\\") || normalized.includes("\0")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  const base = segments[segments.length - 1];
  if (NEVER_TRANSFER.has(base)) return false;
  const dir = segments.slice(0, -1).join("/");
  return EXPORT_FILE_RULES.some((rule) => rule.dir === dir && rule.pattern.test(base));
}

function labelForPath(relativePath: string): string {
  const normalized = toPosixPath(relativePath);
  const segments = normalized.split("/");
  const base = segments[segments.length - 1];
  const dir = segments.slice(0, -1).join("/");
  return EXPORT_FILE_RULES.find((rule) => rule.dir === dir && rule.pattern.test(base))?.label ?? "file";
}

// ── bundle schema ───────────────────────────────────────────────────────────

const bundleFileSchema = z.object({
  path: z.string().min(1),
  label: z.string().optional(),
  contents: z.string()
});

const bundleSchema = z.object({
  kind: z.literal(COMPOSITION_BUNDLE_KIND),
  version: z.number().int(),
  exported_at: z.string().optional(),
  source: z
    .object({
      composition_id: z.string().optional(),
      garrison_profile: z.string().optional()
    })
    .optional(),
  composition: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    schema: z.number().int().optional()
  }),
  // The apm.yml document, verbatim. Kept loose here: compositions.ts owns the
  // manifest contract and validates it (parseCompositionV4) during inspection,
  // where the error can be reported against the bundle instead of thrown from
  // a writer half-way through creating a directory.
  manifest: z.record(z.unknown()),
  files: z.array(bundleFileSchema).default([]),
  requirements: z
    .object({
      fittings: z
        .array(
          z.object({
            id: z.string(),
            faculty: z.string().optional(),
            source: z.string().nullable().optional()
          })
        )
        .default([]),
      secrets: z.array(z.string()).default([])
    })
    .default({ fittings: [], secrets: [] }),
  excluded: z.array(z.string()).default([])
});

export type CompositionBundle = z.infer<typeof bundleSchema>;
export type CompositionBundleFile = z.infer<typeof bundleFileSchema>;

// ── export ──────────────────────────────────────────────────────────────────

// An optional directory (.garrison/prompts on a freshly-scaffolded composition)
// reads as empty rather than throwing. Return type deliberately inferred.
async function readDirEntries(absDir: string) {
  try {
    return await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readAuthoredFiles(
  compositionDir: string
): Promise<{ files: CompositionBundleFile[]; warnings: string[] }> {
  const files: CompositionBundleFile[] = [];
  const warnings: string[] = [];
  let total = 0;

  const directories = [...new Set(EXPORT_FILE_RULES.map((rule) => rule.dir))].sort();
  for (const dir of directories) {
    const absDir = dir ? path.join(compositionDir, ...dir.split("/")) : compositionDir;
    for (const entry of await readDirEntries(absDir)) {
      if (!entry.isFile()) continue;
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (!compositionExportPathAllowed(relative)) continue;
      const absolute = path.join(absDir, entry.name);
      const raw = await fs.readFile(absolute);
      if (raw.byteLength > MAX_FILE_BYTES) {
        warnings.push(
          `${relative} is ${formatBytes(raw.byteLength)} (over the ${formatBytes(MAX_FILE_BYTES)} per-file limit) and was not included`
        );
        continue;
      }
      const contents = raw.toString("utf8");
      // Lossy decode = binary. Buffer#toString replaces invalid bytes with
      // U+FFFD silently, so round-trip rather than trust it: writing the
      // replacement characters back on import would corrupt the file.
      if (!Buffer.from(contents, "utf8").equals(raw)) {
        warnings.push(`${relative} is not UTF-8 text and was not included`);
        continue;
      }
      if (total + raw.byteLength > MAX_TOTAL_BYTES) {
        warnings.push(`bundle hit the ${formatBytes(MAX_TOTAL_BYTES)} size limit; ${relative} was not included`);
        continue;
      }
      total += raw.byteLength;
      files.push({ path: relative, label: labelForPath(relative), contents });
    }
  }
  // Deterministic order so two exports of an unchanged composition are
  // byte-identical and a bundle diffs cleanly in review.
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, warnings };
}

// The vault keys a composition's selected fittings need: every key a fitting is
// scoped to read, plus every config value the fitting's schema declares as a
// `secret-ref` (those values are secret NAMES, never secret values).
export function requiredSecretKeys(
  selections: FittingSelectionMap,
  library: readonly LibraryEntry[]
): string[] {
  const byId = new Map(library.map((entry) => [entry.id, entry]));
  const keys = new Set<string>();
  for (const items of Object.values(selections)) {
    for (const item of items ?? []) {
      const entry = byId.get(item.id);
      if (!entry) continue; // unknown fitting - reported separately as missing
      for (const key of entry.metadata.secret_scope ?? []) keys.add(key);
      const fieldTypes = new Map(
        (entry.metadata.config_schema ?? []).map((field) => [field.key, field.type])
      );
      for (const [key, value] of Object.entries(item.config ?? {})) {
        if (fieldTypes.get(key) !== "secret-ref") continue;
        if (typeof value === "string" && value.trim()) keys.add(value.trim());
      }
    }
  }
  return [...keys].sort();
}

function selectionsFromManifest(manifest: Record<string, unknown>): FittingSelectionMap {
  const block = (manifest["x-garrison"] as { composition?: { selections?: FittingSelectionMap } } | undefined)
    ?.composition;
  return block?.selections ?? {};
}

// Build the portable bundle for an in-repo composition.
export async function buildCompositionBundle(
  compositionId: string
): Promise<{ bundle: CompositionBundle; warnings: string[] }> {
  const id = slugify(compositionId.trim());
  if (!id) throw new Error("composition id is required");
  const manifestPath = getCompositionManifestPath(id);
  if (!(await pathExists(manifestPath))) {
    throw new Error(`composition "${id}" does not exist`);
  }
  const manifest = await readYamlFile<Record<string, unknown>>(manifestPath);
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`composition "${id}" has an unreadable apm.yml`);
  }
  // Parse it as a composition before exporting: a bundle built from a manifest
  // that cannot itself be read is a bundle that cannot be imported.
  const composition = await readCompositionWithDerivedTasks(id);
  const { files, warnings } = await readAuthoredFiles(getCompositionDirectory(id));
  const library = await readLibrary();
  const byId = new Map(library.map((entry) => [entry.id, entry]));

  const selections = selectionsFromManifest(manifest);
  const fittings: CompositionBundle["requirements"]["fittings"] = [];
  for (const faculty of Object.keys(selections)) {
    for (const item of selections[faculty as FacultyId] ?? []) {
      const entry = byId.get(item.id);
      fittings.push({
        id: item.id,
        faculty,
        source: entry?.localPath ?? entry?.repo ?? null
      });
    }
  }
  fittings.sort((left, right) => left.id.localeCompare(right.id));

  const bundle: CompositionBundle = {
    kind: COMPOSITION_BUNDLE_KIND,
    version: COMPOSITION_BUNDLE_VERSION,
    exported_at: new Date().toISOString(),
    source: { composition_id: id, garrison_profile: currentProfile() },
    composition: { id, name: composition.name, schema: composition.schema },
    manifest,
    files,
    requirements: { fittings, secrets: requiredSecretKeys(selections, library) },
    excluded: [...BUNDLE_EXCLUSIONS]
  };
  return { bundle, warnings };
}

export function bundleFileName(bundle: CompositionBundle): string {
  return `${slugify(bundle.composition.id) || "composition"}.garrison.json`;
}

export function serializeBundle(bundle: CompositionBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

// ── inspect ─────────────────────────────────────────────────────────────────

export interface BundleInspection {
  composition: { id: string; name: string; schema: number | null };
  // The id an import would land on, and whether it is free right now.
  suggestedId: string;
  requestedIdAvailable: boolean;
  fittings: Array<{ id: string; faculty: string; present: boolean; source: string | null }>;
  secrets: Array<{ key: string; set: boolean }>;
  files: Array<{ path: string; label: string; bytes: number }>;
  duties: number;
  targets: number;
  exportedAt: string | null;
  sourceProfile: string | null;
  excluded: string[];
  // Non-fatal: the import will succeed but something will need attention.
  warnings: string[];
  // Fatal: the import is refused.
  errors: string[];
}

// Parse an untrusted document into a bundle. Accepts the JSON text or an
// already-parsed object; every failure is reported as a readable sentence
// rather than a zod dump, because this is what a user sees after dropping a
// file they may have hand-edited.
export function parseCompositionBundle(input: unknown): CompositionBundle {
  let candidate = input;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new Error("that file is not valid JSON - a composition bundle is a .garrison.json document");
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("a composition bundle must be a JSON object");
  }
  const record = candidate as Record<string, unknown>;
  if (record.kind !== COMPOSITION_BUNDLE_KIND) {
    throw new Error(
      `this is not a Garrison composition bundle (expected kind "${COMPOSITION_BUNDLE_KIND}", got ${
        typeof record.kind === "string" ? `"${record.kind}"` : "no kind field"
      })`
    );
  }
  if (typeof record.version === "number" && record.version > COMPOSITION_BUNDLE_VERSION) {
    throw new Error(
      `this bundle is version ${record.version}; this Garrison understands up to version ${COMPOSITION_BUNDLE_VERSION}. Update Garrison to import it.`
    );
  }
  const parsed = bundleSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? first.path.join(".") : "bundle";
    throw new Error(`bundle is malformed at ${where}: ${first?.message ?? "unknown error"}`);
  }
  return parsed.data;
}

// A free composition id near `base` — `base`, else `base-2`, `base-3`, …
export async function suggestCompositionId(base: string): Promise<string> {
  const root = slugify(base) || "composition";
  for (let n = 1; n <= 200; n += 1) {
    const candidate = n === 1 ? root : `${root}-${n}`;
    if (!(await pathExists(getCompositionDirectory(candidate)))) return candidate;
  }
  return `${root}-${randomBytes(3).toString("hex")}`;
}

// Everything a user needs to decide whether to import, computed against THIS
// machine: which fittings exist here, which vault keys are set, what will be
// written, and what is broken. Writes nothing.
export async function inspectCompositionBundle(
  bundle: CompositionBundle,
  requestedId?: string
): Promise<BundleInspection> {
  const warnings: string[] = [];
  const errors: string[] = [];

  const block = (bundle.manifest["x-garrison"] as { composition?: Record<string, unknown> } | undefined)
    ?.composition;
  let duties = 0;
  let targets = 0;
  let schema: number | null = null;
  if (!block || typeof block !== "object") {
    errors.push("the bundled manifest has no x-garrison.composition block, so it is not a composition");
  } else {
    try {
      // The real parser, so a bundle that would explode on read is refused now.
      const parsed = manifestToComposition(bundle.composition.id, {
        name: String(bundle.manifest.name ?? bundle.composition.id),
        version: String(bundle.manifest.version ?? "0.1.0"),
        target: String(bundle.manifest.target ?? "claude"),
        "x-garrison": { composition: block }
      } as Parameters<typeof manifestToComposition>[1]);
      duties = parsed.duties.length;
      targets = parsed.targets.length;
      schema = parsed.schema;
    } catch (error) {
      errors.push(`the bundled manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const files: BundleInspection["files"] = [];
  for (const file of bundle.files) {
    if (!compositionExportPathAllowed(file.path)) {
      errors.push(
        `bundle contains a file path that a composition bundle may not write: "${file.path}"`
      );
      continue;
    }
    files.push({
      path: toPosixPath(file.path),
      label: file.label ?? labelForPath(file.path),
      bytes: Buffer.byteLength(file.contents, "utf8")
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  const library = await readLibrary();
  const known = new Set(library.map((entry) => entry.id));
  const facultyById = new Map(library.map((entry) => [entry.id, entry.faculty as string]));
  const selections = selectionsFromManifest(bundle.manifest);
  const declared = new Map(bundle.requirements.fittings.map((f) => [f.id, f]));
  const fittingIds = new Set<string>([
    ...bundle.requirements.fittings.map((f) => f.id),
    ...Object.values(selections).flatMap((items) => (items ?? []).map((item) => item.id))
  ]);
  const fittings = [...fittingIds]
    .sort()
    .map((id) => ({
      id,
      faculty: facultyById.get(id) ?? declared.get(id)?.faculty ?? "unknown",
      present: known.has(id),
      source: declared.get(id)?.source ?? null
    }));
  const missing = fittings.filter((f) => !f.present);
  if (missing.length > 0) {
    warnings.push(
      `${missing.length} fitting${missing.length === 1 ? " is" : "s are"} not in this machine's registry (${missing
        .map((f) => f.id)
        .join(", ")}). The composition imports, but will not run until they are installed or removed.`
    );
  }
  // An unknown faculty key would be dropped by normalizeSelections on the first
  // save, silently unstationing whatever was under it.
  const unknownFaculties = Object.keys(selections).filter(
    (key) => !(facultyIds as readonly string[]).includes(key)
  );
  if (unknownFaculties.length > 0) {
    warnings.push(
      `the bundle groups fittings under ${unknownFaculties.length === 1 ? "a faculty" : "faculties"} this Garrison does not have (${unknownFaculties.join(", ")}); those selections will not load`
    );
  }

  // A locked vault must never block an import — it only blocks a RUN, and the
  // runner already says so. Report the keys as unchecked rather than as unset,
  // which would read as "you are missing all of these".
  let secrets: BundleInspection["secrets"] = bundle.requirements.secrets.map((key) => ({ key, set: false }));
  try {
    const vault = await vaultViewMasked();
    if (!vault.unlocked) {
      warnings.push("the vault is locked, so the keys this composition needs could not be checked");
    } else {
      const set = new Set(vault.secrets.filter((row) => row.set).map((row) => row.key));
      secrets = bundle.requirements.secrets.map((key) => ({ key, set: set.has(key) }));
      const unset = secrets.filter((row) => !row.set);
      if (unset.length > 0) {
        warnings.push(
          `${unset.length} vault key${unset.length === 1 ? "" : "s"} named by this composition ${
            unset.length === 1 ? "is" : "are"
          } not set here (${unset.map((row) => row.key).join(", ")}). Add ${
            unset.length === 1 ? "it" : "them"
          } in Vault before running.`
        );
      }
    }
  } catch (error) {
    warnings.push(
      `required vault keys could not be checked: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const base = (requestedId?.trim() || bundle.composition.id).trim();
  const requestedIdAvailable = Boolean(slugify(base)) && !(await pathExists(getCompositionDirectory(base)));
  const suggestedId = requestedIdAvailable ? slugify(base) : await suggestCompositionId(base);

  return {
    composition: { id: bundle.composition.id, name: bundle.composition.name, schema },
    suggestedId,
    requestedIdAvailable,
    fittings,
    secrets,
    files,
    duties,
    targets,
    exportedAt: bundle.exported_at ?? null,
    sourceProfile: bundle.source?.garrison_profile ?? null,
    excluded: bundle.excluded.length > 0 ? bundle.excluded : [...BUNDLE_EXCLUSIONS],
    warnings,
    errors
  };
}

// ── import ──────────────────────────────────────────────────────────────────

export interface ImportCompositionInput {
  bundle: CompositionBundle;
  // Target id/name. Both default to the bundle's own; an id collision is a hard
  // error rather than an overwrite — an import never edits a composition that
  // is already here.
  id?: string;
  name?: string;
}

// Materialise a bundle as a new composition. Staged in a hidden sibling and
// renamed into place only once fully written, exactly like cloneComposition:
// readers see either no composition or a complete one, and a failure part-way
// leaves nothing behind.
export async function importComposition(input: ImportCompositionInput): Promise<CompositionV4> {
  const { bundle } = input;
  const name = (input.name?.trim() || bundle.composition.name || bundle.composition.id).trim();
  const id = slugify(input.id?.trim() || bundle.composition.id);
  if (!id) throw new Error("composition id must contain a letter or number");

  const inspection = await inspectCompositionBundle(bundle, id);
  if (inspection.errors.length > 0) {
    throw new Error(inspection.errors[0]);
  }

  await ensureDir(COMPOSITIONS_DIR);
  const destinationDir = getCompositionDirectory(id);
  if (await pathExists(destinationDir)) {
    throw new Error(`composition "${id}" already exists`);
  }

  const stageDir = path.join(
    COMPOSITIONS_DIR,
    `.${id}.import-${process.pid}-${randomBytes(6).toString("hex")}`
  );
  let committed = false;
  try {
    await ensureDir(stageDir);

    // Re-stamp identity. Everything else in the manifest travels verbatim,
    // including dependencies.apm: its `path:` entries are relative to the
    // composition directory, and the import lands as a sibling of the source,
    // so they resolve identically.
    const manifest = JSON.parse(JSON.stringify(bundle.manifest)) as Record<string, unknown>;
    const xGarrison = (manifest["x-garrison"] ?? {}) as Record<string, unknown>;
    const block = (xGarrison.composition ?? {}) as Record<string, unknown>;
    manifest.name = slugify(name) || id;
    manifest["x-garrison"] = { ...xGarrison, composition: { ...block, id, name } };
    await writeYamlFile(path.join(stageDir, "apm.yml"), manifest);

    for (const file of bundle.files) {
      const relative = toPosixPath(file.path);
      // Already validated in inspect; re-checked here because this is the call
      // that writes, and a path check that lives only in a preview is not a
      // path check.
      if (!compositionExportPathAllowed(relative)) {
        throw new Error(`refusing to write "${file.path}" from a composition bundle`);
      }
      const absolute = path.join(stageDir, ...relative.split("/"));
      const resolved = path.resolve(absolute);
      if (resolved !== absolute || !resolved.startsWith(`${path.resolve(stageDir)}${path.sep}`)) {
        throw new Error(`refusing to write "${file.path}" outside the composition directory`);
      }
      await ensureDir(path.dirname(absolute));
      await fs.writeFile(absolute, file.contents, "utf8");
    }

    if (await pathExists(destinationDir)) {
      throw new Error(`composition "${id}" already exists`);
    }
    await fs.rename(stageDir, destinationDir);
    committed = true;
  } finally {
    if (!committed) await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }

  // Backfill anything the bundle did not carry (a bundle from a composition
  // whose prompts were never authored has no prompt files). Runs after the
  // rename so the staged directory is never half-scaffolded.
  await ensureComposition(id);
  return readCompositionWithDerivedTasks(id);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
