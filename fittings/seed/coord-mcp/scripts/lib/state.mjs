// The fitting's handle on the Garrison state service — the ONE coordination
// store. There is deliberately no local fallback: a file lock on one box is
// worse than no lock at all, because it reports a guarantee it cannot make
// across the mesh.
//
// Discovery differs here from every other fitting. This MCP server is spawned
// by CLAUDE CODE, not by the runner, so it inherits the SESSION's env —
// GARRISON_STATE_URL / GARRISON_STATE_TOKEN may simply be absent, and so may
// GARRISON_HOME. $GARRISON_HOME/state.json is the reliable fallback, so the
// GARRISON_HOME default (~/.garrison) is applied HERE, around the generated
// client, which requires the variable to be set before it will read the file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStateClient, StateApiError, StateUnavailableError } from "./state-client.mjs";

export { StateApiError, StateUnavailableError };

// The mesh identity of this machine. Used to scope the repo key of a checkout
// with no origin, so the same path on two Macs can never share a lock.
export function nodeName(env = process.env) {
  const explicit = env.GARRISON_NODE_NAME && env.GARRISON_NODE_NAME.trim();
  return explicit || os.hostname().split(".")[0];
}

export function garrisonHome(env = process.env) {
  const o = env.GARRISON_HOME && env.GARRISON_HOME.trim();
  return o || path.join(os.homedir(), ".garrison");
}

let cached = null;

// Constructed once per process. Discovery THROWS when this node is not
// enrolled; that error names the service and is what every tool surfaces.
export function stateClient(env = process.env) {
  if (cached) return cached;
  cached = createStateClient({
    env: { ...env, GARRISON_HOME: garrisonHome(env) },
    readFileSync: fs.readFileSync
  });
  return cached;
}

// Tests and token rotation: drop the memoised client so discovery re-runs.
export function resetStateClient() {
  cached = null;
}
