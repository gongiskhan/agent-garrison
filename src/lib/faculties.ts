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
    shapes: ["script", "skill", "system-prompt"],
    notes: "Reusable agent skills the Operative can invoke — including but not limited to test authoring and Soul sub-sessions."
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
    cardinality: "multi",
    shapes: ["script", "manual-instructions"],
    notes: "The MCP-speaking entry point. Multi-cardinality: http-gateway (chat operative) and mcp-gateway (UI-tab tool bridge) can coexist."
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
    notes: "PTY-backed terminal sessions. Stand-alone Fitting on its own port (default 7078)."
  },
  {
    id: "screen-share",
    order: 16,
    name: "Screen share",
    cardinality: "single",
    shapes: ["plugin", "script"],
    notes: "macOS screenshot capture viewer (~1fps JPEG polling). Stand-alone Fitting on its own port (default 7079)."
  },
  {
    id: "worktree-management",
    order: 17,
    name: "Worktree management",
    cardinality: "single",
    shapes: ["plugin", "script"],
    notes: "Git worktree lifecycle — create, list, and delete worktrees. Stand-alone Fitting on its own port (default 7080)."
  },
  {
    id: "session-view",
    order: 18,
    name: "Session view",
    cardinality: "single",
    shapes: ["plugin"],
    notes: "Claude Code session status dashboard across git worktrees. Stand-alone Fitting on its own port (default 7081)."
  },
  {
    id: "outposts",
    order: 19,
    name: "Outposts",
    cardinality: "multi",
    shapes: ["plugin"],
    notes: "Remote Mac bridges connected over Garrison Outpost Protocol v1. Stand-alone Fitting on its own port (default 7082)."
  },
  {
    id: "sync",
    order: 20,
    name: "Sync",
    cardinality: "multi",
    shapes: ["script", "cli-skill"],
    notes: "Periodic mirroring between the host and external surfaces (filesystems, vaults). v1 = host→outpost unidirectional."
  },
  {
    id: "monitor",
    order: 21,
    name: "Monitor",
    cardinality: "single",
    shapes: ["plugin", "script"],
    notes:
      "Read-only visibility into everything Garrison spawns — PIDs, status, ports, logs. Default Fitting serves its own UI on its own port; consumers link by URL."
  },
  {
    id: "web-channel",
    order: 22,
    name: "Web channel",
    cardinality: "single",
    shapes: ["plugin", "script"],
    notes:
      "Mobile-first browser chat surface. Stand-alone Fitting on its own port (default 7083) — talks to the Operative via the http-gateway and provides a kind:channel capability."
  },
  {
    id: "browser",
    order: 23,
    name: "Browser",
    cardinality: "single",
    shapes: ["plugin", "script"],
    notes:
      "Headless browser substrate. Default Fitting runs Playwright-managed Chromium on its own port (default 7084), exposes CDP / screencast / input over WebSockets, and reverse-proxies Chromium's built-in DevTools frontend so iPad Safari over Tailscale gets full DevTools."
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

// Faculties whose Fittings serve their own React UI on their own port (Monitor
// pattern, per docs/decisions/2026-05-17-dissolve-workbench.md). These do not
// declare x-garrison.ui.views[] — they register at runtime via
// ~/.garrison/ui-fittings/<id>.json. The default port is documented below.
export const OWN_PORT_FACULTIES: ReadonlySet<FacultyId> = new Set([
  "terminal",
  "screen-share",
  "worktree-management",
  "session-view",
  "outposts",
  "monitor",
  "web-channel",
  "browser"
]);

export const OWN_PORT_DEFAULTS: Partial<Record<FacultyId, number>> = {
  terminal: 7078,
  "screen-share": 7079,
  "worktree-management": 7080,
  "session-view": 7081,
  outposts: 7082,
  "web-channel": 7083,
  browser: 7084
  // monitor's default port is owned by the Monitor Fitting itself; if/when it
  // lands a canonical default, add it here.
};

export function isOwnPortFaculty(id: FacultyId): boolean {
  return OWN_PORT_FACULTIES.has(id);
}
