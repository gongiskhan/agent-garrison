// The only module in project-viewer that shells out. Everything else is pure so
// it can be unit-tested without a repo on disk.
//
// Reads are always from git objects (`git show <sha>:<path>`), never from the
// working tree, so a sample hash is a function of the commit and nothing else.
// The single exception is readWorkingTree(), used only by explicitly-dirty
// preview flows.

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MAX_BUFFER = 32 * 1024 * 1024; // a big diff or a long log must not truncate silently

function run(root, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: root, maxBuffer: MAX_BUFFER, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          if (allowFailure) return resolve(null);
          const detail = String(stderr || err.message).trim();
          return reject(new Error(`git ${args.join(" ")} failed: ${detail}`));
        }
        resolve(stdout);
      }
    );
  });
}

/** Repo-relative, forward-slashed. Manifests never carry a backslash. */
export function toRepoPath(p) {
  return String(p).split(path.sep).join("/").replace(/^\.\//, "");
}

export async function isGitRepo(root) {
  const out = await run(root, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  return out !== null && out.trim() === "true";
}

export async function headSha(root) {
  const out = await run(root, ["rev-parse", "HEAD"]);
  return out.trim();
}

export async function resolveSha(root, rev) {
  const out = await run(root, ["rev-parse", rev]);
  return out.trim();
}

/**
 * Every tracked file, repo-relative.
 *
 * `git ls-files` rather than a directory walk, because git tracking is the project's
 * own definition of what its code is: a build artefact, a scratch file or an
 * untracked experiment can never leak into a scan this way.
 *
 * `-z` because a path may contain a newline, and a newline-split list would silently
 * turn one such file into two nonexistent ones.
 */
export async function lsFiles(root) {
  const out = await run(root, ["ls-files", "-z"]);
  return out
    .split("\0")
    .filter(Boolean)
    .map(toRepoPath)
    .sort();
}

export async function isDirty(root) {
  const out = await run(root, ["status", "--porcelain"]);
  return out.trim().length > 0;
}

/**
 * File contents at a commit. Returns null when the path does not exist there —
 * that is a normal outcome (a step whose file was deleted) and the caller turns
 * it into an `invalidated` badge, not an exception.
 */
export async function gitShow(root, sha, relPath) {
  const out = await run(root, ["show", `${sha}:${toRepoPath(relPath)}`], { allowFailure: true });
  return out;
}

/** Working-tree read, for dirty previews only. Null when absent. */
export async function readWorkingTree(root, relPath) {
  try {
    return await readFile(path.join(root, relPath), "utf8");
  } catch {
    return null;
  }
}

/**
 * `--unified=0` so each hunk's touched range is exact: this is what makes the
 * intersect-and-rebase arithmetic in invalidate.mjs precise rather than
 * approximate. Rename detection stays on so a moved file is reported as a
 * rename instead of a delete plus an add.
 */
export async function diffUnifiedZero(root, oldSha, newSha) {
  return runFiltered(root, ["diff", "--unified=0", "--find-renames", `${oldSha}..${newSha}`], isStructuralDiffLine);
}

/**
 * The diff lines `parseUnifiedZeroDiff` actually reads: file headers and hunk ranges.
 * Never the changed content, which is the entire bulk of a diff.
 *
 * Column zero matters. Every content line in a unified diff is prefixed with a space,
 * `+` or `-`, so a removed line whose text happens to be `@@ -1 +1 @@` arrives as
 * `-@@ -1 +1 @@` and cannot be mistaken for a hunk header. Anchoring these patterns
 * at the start of the line is what makes discarding the content safe.
 */
export function isStructuralDiffLine(line) {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("@@ ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("Binary files ")
  );
}

/**
 * Stream a git command and keep only the lines a predicate wants.
 *
 * `execFile` buffers everything, so a flow anchored a few months back produced a diff
 * that blew the 32 MB ceiling and took the whole update down with a raw git error.
 * Raising the ceiling only moves the cliff; the fix is to never hold the payload,
 * since memory here is now bounded by the number of hunks rather than the size of
 * the change.
 */
function runFiltered(root, args, keep) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true });
    const kept = [];
    let pending = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      const lines = pending.split("\n");
      // The last piece may be half a line; hold it until the next chunk.
      pending = lines.pop() ?? "";
      for (const line of lines) if (keep(line)) kept.push(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });

    child.on("error", (err) => reject(new Error(`git ${args.join(" ")} failed: ${err.message}`)));
    child.on("close", (code) => {
      if (pending && keep(pending)) kept.push(pending);
      if (code !== 0) {
        return reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`));
      }
      resolve(kept.length ? `${kept.join("\n")}\n` : "");
    });
  });
}

/**
 * The working tree against HEAD, staged and unstaged together, so the
 * uncommitted view shows everything that is not yet a commit in one pass.
 */
export async function diffWorkingTree(root) {
  return run(root, ["diff", "HEAD", "--unified=3", "--find-renames"]);
}

/** The patch a single commit introduces, optionally narrowed to one path. */
export async function commitPatch(root, sha, relPath) {
  const args = ["show", "--format=", "--unified=3", "--find-renames", sha];
  if (relPath) args.push("--", toRepoPath(relPath));
  return run(root, args);
}

/** Files a commit touched, with status letters. */
export async function commitFiles(root, sha) {
  const out = await run(root, ["show", "--format=", "--name-status", "--find-renames", sha]);
  return parseNameStatus(out);
}

export function parseNameStatus(out) {
  const files = [];
  for (const line of String(out ?? "").split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0];
    if (code.startsWith("R") && parts.length >= 3) {
      files.push({ status: "renamed", file: toRepoPath(parts[2]), from: toRepoPath(parts[1]) });
    } else if (parts.length >= 2) {
      const map = { A: "added", M: "modified", D: "deleted", C: "added", T: "modified" };
      files.push({ status: map[code[0]] ?? "modified", file: toRepoPath(parts[1]) });
    }
  }
  return files;
}

/** Commit metadata for a walkthrough header. */
export async function commitMeta(root, sha) {
  const out = await run(root, ["show", "--no-patch", "--format=%H%n%h%n%an%n%aI%n%s%n%b", sha]);
  const lines = String(out).split("\n");
  return {
    sha: (lines[0] ?? "").trim(),
    shortSha: (lines[1] ?? "").trim(),
    author: (lines[2] ?? "").trim(),
    committedAt: (lines[3] ?? "").trim(),
    subject: (lines[4] ?? "").trim(),
    body: lines.slice(5).join("\n").trim(),
  };
}

/** Recent commits, newest first. */
export async function recentCommits(root, limit = 10) {
  const out = await run(root, ["log", `-n${limit}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s"]);
  return String(out)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [sha, shortSha, author, committedAt, subject] = l.split("\x1f");
      return { sha, shortSha, author, committedAt, subject };
    });
}

