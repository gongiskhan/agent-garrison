// `git status --porcelain=v2 --branch`, parsed.
//
// Kept apart from self-snapshot.ts so the parser is testable without dragging
// in the runner, and so the ONE rule that matters here stays visible: the
// counts come from `--branch` alone, with NO implicit fetch. A status read must
// be instant and side-effect-free — ahead/behind are against the last fetched
// remote ref, which is exactly what the merge system acts on.

import { execFile } from "node:child_process";

export interface GitSnapshot {
  branch: string | null;
  head: string | null;
  dirty: number;
  ahead: number;
  behind: number;
  upstream: string | null;
}

export function parseGitStatus(stdout: string): GitSnapshot {
  const snapshot: GitSnapshot = { branch: null, head: null, dirty: 0, ahead: 0, behind: 0, upstream: null };
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    if (!line.startsWith("# ")) {
      // Every non-header porcelain-v2 line is a changed, renamed, unmerged or
      // untracked path — all of them count as dirty for "is this tree safe to
      // merge into".
      snapshot.dirty += 1;
      continue;
    }
    const [, key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "branch.head") snapshot.branch = value === "(detached)" ? null : value;
    else if (key === "branch.oid") snapshot.head = value === "(initial)" ? null : value.slice(0, 12);
    else if (key === "branch.upstream") snapshot.upstream = value;
    else if (key === "branch.ab") {
      const m = value.match(/^\+(\d+)\s+-(\d+)$/);
      if (m) {
        snapshot.ahead = Number(m[1]);
        snapshot.behind = Number(m[2]);
      }
    }
  }
  return snapshot;
}

export async function readGitSnapshot(cwd: string, timeoutMs = 4_000): Promise<GitSnapshot | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        // Never a shell, and never this repo's hooks: reading a tree's status
        // must not be able to execute anything that tree happens to carry.
        ["-c", "core.hooksPath=/dev/null", "status", "--porcelain=v2", "--branch"],
        { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
        (err, out) => (err ? reject(err) : resolve(out))
      );
    });
    return parseGitStatus(stdout);
  } catch {
    return null;
  }
}
