import fs from "node:fs/promises";
import path from "node:path";
import { claudeHome } from "./claude-home";

// Claude Code saved workflows are JavaScript orchestration scripts stored in
// either the current project's .claude/workflows/ or the user's
// ~/.claude/workflows/. Project workflows win at launch time when both scopes
// define the same command name.

export type WorkflowSource = "project" | "user";

export interface WorkflowScanOptions {
  projectRoot?: string;
  claudeHome?: string;
}

export interface ScannedWorkflow {
  id: string;
  name: string;
  source: WorkflowSource;
  sourceLabel: string;
  relPath: string;
  absPath: string;
}

export interface WorkflowDetail extends ScannedWorkflow {
  script: string;
  body: string;
  routerTarget: RouterWorkflowTarget;
}

export interface WorkflowDeleteResult {
  ok: boolean;
  id?: string;
  code?: "not-found" | "invalid";
  error?: string;
}

export interface RouterWorkflowTarget {
  id: string;
  name: string;
  label: string;
  type: "workflow";
  workflow: string;
  source: WorkflowSource;
  recordId: string;
  scriptPath: string;
  description: string;
  input: {
    name: string;
    scriptPath: string;
  };
}

const WORKFLOW_EXTS = new Set(["", ".js", ".mjs", ".cjs", ".ts"]);

export function workflowProjectRoot(): string {
  const override = process.env.GARRISON_PROJECT_ROOT?.trim();
  return override && override.length > 0 ? path.resolve(override) : process.cwd();
}

function roots(opts: WorkflowScanOptions = {}): Array<{ source: WorkflowSource; root: string; dir: string }> {
  const projectRoot = path.resolve(opts.projectRoot ?? workflowProjectRoot());
  const home = path.resolve(opts.claudeHome ?? claudeHome());
  return [
    { source: "project", root: projectRoot, dir: path.join(projectRoot, ".claude", "workflows") },
    { source: "user", root: home, dir: path.join(home, "workflows") }
  ];
}

function sourceLabel(source: WorkflowSource): string {
  return source === "project" ? "project" : "user";
}

function relFor(source: WorkflowSource, filename: string): string {
  return source === "project" ? `.claude/workflows/${filename}` : `workflows/${filename}`;
}

function nameFor(filename: string): string {
  const ext = path.extname(filename);
  return ext && WORKFLOW_EXTS.has(ext) ? filename.slice(0, -ext.length) : filename;
}

function idFor(source: WorkflowSource, name: string): string {
  return `workflow:${source}:${name}`;
}

function slugFor(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "workflow";
}

async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

async function isRegularWorkflowFile(dir: string, filename: string): Promise<boolean> {
  if (filename.startsWith(".")) return false;
  const ext = path.extname(filename);
  if (!WORKFLOW_EXTS.has(ext)) return false;
  try {
    const st = await fs.stat(path.join(dir, filename));
    return st.isFile();
  } catch {
    return false;
  }
}

export async function scanClaudeWorkflows(opts: WorkflowScanOptions = {}): Promise<ScannedWorkflow[]> {
  const out: ScannedWorkflow[] = [];
  const seenPaths = new Set<string>();

  for (const root of roots(opts)) {
    let names: string[];
    try {
      names = await fs.readdir(root.dir);
    } catch {
      continue;
    }

    for (const filename of names.sort((a, b) => a.localeCompare(b))) {
      if (!(await isRegularWorkflowFile(root.dir, filename))) continue;
      const absPath = path.join(root.dir, filename);
      const real = await realpathOrResolve(absPath);
      if (seenPaths.has(real)) continue;
      seenPaths.add(real);

      const name = nameFor(filename);
      out.push({
        id: idFor(root.source, name),
        name,
        source: root.source,
        sourceLabel: sourceLabel(root.source),
        relPath: relFor(root.source, filename),
        absPath
      });
    }
  }

  return out;
}

function parseWorkflowId(id: string): { source: WorkflowSource; name: string } | null {
  const match = id.match(/^workflow:(project|user):(.+)$/);
  if (!match) return null;
  return { source: match[1] as WorkflowSource, name: match[2] };
}

async function workflowById(id: string, opts: WorkflowScanOptions = {}): Promise<ScannedWorkflow | null> {
  const parsed = parseWorkflowId(id);
  if (!parsed) return null;
  const workflows = await scanClaudeWorkflows(opts);
  return workflows.find((wf) => wf.id === id) ?? null;
}

export function workflowToRouterTarget(wf: ScannedWorkflow): RouterWorkflowTarget {
  return {
    id: `workflow-${wf.source}-${slugFor(wf.name)}`,
    name: wf.name,
    label: `${wf.name} (${wf.sourceLabel})`,
    type: "workflow",
    workflow: wf.name,
    source: wf.source,
    recordId: wf.id,
    scriptPath: wf.absPath,
    description: `${wf.sourceLabel} workflow at ${wf.relPath}`,
    input: {
      name: wf.name,
      scriptPath: wf.absPath
    }
  };
}

export async function listWorkflowRouterTargets(opts: WorkflowScanOptions = {}): Promise<RouterWorkflowTarget[]> {
  const targets = new Map<string, RouterWorkflowTarget>();
  for (const wf of await scanClaudeWorkflows(opts)) {
    if (!targets.has(wf.name)) targets.set(wf.name, workflowToRouterTarget(wf));
  }
  return Array.from(targets.values());
}

export async function readWorkflowDetail(id: string, opts: WorkflowScanOptions = {}): Promise<WorkflowDetail> {
  const wf = await workflowById(id, opts);
  if (!wf) throw new Error(`no workflow found for "${id}"`);
  const script = await fs.readFile(wf.absPath, "utf8");
  return {
    ...wf,
    script,
    body: script,
    routerTarget: workflowToRouterTarget(wf)
  };
}

export async function deleteWorkflow(id: string, opts: WorkflowScanOptions = {}): Promise<WorkflowDeleteResult> {
  const parsed = parseWorkflowId(id);
  if (!parsed) return { ok: false, code: "invalid", error: `malformed workflow id: ${id}` };
  const wf = await workflowById(id, opts);
  if (!wf) return { ok: false, code: "not-found", error: `no workflow named "${parsed.name}" in ${parsed.source} scope` };
  await fs.rm(wf.absPath, { force: false });
  return { ok: true, id };
}
