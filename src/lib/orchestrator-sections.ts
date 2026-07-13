// Layered orchestrator prompt (MARATHON-V3 D11, slice S3e).
//
// The orchestrator prompt is assembled from named SECTIONS in two classes:
//
//   GENERATED + LOCKED - derived from the resolved model, regenerated on every
//   composition change, NEVER hand-edited (constraint 12). Three blocks:
//     - capabilities:       the installed Faculties + their for_consumers guidance
//     - duties-and-levels:  the duty table the Dispatcher + operative read
//     - readiness:          the D10 validation state (which rules are met/unmet)
//
//   AUTHORED + EDITABLE - the orchestration doctrine (routing philosophy,
//   escalation policy, when-to-ask-vs-proceed, identity hand-off), each shipping
//   predefined default text (orchestrator-authored-defaults.ts).
//
// Locked sections carry a machine-readable marker (`locked: true` +
// `regeneratedFrom: "composition"`) so the Muster editor (S5c) can render them
// greyed with a "regenerated from composition" badge and refuse hand edits over
// them. Regeneration (regenerateLockedSections) rebuilds the locked blocks from
// a fresh resolved model while preserving authored edits verbatim.
//
// Every function here is PURE (no fs, no network) so tests exercise it without
// HTTP; the fs-touching preview loader lives in orchestrator-projection.ts.

import type { DutyLevel, DutyLevelCell, LibraryEntry } from "./types";
import type { ResolvedModel } from "./resolver";
import { substituteCapabilitiesPlaceholder } from "./runner";
import {
  AUTHORED_SECTION_DEFAULTS,
  AUTHORED_SECTION_IDS,
  type AuthoredSectionId
} from "./orchestrator-authored-defaults";

export type SectionKind = "locked" | "authored";

// A locked section's content is derived from the composition. The literal is a
// discriminated marker the UI keys off (never free text) - today only the
// resolved composition drives locked blocks.
export type RegeneratedFrom = "composition";

export interface PromptSection {
  id: string;
  kind: SectionKind;
  title: string;
  // Markdown body only - the section heading is rendered from `title` by
  // assembleLayeredPrompt, so authored edits touch prose, never the heading.
  content: string;
  // Machine-readable marker for the UI: true iff kind === "locked". A locked
  // section is greyed + badged and regeneration overwrites it; an authored
  // section is editable and regeneration preserves it.
  locked: boolean;
  // Present only on locked sections: what the content was regenerated from.
  regeneratedFrom?: RegeneratedFrom;
}

export const LOCKED_SECTION_IDS = ["capabilities", "duties-and-levels", "readiness"] as const;
export type LockedSectionId = (typeof LOCKED_SECTION_IDS)[number];

const LOCKED_SECTION_TITLES: Record<LockedSectionId, string> = {
  capabilities: "Tools and capabilities available in this Operative",
  "duties-and-levels": "Duties and levels",
  readiness: "Composition readiness"
};

// Canonical section order: authored framing first, then the generated inventory
// (capabilities -> duties -> readiness), then the behavior policies, with the
// identity hand-off last. assembleLayeredPrompt emits sections in the order it
// receives them; buildLayeredSections produces this order.
const SECTION_ORDER: string[] = [
  "routing-philosophy",
  "capabilities",
  "duties-and-levels",
  "readiness",
  "escalation-policy",
  "when-to-ask",
  "identity-handoff"
];

export interface LayeredPromptInput {
  model: ResolvedModel;
  entries: LibraryEntry[];
  // Authored overrides by section id. Any absent id falls back to its default
  // text. Unknown ids are ignored.
  authored?: Partial<Record<AuthoredSectionId, string>>;
}

export interface OrchestratorPreview {
  sections: PromptSection[];
  assembled: string;
}

// ── Locked-block generators ─────────────────────────────────────────────────

// The capabilities block - reuses the runner's single renderer (the locality
// principle: provider for_consumers guidance lives in the fitting, folded here).
// Empty compositions render the runner's "no Faculties" sentinel.
export function renderCapabilities(entries: LibraryEntry[]): string {
  const block = substituteCapabilitiesPlaceholder("{{capabilities}}", entries).trim();
  return [
    "Treat this list as the authoritative inventory of what is installed in this",
    "composition. Each provider's usage guidance is indented under its line. If a",
    "capability is not listed here it is not installed - say so rather than",
    "fabricating it.",
    "",
    block
  ].join("\n");
}

