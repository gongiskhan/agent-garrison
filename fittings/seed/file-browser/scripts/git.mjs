// Git for the workspace browser. ONE `runGit` choke point, and every rule in it
// is load-bearing rather than stylistic:
//
//   * `execFile`, NEVER a shell. There is no command string anywhere in this
//     module, so there is nothing for a quote, a `;` or a `$(...)` to break out
//     of. A repository name, a branch name and a path are data, always.
//   * `-c core.hooksPath=/dev/null` on EVERY invocation. Browsing a repository
//     must not execute code that repository happens to carry: a `post-checkout`
//     or `pre-commit` hook in a tree you merely opened in a file browser would
//     otherwise run as the Garrison user.
//   * An explicit argument allow-list per operation. Callers pass structured
//     options (a path, a limit, a flag), never argv. No caller-supplied string
//     ever lands in a flag position.
//   * `--` before every path argument, plus a path validator, so a file called
//     `--output=/etc/cron.d/x` is a path and not an option.
//   * A timeout and an output cap on every call. `git log` in a big repository
//     and `git diff` of a generated file are both unbounded by nature.
//   * `cwd` must be an absolute path that ALREADY passed the source resolver.
//     This module resolves nothing; handing it an unvalidated directory is the
//     one way to misuse it.
//
// The network boundary is equally deliberate: `status` never fetches, so a
// status read is instant and side-effect-free, and `fetch` is the only call in
// the module that talks to a remote at all (plus `push`, which the merge
// actions drive explicitly).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CAP_BYTES = 1024 * 1024;
/** The diff cap the endpoint advertises: a diff past this is a download, not a read. */
export const DIFF_CAP_BYTES = 500 * 1024;
const NETWORK_TIMEOUT_MS = 180_000;

// Prepended to every argv. `core.hooksPath=/dev/null` is the important one;
// `core.fsmonitor=false` keeps a repository from starting a background daemon
// just because something listed its status.
const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export class GitError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = "GitError";
    this.status = status;
  }
}

/**
 * A path argument accepted from a client. Repository-relative only: an absolute
 * path, a `..` hop or a leading dash never becomes an argv element, even though
 * `--` already protects the flag position.
 */
export function assertPathArg(value) {
  const p = String(value ?? "");
  if (!p) throw new GitError("path required");
  if (p.includes("\0")) throw new GitError("path contains a NUL byte");
  if (p.startsWith("-")) throw new GitError("path may not start with a dash");
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) throw new GitError("path must be repository-relative");
  const normalised = path.posix.normalize(p.replace(/\\/g, "/"));
  if (normalised === ".." || normalised.startsWith("../")) throw new GitError("path escapes the repository");
  return normalised;
}

/** A ref name we are willing to put in an argv position (branches we read back
 *  out of git itself, never free text off the wire). */
export function assertRefArg(value) {
  const ref = String(value ?? "").trim();
  if (!ref) throw new GitError("ref required");
  if (!/^[A-Za-z0-9._\/-]+$/.test(ref) || ref.startsWith("-") || ref.includes("..")) {
    throw new GitError(`refusing an unsafe ref name: ${ref}`);
  }
  return ref;
}

function capUtf8(text, cap) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return { text, truncated: false };
  return { text: buf.subarray(0, cap).toString("utf8"), truncated: true };
}

/**
 * Run one git command. Resolves with `{code, stdout, stderr, truncated}` rather
 * than rejecting on a non-zero exit — a dirty tree, a missing upstream and a
 * conflicted merge are all ordinary answers here, not exceptions.
 */
export function runGit(cwd, args, { cap = DEFAULT_CAP_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof cwd !== "string" || !cwd || !path.isAbsolute(cwd)) {
    throw new GitError("git cwd must be an absolute path that already passed the source resolver", { status: 500 });
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new GitError("git args must be an array of strings", { status: 500 });
  }
  return new Promise((resolve) => {
    execFile(
      "git",
      [...SAFE_CONFIG, ...args],
      {
        cwd,
        timeout: timeoutMs,
        // Room above the cap so a slightly-over response is truncated by us
        // (with a flag the caller can show) rather than killed by execFile.
        maxBuffer: cap + 256 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          // Never block on a credential or host-key prompt: a fetch that hangs
          // for an hour is worse than a fetch that fails in a second.
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
          // Reading a status must not take the index lock out from under a
          // developer working in the same tree.
          GIT_OPTIONAL_LOCKS: "0"
        }
      },
      (err, stdout, stderr) => {
        const out = capUtf8(String(stdout ?? ""), cap);
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: out.text,
          stderr: String(stderr ?? "").slice(0, 8_000),
          truncated: out.truncated,
          timedOut: Boolean(err && err.killed)
        });
      }
    );
  });
}

