import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runImport, parseFrontmatter } from "../scripts/import-claude-install";
import { readInstallLock } from "@/lib/claude-install";

let claudeHome: string;
let outDir: string;
let lockPath: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gar-import-"));
  claudeHome = path.join(base, "claude");
  outDir = path.join(base, "seed");
  lockPath = path.join(base, "lock.json");
  // two real skills + one plugin-only dir (no SKILL.md)
  mkSkill("foo", "---\nname: foo\ndescription: A foo skill that foos.\n---\n# Foo");
  mkSkill("bar", "---\nname: bar\ndescription: A bar skill.\n---\n# Bar");
  fs.mkdirSync(path.join(claudeHome, "skills", "plug"), { recursive: true }); // no SKILL.md
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.writeFileSync(
    path.join(claudeHome, "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "user" }] }] } })
  );
  fs.mkdirSync(outDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(path.dirname(claudeHome), { recursive: true, force: true });
});

function mkSkill(name: string, body: string): void {
  const dir = path.join(claudeHome, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}

describe("import-claude-install", () => {
  it("parses frontmatter", () => {
    expect(parseFrontmatter("---\nname: x\ndescription: y\n---\nbody").name).toBe("x");
    expect(parseFrontmatter("no frontmatter")).toEqual({});
  });

  it("emits a valid skill fitting per skill and skips existing seeds", async () => {
    fs.mkdirSync(path.join(outDir, "bar"), { recursive: true }); // pre-existing seed
    const report = await runImport({ claudeHome, outDir, write: true, adopt: false, prefix: "" });

    expect(report.created).toContain("foo");
    expect(report.skipped).toContain("bar"); // not mutated
    expect(report.untaggedHookGroups).toBe(1);

    // emitted layout
    expect(fs.existsSync(path.join(outDir, "foo", "apm.yml"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "foo", ".apm", "skills", "foo", "SKILL.md"))).toBe(true);
    // pre-existing bar seed left empty (untouched)
    expect(fs.readdirSync(path.join(outDir, "bar"))).toHaveLength(0);

    // emitted apm.yml is schema-shaped
    const m = yaml.load(fs.readFileSync(path.join(outDir, "foo", "apm.yml"), "utf8")) as Record<string, unknown>;
    expect(m.type).toBe("skill");
    const xg = m["x-garrison"] as Record<string, unknown>;
    expect(xg.faculty).toBe("skills");
    expect(xg.component_shape).toBe("skill");
    expect(xg.provides).toEqual([{ kind: "agent-skill", name: "foo" }]);
  });

  it("--adopt records emitted skills in the install lock at current bytes", async () => {
    await runImport({ claudeHome, outDir, write: true, adopt: true, prefix: "", lockPath });
    const lock = await readInstallLock({ lockPath });
    expect(lock.installs.foo).toBeDefined();
    expect(lock.installs.foo.adopted).toBe(true);
    expect(lock.installs.foo.artifacts[0].target).toBe("skills/foo");
    // on-disk skill not modified by adopt
    expect(fs.readFileSync(path.join(claudeHome, "skills", "foo", "SKILL.md"), "utf8")).toContain("# Foo");
  });

  it("dry-run reports would-create without writing", async () => {
    const report = await runImport({ claudeHome, outDir, write: false, adopt: false, prefix: "" });
    // two skills + one hook fitting for the untagged Stop group (S5 follow-up)
    expect(report.created.sort()).toEqual(["bar", "foo", "imported-hook-stop"]);
    expect(fs.existsSync(path.join(outDir, "foo"))).toBe(false); // nothing written
    expect(fs.existsSync(path.join(outDir, "imported-hook-stop"))).toBe(false); // nothing written
  });
});
