// Machine identity for Outpost Dispatch.
//
// A worker on a remote Mac authenticates to the host with a bearer token. The
// token store is the EXISTING outpost registry
// (`$GARRISON_HOME/outpost-registry.json`, written by scripts/outpost-host.mjs's
// /registry/pair) — deliberately not a new file. Phase 0 found two disjoint
// machine registries already (outpost-registry.json and src/lib/hosts.ts, the
// latter with zero callers); a third would be the point where "which registry
// is authoritative" becomes unanswerable.
//
// Reusing it means one pairing flow covers both transports: the WebSocket bridge
// (host pushes RPC) and this pull-based dispatch API. A machine is paired once.
//
// SECURITY NOTES
//   • Constant-time compare, same discipline as verifyInternalToken.
//   • A `pending` registry entry (paired but never connected) is still a valid
//     dispatch identity: pairing is what grants it, and the pull worker never
//     dials the bridge, so requiring `connected` would lock out exactly the
//     machines this feature exists for.
//   • "host" is a RESERVED name, never a registry entry. The Linux box Garrison
//     runs on has no pairing token and needs none — it is the thing being
//     authenticated TO. Rejecting it here stops a remote machine from claiming
//     host-targeted work by registering itself under that name.

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "./claude-home";

// The placement target meaning "run where Garrison itself runs". Not a machine
// name — no registry entry may use it.
export const HOST_TARGET = "host";

export interface DispatchMachine {
  name: string;
  registeredAt: string | null;
  pending: boolean;
}

interface RegistryEntry {
  name?: unknown;
  token?: unknown;
  registeredAt?: unknown;
  pending?: unknown;
}

export function outpostRegistryPath(): string {
  return path.join(garrisonDir(), "outpost-registry.json");
}

async function readRegistry(): Promise<RegistryEntry[]> {
  try {
    const raw = await readFile(outpostRegistryPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    // The daemon writes a bare array; tolerate an object wrapper so a future
    // shape change here is a no-op rather than a silent "no machines".
    if (Array.isArray(parsed)) return parsed as RegistryEntry[];
    if (parsed && typeof parsed === "object") {
      const outposts = (parsed as { outposts?: unknown }).outposts;
      if (Array.isArray(outposts)) return outposts as RegistryEntry[];
    }
    return [];
  } catch {
    // No registry yet = no paired machines. Not an error: a fresh install has
    // none, and dispatch simply has nobody to hand work to.
    return [];
  }
}

function isUsableEntry(entry: RegistryEntry): entry is { name: string; token: string } & RegistryEntry {
  return (
    typeof entry.name === "string" &&
    entry.name.trim().length > 0 &&
    entry.name.trim() !== HOST_TARGET &&
    typeof entry.token === "string" &&
    entry.token.length > 0
  );
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch. The length
  // of a token is not the secret.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Every machine that may be targeted by a card's placement.
export async function listDispatchMachines(): Promise<DispatchMachine[]> {
  const entries = await readRegistry();
  return entries.filter(isUsableEntry).map((entry) => ({
    name: entry.name.trim(),
    registeredAt: typeof entry.registeredAt === "string" ? entry.registeredAt : null,
    pending: entry.pending === true
  }));
}

// Resolve `Authorization: Bearer <token>` to a machine name, or null.
//
// The token alone identifies the machine — a caller-supplied name is NOT
// trusted, because trusting it would let any paired machine claim another's
// work by simply asking. Callers that also send a name must check it against
// this result (see assertMachineMatches).
export async function authenticateMachine(
  authorization: string | null | undefined
): Promise<string | null> {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;
  const presented = match[1].trim();
  if (!presented) return null;

  const entries = (await readRegistry()).filter(isUsableEntry);
  // Compare against EVERY entry rather than breaking on the first hit, so the
  // work done does not depend on which machine presented the token.
  let resolved: string | null = null;
  for (const entry of entries) {
    if (tokenMatches(presented, entry.token)) resolved = entry.name.trim();
  }
  return resolved;
}

// A placement target is dispatchable when it is a paired machine. `host` is
// valid as a target but is never dispatched — the local engine runs it.
export async function isDispatchableTarget(target: string): Promise<boolean> {
  if (target === HOST_TARGET) return false;
  const machines = await listDispatchMachines();
  return machines.some((m) => m.name === target);
}
