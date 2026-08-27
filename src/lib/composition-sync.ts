// Composition materialisation — the S10 seam. The state service is the source
// of truth for a composition's SHARED files (manifest + the transfer
// allow-list); each node materialises a working tree from it, and edits flow
// back with rev CAS. Node-local files (.env, apm.lock.yaml, apm_modules/,
// owner.json, local.yml) never travel — they are unstorable at the API.
//
// Enrollment semantics, deliberately asymmetric:
//   * An ENROLLED node that cannot reach the service FAILS the operation —
//     no offline mode; a fork of shared state is worse than a clear stop.
//   * An UNENROLLED box (no state.json, no env) behaves exactly as before the
//     mesh existed — same carve-out as the scheduler's file fallback, because
//     a standalone Garrison must still boot.
//
// Writes are HASH-COMPARED (the reconcile.ts echo-suppression pattern): dev()
// watches these paths with chokidar, so an unconditional rewrite per up()
// would be an infinite install/restart loop, not an optimisation problem.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { stateClient, StateUnavailableError } from "./state-client";
import { discoverStateConfig } from "@garrison/state-client";
import { readFileSync } from "node:fs";

export function nodeIsEnrolled(): boolean {
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

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function writeIfChanged(absPath: string, body: string): Promise<boolean> {
  try {
    const current = await readFile(absPath, "utf8");
    if (current === body) return false;
  } catch {
    // absent — write it
  }
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, body, "utf8");
  return true;
}

export interface CompositionSyncResult {
  source: "service" | "seeded-to-service" | "unenrolled";
  refreshedFiles: string[];
}

// Materialise the composition's shared files from the service into the
// working tree. When the service has never seen this composition, the local
// tree SEEDS it (a composition created on this node becomes shared) — the
// seed-or-migrate-never-clobber pattern pointed at the mesh.
export async function syncCompositionFromState(
  compositionId: string,
  compositionDir: string
): Promise<CompositionSyncResult> {
  if (!nodeIsEnrolled()) return { source: "unenrolled", refreshedFiles: [] };
  const client = stateClient();
  const comp = await client.getComposition(compositionId);
  const manifestPath = path.join(compositionDir, "apm.yml");

  if (!comp) {
    // First contact: push the local tree up.
    const manifestYaml = await readFile(manifestPath, "utf8");
    await client.putComposition(compositionId, manifestYaml, { ifMatchRev: 0 });
    return { source: "seeded-to-service", refreshedFiles: [] };
  }

  const refreshed: string[] = [];
  if (await writeIfChanged(manifestPath, comp.manifestYaml)) refreshed.push("apm.yml");
  for (const file of comp.files ?? []) {
    const doc = await client.getCompositionFile(compositionId, file.path);
    if (!doc) continue;
    if (await writeIfChanged(path.join(compositionDir, file.path), doc.body)) {
      refreshed.push(file.path);
    }
  }
  return { source: "service", refreshedFiles: refreshed };
}

// Push a locally-edited manifest to the service with rev CAS. Returns the new
// rev. A 409 here means another node edited the composition — the caller
// surfaces "reload", it does not merge.
export async function pushManifestToState(
  compositionId: string,
  manifestYaml: string
): Promise<{ pushed: boolean; rev?: number }> {
  if (!nodeIsEnrolled()) return { pushed: false };
  const client = stateClient();
  const current = await client.getComposition(compositionId);
  const out = await client.putComposition(compositionId, manifestYaml, {
    ifMatchRev: current?.rev ?? 0
  });
  return { pushed: true, rev: out.rev };
}

// The materializeEnv seam: an enrolled node renders its composition .env from
// the SECRET AUTHORITY (loopback on dev-madrid — one code path, no
// authority/peer branch); an unenrolled box uses its local vault as before.
// mode:"all" is exact parity with vault.ts materializeEnv; "scoped" waits for
// a live 44-verify up() to prove no fitting depends on an unscoped key.
export async function materializeEnvViaAuthority(
  compositionDir: string,
  compositionId: string
): Promise<{ envPath: string; source: "authority" | "local-vault" }> {
  const envPath = path.join(compositionDir, ".env");
  if (!nodeIsEnrolled()) {
    const { materializeEnv } = await import("./vault");
    await materializeEnv(compositionDir);
    return { envPath, source: "local-vault" };
  }
  const client = stateClient();
  const rendered = await client.compositionEnv(compositionId, "all");
  const { writeFileAtomic } = await import("./atomic-write");
  await writeFileAtomic(envPath, rendered.content, { mode: 0o600 });
  return { envPath, source: "authority" };
}

export { StateUnavailableError };
