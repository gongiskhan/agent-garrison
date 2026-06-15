// workflows-scan.ts — read-only scan of saved Claude Code workflows (BRIEF v4 MR4).
//
// Lists `.claude/workflows/` (project) and `~/.claude/workflows/` (user) when
// present; graceful empty-state when absent (the dirs don't exist on CLI 2.1.175,
// so this is empty-state-first + fixture-tested). Saved workflows also surface as
// `workflow` targets in the Model Router dropdown.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type WorkflowScope = "user" | "project";

export interface WorkflowEntry {
  name: string; // basename without extension
  scope: WorkflowScope;
  relPath: string; // workflows/<file>
  absPath: string;
  ext: string;
}

const WORKFLOW_EXTS = new Set([".js", ".mjs", ".ts"]);

function scanDir(dir: string, scope: WorkflowScope): WorkflowEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // graceful empty-state when the dir is absent
  }
  const out: WorkflowEntry[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name);
    if (!WORKFLOW_EXTS.has(ext)) continue;
    out.push({
      name: e.name.slice(0, -ext.length),
      scope,
      relPath: `workflows/${e.name}`,
      absPath: path.join(dir, e.name),
      ext
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ScanWorkflowsOptions {
  userHome?: string; // defaults to ~/.claude
  projectRoot?: string; // defaults to cwd/.claude
}

// Scan user + project workflow dirs. Project entries shadow user entries of the
// same name (project wins), mirroring Claude Code precedence.
export function scanWorkflows(opts: ScanWorkflowsOptions = {}): WorkflowEntry[] {
  const userDir = path.join(opts.userHome ?? path.join(os.homedir(), ".claude"), "workflows");
  const projectDir = path.join(opts.projectRoot ?? path.join(process.cwd(), ".claude"), "workflows");
  const user = scanDir(userDir, "user");
  const project = scanDir(projectDir, "project");
  const byName = new Map<string, WorkflowEntry>();
  for (const e of user) byName.set(e.name, e);
  for (const e of project) byName.set(e.name, e); // project wins
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readWorkflowScript(entry: WorkflowEntry): string {
  try {
    return fs.readFileSync(entry.absPath, "utf8");
  } catch {
    return "";
  }
}

// Map scanned workflows → Model Router `workflow` targets (so they appear in the
// router's target dropdown). Target ids are namespaced by scope to avoid clashes.
export interface WorkflowTarget {
  id: string;
  type: "workflow";
  workflow: string;
  scope: WorkflowScope;
}

export function workflowTargets(entries: WorkflowEntry[]): WorkflowTarget[] {
  return entries.map((e) => ({ id: `workflow:${e.name}`, type: "workflow", workflow: e.name, scope: e.scope }));
}
