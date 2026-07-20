import fsp from "node:fs/promises";
import path from "node:path";
import { claudeHome, capturedFittingsDir } from "./claude-home";
import {
  writeGlobalApmManifest,
  apmInstall,
  readGlobalLock,
  type ApmLockDepView
} from "./global-composition";
import { writeYamlFile } from "./yaml";
import { hashFile } from "./claude-scan";
import { writeFileAtomic } from "./atomic-write";
import { PROJECTION_MARKER } from "./quarters-runtimes";
import { recordWritten } from "./provenance";
import { substituteCapabilitiesPlaceholder, substituteRoutingPlaceholder } from "./runner";
import type { ApmRunner } from "./apm-exec";
import type { ApmDependencyInput } from "./apm-manifest";
import type { LibraryEntry } from "./types";
import { DEFAULT_COMPOSITION_ID, readComposition, selectedLibraryEntries } from "./compositions";
import { resolveModel } from "./resolver";
import { buildOrchestratorPreview, type OrchestratorPreview } from "./orchestrator-sections";
import type { AuthoredSectionId } from "./orchestrator-authored-defaults";
import { AUTHORED_SECTION_IDS } from "./orchestrator-authored-defaults";

// RC3 — project Garrison's orchestrator prompt INTO the real ~/.claude as an
// APM-managed instructions primitive. This is how "the Operative folds into your
// real Claude Code": instead of spawning a separate SDK agent with the assembled
// prompt as --append, Garrison deploys the prompt as a standing rule so the
// user's actual Claude Code carries the orchestrator behavior every session.
//
// Delivery (SP2): verified empirically AND against primary docs (Claude Code
// 2.1.168 / code.claude.com/docs/en/memory). A sentinel `~/.claude/rules/<x>.md`
// with no `paths:` frontmatter was auto-loaded by a standard headless
// headless `claude` run. Docs confirm: "Personal rules in ~/.claude/rules/ apply
// to every project" and "Rules without paths frontmatter are loaded at launch
// with the same priority as .claude/CLAUDE.md". So the reversible rules-file is
// the DEFAULT target.
//   PRECEDENCE caveat (docs): CLAUDE.md AND rules are delivered as a USER message
//   after the system prompt — "no guarantee of strict compliance". For
//   system-prompt-level authority, --append-system-prompt is the documented
//   mechanism (must be passed each launch). So the rules-file is the durable/
//   reversible default; orchestratorAppendSystemPrompt() is the higher-authority
//   launch-time FALLBACK the hosted-session lane (RC4) passes. Prompt-based,
//   never programmatic config (D4).

export const ORCHESTRATOR_PRIMITIVE_ID = "garrison-orchestrator";
export const ORCHESTRATOR_RULE_REL = `rules/${ORCHESTRATOR_PRIMITIVE_ID}.md`;

export interface OrchestratorPromptInputs {
  orchestrator: string; // the orchestrator prompt (may contain {{capabilities}} / {{routing}})
  soul?: string; // identity prompt, folded in ahead of behavior
  entries: LibraryEntry[]; // resolved providers for {{capabilities}} substitution
  routingSection?: string | null; // compiled Model Router section for {{routing}} (BRIEF v4 MR1b)
}

// Pure: fold soul (identity) + orchestrator (behavior) and substitute the
// {{capabilities}} + {{routing}} placeholders. Identity leads so it lands before
// the long behavior section buries it (mirrors runner.assembleSystemPrompt's
// ordering). {{routing}} is always substituted (stripped when no section) so the
// placeholder never leaks into the projected rule.
export function buildOrchestratorInstructions(inputs: OrchestratorPromptInputs): string {
  const withCaps = substituteCapabilitiesPlaceholder(inputs.orchestrator, inputs.entries);
  const behavior = substituteRoutingPlaceholder(withCaps, inputs.routingSection ?? null).trim();
  const parts: string[] = [];
  const soul = inputs.soul?.trim();
  if (soul) parts.push(soul, "");
  parts.push(behavior);
  return `${parts.join("\n")}\n`;
}

function depToInput(dep: ApmLockDepView): ApmDependencyInput | null {
  return dep.localPath ? { absPath: dep.localPath } : dep.repoUrl ? { repo: dep.repoUrl } : null;
}

