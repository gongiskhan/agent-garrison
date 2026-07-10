import type { FacultyDefinition, FacultyId, GarrisonMetadata } from "./types";

// Faculties are ROLES (the Quarters pivot). Each is a slot a Fitting fills; the
// own-port runtime residue (dev-env, screen-share, outposts, browser, monitor,
// web-channel, voice) folds under sessions / channels / observability and is
// detected via the `own_port` metadata flag.
// Legacy faculty names map here via metadata.ts normalizeDeprecations.
export const faculties: FacultyDefinition[] = [
  {
    id: "orchestrator",
    order: 1,
    name: "Orchestrator",
    cardinality: "single",
    shapes: ["system-prompt"],
    notes: "The governing behavior spine — projected into ~/.claude as a managed prompt.",
    governing: true,
    essential: true,
    tier: "agent"
  },
  {
    id: "channels",
    order: 2,
    name: "Channels",
    cardinality: "multi",
    shapes: ["plugin", "skill", "script"],
    notes: "User-facing message surfaces (Slack, web channel, voice). Garrison-side runtime.",
    essential: true,
    tier: "agent"
  },
  {
    id: "gateway",
    order: 3,
    name: "Gateway",
    cardinality: "multi",
    shapes: ["script", "manual-instructions"],
    notes: "The Claude Code execution path (stream-JSON). Garrison-side runtime.",
    essential: true,
    tier: "agent"
  },
  {
    id: "runtimes",
    order: 4,
    name: "Runtimes",
    // Split out of sessions 2026-06-18: the alternative execution engines
    // (Agent SDK, Codex, Gemini) are an execution concern of their own — peers
    // to the gateway, not session surfaces. Each drives the uniform
    // RuntimeAdapter + runtime-bridge delegate() contract. The seed runtimes
    // ship as cli-skill packages (they wrap an external CLI behind a skill).
    cardinality: "multi",
    shapes: ["cli-skill", "script"],
    notes:
      "Alternative execution engines behind the uniform runtime bridge (Agent SDK, Codex, Gemini). The composition names one primary; others are secondary delegate targets.",
    // 2026-06-24: promoted to an essential Faculty — every Operative runs ON a
    // runtime (the orchestrator's own engine is the primary runtime), so a
    // runtime belongs in "Every agent needs these". Orthogonal to the `tier`
    // axis below (essential = base-need grouping; tier = agent/dev grouping).
    essential: true,
    // Dev-tier: the dev mode (Joe) is the only mode that activates `runtimes`.
    tier: "dev"
  },
  {
    id: "memory",
    order: 5,
    name: "Memory",
    // multi + cli since 2026-06-10: trello-data-source (component_shape: cli)
    // joins this role alongside the memory store — external data the
    // Operative recalls and manipulates, with a derived Tasks truth file.
    cardinality: "multi",
    shapes: ["skill", "system-prompt", "hook", "cli"],
    notes: "Produces the Context document; unified with the Basic Memory store. Also holds external recall sources (e.g. Trello-backed derived Tasks).",
    essential: true,
    tier: "agent"
  },
  {
    id: "observability",
    order: 6,
    name: "Observability",
    cardinality: "multi",
    shapes: ["hook", "script", "plugin"],
    notes: "Health, errors, runtime reporting; surfaces the Logs record.",
    // Dev-tier: watching the operative's runtime health is a development/ops
    // concern, not part of the everyday base operative.
    tier: "dev"
  },
  {
    id: "sessions",
    order: 7,
    name: "Sessions",
    cardinality: "multi",
    shapes: ["plugin", "script", "cli-skill"],
    notes:
      "The working dev session and its records — Dev Env (the consolidated tabbed terminal + browser surface) plus the artifact store. Surfaces the Sessions record.",
    tier: "dev"
  },
  {
    id: "surfaces",
    order: 8,
    name: "Surfaces",
    // Split out of sessions 2026-06-18: the auxiliary own-port live viewers
    // (screen share, standalone browser, remote Outpost bridge) are ways to
    // *see/reach* the machine, distinct from the primary dev session.
    cardinality: "multi",
    shapes: ["plugin", "script"],
    notes:
      "Auxiliary own-port live surfaces — screen share, standalone browser, and remote Outpost bridges. Each is detected via the own_port flag and linked from the sidebar Views group.",
    tier: "dev"
  },
  {
    id: "modes",
    order: 9,
    name: "Modes",
    cardinality: "single",
    shapes: ["system-prompt"],
    notes:
      "The operative's identity/persona layer — the souls (Gary/Joe/James) + shared voice + per-mode routing bias + name-based sticky switching, composed into the orchestrator's system prompt. One operative, three faces, one shared memory.",
    essential: false,
    // Agent-tier: the persona layer shapes the everyday operative.
    tier: "agent"
  },
  // ── Optional capability faculties (2026-06-24) ──────────────────────────────
  // Homes for the promoted Claude Code primitives. Named by what the capability
  // is FOR, never by the primitive type. `cardinality: multi` — each holds many
  // promoted Fittings. `shapes` are permissive (these slots accept the shapes the
  // promoted primitives carry). Agent vs Dev anchored on the modes config.
  {
    id: "knowledge",
    order: 10,
    name: "Knowledge",
    cardinality: "multi",
    shapes: ["skill", "plugin", "cli", "cli-skill", "mcp"],
    notes:
      "Create, edit, and organize documents and notes — office files, vault notes, generated reports — and pull facts out of them.",
    tier: "agent"
  },
  {
    id: "research",
    order: 11,
    name: "Research & Media",
    cardinality: "multi",
    shapes: ["skill", "plugin", "cli", "cli-skill", "mcp"],
    notes:
      "Find things out and make sense of media — research a question across sources, watch and summarize a video, consult reference material.",
    tier: "agent"
  },
  {
    id: "building",
    order: 12,
    name: "Software Building",
    cardinality: "multi",
    shapes: ["skill", "cli-skill", "script", "plugin"],
    notes:
      "Write, test, and ship software end-to-end — plan the work, implement it, prove it works, and record the evidence.",
    tier: "dev"
  },
  {
    id: "code-intelligence",
    order: 13,
    name: "Code Intelligence",
    cardinality: "multi",
    shapes: ["mcp", "skill", "cli-skill"],
    notes:
      "Understand and navigate a codebase — find where things are defined and used, and read structure without trawling files by hand.",
    tier: "dev"
  },
  {
    id: "design",
    order: 14,
    name: "Design Studio",
    cardinality: "multi",
    shapes: ["skill", "plugin"],
    notes:
      "Design and prototype user interfaces — explore visual directions, build hi-fi prototypes, and review the result for polish.",
    tier: "dev"
  },
  {
    id: "browser-qa",
    order: 15,
    name: "Browser & QA",
    cardinality: "multi",
    shapes: ["skill", "mcp", "cli-skill"],
    notes:
      "Drive a real browser to build and verify — click through a flow, fill forms, read the console, and confirm a change actually works.",
    tier: "dev"
  },
  {
    id: "coordination",
    order: 16,
    name: "Coordination",
    cardinality: "multi",
    shapes: ["mcp", "hook", "script"],
    notes:
      "Keep parallel work sessions out of each other's way — claim files, plan before touching shared structure, and pass messages between sessions.",
    tier: "dev"
  },
  {
    id: "connectors",
    order: 17,
    name: "Connectors",
    // 2026-06-26: authenticated, reusable connections to the external services
    // the operative acts on. Multi (many services coexist); agent-tier (a base
    // operative reaches out to Slack/Google/Trello). A new faculty because no
    // existing role is "a connected service with a callable action catalog +
    // Vault-sealed auth + triggers"; it absorbs the dropped data-source case.
    cardinality: "multi",
    shapes: ["cli", "cli-skill", "script", "plugin", "mcp"],
    notes:
      "Authenticated connections to external services (Slack, Google, Trello, …) — each a Fitting exposing a discoverable action catalog with Vault-sealed credentials and optional webhook/listener triggers.",
    tier: "agent"
  }
];

