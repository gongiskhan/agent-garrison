// Node liveness vocabulary.
//
// Deliberately the SAME model as the outpost worker registry
// (`dispatch-workers.ts`): a 45 second staleness limit over a 15 second beat,
// so three consecutive misses read as offline, and the same four-state
// vocabulary. A node that stops beating is indistinguishable from one that
// died, and both are `offline` — there is no "probably fine" state.

export const NODE_STALE_MS = 45_000;

export type NodeState = "ready" | "busy" | "degraded" | "offline";

// The registry's own column: `active` (beating and in-window), `behind` (its
// schema window no longer overlaps the service, so its writes refuse), or
// `retired` (deliberately removed from the mesh).
export type NodeStatus = "active" | "behind" | "retired" | string;

export interface NodeStateInput {
  status: NodeStatus | null | undefined;
  lastSeenAt: string | null | undefined;
  // The node's own last health snapshot, as posted by its beat. Only two
  // fields are read here, both optional: a node that reports neither is
  // `ready` once it is fresh.
  health?: { degraded?: unknown; activity?: unknown } | null;
}

export function nodeStale(lastSeenAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeenAt) return true;
  const at = Date.parse(lastSeenAt);
  if (!Number.isFinite(at)) return true;
  return now - at > NODE_STALE_MS;
}

// Staleness wins over every other signal: a node that last spoke four minutes
// ago is offline no matter how healthy it claimed to be at the time.
export function nodeState(input: NodeStateInput, now = Date.now()): NodeState {
  if (input.status === "retired") return "offline";
  if (nodeStale(input.lastSeenAt, now)) return "offline";
  if (input.status === "behind") return "degraded";
  if (input.health?.degraded === true) return "degraded";
  if (input.health?.activity === "busy") return "busy";
  return "ready";
}

export function nodeStateLabel(state: NodeState): string {
  switch (state) {
    case "ready":
      return "READY";
    case "busy":
      return "BUSY";
    case "degraded":
      return "DEGRADED";
    default:
      return "OFFLINE";
  }
}

// "3s ago" / "4m ago" — a last-seen age is only ever read for staleness, so it
// stays coarse and never pretends to millisecond precision.
export function lastSeenAge(lastSeenAt: string | null | undefined, now = Date.now()): string {
  if (!lastSeenAt) return "never";
  const at = Date.parse(lastSeenAt);
  if (!Number.isFinite(at)) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
