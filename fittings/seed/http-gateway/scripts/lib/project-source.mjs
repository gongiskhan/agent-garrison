// Resolve a named project label to its repo root, so a soul can be spawned at a
// project's checkout on its current branch. Uses the SAME source the rest of
// Garrison uses: ~/.garrison/dev-root (default ~/dev), scanned one level deep
// with ".git" required — the precedent from the Kanban loop's listProjects.
// Read-only + best-effort: a missing dir just yields the default.

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
export function resolveProjectPath(project, devRoot = readDevRoot()) {
  if (typeof project !== "string" || !project) return null;
  const expanded = expandHome(project);
  if (path.isAbsolute(expanded) && existsSync(expanded)) return expanded;
  const candidate = path.join(devRoot, project);
  if (existsSync(path.join(candidate, ".git"))) return candidate;
  return null;
}
