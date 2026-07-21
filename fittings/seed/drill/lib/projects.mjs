// Project selection for Drill: discover the user's projects, remember which
// one is under test, and locate each project's "run skill".
//
// Discovery reimplements the CONTRACT of kanban-loop's lib/discover.mjs
// (never imported across fittings): the dev-root file at
// <garrison-home>/dev-root (default ~/dev), git repos one level deep. The two
// must keep listing the same repos so the Drill project picker matches the
// Kanban/dev-env pickers.
//
// The ACTIVE project persists at <garrison-home>/drill/active-project.json and
// takes precedence over the GARRISON_DRILL_TARGET_REPO env pin - the env pin
// is the boot-time default, the file is the user's live selection.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { drillHomeDir } from "./runs-store.mjs";

function garrisonHome() {
  return process.env.GARRISON_HOME || path.join(os.homedir(), ".garrison");
}

export function expandHome(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// One canonical identity per repo: ~ expanded, resolved absolute, symlinks
// collapsed (best-effort - a not-yet-existing path keeps the resolved form).
// Every root boundary (env pin, selection, discovery) funnels through this,
// so the server's raw-string comparisons (active flag, run scoping) hold even
// when the same repo is reachable through an alias (trailing slash, ~/, the
// ~/dev vs ~/Projects symlink pair).
export function canonicalRoot(p) {
  const resolved = path.resolve(expandHome(String(p ?? "")));
  try { return realpathSync(resolved); } catch { return resolved; }
}

// The dev-root the user configured in dev-env (<garrison-home>/dev-root),
// default ~/dev - the SAME file dev-env and kanban-loop read.
export function readDevRoot() {
  try {
    const raw = readFileSync(path.join(garrisonHome(), "dev-root"), "utf8").trim();
    if (raw) return expandHome(raw);
  } catch { /* no file -> default */ }
  return path.join(os.homedir(), "dev");
}

// The project's run skill: a .claude/skills/run-* dir with a SKILL.md.
// Prefers the conventional run-<repo-basename>; falls back to the first
// run-* skill so a differently-named one still counts.
export function findRunSkill(root) {
  const skillsDir = path.join(root, ".claude", "skills");
  let entries = [];
  try { entries = readdirSync(skillsDir, { withFileTypes: true }); } catch { return null; }
  const candidates = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.startsWith("run-"))
    .map((e) => e.name)
    .filter((name) => existsSync(path.join(skillsDir, name, "SKILL.md")))
    .sort();
  if (candidates.length === 0) return null;
  const preferred = `run-${path.basename(root)}`;
  return candidates.includes(preferred) ? preferred : candidates[0];
}

export function projectInfo(root, name = path.basename(root)) {
  return {
    name,
    path: root,
    runSkill: findRunSkill(root),
    hasDrillBook: existsSync(path.join(root, "drills", "drillbook.yml"))
  };
}

// Git repos directly under devRoot (one level, ".git" required) - the same
// rule as dev-env/kanban-loop. Returns [{name, path, runSkill, hasDrillBook}]
// sorted by name.
export function listProjects(devRoot = readDevRoot()) {
  const root = expandHome(devRoot);
  if (!existsSync(root)) return [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith(".")) continue;
    const p = path.join(root, e.name);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    if (!existsSync(path.join(p, ".git"))) continue;
    out.push(projectInfo(canonicalRoot(p), e.name));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function activeProjectFile() {
  return path.join(drillHomeDir(), "active-project.json");
}

// The persisted selection, or null. Sync because store.mjs resolves the
// target root synchronously on every request; the file is a few bytes.
export function activeProjectRoot() {
  try {
    const parsed = JSON.parse(readFileSync(activeProjectFile(), "utf8"));
    const root = typeof parsed?.root === "string" ? parsed.root : null;
    if (root && path.isAbsolute(root) && existsSync(root) && statSync(root).isDirectory()) return canonicalRoot(root);
  } catch { /* unset or unreadable -> no selection */ }
  return null;
}

// A pinned project identity must still exist on disk before a mutating
// request is allowed to write against it - a client holding a root it
// captured minutes ago (the project was since removed/renamed, or the path
// was never valid) must be rejected outright, not silently redirected to
// whatever the live global selection happens to be right now.
export function isValidProjectRoot(root) {
  if (typeof root !== "string" || !root || !path.isAbsolute(root)) return false;
  try { return existsSync(root) && statSync(root).isDirectory(); } catch { return false; }
}

export async function selectProject(root) {
  const resolved = canonicalRoot(root);
  if (!path.isAbsolute(resolved) || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`not a directory: ${root}`);
  }
  const file = activeProjectFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ root: resolved, selectedAt: new Date().toISOString() }, null, 2), "utf8");
  await fs.rename(tmp, file);
  return projectInfo(resolved);
}
