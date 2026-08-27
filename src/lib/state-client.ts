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
  discoverStateConfig,
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
  cached = createStateClient({
    readFileSync: (p: string, enc: string) => readFileSync(p, enc as BufferEncoding),
    // Next PATCHES global fetch with its Data Cache, which persists across
    // restarts in .next-prod/cache — the roster intermittently replayed a
    // pre-first-beat /v1/nodes body from a day earlier, showing live peers as
    // "never" while the service was fresh (self looked fine only because the
    // local snapshot overrides it). State reads are truth reads: no store.
    fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, cache: "no-store" })) as typeof fetch
  });
  return cached;
}

// Tests and token rotation: drop the cached client so discovery re-runs.
export function resetStateClient(): void {
  cached = null;
}

// Is this machine enrolled in a mesh at all? A standalone Garrison (the
// open-source single-machine install) has no state config, and shared-state
// callers need to tell "not part of a mesh" apart from "the mesh is down":
// the first is a normal local-only install, the second is an outage.
export function stateEnrolled(): boolean {
  try {
    discoverStateConfig({
      env: process.env,
      readFileSync: (p: string, enc: string) => readFileSync(p, enc as BufferEncoding)
    });
    return true;
  } catch {
    return false;
  }
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

// Env projection for fittings and runtime sessions. Part of the fitting env
// FINGERPRINT, so a token rotation heals running fittings on the next up().
// An unenrolled node projects nothing — the client then throws its loud
// unenrolled error at first use, which is the honest failure.
export function stateEnvForProjection(): Record<string, string> {
  try {
    const config = discoverStateConfig({
      env: process.env,
      readFileSync: (p: string, enc: string) => readFileSync(p, enc as BufferEncoding)
    });
    return {
      GARRISON_STATE_URL: config.url,
      GARRISON_STATE_TOKEN: config.token,
      ...(config.node ? { GARRISON_NODE_NAME: config.node } : {})
    };
  } catch {
    return {};
  }
}
