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