// Escape a value for a single markdown table cell: pipes would break the column
// layout, and any embedded newline collapses to a space.
function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

// Render a leaf cell's {skill, target, effort} as a compact "k=v" list. An
// automation-shaped cell may leave target/effort empty (D14); an entirely empty
// cell is labelled rather than rendered blank.
function renderLeafCell(cell: DutyLevelCell): string {
  const parts: string[] = [];
  if (cell.skill) parts.push(`skill=${cell.skill}`);
  if (cell.target) parts.push(`target=${cell.target}`);
  if (cell.effort) parts.push(`effort=${cell.effort}`);
  return parts.length ? parts.join(", ") : "automation (no target/effort)";
}

// Render a composite level's ordered sequence. Each entry runs at its explicit
// per-entry level override, or the parent level by default (mirrors the
// resolver's resolveSequence semantics), so the table shows the EFFECTIVE level.
function renderSequence(level: DutyLevel, parentLevel: number): string {
  const entries = (level.sequence ?? []).map((entry) => {
    const effective = entry.level ?? parentLevel;
    return `${entry.duty} (level ${effective})`;
  });
  return `sequence: ${entries.join(", ")}`;
}

// The duty ids to render: the transitive closure of the selected duties (each
// selected duty plus every duty its levels sequence, recursively), in discovery
// order. This is the set the operative actually works with - unselected
// fitting-provided duties are not part of this composition's repertoire. Refs to
// unknown duties are surfaced in the parent's "Resolves to" cell, not here.
function renderableDutyIds(model: ResolvedModel): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const duty = model.duties[id];
    if (!duty) return;
    out.push(id);
    for (const level of duty.levels) {
      for (const entry of level.sequence ?? []) walk(entry.duty);
    }
  };
  for (const id of model.selectedDuties) walk(id);
  return out;
}

// The duties-and-levels block: one sub-section per duty (id, title, verb
// description) with a table of its levels - each level's one-line description
// and what it resolves to (a leaf cell's skill/target/effort, or a composite's
// resolved sequence). This is what the Dispatcher and the operative read to know
// the system's duties.
export function renderDutiesAndLevels(model: ResolvedModel): string {
  const ids = renderableDutyIds(model);
  if (ids.length === 0) {
    return "_No duties are selected in this composition._";
  }
  const intro = [
    "The work this Operative can perform, as duties. Each duty has one or more",
    "levels; the Dispatcher selects a (duty, level) for each request, and the",
    "card then visits exactly that level's resolved sequence.",
    ""
  ];
  const blocks = ids.map((id) => {
    const duty = model.duties[id];
    const lines: string[] = [`### ${id} (${escapeCell(duty.title)})`, duty.description, ""];
    lines.push("| Level | What it does | Resolves to |");
    lines.push("| --- | --- | --- |");
    duty.levels.forEach((level, index) => {
      const levelNumber = index + 1;
      const resolvesTo = level.cell
        ? renderLeafCell(level.cell)
        : renderSequence(level, levelNumber);
      lines.push(
        `| ${levelNumber} | ${escapeCell(level.description)} | ${escapeCell(resolvesTo)} |`
      );
    });
    return lines.join("\n");
  });
  return [...intro, blocks.join("\n\n")].join("\n");
}

// The readiness block: the D10 validation state - the duty-graph verdict plus
// each readiness rule as a met/unmet checkbox. The Operative is READY only when
// the graph is valid AND every rule is met (mirrors ResolvedModel.ready).
export function renderReadiness(model: ResolvedModel): string {
  const lines: string[] = [
    "The composition validation state. The Operative is READY only when the duty",
    "graph is valid and every rule below is met.",
    "",
    `State: ${model.ready ? "READY" : "NOT READY"}`,
    ""
  ];
  if (model.errors.length === 0) {
    lines.push("Duty graph: valid");
  } else {
    lines.push(`Duty graph: ${model.errors.length} error(s)`);
    for (const error of model.errors) {
      lines.push(`- ${error.code}: ${error.message}`);
    }
  }
  lines.push("", "Rules:");
  for (const result of model.rules) {
    lines.push(`- [${result.met ? "x" : " "}] ${result.rule.id}: ${result.message}`);
  }
  return lines.join("\n");
}

