import { execFileSync } from "node:child_process";

// Server-only: this module shells out to git. Import it from server components
// and route handlers, never from a "use client" file — doing so would drag
// node:child_process into the browser bundle.

const TTL_MS = 15_000;

let cached: { value: string | null; at: number } | null = null;

/**
 * Short hash of the commit this instance is running, or null when it cannot be
 * determined (no git, not a checkout, git missing from PATH).
 *
 * `GARRISON_COMMIT` wins when set, so a packaged deploy without a .git dir can
 * stamp the value explicitly. Otherwise the hash is read from the checkout the
 * server process was started in — `garrison-instance.sh` cds to the repo root
 * before starting next, for every profile.
 *
 * Cached briefly rather than forever: a production build bakes the value at
 * prerender (correct — that is the commit that was built), but `next dev` is a
 * long-lived process that outlives many commits.
 */
export function commitShort(): string | null {
  const fromEnv = process.env.GARRISON_COMMIT?.trim();
  if (fromEnv) return fromEnv.slice(0, 7);

  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;

  let value: string | null = null;
  try {
    value =
      execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"]
      }).trim() || null;
  } catch {
    value = null;
  }
  cached = { value, at: now };
  return value;
}
