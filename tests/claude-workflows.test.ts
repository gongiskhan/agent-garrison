import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteWorkflow,
  listWorkflowRouterTargets,
  readWorkflowDetail,
  scanClaudeWorkflows
} from "@/lib/claude-workflows";

let projectRoot: string;
let claudeRoot: string;

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-wf-project-"));
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-wf-claude-"));
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe("Claude workflow scanning", () => {
  it("scans project and user workflow roots, ignoring non-script files", async () => {
    write(
      path.join(projectRoot, ".claude", "workflows", "review.js"),
      "export const meta = { name: 'review', description: 'project review', phases: [] };\n"
    );
    write(
      path.join(claudeRoot, "workflows", "review.js"),
      "export const meta = { name: 'review', description: 'user review', phases: [] };\n"
    );
    write(path.join(claudeRoot, "workflows", "research.mjs"), "export const meta = { name: 'research', phases: [] };\n");
    write(path.join(claudeRoot, "workflows", "notes.md"), "# not a workflow\n");

    const workflows = await scanClaudeWorkflows({ projectRoot, claudeHome: claudeRoot });
    expect(workflows.map((wf) => wf.id)).toEqual([
      "workflow:project:review",
      "workflow:user:research",
      "workflow:user:review"
    ]);
    expect(workflows.find((wf) => wf.id === "workflow:project:review")?.relPath).toBe(
      ".claude/workflows/review.js"
    );
  });

  it("exports router targets with project workflows winning duplicate command names", async () => {
    write(path.join(projectRoot, ".claude", "workflows", "review.js"), "export const meta = { name: 'review', phases: [] };\n");
    write(path.join(claudeRoot, "workflows", "review.js"), "export const meta = { name: 'review', phases: [] };\n");
    write(path.join(claudeRoot, "workflows", "research.ts"), "export const meta = { name: 'research', phases: [] };\n");

    const targets = await listWorkflowRouterTargets({ projectRoot, claudeHome: claudeRoot });
    expect(targets.map((target) => `${target.name}:${target.source}`)).toEqual(["review:project", "research:user"]);
    expect(targets[0]).toMatchObject({
      id: "workflow-project-review",
      type: "workflow",
      workflow: "review",
      recordId: "workflow:project:review"
    });
    expect(targets[0].input).toMatchObject({
      name: "review",
      scriptPath: path.join(projectRoot, ".claude", "workflows", "review.js")
    });
  });

  it("reads detail script/body and deletes only the addressed workflow file", async () => {
    const projectScript = "export const meta = { name: 'review', phases: [] };\nawait phase('project', async () => {});\n";
    const userScript = "export const meta = { name: 'review', phases: [] };\nawait phase('user', async () => {});\n";
    write(path.join(projectRoot, ".claude", "workflows", "review.js"), projectScript);
    write(path.join(claudeRoot, "workflows", "review.js"), userScript);

    const detail = await readWorkflowDetail("workflow:project:review", { projectRoot, claudeHome: claudeRoot });
    expect(detail.script).toBe(projectScript);
    expect(detail.body).toBe(projectScript);
    expect(detail.routerTarget.input.scriptPath).toBe(path.join(projectRoot, ".claude", "workflows", "review.js"));

    const removed = await deleteWorkflow("workflow:user:review", { projectRoot, claudeHome: claudeRoot });
    expect(removed).toEqual({ ok: true, id: "workflow:user:review" });
    expect(fs.existsSync(path.join(projectRoot, ".claude", "workflows", "review.js"))).toBe(true);
    expect(fs.existsSync(path.join(claudeRoot, "workflows", "review.js"))).toBe(false);
  });

  it("returns an empty list when both workflow roots are absent", async () => {
    await expect(scanClaudeWorkflows({ projectRoot, claudeHome: claudeRoot })).resolves.toEqual([]);
    await expect(listWorkflowRouterTargets({ projectRoot, claudeHome: claudeRoot })).resolves.toEqual([]);
  });
});
