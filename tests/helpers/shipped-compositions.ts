// Which compositions actually ship, read from git.
//
// Several suites used to hardcode a list ("default", "dogfood-dev", "glm",
// "csg", "default-build", …). When the composition set was cut down, every one of
// those suites broke on ENOENT - asserting hard truths about compositions that no
// longer exist, which is worse than not testing them: the failure says nothing
// about the code. Deriving the list means a retired composition drops out
// silently and a NEW one is covered the day it lands.
//
// WHY GIT AND NOT A DIRECTORY SCAN. Other suites create throwaway compositions
// INSIDE compositions/ while they run. A live scan picks those up mid-run, and a
// fixture with no dispatch target then fails assertions about shipped
// compositions - a failure that appears only under the full parallel suite and
// vanishes when the file is run alone. "Shipped" means committed, so ask git,
// which no temporary fixture can perturb.

import { execFileSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const COMPOSITIONS_DIR = path.join(REPO_ROOT, "compositions");

function trackedCompositionIds(): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "compositions/*/apm.yml"], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    });
    const ids = out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("/")[1])
      .filter((id) => existsSync(path.join(COMPOSITIONS_DIR, id, "apm.yml")));
    return ids.length ? [...new Set(ids)].sort() : null;
  } catch {
    return null; // no git (tarball checkout) - fall back below
  }
}

/** Every committed composition id, sorted for stable assertions. */
export function shippedCompositionIds(): string[] {
  const tracked = trackedCompositionIds();
  if (tracked) return tracked;
  // Fallback: a directory with a manifest. Only reached without git, where the
  // concurrent-fixture hazard above does not apply the same way.
  return readdirSync(COMPOSITIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => existsSync(path.join(COMPOSITIONS_DIR, id, "apm.yml")))
    .sort();
}

/** The manifest path for a shipped composition. */
export function compositionManifestPath(id: string): string {
  return path.join(COMPOSITIONS_DIR, id, "apm.yml");
}