// Per-faculty two-part role copy for the Compose station detail + grid tiles.
// Single source of truth (HV wave — was inlined in FacultyStation.tsx).
// `role` = what the faculty does; `fit` = how a Fitting fills it.
export const facultyRoleCopy: Record<FacultyId, { role: string; fit: string }> = {
  orchestrator: {
    role: "Governs the operative's behavior — projected into ~/.claude as a managed prompt primitive.",
    fit: "The capstone role. It coordinates the other roles, owns global config, and provides the behavioral spine."
  },
  channels: {
    role: "Connects user-facing message surfaces (Slack, web channel, voice).",
    fit: "Garrison-side runtime transport. The Operative is reached through these channels; only a garrison-control MCP entry projects into ~/.claude."
  },
  gateway: {
    role: "The Claude Code execution path (stream-JSON).",
    fit: "Garrison-side runtime. Hosts the sessions that authoring and channel traffic run through."
  },
  memory: {
    role: "Produces the Context document and owns recall.",
    fit: "Unified with the Basic Memory store — one instance produces the Context (CLAUDE.md) surfaced in Quarters."
  },
  observability: {
    role: "Reports health, errors, and runtime state; surfaces the Logs record.",
    fit: "Collection is Garrison-side; an own-port Monitor Fitting surfaces it read-only."
  },
  runtimes: {
    role: "Alternative execution engines behind the uniform runtime bridge.",
    fit: "Agent SDK, Codex, and Gemini runtimes. The composition names one primary; others are secondary delegate targets the Orchestrator routes work to."
  },
  sessions: {
    role: "The working dev session and its records.",
    fit: "Dev Env consolidates terminals and session status into one tabbed surface; the artifact store backs it."
  },
  surfaces: {
    role: "Auxiliary own-port live surfaces for seeing and reaching the machine.",
    fit: "Screen share, standalone browser, and remote Outpost bridges — each detected via the own_port flag and linked from the sidebar Views group."
  },
  modes: {
    role: "Gives the operative named faces (Gary/Joe/James) over one shared memory.",
    fit: "One modes fitting supplies the souls + shared voice + per-mode routing bias + name-based switching the orchestrator composes into its system prompt."
  },
  knowledge: {
    role: "Lets the operative create, edit, and organize documents and notes.",
    fit: "Document and note capabilities — office files, vault notes, generated reports — plus pulling facts back out of them."
  },
  research: {
    role: "Lets the operative find things out and make sense of media.",
    fit: "Research a question across sources, watch and summarize a video, or consult reference material."
  },
  building: {
    role: "Lets the operative write, test, and ship software end-to-end.",
    fit: "Plan the work, implement it, prove it works, and record the evidence — the full build pipeline."
  },
  "code-intelligence": {
    role: "Lets the operative understand and navigate a codebase.",
    fit: "Find where things are defined and used, and read structure without trawling files by hand."
  },
  design: {
    role: "Lets the operative design and prototype user interfaces.",
    fit: "Explore visual directions, build hi-fi prototypes, and review the result for polish."
  },
  "browser-qa": {
    role: "Lets the operative drive a real browser to build and verify.",
    fit: "Click through a flow, fill forms, read the console, and confirm a change actually works."
  },
  coordination: {
    role: "Keeps parallel work sessions out of each other's way.",
    fit: "Claim files, plan before touching shared structure, and pass messages between sessions."
  },
  connectors: {
    role: "Connects the operative to the external services it can act on.",
    fit: "Each connector is a Fitting for one service — a catalog of callable actions, Vault-sealed credentials, and optional webhook/listener triggers. Trello, Google, Slack, and Deepgram ship as seeds; the long tail installs from the Armory."
  }
};

export const facultyById = new Map<FacultyId, FacultyDefinition>(
  faculties.map((faculty) => [faculty.id, faculty])
);

export function getFaculty(id: FacultyId): FacultyDefinition {
  const faculty = facultyById.get(id);
  if (!faculty) {
    throw new Error(`Unknown faculty: ${id}`);
  }
  return faculty;
}

// Own-port detection is now per-Fitting (the `own_port` metadata flag), since a
// role like `sessions` mixes own-port and non-own-port Fittings. The runtime
// status file (~/.garrison/ui-fittings/<id>.json) remains the source of truth
// for the actual port; default_port is informational.
export function isOwnPortFitting(entry: { metadata?: Pick<GarrisonMetadata, "own_port"> }): boolean {
  return entry.metadata?.own_port === true;
}

export function ownPortDefaultPort(entry: {
  metadata?: Pick<GarrisonMetadata, "default_port">;
}): number | undefined {
  return entry.metadata?.default_port;
}
