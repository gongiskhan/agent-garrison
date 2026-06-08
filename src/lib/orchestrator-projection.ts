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
import { recordWritten } from "./provenance";
import { substituteCapabilitiesPlaceholder } from "./runner";
import type { ApmRunner } from "./apm-exec";
import type { ApmDependencyInput } from "./apm-manifest";
import type { LibraryEntry } from "./types";

// RC3 — project Garrison's orchestrator prompt INTO the real ~/.claude as an
// APM-managed instructions primitive. This is how "the Operative folds into your
// real Claude Code": instead of spawning a separate SDK agent with the assembled
// prompt as --append, Garrison deploys the prompt as a standing rule so the
// user's actual Claude Code carries the orchestrator behavior every session.
//
// Delivery (SP2): verified empirically AND against primary docs (Claude Code
// 2.1.168 / code.claude.com/docs/en/memory). A sentinel `~/.claude/rules/<x>.md`
// with no `paths:` frontmatter was auto-loaded by a standard headless
// `claude --print` run. Docs confirm: "Personal rules in ~/.claude/rules/ apply
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
  orchestrator: string; // the orchestrator prompt (may contain {{capabilities}})
  soul?: string; // identity prompt, folded in ahead of behavior
  entries: LibraryEntry[]; // resolved providers for {{capabilities}} substitution
}

// Pure: fold soul (identity) + orchestrator (behavior) and substitute the
// {{capabilities}} placeholder. Identity leads so it lands before the long
// behavior section buries it (mirrors runner.assembleSystemPrompt's ordering).
export function buildOrchestratorInstructions(inputs: OrchestratorPromptInputs): string {
  const behavior = substituteCapabilitiesPlaceholder(inputs.orchestrator, inputs.entries).trim();
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
