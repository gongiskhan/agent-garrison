// The shell-side twin of the gateway's SAFE project resolver
// (fittings/seed/http-gateway/scripts/lib/project-source.mjs).
//
// Why this exists rather than a fourth precedence: src/lib/project-config.ts
// carries a standing warning against inventing another project -> path order,
// and it is right. This module deliberately encodes NO new precedence. It is a
// literal port of `resolveProjectName` / `listProjectNames`: dev-root children
// only, realpath-confined, ".git" required, and nothing else. Its only reason
// to exist in TypeScript is that the Next.js app cannot import a fitting's
// private lib. `tests/dev-root.test.ts` runs both implementations over the same
// temp trees and asserts they agree, so the two cannot drift apart.
//
// Use this for ANY project label that came off the wire (a request body, a
// query string, a picker selection). `resolveProjectPath` in the gateway - the
// one that waves through any absolute existing path - has no counterpart here
// on purpose.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function homeDir(): string {
  return os.homedir();
}

// Expand a leading ~ to the home dir (the dev-root file may store "~/dev").
export function expandHome(p: string): string {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return homeDir();
  if (p.startsWith("~/")) return path.join(homeDir(), p.slice(2));
  return p;
}

// The dev-root the user configured in dev-env (~/.garrison/dev-root), default
// ~/dev. GARRISON_HOME is read at call time so a test can point the whole thing
// at a sandbox without import-order tricks.
export function readDevRoot(): string {
  const garrisonHome =
    process.env.GARRISON_HOME?.trim() || path.join(homeDir(), ".garrison");
  try {
    const raw = fs.readFileSync(path.join(garrisonHome, "dev-root"), "utf8").trim();
    if (raw) return expandHome(raw);
  } catch {
    /* no file -> default */
  }
  return path.join(homeDir(), "dev");
}

// True when `target` is a strict descendant of `root`. The dev-root itself is
// not a project, so the empty relative path ("" = root) is rejected too.
function isStrictlyInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (!rel) return false;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Resolve a dev-root CHILD NAME to its absolute repo root, or null.
//
// Rejected, in order: non-strings and blanks; anything carrying a path
// separator or ".."; absolute paths; dotfiles; a candidate whose realpath
// leaves the dev-root (a symlinked child pointing at /etc or another checkout);
// non-directories; and directories with no ".git" entry.
//
// Returns the realpath, which is the path already proven contained and the same
// canonical identity the other dev-root scanners hand out - so the ~/dev vs
// ~/Projects symlink pair cannot produce two spellings of one repo.
export function resolveProjectName(
  label: string,
  { devRoot = readDevRoot() }: { devRoot?: string } = {}
): string | null {
  if (typeof label !== "string") return null;
  const name = label.trim();
  if (!name) return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (name.includes("..")) return null;
  if (path.isAbsolute(name)) return null; // win32 "C:\x" survives the separator checks
  if (name.startsWith(".")) return null;

  const root = expandHome(devRoot);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null; // no dev-root -> no projects
  }
  let real: string;
  try {
    real = fs.realpathSync(path.join(realRoot, name));
  } catch {
    return null;
  }
  if (!isStrictlyInside(realRoot, real)) return null;
  try {
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!fs.existsSync(path.join(real, ".git"))) return null;
  return real;
}

// The dev-root child names resolveProjectName would accept, sorted. Every
// candidate is re-run through the resolver so an offered name and an accepted
// name cannot drift. Never throws: an unreadable dev-root yields [].
export function listProjectNames(devRoot: string = readDevRoot()): string[] {
  const root = expandHome(devRoot);
  if (!fs.existsSync(root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (resolveProjectName(entry.name, { devRoot: root })) names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names;
}
