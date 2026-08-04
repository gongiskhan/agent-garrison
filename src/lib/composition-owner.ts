import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-write";
import { currentProfile, type InstanceProfileId } from "./instance-profile";

// Single-owner guard for a composition's WORKING TREE.
//
// The launcher isolates each instance's ports, GARRISON_HOME and Claude config
// dir — but NOT the composition directory, which is checkout-relative
// (COMPOSITIONS_DIR in paths.ts). prod, dev and codex all run out of the same
// checkout, so they resolve the SAME compositions/<id>/ and every destructive
// step inside it collides:
//
//   - `apm install` + each fitting's setup hook rewrite apm_modules/_local/**,
//     the very files a running operative and its fittings execute from
//   - materializeEnv writes <dir>/.env from the CALLING instance's vault — a
//     different key and a different secret set per instance
//   - wipeMaterializedEnv DELETES that .env on down(), so one instance's stop
//     leaves the other's fittings keyless
//   - .garrison/routing.json is likewise shared
//
// Nothing but each home's `active_composition` kept them apart, and that is one
// UI click. This records which PROFILE owns the tree and refuses a second one.
//
// Keyed on profile, deliberately NOT on pid: the invariant is "two different
// instances must not share a composition tree", and a same-profile restart
// (systemd, redeploy) legitimately re-enters with a new pid. Same profile is
// always allowed and simply refreshes the record.

export interface CompositionOwner {
  instanceId: InstanceProfileId;
  pid: number;
  compositionId: string;
  claimedAt: string;
  /** Distinguishes successive same-profile claims for failure-path cleanup. */
  claimId?: string;
}

export interface CompositionLaunchClaim {
  owner: CompositionOwner;
  /** False for a same-profile re-entry; a failed re-entry must preserve prior state. */
  acquiredFresh: boolean;
}

export function ownerFilePath(compositionDir: string): string {
  return path.join(compositionDir, ".garrison", "owner.json");
}

export async function readCompositionOwner(
  compositionDir: string
): Promise<CompositionOwner | null> {
  try {
    const raw = await readFile(ownerFilePath(compositionDir), "utf8");
    const parsed = JSON.parse(raw) as CompositionOwner;
    if (!parsed || typeof parsed.instanceId !== "string") return null;
    return parsed;
  } catch {
    // Absent or unreadable — unowned. A corrupt record must not wedge `up`.
    return null;
  }
}

export class CompositionOwnedByOtherInstanceError extends Error {
  constructor(
    readonly owner: CompositionOwner,
    readonly compositionId: string,
    readonly profile: InstanceProfileId
  ) {
    super(
      `Composition "${compositionId}" is already in use by the ${owner.instanceId} instance ` +
        `(pid ${owner.pid}, since ${owner.claimedAt}). Two instances cannot share a composition ` +
        `working tree: apm install and every setup hook rewrite apm_modules/ underneath the ` +
        `running operative, and materializeEnv/wipeMaterializedEnv would overwrite and then ` +
        `delete its .env secrets. Stop the ${owner.instanceId} instance, or point this ` +
        `(${profile}) instance at a different composition.`
    );
    this.name = "CompositionOwnedByOtherInstanceError";
  }
}

async function createCompositionClaim(
  compositionDir: string,
  compositionId: string
): Promise<CompositionLaunchClaim> {
  const profile = currentProfile();
  const existing = await readCompositionOwner(compositionDir);
  if (existing && existing.instanceId !== profile) {
    throw new CompositionOwnedByOtherInstanceError(existing, compositionId, profile);
  }
  const owner: CompositionOwner = {
    instanceId: profile,
    pid: process.pid,
    compositionId,
    claimedAt: new Date().toISOString(),
    claimId: randomUUID()
  };
  await mkdir(path.dirname(ownerFilePath(compositionDir)), { recursive: true });
  await writeJsonAtomic(ownerFilePath(compositionDir), owner);
  return { owner, acquiredFresh: existing === null };
}

// Claim the tree for THIS profile. Throws if another profile holds it.
export async function claimComposition(
  compositionDir: string,
  compositionId: string
): Promise<CompositionOwner> {
  return (await createCompositionClaim(compositionDir, compositionId)).owner;
}

/**
 * Launch-specific claim metadata lets a failed `up` clean only state it acquired
 * from an unowned tree. A same-profile re-entry may be a live restart boundary;
 * its failure must not wipe or release the prior owner's materialized state.
 */
export async function claimCompositionForLaunch(
  compositionDir: string,
  compositionId: string
): Promise<CompositionLaunchClaim> {
  return createCompositionClaim(compositionDir, compositionId);
}

function sameClaim(left: CompositionOwner, right: CompositionOwner): boolean {
  if (left.claimId || right.claimId) return left.claimId === right.claimId;
  return left.instanceId === right.instanceId &&
    left.pid === right.pid &&
    left.compositionId === right.compositionId &&
    left.claimedAt === right.claimedAt;
}

/** True only while the exact launch generation still owns the tree. */
export async function isCompositionClaimCurrent(
  compositionDir: string,
  expected: CompositionOwner
): Promise<boolean> {
  const existing = await readCompositionOwner(compositionDir);
  return existing !== null && sameClaim(existing, expected);
}

/**
 * Release one exact failed-launch generation. Unlike releaseComposition(), this
 * cannot delete a newer same-profile claim that took ownership after it.
 */
export async function releaseCompositionClaim(
  compositionDir: string,
  expected: CompositionOwner
): Promise<boolean> {
  if (expected.instanceId !== currentProfile()) return false;
  if (!(await isCompositionClaimCurrent(compositionDir, expected))) return false;
  try {
    await unlink(ownerFilePath(compositionDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Release on down(). Only the owning profile may release, so a stray call from
// another instance can never hand away a live tree. Best-effort: a failed
// release must not break `down`.
export async function releaseComposition(compositionDir: string): Promise<void> {
  const profile = currentProfile();
  const existing = await readCompositionOwner(compositionDir);
  if (!existing || existing.instanceId !== profile) return;
  try {
    await unlink(ownerFilePath(compositionDir));
  } catch {
    // Already gone — nothing to do.
  }
}
