import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { claudeHome } from "./claude-home";
import { writeFileAtomic } from "./atomic-write";

// Markdown plan files under ~/.claude/plans. Garrison-direct-write (autosave),
// with a strict filename guard against path traversal.

const NAME_RE = /^[\w.-]+\.md$/;

function plansDir(home: string = claudeHome()): string {
  return path.join(home, "plans");
}

function sha(s: string): string {
  return `sha256:${crypto.createHash("sha256").update(s).digest("hex")}`;
}

function resolveSafe(name: string, home: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid plan filename: ${name}`);
  const dir = path.resolve(plansDir(home));
  const resolved = path.resolve(dir, name);
  if (path.dirname(resolved) !== dir) throw new Error("path traversal rejected");
  return resolved;
}

export interface PlanListItem {
  name: string;
  mtime: number;
}

export interface PlanView {
  name: string;
  exists: boolean;
  content: string;
  sha: string;
}

export async function listPlans(home: string = claudeHome()): Promise<PlanListItem[]> {
  try {
    const entries = await fs.readdir(plansDir(home), { withFileTypes: true });
    const out: PlanListItem[] = [];
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) {
        const st = await fs.stat(path.join(plansDir(home), e.name));
        out.push({ name: e.name, mtime: st.mtimeMs });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

export async function readPlan(name: string, home: string = claudeHome()): Promise<PlanView> {
  const p = resolveSafe(name, home);
  try {
    const content = await fs.readFile(p, "utf8");
    return { name, exists: true, content, sha: sha(content) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { name, exists: false, content: "", sha: sha("") };
    }
    throw e;
  }
}

export async function writePlan(name: string, body: string, home: string = claudeHome()): Promise<PlanView> {
  const p = resolveSafe(name, home);
  await writeFileAtomic(p, body);
  return { name, exists: true, content: body, sha: sha(body) };
}