export interface ProjectResult {
  ok: boolean;
  deployed: string[]; // claudeHome-relative files apm deployed for this primitive
  rulePath: string; // claudeHome-relative target (rules/garrison-orchestrator.md)
  fittingDir: string; // the captured fitting that owns the primitive
}

// Project the instructions as an APM-managed instructions primitive: emit a
// minimal hybrid fitting whose .apm/instructions/<id>.instructions.md deploys
// (through the global-composition symlink) to ~/.claude/rules/<id>.md, append it
// as a global dep, and apm install. End state: the rule is OWNED in apm.lock.
// Reversible — park(ORCHESTRATOR_PRIMITIVE_ID) drops it like any owned primitive.
export async function projectOrchestrator(opts: {
  instructions: string;
  runApm?: ApmRunner;
  claudeHome?: string;
}): Promise<ProjectResult> {
  const home = opts.claudeHome ?? claudeHome();
  const fittingDir = path.join(capturedFittingsDir(), ORCHESTRATOR_PRIMITIVE_ID);
  const dest = path.join(
    fittingDir,
    ".apm",
    "instructions",
    `${ORCHESTRATOR_PRIMITIVE_ID}.instructions.md`
  );
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, opts.instructions, "utf8");
  await writeYamlFile(path.join(fittingDir, "apm.yml"), {
    name: ORCHESTRATOR_PRIMITIVE_ID,
    version: "0.1.0",
    target: "claude",
    type: "hybrid",
    includes: "auto"
  });

  // deps = existing local/remote deps + ours (deduped by our fitting dir so a
  // re-projection updates in place rather than double-listing).
  const lock = await readGlobalLock();
  const inputs: ApmDependencyInput[] = lock.deps
    .map(depToInput)
    .filter((i): i is ApmDependencyInput => i !== null)
    .filter((i) => !("absPath" in i && i.absPath === fittingDir));
  inputs.push({ absPath: fittingDir });
  await writeGlobalApmManifest(inputs);
  const nextLock = await apmInstall({ runApm: opts.runApm });

  const dep = nextLock.deps.find((d) => d.name === ORCHESTRATOR_PRIMITIVE_ID);
  const deployed = dep?.deployedFiles ?? [];

  // Snapshot provenance (echo suppression): a later reconcile/watcher whose
  // on-disk hash equals this is our own write, not an external edit.
  let hash = "";
  try {
    hash = await hashFile(path.join(home, ORCHESTRATOR_RULE_REL));
  } catch {
    /* deploy target may differ under a stub runner; provenance hash is best-effort */
  }
  await recordWritten(`rule:${ORCHESTRATOR_PRIMITIVE_ID}`, hash, {
    surface: "rule",
    fittingId: ORCHESTRATOR_PRIMITIVE_ID
  });

  return { ok: true, deployed, rulePath: ORCHESTRATOR_RULE_REL, fittingDir };
}

// The higher-authority fallback (SP2): the same text Claude Code receives via
// --append-system-prompt at hosted-session launch (RC4 lane). Returned verbatim
// so the launcher owns the flag wiring; kept here so the projection and the
// fallback share one source of truth.
export function orchestratorAppendSystemPrompt(instructions: string): string {
  return instructions;
}

// ── Per-primary projection (GARRISON-RUNTIMES-V1 P8/D7) ─────────────────────
// FINDING-E7 established there is NO pre-existing AGENTS.md/GEMINI.md
// projection path in the repo, so THIS module is the single writer for
// non-claude primaries: the assembled orchestrator prompt is projected to the
// primary engine's native context-file convention (codex reads AGENTS.md from
// its cwd; gemini reads GEMINI.md). claude-code keeps the existing rules
// projection + append-system-prompt path untouched; the agent-sdk primary
// receives the prompt through the SDK systemPrompt mechanism (wired at the
// gateway warm seam), so neither writes a context file here.
//
// The marker matches src/lib/quarters-runtimes.ts PROJECTION_MARKER, so the
// generic Quarters tier shows provenance and refuses raw edits over it.
export const PRIMARY_CONTEXT_FILES: Record<string, string> = {
  codex: "AGENTS.md",
  gemini: "GEMINI.md"
};

export interface PrimaryProjectionResult {
  projected: boolean;
  file?: string;
  /** The printed authority warning (D7: weaker prompt authority than claude-code). */
  warning?: string;
}

