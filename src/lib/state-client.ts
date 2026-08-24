// The Next app's handle on the state service — a thin typed wrapper over
// @garrison/state-client with node-file discovery and a process-level
// degraded flag the UI renders as a full-surface banner.
//
// NO cache, NO write queue, NO optimistic apply: when the service is down,
// every surface shows ONE clear error (logged once per transition, not per
// request). Stale reads and replayed writes are worse than a clear stop.

import { readFileSync } from "node:fs";
import {
  createStateClient,
  StateClient,
  StateUnavailableError,
  StateApiError
} from "@garrison/state-client";

export { StateUnavailableError, StateApiError };
export type { StateClient };

let cached: StateClient | null = null;
let degradedSince: string | null = null;

export function stateClient(): StateClient {
  if (cached) return cached;
  cached = createStateClient({ readFileSync: (p: string, enc: string) => readFileSync(p, enc as BufferEncoding) });
  return cached;
}

// Tests and token rotation: drop the cached client so discovery re-runs.
export function resetStateClient(): void {
  cached = null;
}

export function stateDegraded(): { degraded: boolean; since: string | null } {
  return { degraded: degradedSince !== null, since: degradedSince };
}

export function markStateDegraded(err: unknown): void {
  if (degradedSince === null) {
    degradedSince = new Date().toISOString();
    console.error(`[state-client] state service DEGRADED: ${String((err as Error)?.message ?? err)}`);
  }
}

export function markStateHealthy(): void {
  if (degradedSince !== null) {
    console.error(`[state-client] state service recovered (degraded since ${degradedSince})`);
    degradedSince = null;
  }
}

// Wrap a state call so the degraded flag tracks transitions. Errors still
// propagate — callers surface them; nothing is swallowed or retried here.
export async function withState<T>(fn: (client: StateClient) => Promise<T>): Promise<T> {
  try {
    const out = await fn(stateClient());
    markStateHealthy();
    return out;
  } catch (err) {
    if (err instanceof StateUnavailableError) markStateDegraded(err);
    throw err;
  }
}
