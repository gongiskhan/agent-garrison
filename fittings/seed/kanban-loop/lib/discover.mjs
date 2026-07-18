// Local discovery helpers for the Kanban config/create UI:
//   - listProjects(): the git repos under the dev-root the user picked in dev-env
//     (the SAME ~/.garrison/dev-root file + the SAME ".git-dir, one level deep" scan
//     dev-env uses), so the Kanban project picker shows exactly the dev-env list.
//   - listSkills(): the skills installed under ~/.claude/skills (each subdir with a
//     SKILL.md), so the list-config skill field is a real list, not free text.
// Read-only + best-effort: a missing dir / unreadable file just yields [].
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const GARRISON_HOME = process.env.GARRISON_HOME || path.join(HOME, ".garrison");
const CLAUDE_HOME = process.env.GARRISON_CLAUDE_HOME || path.join(HOME, ".claude");
const DEV_ROOT_FILE = path.join(GARRISON_HOME, "dev-root");

// Expand a leading ~ to the home dir (the dev-root file may store "~/dev").
export function expandHome(p) {
  if (typeof p !== "string" || !p) return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

// The dev-root the user configured in dev-env (~/.garrison/dev-root), default ~/dev —
// the SAME source dev-env scans, so the Kanban project list matches dev-env's.
export function readDevRoot() {
  try {
    const raw = readFileSync(DEV_ROOT_FILE, "utf8").trim();
    if (raw) return expandHome(raw);
  } catch { /* no file → default */ }
  return path.join(HOME, "dev");
}

// Enumerate git repos directly under devRoot (one level, ".git" required) — the SAME
// rule as dev-env's listProjects. Returns [{ name, path }] sorted by name.
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
    out.push({ name: e.name, path: p });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Read the one-line `description:` from a SKILL.md frontmatter (best-effort, capped).
function readSkillDescription(file, max = 160) {
  try {
    const text = readFileSync(file, "utf8");
    const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
    const fm = m ? m[1] : text.slice(0, 800);
    const d = fm.match(/^description:\s*(.+)$/m);
    if (!d) return "";
    const s = d[1].trim().replace(/^["']|["']$/g, "");
    return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
  } catch {
    return "";
  }
}

// The skills installed under ~/.claude/skills (each subdir with a SKILL.md). Returns
// [{ name, description }] sorted by name; description is the frontmatter one-liner.
export function listSkills(home = CLAUDE_HOME) {
  const root = path.join(home, "skills");
  if (!existsSync(root)) return [];
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (e.name.startsWith(".")) continue;
    const skillFile = path.join(root, e.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    out.push({ name: e.name, description: readSkillDescription(skillFile) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
