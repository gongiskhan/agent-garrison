import type { PrimitiveDefinition, PrimitiveId } from "./types";

export const primitives: PrimitiveDefinition[] = [
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
    shapes: ["skill", "mcp", "script"],
    notes: "Docs, codebases, and references the operative can read."
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
    id: "testing-framework",
    order: 6,
    name: "Testing framework",
    cardinality: "multi",
    shapes: ["script", "skill"],
    notes: "Test writers and verification helpers."
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
  }
];

export const primitiveById = new Map<PrimitiveId, PrimitiveDefinition>(
  primitives.map((primitive) => [primitive.id, primitive])
);

export function getPrimitive(id: PrimitiveId): PrimitiveDefinition {
  const primitive = primitiveById.get(id);
  if (!primitive) {
    throw new Error(`Unknown primitive: ${id}`);
  }
  return primitive;
}
