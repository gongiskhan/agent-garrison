// Slash-command + skill enumeration for the rich chat composer's autocomplete.
//
// Sources (merged, project shadows user shadows builtin on name collision):
//   - builtin: a curated static list of Claude Code slash commands.
//   - user:    ~/.claude/commands/*.md         (+ nested dirs -> ns:name)
//   - project: <cwd>/.claude/commands/*.md
//   - skill:   ~/.claude/skills/* /SKILL.md  and <cwd>/.claude/skills/* /SKILL.md
//             (invoked as /<name>)
//
// Each entry: { name, description, source, argumentHint? }. `name` has no
// leading slash. Pure + dependency-injectable for tests (pass dirs/home).

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Curated built-ins with one-line descriptions (claude 2.1.x).
export const BUILTIN_COMMANDS = [
  ["add-dir", "Add a working directory to the session"],
  ["agents", "Manage and launch sub-agents"],
  ["clear", "Clear the conversation history"],
  ["compact", "Summarise and compact the conversation"],
  ["config", "Open the settings/config view"],
  ["context", "Show token/context usage for the session"],
  ["cost", "Show token cost and usage for the session"],
  ["doctor", "Diagnose setup and configuration issues"],
  ["exit", "Exit the session"],
  ["export", "Export the conversation transcript"],
  ["help", "List available commands and shortcuts"],
  ["hooks", "View and manage configured hooks"],
  ["init", "Generate a CLAUDE.md for this project"],
  ["mcp", "Manage MCP servers"],
  ["memory", "View and edit memory files"],
  ["model", "Switch the active model"],
  ["permissions", "View and edit tool permissions"],
  ["pr-comments", "Fetch and address PR review comments"],
  ["release-notes", "Show recent Claude Code release notes"],
  ["resume", "Resume a previous conversation"],
  ["review", "Review the current changes"],
  ["rewind", "Rewind to an earlier point in the conversation"],
  ["status", "Show session status"],
  ["statusline", "Configure the status line"],
  ["terminal-setup", "Configure terminal key bindings"],
  ["todos", "Show the current todo list"],
  ["vim", "Toggle vim editing mode"],
].map(([name, description]) => ({ name, description, source: "builtin" }));

function parseFrontmatter(text) {
  // Returns { description, argumentHint, name } from a leading YAML --- block,
  // plus the first non-empty body line as a fallback description.
  const out = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (m) {
    const fm = m[1];
    body = m[2];
    const desc = /(^|\n)description:\s*(.+)/i.exec(fm);
    if (desc) out.description = desc[2].trim().replace(/^["']|["']$/g, "");
    const hint = /(^|\n)argument-hint:\s*(.+)/i.exec(fm);
    if (hint) out.argumentHint = hint[2].trim().replace(/^["']|["']$/g, "");
    const nm = /(^|\n)name:\s*(.+)/i.exec(fm);
    if (nm) out.name = nm[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!out.description) {
    const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    if (firstLine) out.description = firstLine.replace(/^#+\s*/, "").slice(0, 200);
  }
  return out;
}

function scanCommandDir(dir, source, prefix = "") {
  const out = [];
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...scanCommandDir(full, source, prefix ? `${prefix}:${ent.name}` : ent.name));
      continue;
    }
    if (!ent.name.endsWith(".md")) continue;
    const base = ent.name.replace(/\.md$/, "");
    const name = prefix ? `${prefix}:${base}` : base;
    let meta = {};
    try {
      meta = parseFrontmatter(readFileSync(full, "utf8"));
    } catch {
      /* unreadable — keep the name only */
    }
    out.push({ name, description: meta.description ?? "", source, argumentHint: meta.argumentHint });
  }
  return out;
}

function scanSkillsDir(dir, source) {
  const out = [];
  if (!existsSync(dir)) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillFile = join(dir, ent.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    let meta = {};
    try {
      meta = parseFrontmatter(readFileSync(skillFile, "utf8"));
    } catch {
      /* keep dir name */
    }
    out.push({
      name: meta.name ?? ent.name,
      description: meta.description ?? "",
      source,
    });
  }
  return out;
}

/**
 * Enumerate all slash commands + skills available for `cwd`.
 * @param {{cwd?: string, home?: string}} opts
 * @returns {Array<{name:string, description:string, source:string, argumentHint?:string}>}
 */
export function enumerateCommands(opts = {}) {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd;
  const byName = new Map();
  const add = (entry) => byName.set(entry.name, entry); // later writers win

  for (const c of BUILTIN_COMMANDS) add(c);
  for (const s of scanSkillsDir(join(home, ".claude", "skills"), "skill")) add(s);
  for (const c of scanCommandDir(join(home, ".claude", "commands"), "user")) add(c);
  if (cwd) {
    for (const s of scanSkillsDir(join(cwd, ".claude", "skills"), "skill")) add(s);
    for (const c of scanCommandDir(join(cwd, ".claude", "commands"), "project")) add(c);
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Small in-process cache so the HTTP endpoint isn't re-scanning the FS on
// every keystroke-driven refetch.
const cache = new Map();
const TTL_MS = 30_000;

export function enumerateCommandsCached(opts = {}) {
  const key = `${opts.home ?? ""}::${opts.cwd ?? ""}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = enumerateCommands(opts);
  cache.set(key, { at: now, value });
  return value;
}
