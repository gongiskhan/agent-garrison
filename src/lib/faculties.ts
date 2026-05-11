import type { FacultyDefinition, FacultyId } from "./types";

export const faculties: FacultyDefinition[] = [
  {
    id: "heartbeat",
    order: 1,
    name: "Heartbeat",
    cardinality: "single",
    shapes: ["script", "skill", "system-prompt", "manual-instructions"],
    notes: "The cadence that wakes the operative."
  },
  {
    id: "scheduler",
    order: 2,
    name: "Scheduler",
    cardinality: "single",
    shapes: ["script", "skill"],
    notes: "Scheduled work outside the heartbeat cadence."
  },
  {
    id: "data-sources",
    order: 3,
    name: "Data sources",
    cardinality: "multi",
    shapes: ["mcp", "cli"],
    notes: "Integration-flavoured one-way fetches in v1."
  },
  {
    id: "knowledge-base",
    order: 4,
    name: "Knowledge base",
    cardinality: "multi",
    shapes: ["skill", "mcp", "script", "cli-skill"],
    notes:
      "Docs, codebases, and references the operative can read. cli-skill is allowed for Fittings that pair a CLI surface for the Operative with a UI surface for the user (e.g. Documents)."
  },
  {
    id: "automations",
    order: 5,
    name: "Automations",
    cardinality: "multi",
    shapes: ["cli-skill", "mcp"],
    notes: "Actions the operative can take in the world."
  },
  {
    id: "skills",
    order: 6,
    name: "Skills",
    cardinality: "multi",
    shapes: ["script", "skill"],
    notes: "Reusable agent skills the Operative can invoke — including but not limited to test authoring."
  },
  {
    id: "memory",
    order: 7,
    name: "Memory",
    cardinality: "single",
    shapes: ["skill", "system-prompt", "hook"],
    notes: "Within-session and cross-session recall."
  },
  {
    id: "classifier",
    order: 8,
    name: "Classifier",
    cardinality: "single",
    shapes: ["skill", "system-prompt"],
    notes: "The routing floor every prompt crosses."
  },
  {
    id: "gateway",
    order: 9,
    name: "Gateway",
    cardinality: "single",
    shapes: ["script", "manual-instructions"],
    notes: "The MCP-speaking entry point."
  },
  {
    id: "channels",
    order: 10,
    name: "Channels",
    cardinality: "multi",
    shapes: ["plugin", "skill", "script"],
    notes: "User-facing message surfaces."
  },
  {
    id: "observability",
    order: 11,
    name: "Observability",
    cardinality: "multi",
    shapes: ["hook", "script"],
    notes: "Health, errors, no-ops, and runtime reporting."
  },
  {
    id: "soul",
    order: 12,
    name: "Soul",
    cardinality: "single",
    shapes: ["system-prompt"],
    notes: "Identity, tone, voice, and boundaries."
  },
  {
    id: "orchestrator",
    order: 13,
    name: "Orchestrator",
    cardinality: "single",
    shapes: ["system-prompt"],
    notes: "The governing behavior spine and global config owner.",
    governing: true
  },
  {
    id: "artifact-store",
    order: 14,
    name: "Artifact store",
    cardinality: "single",
    shapes: ["cli-skill"],
    notes:
      "Filesystem-backed storage for files the Operative or its Fittings produce — documents, recordings, audio."
  },
  {
    id: "terminal",
    order: 15,
    name: "Terminal",
    cardinality: "single",
    shapes: ["plugin", "script"],
    family: "workbench",
    notes: "PTY-backed terminal sessions with SSH host support and Claude Code launch presets."
  },
  {
    id: "screen-share",
    order: 16,
    name: "Screen share",
    cardinality: "single",
    shapes: ["plugin", "script"],
    family: "workbench",
    notes: "macOS screenshot capture viewer (~2fps JPEG polling) for phone/remote access."
  },
  {
    id: "worktree-management",
    order: 17,
    name: "Worktree management",
    cardinality: "single",
    shapes: ["plugin", "script"],
    family: "workbench",
    notes: "Git worktree lifecycle — create, list, and delete worktrees with per-branch env port rewriting."
  },
  {
    id: "session-view",
    order: 18,
    name: "Session view",
    cardinality: "single",
    shapes: ["plugin"],
    family: "workbench",
    notes: "Claude Code session status dashboard across git worktrees."
  },
  {
    id: "outposts",
    order: 19,
    name: "Outposts",
    cardinality: "multi",
    shapes: ["plugin"],
    family: "workbench",
    notes: "Remote Mac bridges connected over Garrison Outpost Protocol v1 — spawn processes, watch files, manage git worktrees on remote machines."
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
