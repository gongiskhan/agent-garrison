// Resolve a named project label to its repo root, so a soul can be spawned at a
// project's checkout on its current branch. Uses the SAME source the rest of
// Garrison uses: ~/.garrison/dev-root (default ~/dev), scanned one level deep
// with ".git" required — the precedent from the Kanban loop's listProjects.
// Read-only + best-effort: a missing dir just yields the default.
//
// Two resolvers, two trust levels, and the difference matters:
//   resolveProjectPath  - legacy, trusted callers only. Any absolute existing
//                         path passes through unchanged.
//   resolveProjectName  - dev-root child names ONLY. Use this for anything a
//                         channel body can set (decision
//                         2026-07-25-web-channel-run-context §8).
// listProjectNames is the matching enumerator, so a picker can only offer names
// the resolver would accept.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { logEvent } from "./log.mjs";

const HOME = os.homedir();
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const DEV_ROOT_FILE = path.join(GARRISON_HOME, "dev-root");

// Expand a leading ~ to the home dir (the dev-root file may store "~/dev").
export function expandHome(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

// The dev-root the user configured in dev-env (~/.garrison/dev-root), default ~/dev.
export function readDevRoot() {
  try {
    const raw = readFileSync(DEV_ROOT_FILE, "utf8").trim();
    if (raw) return expandHome(raw);
  } catch { /* no file → default */ }
  return path.join(HOME, "dev");
}

// Resolve a project label to an absolute repo root. An absolute path that already
// exists is used as-is; otherwise the label is joined onto the dev-root and a
// ".git" dir is required. Returns null when nothing on disk matches.
//
// NOT SAFE FOR CHANNEL-SUPPLIED INPUT. This accepts ANY absolute existing path
// and hands it straight back, so a caller that feeds it a value from a request
// body has given the requester an arbitrary cwd (`/`, `~/.ssh`, another user's
// checkout). It stays this way because the trusted spawn path in gateway.mjs
// already relies on it for explicit paths. Anything reachable from a channel
// body must go through resolveProjectName below instead.
export function resolveProjectPath(project, devRoot = readDevRoot()) {
  if (typeof project !== "string" || !project) return null;
  const expanded = expandHome(project);
  if (path.isAbsolute(expanded) && existsSync(expanded)) return expanded;
  const candidate = path.join(devRoot, project);
  if (existsSync(path.join(candidate, ".git"))) return candidate;
  return null;
}

// True when `target` is a strict descendant of `root`. path.relative gives ".." /
// an absolute result for anything outside, and "" for root itself - the dev-root
// is not a project, so "" is rejected too.
function isStrictlyInside(root, target) {
  const rel = path.relative(root, target);
  if (!rel) return false;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Resolve a dev-root CHILD NAME to its absolute repo root, or null. This is the
// only resolver safe for a value that came off the wire (a channel body's
// `routing.project`): the accepted vocabulary is exactly "a name listed by
// listProjectNames", never a path.
//
// Rejected, in order: non-strings and blanks; anything carrying a path separator
// or ".." (so "../../etc", "a/b" and absolute paths never even form a candidate);
// dotfiles (".git", "." and ".." fall out here); a candidate whose realpath leaves
// the dev-root (a symlink child pointing at /etc or another checkout - a name-only
// check would have waved it through); non-directories; and directories with no
// ".git" entry.
//
// Returns the realpath, not the pre-symlink join: it is the path already proven
// contained, and it is the same canonical identity the other dev-root scanners in
// the repo (drill's canonicalRoot) hand out, so the ~/dev vs ~/Projects symlink
// pair cannot produce two spellings of one repo.
export function resolveProjectName(label, { devRoot = readDevRoot() } = {}) {
  if (typeof label !== "string") return null;
  const name = label.trim();
  if (!name) return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (name.includes("..")) return null;
  if (path.isAbsolute(name)) return null; // win32 "C:\x" survives the separator checks
  if (name.startsWith(".")) return null;

  const root = expandHome(devRoot);
  let realRoot;
  try { realRoot = realpathSync(root); } catch { return null; } // no dev-root -> no projects
  let real;
  try { real = realpathSync(path.join(realRoot, name)); } catch { return null; }
  if (!isStrictlyInside(realRoot, real)) return null;
  try { if (!statSync(real).isDirectory()) return null; } catch { return null; }
  if (!existsSync(path.join(real, ".git"))) return null;
  return real;
}

// The dev-root child names that resolveProjectName would accept, sorted - the
// source for the gateway's route-options menu. Each candidate is re-run through
// resolveProjectName so the offered list and the accepted vocabulary cannot
// drift. Cheap (one readdir + a realpath/stat per entry) and never throws: an
// unreadable dev-root yields [] with one stderr line.
export function listProjectNames(devRoot = readDevRoot()) {
  const root = expandHome(devRoot);
  if (!existsSync(root)) return [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    logEvent("stderr", { kind: "project-list-failed", devRoot: root, error: String(err?.message || err) });
    return [];
  }
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (resolveProjectName(e.name, { devRoot: root })) names.push(e.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}
