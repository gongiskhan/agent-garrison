import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG = "@garrison/claude-pty";

function mkproj() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cwd-"));
  fs.mkdirSync(path.join(home, ".claude", "commands"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills", "summarize"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".claude", "commands"), { recursive: true });
  return { home, cwd };
}

describe("claude-pty: command enumeration", () => {
  it("includes curated built-ins with descriptions", async () => {
    const { enumerateCommands } = await import(PKG);
    const cmds = enumerateCommands({ home: fs.mkdtempSync(path.join(os.tmpdir(), "cc-empty-")) });
    const ctx = cmds.find((c: any) => c.name === "context");
    expect(ctx).toBeTruthy();
    expect(ctx.source).toBe("builtin");
    expect(ctx.description.length).toBeGreaterThan(0);
  });

  it("reads user commands with frontmatter description, project commands shadow user", async () => {
    const { enumerateCommands } = await import(PKG);
    const { home, cwd } = mkproj();
    fs.writeFileSync(
      path.join(home, ".claude", "commands", "deploy.md"),
      "---\ndescription: Deploy to staging\nargument-hint: <env>\n---\nDeploy steps...\n"
    );
    fs.writeFileSync(path.join(home, ".claude", "commands", "deploy.md").replace("home", "home"), fs.readFileSync(path.join(home, ".claude", "commands", "deploy.md")));
    fs.writeFileSync(
      path.join(cwd, ".claude", "commands", "deploy.md"),
      "---\ndescription: Project deploy (prod)\n---\n"
    );
    const cmds = enumerateCommands({ home, cwd });
    const deploy = cmds.find((c: any) => c.name === "deploy");
    expect(deploy.description).toBe("Project deploy (prod)"); // project shadows user
    expect(deploy.source).toBe("project");
  });

  it("falls back to the first body line when no description frontmatter", async () => {
    const { enumerateCommands } = await import(PKG);
    const { home } = mkproj();
    fs.writeFileSync(path.join(home, ".claude", "commands", "note.md"), "# Title\nJust jot a note\n");
    const cmds = enumerateCommands({ home });
    const note = cmds.find((c: any) => c.name === "note");
    expect(note.description).toBe("Title");
  });

  it("surfaces skills as slash entries", async () => {
    const { enumerateCommands } = await import(PKG);
    const { home } = mkproj();
    fs.writeFileSync(
      path.join(home, ".claude", "skills", "summarize", "SKILL.md"),
      "---\nname: summarize\ndescription: Summarise a document\n---\n"
    );
    const cmds = enumerateCommands({ home });
    const sk = cmds.find((c: any) => c.name === "summarize");
    expect(sk).toBeTruthy();
    expect(sk.source).toBe("skill");
    expect(sk.description).toBe("Summarise a document");
  });

  it("namespaces nested command dirs with ns:name", async () => {
    const { enumerateCommands } = await import(PKG);
    const { home } = mkproj();
    fs.mkdirSync(path.join(home, ".claude", "commands", "git"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "commands", "git", "sync.md"), "Sync the repo\n");
    const cmds = enumerateCommands({ home });
    expect(cmds.find((c: any) => c.name === "git:sync")).toBeTruthy();
  });
});

describe("claude-pty: rich-stream helpers", () => {
  it("keySequence maps allowlisted keys and rejects others", async () => {
    const { keySequence } = await import(PKG);
    expect(keySequence("shift-tab")).toBe("\x1b[Z");
    expect(keySequence("escape")).toBe("\x1b");
    expect(keySequence("enter")).toBe("\r");
    expect(keySequence("rm-rf")).toBe(null);
  });
});