/** Same, but a non-zero exit is an error — for the commands whose failure is a failure. */
export async function runGitOrThrow(cwd, args, options) {
  const res = await runGit(cwd, args, options);
  if (res.code !== 0) {
    throw new GitError(`git ${args[0]} failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`, { status: 500 });
  }
  return res;
}

/** Parse `git status --porcelain=v2 --branch`. */
export function parsePorcelainV2(stdout) {
  const snapshot = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, dirty: [] };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# ")) {
      const [, key, ...rest] = line.split(" ");
      const value = rest.join(" ");
      if (key === "branch.head") snapshot.branch = value === "(detached)" ? null : value;
      else if (key === "branch.oid") snapshot.head = value === "(initial)" ? null : value;
      else if (key === "branch.upstream") snapshot.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+)\s+-(\d+)$/.exec(value);
        if (m) {
          snapshot.ahead = Number(m[1]);
          snapshot.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = line[0];
    if (kind === "1") {
      const parts = line.split(" ");
      snapshot.dirty.push({ state: "changed", xy: parts[1], path: parts.slice(8).join(" ") });
    } else if (kind === "2") {
      // Rename/copy: "<path>\t<origPath>".
      const parts = line.split(" ");
      const paths = parts.slice(9).join(" ");
      const [target, origin] = paths.split("\t");
      snapshot.dirty.push({ state: "renamed", xy: parts[1], path: target, from: origin ?? null });
    } else if (kind === "u") {
      const parts = line.split(" ");
      snapshot.dirty.push({ state: "unmerged", xy: parts[1], path: parts.slice(10).join(" ") });
    } else if (kind === "?") {
      snapshot.dirty.push({ state: "untracked", xy: "??", path: line.slice(2) });
    }
    // "!" (ignored) only appears with --ignored, which we never pass.
  }
  return snapshot;
}

/** The in-progress operations that make a tree unsafe to merge into. */
export function inProgressOps(gitDir) {
  const ops = [];
  const has = (rel) => existsSync(path.join(gitDir, rel));
  if (has("MERGE_HEAD")) ops.push("merge");
  if (has("rebase-merge") || has("rebase-apply")) ops.push("rebase");
  if (has("CHERRY_PICK_HEAD")) ops.push("cherry-pick");
  if (has("REVERT_HEAD")) ops.push("revert");
  if (has("BISECT_LOG")) ops.push("bisect");
  return ops;
}

/**
 * Repository status. NO implicit fetch — ahead/behind are measured against the
 * last-fetched remote ref, which is exactly the thing the merge actions decide
 * on, and a status read that silently hit the network would not be instant.
 */
export async function gitStatus(cwd) {
  const status = await runGit(cwd, ["status", "--porcelain=v2", "--branch"]);
  if (status.code !== 0) {
    throw new GitError(`not a git repository or git failed: ${status.stderr.trim() || `exit ${status.code}`}`, { status: 400 });
  }
  const snapshot = parsePorcelainV2(status.stdout);

  // The authoritative ahead/behind when an upstream exists. `--branch` already
  // carries branch.ab, but the explicit rev-list is what the plan specifies and
  // it also answers when the porcelain header is absent (older gits, no ab line).
  if (snapshot.upstream) {
    const counts = await runGit(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], { cap: 4096 });
    if (counts.code === 0) {
      const m = /^(\d+)\s+(\d+)/.exec(counts.stdout.trim());
      if (m) {
        snapshot.behind = Number(m[1]);
        snapshot.ahead = Number(m[2]);
      }
    }
  }

  const gitDirRes = await runGit(cwd, ["rev-parse", "--absolute-git-dir"], { cap: 8192 });
  const gitDir = gitDirRes.code === 0 ? gitDirRes.stdout.trim() : null;
  const inProgress = gitDir ? inProgressOps(gitDir) : [];

  const stash = await runGit(cwd, ["stash", "list"], { cap: 64 * 1024 });
  const stashCount = stash.code === 0 ? stash.stdout.split("\n").filter(Boolean).length : 0;

  return {
    branch: snapshot.branch,
    head: snapshot.head,
    upstream: snapshot.upstream,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    dirty: snapshot.dirty,
    dirtyCount: snapshot.dirty.length,
    stash: stashCount,
    inProgress,
    mergeInProgress: inProgress.length > 0
  };
}

