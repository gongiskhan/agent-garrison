// The short git commit hash of the running build, for the sidebar footer.
//
// Same shape as node-identity.ts: a sync, module-cached read so server
// components (layout.tsx) can call it with no await, and a stale value only
// changes on the next process start - which is when a redeploy rebuilds
// anyway.

import { execFileSync } from "node:child_process";

let cache: string | null | undefined;

export function resetBuildInfoCache(): void {
  cache = undefined;
}

// Never throws: a checkout with no `.git` (or no `git` on PATH) degrades to
// null, which callers render as absent rather than a broken build.
export function readBuildSha(): string | null {
  if (cache !== undefined) return cache;
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    cache = sha || null;
  } catch {
    cache = null;
  }
  return cache;
}