/**
 * `-z` so paths with spaces or non-ASCII survive intact. Returns
 * [{ file, index, worktree, status }] where status is a coarse label the
 * uncommitted view renders.
 */
export async function statusPorcelain(root) {
  const out = await run(root, ["status", "--porcelain", "-z"]);
  return parsePorcelainZ(out);
}

export function parsePorcelainZ(out) {
  const entries = [];
  const parts = String(out ?? "").split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (!rec) continue;
    const index = rec[0];
    const worktree = rec[1];
    let file = rec.slice(3);
    // A rename record is followed by its original path as the next NUL field.
    if (index === "R" || index === "C") {
      const from = parts[i + 1];
      i += 1;
      entries.push({
        file: toRepoPath(file),
        from: from ? toRepoPath(from) : null,
        index,
        worktree,
        status: "renamed",
      });
      continue;
    }
    entries.push({
      file: toRepoPath(file),
      from: null,
      index,
      worktree,
      status: coarseStatus(index, worktree),
    });
  }
  return entries;
}

function coarseStatus(index, worktree) {
  if (index === "?" && worktree === "?") return "untracked";
  if (index === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  if (index === "M" || worktree === "M") return "modified";
  if (index === "!" ) return "ignored";
  return "modified";
}

/** Repo root, so the fitting can be pointed at a subdirectory and still work. */
export async function repoRoot(root) {
  const out = await run(root, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  return out === null ? root : out.trim();
}
