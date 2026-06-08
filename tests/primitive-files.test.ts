import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFilePrimitive,
  updateFilePrimitive,
  deleteFilePrimitive,
  readFilePrimitive
} from "@/lib/primitive-files";
import { runQuartersAction, type CrudResult } from "@/lib/quarters";

let garrisonRoot: string;
let claudeRoot: string;
let priorHome: string | undefined;
let priorClaude: string | undefined;

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(claudeRoot, rel));
}

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  priorClaude = process.env.GARRISON_CLAUDE_HOME;
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-pf-home-"));
  claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-pf-claude-"));
  process.env.GARRISON_HOME = garrisonRoot;
  process.env.GARRISON_CLAUDE_HOME = claudeRoot;
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  if (priorClaude === undefined) delete process.env.GARRISON_CLAUDE_HOME;
  else process.env.GARRISON_CLAUDE_HOME = priorClaude;
  fs.rmSync(garrisonRoot, { recursive: true, force: true });
  fs.rmSync(claudeRoot, { recursive: true, force: true });
});

describe("primitive-files CRUD", () => {
  it("creates a skill SKILL.md, refuses to clobber, edits, and deletes", async () => {
    const created = await createFilePrimitive("skill", "demo", "---\nname: demo\n---\n# demo\n");
    expect(created.ok).toBe(true);
    expect(exists("skills/demo/SKILL.md")).toBe(true);

    const clobber = await createFilePrimitive("skill", "demo", "x");
    expect(clobber.ok).toBe(false);
    expect(clobber.code).toBe("exists");

    const updated = await updateFilePrimitive("skill", "demo", "# edited\n");
    expect(updated.ok).toBe(true);
    expect((await readFilePrimitive("skill", "demo")).content).toBe("# edited\n");

    const removed = await deleteFilePrimitive("skill", "demo");
    expect(removed.ok).toBe(true);
    expect(exists("skills/demo")).toBe(false);
  });

  it("creates command + rule .md files at the right paths", async () => {
    await createFilePrimitive("command", "greet", "say hi");
    await createFilePrimitive("rule", "style", "be terse");
    expect(exists("commands/greet.md")).toBe(true);
    expect(exists("rules/style.md")).toBe(true);
  });

  it("rejects unsafe names (no traversal/slashes)", async () => {
    expect((await createFilePrimitive("skill", "../escape", "x")).code).toBe("invalid");
    expect((await createFilePrimitive("command", "a/b", "x")).code).toBe("invalid");
    expect((await updateFilePrimitive("skill", "missing", "x")).code).toBe("not-found");
  });

  it("appends a trailing newline when the content lacks one", async () => {
    await createFilePrimitive("rule", "nl", "no newline");
    expect((await readFilePrimitive("rule", "nl")).content).toBe("no newline\n");
  });
});

describe("file CRUD dispatch + owned-delete guard", () => {
  it("round-trips create → update → delete through runQuartersAction", async () => {
    const c = (await runQuartersAction({ action: "file.create", surface: "skill", name: "viaapi", content: "x" })) as CrudResult;
    expect(c.ok).toBe(true);
    expect(c.id).toBe("skill:viaapi");
    const u = (await runQuartersAction({ action: "file.update", surface: "skill", name: "viaapi", content: "y\n" })) as CrudResult;
    expect(u.ok).toBe(true);
    const d = (await runQuartersAction({ action: "file.delete", surface: "skill", name: "viaapi" })) as CrudResult;
    expect(d.ok).toBe(true);
    expect(exists("skills/viaapi")).toBe(false);
  });

  it("REFUSES to delete an APM-owned skill (route to Park), leaving the file intact", async () => {
    // Put a skill on disk AND record it as owned in the global lock.
    write(path.join(claudeRoot, "skills", "owned-skill", "SKILL.md"), "---\nname: owned-skill\n---\n# owned\n");
    write(
      path.join(garrisonRoot, "global-composition", "apm.lock.yaml"),
      [
        "dependencies:",
        "- repo_url: _local/owned-skill",
        "  package_type: apm_package",
        "  deployed_files:",
        "  - .claude/skills/owned-skill"
      ].join("\n") + "\n"
    );

    const res = (await runQuartersAction({ action: "file.delete", surface: "skill", name: "owned-skill" })) as CrudResult;
    expect(res.ok).toBe(false);
    expect(res.code).toBe("owned");
    // file still there — we did NOT delete behind the lock
    expect(exists("skills/owned-skill/SKILL.md")).toBe(true);
  });
});
