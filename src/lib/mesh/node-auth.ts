// Node identity for the dispatch API.
//
// A task runner on another node authenticates to this one with a bearer token.
// The token store is still `$GARRISON_HOME/outpost-registry.json` — the file
// the retired pairing flow wrote — kept for ONE more release so every already
// paired machine keeps working across the mesh cutover. Phase 4 replaces it
// with per-node mesh tokens minted by the state service; until then this file
// is the dispatch-token store and nothing else reads it.
//
// A single store is the point: Phase 0 found two disjoint machine registries
// (this one and the since-deleted src/lib/hosts.ts, which had zero callers).
// A third would be the point where "which registry is authoritative" becomes
// unanswerable.
//
// SECURITY NOTES
//   • Constant-time compare, same discipline as verifyInternalToken.
//   • A `pending` registry entry (paired but never connected) is still a valid
//     dispatch identity: pairing is what grants it, and a pull-based runner
//     never dials back, so requiring `connected` would lock out exactly the
//     machines this feature exists for.
//   • The self target is a RESERVED name, never a registry entry. The node
//     Garrison runs on has no token and needs none — it is the thing being
//     authenticated TO. Rejecting it here stops a peer from claiming
//     locally-targeted work by registering itself under that name.

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { garrisonDir } from "../claude-home";

// The placement target meaning "run on THIS node". Not a machine name — no
// registry entry may use it.
//
// The LITERAL stays `"host"` deliberately. The mesh store never holds it — a
// card meant for this node carries this node's id, and localisePlacement
// (src/lib/dispatch.ts) translates that to this word on the way in and back on
// the way out. So the string is a purely local reading, every pre-mesh card
// carrying `placement.target: "host"` still parses, and only the NAME needed to
// stop saying that one machine is special.
export const SELF_TARGET = "host";

/** @deprecated Pre-mesh name for {@link SELF_TARGET}. Kept for one release. */
export const HOST_TARGET = SELF_TARGET;

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
    entry.name.trim() !== SELF_TARGET &&
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

// A placement target is dispatchable when it is a paired node. The self target
// is valid but is never dispatched — the local engine runs it.
export async function isDispatchableTarget(target: string): Promise<boolean> {
  if (target === SELF_TARGET) return false;
  const machines = await listDispatchMachines();
  return machines.some((m) => m.name === target);
}
