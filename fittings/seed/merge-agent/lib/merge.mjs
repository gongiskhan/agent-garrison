// The deterministic parts of a merge, kept out of the model's hands.
//
// A merge has two halves. Reconciling two people's edits to the same function
// needs judgement, so it belongs to the duty's skill. Naming the revert tag,
// deciding whether a merge was trivial, and knowing which files must never be
// merged at all are mechanical, so they belong here — where they are the same
// on every node, every night, and are covered by tests rather than by prompt
// adherence.

import { execFile } from "node:child_process";

const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null"];

/** Run one git command. execFile, never a shell, and never the repository's hooks. */
export function runGit(cwd, args, { timeoutMs = 20_000, cap = 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...SAFE_CONFIG, ...args],
      { cwd, timeout: timeoutMs, maxBuffer: cap, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "")
        })
    );
  });
}

/**
 * A git ref name may not contain `:`, and an ISO timestamp is full of them, so
 * the timestamp is flattened to `2026-08-24T191134Z`. It still sorts
 * lexicographically, which is what makes "prune tags older than 14 days" a
 * string comparison rather than a parse.
 */
export function tagTimestamp(now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  return at.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "");
}

const REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `garrison/premerge/<project>/<node>/<ISO>` at the pre-merge HEAD.
 *
 * A TAG, not a branch: it stays out of `git branch` noise, is not auto-pruned,
 * pushes once, and `git reset --hard <tag>` IS the one-command revert. Rail 1 of
 * the merge doctrine — every non-trivial merge gets one BEFORE it starts.
 */
export function premergeTag(project, node, now = new Date()) {
  for (const [label, value] of [["project", project], ["node", node]]) {
    const s = String(value ?? "");
    if (!REF_SEGMENT.test(s) || s.includes("..") || s.endsWith(".lock")) {
      throw new Error(`${label} "${s}" is not usable in a git ref name`);
    }
  }
  return `garrison/premerge/${project}/${node}/${tagTimestamp(now)}`;
}

/** Parse a tag this module produced back into its parts, or null. */
export function parsePremergeTag(tag) {
  const m = /^garrison\/premerge\/([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2}T\d{6}Z)$/.exec(String(tag ?? ""));
  if (!m) return null;
  const [, project, node, stamp] = m;
  const iso = `${stamp.slice(0, 11)}${stamp.slice(11, 13)}:${stamp.slice(13, 15)}:${stamp.slice(15, 17)}Z`;
  return { project, node, stamp, at: new Date(iso) };
}

/**
 * Would merging `ref` into HEAD be a fast-forward (or a no-op)?
 *
 * This is the question rail 2 turns on: a trivial fast-forward files NOTHING,
 * because a board full of "merged 3 commits, no conflicts" cards stops being
 * read, and a rail nobody reads is not a rail. `merge-base --is-ancestor HEAD
 * <ref>` is the whole test — if HEAD is already an ancestor of the incoming ref,
 * nothing of ours can be lost.
 */
export async function isTrivialFastForward(cwd, ref) {
  const res = await runGit(cwd, ["merge-base", "--is-ancestor", "HEAD", ref], { cap: 64 * 1024 });
  // 0 = ancestor (fast-forward or already merged), 1 = not, anything else = the
  // ref does not resolve, which is emphatically not "trivial".
  return res.code === 0;
}

// Files that are REGENERATED, never merged: a three-way merge of a lockfile
// produces a file that is valid YAML/JSON and describes a dependency tree that
// has never existed anywhere.
const LOCKFILES = new Set([
  "package-lock.json",
  "apm.lock.yaml",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum"
]);

// Extensions with no line structure to merge. Git already refuses to
// three-way-merge these; naming them is how the escalation says WHY.
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".icns",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar",
  ".mp4", ".mov", ".webm", ".avi", ".mp3", ".wav", ".m4a", ".ogg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".so", ".dylib", ".dll", ".exe", ".node", ".wasm", ".jar", ".class", ".pyc",
  ".db", ".sqlite", ".sqlite3"
]);

// The composition-transfer never-travels list, applied here for the same reason
// it exists there: these are machine-local or secret, and a merge that carried
// one across nodes would move a credential or a home path onto another machine.
const NEVER_TRAVELS = [
  { test: (p) => /(^|\/)\.env($|\.)/.test(p), reason: "secret: .env is machine-local and never travels" },
  { test: (p) => /(^|\/)vault\.json$/.test(p), reason: "secret: the vault never travels" },
  { test: (p) => /(^|\/)local\.yml$/.test(p), reason: "machine-local overlay (home paths, machine ports)" },
  { test: (p) => /(^|\/)owner\.json$/.test(p), reason: "machine-local composition ownership claim" },
  { test: (p) => /(^|\/)apm_modules\//.test(p), reason: "installed packages: reinstall, never merge" },
  { test: (p) => /(^|\/)node_modules\//.test(p), reason: "installed packages: reinstall, never merge" },
  { test: (p) => /(^|\/)\.claude\//.test(p), reason: "the real ~/.claude is APM's to write, not a merge's" }
];

function extname(p) {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * The paths in a conflict set that must be REFUSED rather than resolved.
 *
 * Returns `[{path, reason, action}]`. An empty array means every conflicting
 * file is a candidate for file-by-file resolution; a non-empty one means the
 * merge stops and escalates, because guessing at any of these silently destroys
 * something. "Refuse and escalate, never guess" is the whole point.
 */
export function refusalList(paths) {
  const out = [];
  for (const raw of paths ?? []) {
    const p = String(raw ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!p) continue;
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (LOCKFILES.has(base)) {
      out.push({ path: p, reason: `${base} is a lockfile — regenerate it, never merge it`, action: "regenerate" });
      continue;
    }
    if (BINARY_EXT.has(extname(p))) {
      out.push({ path: p, reason: `${extname(p)} has no line structure to merge`, action: "escalate" });
      continue;
    }
    const never = NEVER_TRAVELS.find((rule) => rule.test(p));
    if (never) {
      out.push({ path: p, reason: never.reason, action: "escalate" });
    }
  }
  return out;
}

/** The conflicting paths of an in-progress merge (`git diff --name-only --diff-filter=U`). */
export async function conflictPaths(cwd) {
  const res = await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"], { cap: 512 * 1024 });
  if (res.code !== 0) return [];
  return res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Is this merge worth a decision card? Any conflict resolved, or any file both
 * sides changed. A clean fast-forward is not.
 */
export function isNonTrivialMerge({ fastForward, conflicts = [], bothChanged = [] }) {
  if (fastForward) return false;
  return conflicts.length > 0 || bothChanged.length > 0;
}
