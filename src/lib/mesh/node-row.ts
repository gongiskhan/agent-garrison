// The shape `/api/mesh/nodes` hands the browser: one registry row per node,
// with this node's own row merged from its live local snapshot.
//
// It lives here rather than in the route module so the client panel can import
// the type without importing a server route.

import { nodeState, type NodeState } from "./staleness";
import type { MeshSelfSnapshot } from "./self-snapshot";

export interface MeshNodeRow {
  id: string;
  name: string;
  // Always a resolved palette hex, never null: an unresolvable or unset value
  // falls back to the id-derived accent, so every node is visually distinct
  // AND contrast-checked. See resolveAccent in src/lib/node-identity.ts.
  accentColor: string;
  tailnetHost: string | null;
  platform: string | null;
  status: string;
  state: NodeState;
  lastSeenAt: string | null;
  activeComposition: string | null;
  schemaVersion: number | null;
  clientVersion: string | null;
  capabilities: string[];
  // The node's last posted `/api/mesh/self` body. Untyped on purpose: a peer
  // running an older build posts an older shape, and the roster must still
  // render. Read it through `nodeHealth()`.
  health: Record<string, unknown>;
  isSelf: boolean;
  // false when this node has a node.json but no row in the registry yet.
  registered: boolean;
}

export interface MeshNodesResponse {
  nodes: MeshNodeRow[];
  self: MeshSelfSnapshot | null;
  degraded: false;
}

export interface MeshNodesUnavailable {
  error: string;
  since?: string;
  url?: string;
  self: MeshSelfSnapshot | null;
}

// Injected rather than imported: node-identity reads the filesystem, and this
// module is imported by the CLIENT panel for its row type and health accessor.
// The route supplies node-identity's resolveAccent; the tests supply the same
// one, so production and test never disagree about a colour.
export type AccentResolver = (value: unknown, id: string) => string;

// A peer's health block is whatever THAT node's build posted. Reach into it
// defensively; a missing field is "unknown", never a crash.
export function nodeHealth(row: MeshNodeRow): Partial<MeshSelfSnapshot> {
  return (row.health ?? {}) as Partial<MeshSelfSnapshot>;
}

// The registry's own row shape, narrowed to what the roster reads. Declared
// structurally rather than imported from the client package so this module
// stays free of the state client (the browser must never reach it).
export interface RegistryNode {
  name: string;
  accentColor: string;
  tailnetHost: string | null;
  platform: string | null;
  capabilities: string[];
  schemaVersion: number | null;
  clientVersion: string | null;
  activeComposition: string | null;
  status: string;
  health: Record<string, unknown>;
  lastSeenAt: string | null;
}

function registryRow(node: RegistryNode, selfId: string | null, accentHex: AccentResolver, now: number): MeshNodeRow {
  return {
    id: node.name,
    name: node.name,
    accentColor: accentHex(node.accentColor, node.name),
    tailnetHost: node.tailnetHost,
    platform: node.platform,
    status: node.status,
    state: nodeState(
      { status: node.status, lastSeenAt: node.lastSeenAt, health: node.health as { degraded?: unknown; activity?: unknown } },
      now
    ),
    lastSeenAt: node.lastSeenAt,
    activeComposition: node.activeComposition,
    schemaVersion: node.schemaVersion,
    clientVersion: node.clientVersion,
    capabilities: node.capabilities ?? [],
    health: node.health ?? {},
    isSelf: selfId !== null && node.name === selfId,
    registered: true
  };
}

function selfRow(self: MeshSelfSnapshot, registry: MeshNodeRow | null, now: number): MeshNodeRow {
  const status = registry?.status ?? "unregistered";
  return {
    id: self.node.id,
    name: self.node.name || self.node.id,
    // node.json is authoritative for identity and the registry is its replica,
    // so this node's own already-resolved palette hex wins over the pushed copy.
    accentColor: self.node.accentHex,
    tailnetHost: self.node.tailnetHost ?? registry?.tailnetHost ?? null,
    platform: self.platform,
    status,
    // Local data, so freshness is not in question — but `behind` and `retired`
    // still come from the registry and still decide the pill.
    state: nodeState({ status, lastSeenAt: self.at, health: self }, now),
    lastSeenAt: self.at,
    activeComposition: self.composition?.id ?? null,
    schemaVersion: self.schemaVersion.max,
    clientVersion: self.clientVersion,
    capabilities: registry?.capabilities ?? [],
    health: self as unknown as Record<string, unknown>,
    isSelf: true,
    registered: registry !== null
  };
}

// The roster: every registered node, with THIS node's row replaced by its live
// local snapshot rather than by the beat the registry last received. A node
// reading its own row through a heartbeat it may have failed to send is the
// one case where the mesh would show a machine the wrong answer about itself.
//
// A node that is not in the registry yet still renders, marked `registered:
// false` — an unenrolled machine must be visible as unenrolled, not absent.
export function mergeMeshRoster(
  registry: RegistryNode[],
  self: MeshSelfSnapshot | null,
  accentHex: AccentResolver,
  now = Date.now()
): MeshNodeRow[] {
  const selfId = self?.node.id ?? null;
  const rows = registry.map((node) => registryRow(node, selfId, accentHex, now));

  if (self) {
    const index = rows.findIndex((row) => row.isSelf);
    const merged = selfRow(self, index >= 0 ? rows[index] : null, now);
    if (index >= 0) rows[index] = merged;
    else rows.push(merged);
  }

  // Self first, then by name: the node you are looking at is the one you came
  // to check.
  return rows.sort((a, b) => (a.isSelf === b.isSelf ? a.name.localeCompare(b.name) : a.isSelf ? -1 : 1));
}
