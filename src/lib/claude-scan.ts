import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Dirent } from "node:fs";
import { claudeHome } from "./claude-home";

// Disk-scan primitives for the ~/.claude package-file surface. Shared by the
// classifier (primitive-state.ts) and the reconcile engine (reconcile.ts).
//
// APM deploys flat files: skills/<name>/ (a dir with SKILL.md), commands/<x>.md,
// rules/<x>.md. We scan exactly those shapes; plugin-namespaced command subdirs
// belong to the Plugins surface (a separate, discovery-gated concern).

export type FileSurface = "skill" | "command" | "rule";

export interface ScannedFile {
  surface: FileSurface;
  name: string; // skill dir name, or command/rule basename without ".md"
  relPath: string; // claudeHome-relative, posix ("skills/foo", "rules/bar.md")
  absPath: string;
  isDir: boolean;
}

async function listDir(p: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function toRel(home: string, abs: string): string {
  return path.relative(home, abs).split(path.sep).join("/");
}

export async function scanClaudeFiles(home: string = claudeHome()): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];

  // skills: each subdir of skills/ that contains a SKILL.md (follow symlinked dirs too)
  const skillsRoot = path.join(home, "skills");
  for (const e of await listDir(skillsRoot)) {
    const abs = path.join(skillsRoot, e.name);
    const isDirLike = e.isDirectory() || e.isSymbolicLink();
    if (!isDirLike) continue;
    if (!(await fileExists(path.join(abs, "SKILL.md")))) continue;
    out.push({ surface: "skill", name: e.name, relPath: `skills/${e.name}`, absPath: abs, isDir: true });
  }

  // commands + rules: top-level *.md files (the shape APM deploys)
  for (const [surface, dirName] of [
    ["command", "commands"],
    ["rule", "rules"]
  ] as const) {
    const root = path.join(home, dirName);
    for (const e of await listDir(root)) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const abs = path.join(root, e.name);
      out.push({
        surface,
        name: e.name.replace(/\.md$/, ""),
        relPath: toRel(home, abs),
        absPath: abs,
        isDir: false
      });
    }
  }

  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export async function hashFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath);
  return `sha256:${crypto.createHash("sha256").update(buf).digest("hex")}`;
}

export interface InstalledPlugin {
  key: string; // "<name>@<marketplace>" — the unique installed id
  name: string; // the plugin name (before "@")
  marketplace?: string; // after "@"
  version?: string;
  scope?: string;
}

// Plugins installed by Claude Code's own plugin manager, read from
// plugins/installed_plugins.json (schema: { version, plugins: { "<name>@<mkt>":
// [ { scope, version, installPath, ... } ] } }). These are Claude-Code-managed,
// not APM/Garrison-owned — Quarters surfaces them read-only (SP6 gates Garrison-
// driven plugin install).
export async function readInstalledPlugins(home: string = claudeHome()): Promise<InstalledPlugin[]> {
  try {
    const raw = await fs.readFile(path.join(home, "plugins", "installed_plugins.json"), "utf8");
    const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    const plugins = parsed?.plugins;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];
    const out: InstalledPlugin[] = [];
    for (const [key, installs] of Object.entries(plugins)) {
      const at = key.indexOf("@");
      const name = at > 0 ? key.slice(0, at) : key;
      const marketplace = at > 0 ? key.slice(at + 1) : undefined;
      const first =
        Array.isArray(installs) && installs[0] && typeof installs[0] === "object"
          ? (installs[0] as Record<string, unknown>)
          : {};
      out.push({
        key,
        name,
        ...(marketplace ? { marketplace } : {}),
        ...(typeof first.version === "string" ? { version: first.version } : {}),
        ...(typeof first.scope === "string" ? { scope: first.scope } : {})
      });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  } catch {
    return [];
  }
}

// Server names declared in ~/.claude/mcp.json. Tolerates both `{ mcpServers: {…} }`
// and a bare `{ <name>: {…} }` top-level map.
export async function readMcpServerNames(home: string = claudeHome()): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(home, "mcp.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const servers =
      parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object"
        ? (parsed.mcpServers as Record<string, unknown>)
        : parsed;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return Object.keys(servers).sort();
    }
  } catch {
    /* missing/unparseable -> no servers */
  }
  return [];
}
