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

// Stable short slug for filenames (lock/ledger), derived from the absolute path
// so two repos never collide and one repo always maps to the same files.
export function repoSlug(repoPath) {
  return crypto.createHash("sha1").update(path.resolve(repoPath)).digest("hex").slice(0, 16);
}