export async function projectPrimaryContext(opts: {
  engine: string;
  instructions: string;
  targetDir: string;
}): Promise<PrimaryProjectionResult> {
  const fileName = PRIMARY_CONTEXT_FILES[opts.engine];
  if (!fileName) return { projected: false };
  const target = path.join(opts.targetDir, fileName);
  // Ownership check BEFORE writing: a pre-existing file WITHOUT our marker is
  // hand-authored — refuse to clobber it and say exactly what to do instead.
  // Only our own prior projection (marker present) or a missing file is
  // overwritten (reprojection at every up(), stale prompts never survive).
  let existing: string | null = null;
  try {
    existing = await fsp.readFile(target, "utf8");
  } catch {
    /* absent — fine */
  }
  if (existing !== null && !existing.includes(PROJECTION_MARKER)) {
    return {
      projected: false,
      file: target,
      warning:
        `PROJECTION REFUSED: ${target} already exists and is hand-authored (no GARRISON-PROJECTED marker). ` +
        `The ${opts.engine} primary will NOT receive the orchestrator prompt through it. Move or merge your ` +
        `${fileName}, or fold its content into the Orchestrator prompt, then run up again.`
    };
  }
  const header =
    `<!-- ${PROJECTION_MARKER} source=orchestrator engine=${opts.engine} -->\n` +
    `<!-- Managed by Garrison (RUNTIMES-V1 P8): the assembled Orchestrator prompt projected to the ${opts.engine} ` +
    `primary's native context convention. Edit it from the Muster Orchestrator tab, not this file. -->\n\n`;
  await fsp.mkdir(opts.targetDir, { recursive: true });
  await writeFileAtomic(target, header + opts.instructions);
  return {
    projected: true,
    file: target,
    warning:
      `PROMPT AUTHORITY WARNING: the ${opts.engine} primary receives the orchestrator prompt via ${fileName} ` +
      `(context-file convention) — weaker authority than the claude-code append-system-prompt path; ` +
      `the engine may weigh it like any other context file.`
  };
}

// ── Layered orchestrator preview (MARATHON-V3 D11, slice S3e) ────────────────
// The assembled-preview surface for the Muster orchestrator panel (S5c). The
// pure section machinery lives in orchestrator-sections.ts; this is the
// fs-touching loader that resolves a composition into {sections, assembled}.
//
// AUTHORED overrides persist beside the composition as a flat
// {sectionId: markdown} JSON. The Muster editor writes it; the locked blocks
// are ALWAYS regenerated from the resolved model, never read from disk.

export const AUTHORED_OVERRIDES_REL = ".garrison/orchestrator-authored.json";

// Read the authored-section overrides for a composition directory. Returns {}
// when the file is absent or unreadable, and keeps ONLY known authored section
// ids (so a stale/renamed key can never leak into the assembled prompt).
export async function readAuthoredOverrides(
  compositionDir: string
): Promise<Partial<Record<AuthoredSectionId, string>>> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(compositionDir, AUTHORED_OVERRIDES_REL), "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[garrison] ${AUTHORED_OVERRIDES_REL} is not valid JSON — using authored defaults`);
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const known = new Set<string>(AUTHORED_SECTION_IDS);
  const overrides: Partial<Record<AuthoredSectionId, string>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (known.has(key) && typeof value === "string" && value.trim().length > 0) {
      overrides[key as AuthoredSectionId] = value;
    }
  }
  return overrides;
}

// Resolve a composition into the layered orchestrator preview: the ordered
// section model plus its assembled concatenation. Locked blocks (capabilities,
// duties-and-levels, readiness) regenerate from the resolved model on every
// call; authored blocks come from the on-disk overrides or their defaults.
export async function loadOrchestratorPreview(
  compositionId: string = DEFAULT_COMPOSITION_ID
): Promise<OrchestratorPreview> {
  const composition = await readComposition(compositionId);
  const entries = await selectedLibraryEntries(composition.selections);
  const model = resolveModel({
    fittings: entries.map((entry) => ({ id: entry.id, metadata: entry.metadata })),
    compositionDuties: composition.duties,
    // An empty selected_duties block means "no explicit narrowing" — let the
    // resolver default to every known duty (matches resolveModel's own default).
    selectedDuties: composition.selectedDuties.length ? composition.selectedDuties : undefined
  });
  const authored = await readAuthoredOverrides(composition.directory);
  return buildOrchestratorPreview({ model, entries, authored });
}
