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
    governing: true
  },
  {
    id: "channels",
    order: 2,
    name: "Channels",
    cardinality: "multi",
    shapes: ["plugin", "skill", "script"],
    notes: "User-facing message surfaces (Slack, web channel, voice). Garrison-side runtime."
  },
  {
    id: "gateway",
    order: 3,
    name: "Gateway",
    cardinality: "multi",
    shapes: ["script", "manual-instructions"],
    notes: "The Claude Code execution path (stream-JSON). Garrison-side runtime."
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
      "Alternative execution engines behind the uniform runtime bridge (Agent SDK, Codex, Gemini). The composition names one primary; others are secondary delegate targets."
  },
  {
    id: "memory",
    order: 5,
    name: "Memory",
    // multi + cli since 2026-06-10: trello-data-source (component_shape: cli)
    // joins this role alongside the memory compiler — external data the
    // Operative recalls and manipulates, with a derived Tasks truth file.
    cardinality: "multi",
    shapes: ["skill", "system-prompt", "hook", "cli"],
    notes: "Produces the Context document; unified with the local memory-compiler. Also holds external recall sources (e.g. Trello-backed derived Tasks)."
  },
  {
    id: "observability",
    order: 6,
    name: "Observability",
    cardinality: "multi",
    shapes: ["hook", "script", "plugin"],
    notes: "Health, errors, runtime reporting; surfaces the Logs record."
  },
  {
    id: "sessions",
    order: 7,
    name: "Sessions",
    cardinality: "multi",
    shapes: ["plugin", "script", "cli-skill"],
    notes:
      "The working dev session and its records — Dev Env (the consolidated tabbed terminal + browser surface) plus the artifact store. Surfaces the Sessions record."
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
      "Auxiliary own-port live surfaces — screen share, standalone browser, and remote Outpost bridges. Each is detected via the own_port flag and linked from the sidebar Views group."
  }
];

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
