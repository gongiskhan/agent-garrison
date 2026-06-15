import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWorkflows, readWorkflowScript, workflowTargets } from "@/lib/workflows-scan";

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "gar-wf-"));
}

describe("workflows scan (MR4 — quarters-workflows-ok)", () => {
  it("empty-state: no workflows dirs → empty list (graceful)", () => {
    const userHome = tmpHome();
    const projectRoot = tmpHome();
    expect(scanWorkflows({ userHome, projectRoot })).toEqual([]);
  });

  it("lists a fixture workflow + renders its script", () => {
    const userHome = tmpHome();
    mkdirSync(join(userHome, "workflows"), { recursive: true });
    writeFileSync(join(userHome, "workflows", "nightly-review.mjs"), "export const meta = { name: 'nightly-review' }\n", "utf8");
    writeFileSync(join(userHome, "workflows", "notes.txt"), "ignored", "utf8"); // non-script ignored

    const entries = scanWorkflows({ userHome, projectRoot: tmpHome() });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("nightly-review");
    expect(entries[0].scope).toBe("user");
    expect(readWorkflowScript(entries[0])).toContain("meta = { name: 'nightly-review' }");
  });

  it("project workflows shadow user workflows of the same name", () => {
    const userHome = tmpHome();
    const projectRoot = tmpHome();
    mkdirSync(join(userHome, "workflows"), { recursive: true });
    mkdirSync(join(projectRoot, "workflows"), { recursive: true });
    writeFileSync(join(userHome, "workflows", "build.mjs"), "// user", "utf8");
    writeFileSync(join(projectRoot, "workflows", "build.mjs"), "// project", "utf8");
    const entries = scanWorkflows({ userHome, projectRoot });
    expect(entries).toHaveLength(1);
    expect(entries[0].scope).toBe("project"); // project wins
  });
});

describe("workflow router targets (MR4 — workflow-target-ok)", () => {
  it("scanned workflows map to router `workflow` targets", () => {
    const userHome = tmpHome();
    mkdirSync(join(userHome, "workflows"), { recursive: true });
    writeFileSync(join(userHome, "workflows", "deploy.mjs"), "// deploy", "utf8");
    const targets = workflowTargets(scanWorkflows({ userHome, projectRoot: tmpHome() }));
    expect(targets).toEqual([{ id: "workflow:deploy", type: "workflow", workflow: "deploy", scope: "user" }]);
  });

  it("empty scan → no targets (empty dropdown, no crash)", () => {
    expect(workflowTargets([])).toEqual([]);
  });
});
