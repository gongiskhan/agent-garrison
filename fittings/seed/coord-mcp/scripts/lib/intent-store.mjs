// Per-repo intent store — sessions declare an intent ("I'm about to touch <area>
// for <reason>") so overlapping work by other sessions surfaces as a conflict in
// the digest. Repo-scoped: a session only ever sees its own repo's intents.
//
// Ledger: the state service's append-only `intents` table, keyed by the mesh
// repo key. Release is SET-ONCE (`released_at`), never a delete, so the ledger
// stays append-only and a release can never race a concurrent declare.
//
// The bakery-ticket file lock this module used to carry is GONE with the file
// ledger it protected. Its whole job was serialising append and
// read-modify-write against one file; the service does that in a transaction,
// and its liveness check (process.kill(pid, 0)) was meaningless across hosts
// anyway.
import { stateClient } from "./state.mjs";
import { withinLookback } from "./lookback.mjs";

// Service rows -> the legacy row shape the digest, the CLI and the Coordination
// view already read. `repo` is now the mesh repo KEY, not a filesystem path.
export function normalizeIntent(row) {
  return {
    seq: row.seq,
    repo: row.repoKey,
    session: row.session,
    area: row.area || "",
    files: Array.isArray(row.files) ? row.files : [],
    reason: row.reason || "",
    ts: row.at
  };
}

export async function declareIntent(repoKey, entry) {
  const row = {
    repo: repoKey,
    session: entry.session || "unknown",
    area: entry.area || "",
    files: Array.isArray(entry.files) ? entry.files : [],
    // The service requires a reason — an intent nobody can read is not an intent.
    // Fall back to the area so a reason-less caller still records something true.
    reason: entry.reason || entry.area || "unspecified",
    ts: entry.ts || new Date().toISOString()
  };
  const { seq } = await stateClient().declareIntent({
    repoKey,
    session: row.session,
    area: row.area,
    files: row.files,
    reason: row.reason
  });
  return { ...row, seq };
}

// Open (unreleased) intents for a repo, newest first.
export async function readIntents(repoKey) {
  return (await stateClient().listIntents(repoKey)).map(normalizeIntent);
}

export async function recentIntents(repoKey, now = new Date()) {
  return (await readIntents(repoKey)).filter((i) => withinLookback(i.ts, now));
}

// Every open intent on the mesh, newest first — the machine-wide view.
export async function allRecentIntents(now = new Date()) {
  return (await stateClient().listIntents(undefined)).map(normalizeIntent).filter((i) => withinLookback(i.ts, now));
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// Two intents overlap if they name the same area, if one area contains the other
// (so a free-text prompt mentioning another session's specific area/path counts —
// length-guarded to avoid trivial false positives), if an area mentions a file, or
// if any file paths share/prefix.
export function intentsOverlap(a, b) {
  const aArea = norm(a.area);
  const bArea = norm(b.area);
  const SPECIFIC = 4; // min length for a containment match (avoids "x" matching everything)
  if (aArea && bArea) {
    if (aArea === bArea) return true;
    if (bArea.length >= SPECIFIC && aArea.includes(bArea)) return true;
    if (aArea.length >= SPECIFIC && bArea.includes(aArea)) return true;
  }
  const fa = a.files || [];
  const fb = b.files || [];
  if (aArea && fb.some((f) => f && f.length >= SPECIFIC && aArea.includes(norm(f)))) return true;
  if (bArea && fa.some((f) => f && f.length >= SPECIFIC && bArea.includes(norm(f)))) return true;
  return fa.some((x) => fb.some((y) => x === y || x.startsWith(y + "/") || y.startsWith(x + "/")));
}

// Recent intents by OTHER sessions whose area/files overlap the given intent —
// i.e. potential conflicts the caller should know about before proceeding.
export async function conflictsFor(repoKey, mine, now = new Date()) {
  return (await recentIntents(repoKey, now)).filter((i) => i.session !== mine.session && intentsOverlap(i, mine));
}

// Release this session's intents for a repo. Set-once tombstone, not a delete.
export async function removeIntentsBySession(repoKey, session) {
  return stateClient().releaseIntents({ repoKey, session });
}
