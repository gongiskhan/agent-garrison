// Repo identity — the per-repo scoping key for the planning lock, plan ledger,
// and digest. A session only ever sees coordination state for its own repo.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

// Resolve the git toplevel for a cwd; fall back to the cwd itself when not a git
// repo (a non-git dir still gets its own isolated coordination scope).
export function repoRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim();
  } catch {
    return path.resolve(cwd);
  }
}

// Stable short slug for filenames (lock/ledger), derived from the repo key so
// two repos never collide and one repo always maps to the same files. A
// non-absolute key (a friendly name like "garrison") is hashed AS-IS: resolving
// it against process.cwd() would make the same name map to different files
// depending on which process computed it, producing locks the Coordination view
// can list but never release.
export function repoSlug(repoPath) {
  const key = path.isAbsolute(repoPath) ? path.resolve(repoPath) : String(repoPath);
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}