// ── Section assembly ────────────────────────────────────────────────────────

function lockedSection(id: LockedSectionId, content: string): PromptSection {
  return {
    id,
    kind: "locked",
    title: LOCKED_SECTION_TITLES[id],
    content,
    locked: true,
    regeneratedFrom: "composition"
  };
}

// Build the three locked sections from the resolved model + providers. Callable
// on its own so regeneration can rebuild ONLY the locked blocks.
export function buildLockedSections(input: LayeredPromptInput): PromptSection[] {
  return [
    lockedSection("capabilities", renderCapabilities(input.entries)),
    lockedSection("duties-and-levels", renderDutiesAndLevels(input.model)),
    lockedSection("readiness", renderReadiness(input.model))
  ];
}

// Build the authored sections from their defaults, overlaying any provided
// override text. Always returns every authored section (defaults fill gaps) so a
// composition never loses a doctrine section.
export function buildAuthoredSections(
  overrides: Partial<Record<AuthoredSectionId, string>> = {}
): PromptSection[] {
  return AUTHORED_SECTION_IDS.map((id) => {
    const def = AUTHORED_SECTION_DEFAULTS[id];
    const override = overrides[id];
    return {
      id,
      kind: "authored" as const,
      title: def.title,
      content: (override ?? def.content).trim(),
      locked: false
    };
  });
}

// The full ordered section model for a composition: authored + locked, in the
// canonical order. This is the source both the assembled prompt and the Muster
// editor render.
export function buildLayeredSections(input: LayeredPromptInput): PromptSection[] {
  const byId = new Map<string, PromptSection>();
  for (const section of buildLockedSections(input)) byId.set(section.id, section);
  for (const section of buildAuthoredSections(input.authored)) byId.set(section.id, section);
  const ordered: PromptSection[] = [];
  for (const id of SECTION_ORDER) {
    const section = byId.get(id);
    if (section) ordered.push(section);
  }
  return ordered;
}

// Concatenate sections in order, each wrapped in machine-readable boundary
// markers. The markers let the UI locate each section's region (and its
// locked/authored class) and let a re-parse map assembled text back to sections.
export function assembleLayeredPrompt(sections: PromptSection[]): string {
  const blocks = sections.map((section) => {
    const attrs = [`id=${section.id}`, `kind=${section.kind}`];
    if (section.regeneratedFrom) attrs.push(`regenerated-from=${section.regeneratedFrom}`);
    return [
      `<!-- GARRISON-SECTION ${attrs.join(" ")} -->`,
      `## ${section.title}`,
      "",
      section.content.trim(),
      `<!-- /GARRISON-SECTION id=${section.id} -->`
    ].join("\n");
  });
  return `${blocks.join("\n\n")}\n`;
}

// Regeneration path (constraint 12): given the previous section set and a fresh
// resolved model + providers, rebuild the LOCKED sections from the new model
// while preserving every authored section's content verbatim. Sections keep
// their previous order; a locked section present in `previous` is replaced by
// its freshly generated twin, authored sections pass through untouched.
export function regenerateLockedSections(
  previous: PromptSection[],
  input: LayeredPromptInput
): PromptSection[] {
  const fresh = new Map<string, PromptSection>(
    buildLockedSections(input).map((section) => [section.id, section])
  );
  return previous.map((section) => {
    if (section.kind !== "locked") return section;
    return fresh.get(section.id) ?? section;
  });
}

// The assembled-preview surface (S5c consumes it via the API). Pure: sections +
// their concatenation. Locked blocks are freshly generated from the model;
// authored blocks come from the provided overrides or their defaults.
export function buildOrchestratorPreview(input: LayeredPromptInput): OrchestratorPreview {
  const sections = buildLayeredSections(input);
  return { sections, assembled: assembleLayeredPrompt(sections) };
}