/** The only call in this module that reaches a remote on its own. */
export async function gitFetch(cwd) {
  const res = await runGit(cwd, ["fetch", "--all", "--prune"], { timeoutMs: NETWORK_TIMEOUT_MS, cap: 256 * 1024 });
  return { ok: res.code === 0, output: (res.stderr + res.stdout).trim(), code: res.code };
}

/**
 * `--numstat` probe: git prints `-\t-\t<path>` for a file it treats as binary.
 * Cheap, and the honest way to answer "is this diffable" before spending a
 * megabyte of buffer finding out.
 */
export async function diffBinaryPaths(cwd, { staged = false, relPath = null } = {}) {
  const args = ["diff", ...(staged ? ["--cached"] : []), "--numstat", "--"];
  if (relPath) args.push(relPath);
  const res = await runGit(cwd, args, { cap: 512 * 1024 });
  if (res.code !== 0) return [];
  const binary = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts[0] === "-" && parts[1] === "-") binary.push(parts.slice(2).join("\t"));
  }
  return binary;
}

/**
 * A unified diff of the working tree (or of the index with `staged`). Capped;
 * a single binary path is refused outright rather than answered with git's
 * "Binary files differ" placeholder, which reads as an empty diff.
 */
export async function gitDiff(cwd, { relPath = null, staged = false } = {}) {
  const target = relPath ? assertPathArg(relPath) : null;
  const binary = await diffBinaryPaths(cwd, { staged, relPath: target });
  if (target && binary.length) {
    throw new GitError("refusing to diff a binary file", { status: 415 });
  }
  const args = ["diff", ...(staged ? ["--cached"] : []), "--"];
  if (target) args.push(target);
  const res = await runGit(cwd, args, { cap: DIFF_CAP_BYTES });
  if (res.code !== 0 && !res.stdout) {
    throw new GitError(`git diff failed: ${res.stderr.trim() || `exit ${res.code}`}`, { status: 500 });
  }
  return {
    path: target,
    staged: Boolean(staged),
    diff: res.stdout,
    truncated: res.truncated,
    cap: DIFF_CAP_BYTES,
    // Whole-tree diffs stay useful with binaries present (git emits a one-line
    // placeholder for them), so they are named rather than refused.
    binary
  };
}

const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%aI%x1f%s";

/** Recent history. `limit` is clamped, never interpolated. */
export async function gitLog(cwd, { limit = 30 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const res = await runGit(cwd, ["log", "--max-count", String(n), `--pretty=format:${LOG_FORMAT}`], { cap: 512 * 1024 });
  if (res.code !== 0) {
    throw new GitError(`git log failed: ${res.stderr.trim() || `exit ${res.code}`}`, { status: 500 });
  }
  const commits = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const [sha, short, author, at, subject] = line.split("\x1f");
    commits.push({ sha, short, author, at, subject: subject ?? "" });
  }
  return { commits, limit: n };
}

/** HEAD's full sha. */
export async function gitHead(cwd) {
  const res = await runGit(cwd, ["rev-parse", "HEAD"], { cap: 4096 });
  return res.code === 0 ? res.stdout.trim() : null;
}

/** A commit message we control. Callers never pass free text off the wire. */
export async function gitCommitAll(cwd, message) {
  if (typeof message !== "string" || !message.trim()) throw new GitError("commit message required", { status: 500 });
  await runGitOrThrow(cwd, ["add", "-A", "--"]);
  const res = await runGit(cwd, ["commit", "-m", message]);
  if (res.code !== 0) {
    // "nothing to commit" races a concurrent commit; it is not a failure.
    if (/nothing to commit|no changes added/i.test(res.stdout + res.stderr)) return { committed: false };
    throw new GitError(`git commit failed: ${res.stderr.trim() || res.stdout.trim()}`, { status: 500 });
  }
  return { committed: true };
}

/** Push the named branch to `origin`, setting upstream when it has none. */
export async function gitPush(cwd, branch) {
  const ref = assertRefArg(branch);
  const res = await runGit(cwd, ["push", "--set-upstream", "origin", ref], { timeoutMs: NETWORK_TIMEOUT_MS, cap: 256 * 1024 });
  return { ok: res.code === 0, output: (res.stderr + res.stdout).trim(), code: res.code };
}

/** True when the repository has an `origin` remote to push to at all. */
export async function hasOrigin(cwd) {
  const res = await runGit(cwd, ["remote"], { cap: 8192 });
  return res.code === 0 && res.stdout.split("\n").some((l) => l.trim() === "origin");
}
