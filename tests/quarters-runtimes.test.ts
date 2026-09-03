import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  declaredFiles,
  expandHome,
  readRuntimeFile,
  writeRuntimeFile,
  validateRuntimeFileContent,
  listRuntimeLogs,
  tailRuntimeLog,
  PROJECTION_MARKER,
  DEEP_QUARTERS_REGISTRY
} from "@/lib/quarters-runtimes";
import type { QuartersDescriptor } from "@/lib/types";

// S5 (GARRISON-RUNTIMES-V1): the generic Quarters tier serves ONLY the
// descriptor's DECLARED files, format-validates writes, respects projections,
// and confines log tails to declared roots. Boundary code → property tests.

function sandboxDescriptor(): { home: string; d: QuartersDescriptor } {
  const home = mkdtempSync(join(tmpdir(), "gar-qr-"));
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(join(home, "config.toml"), 'model = "gpt-5.6"\n[mcp_servers.demo]\ncommand = "demo"\n');
  writeFileSync(join(home, "AGENTS.md"), "# agents\n");
  writeFileSync(join(home, "logs", "run.log"), "line1\nline2\nline3\n");
  const d: QuartersDescriptor = {
    tier: "generic",
    id: "codex",
    home_dir: home,
    settings_files: [{ path: join(home, "config.toml"), format: "toml" }],
    context_file: join(home, "AGENTS.md"),
    mcp_config: { path: join(home, "config.toml"), format: "toml", key: "mcp_servers" },
    log_paths: [join(home, "logs")]
  };
  return { home, d };
}

describe("declared-file allowlist (S5)", () => {
  it("declaredFiles enumerates settings + context + mcp", () => {
    const { d } = sandboxDescriptor();
    const files = declaredFiles(d);
    expect(files.map((f) => f.kind).sort()).toEqual(["context", "mcp", "settings"]);
  });

  it("reads a declared file with sha; rejects an UNDECLARED path loudly", async () => {
    const { home, d } = sandboxDescriptor();
    const v = await readRuntimeFile(d, join(home, "config.toml"));
    expect(v.exists).toBe(true);
    expect(v.sha).toBeTruthy();
    expect(v.content).toContain("gpt-5.6");
    await expect(readRuntimeFile(d, join(home, "secret.txt"))).rejects.toThrow(/not declared by the codex quarters descriptor/);
    await expect(readRuntimeFile(d, "/etc/passwd")).rejects.toThrow(/not declared/);
  });

  it("PROPERTY: no undeclared path is ever readable through the file API", async () => {
    const { home, d } = sandboxDescriptor();
    const declared = new Set(declaredFiles(d).map((f) => f.path));
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 60 }), async (p) => {
        const candidate = p.startsWith("/") ? p : join(home, p);
        if (declared.has(candidate)) return true;
        try {
          await readRuntimeFile(d, candidate);
          return false; // must have thrown
        } catch (err) {
          return /not declared/.test(String(err));
        }
      }),
      { numRuns: 40 }
    );
  });
});

describe("writes: format validation + sha guard + projection respect (S5)", () => {
  it("rejects malformed toml/json loudly; accepts valid content with the right baseline", async () => {
    const { home, d } = sandboxDescriptor();
    const before = await readRuntimeFile(d, join(home, "config.toml"));
    await expect(writeRuntimeFile(d, join(home, "config.toml"), "model = [unclosed", before.sha)).rejects.toThrow(/toml invalid/);
    expect(validateRuntimeFileContent("json", "{oops")).toMatch(/json invalid/);
    const after = await writeRuntimeFile(d, join(home, "config.toml"), 'model = "opus"\n', before.sha);
    expect(after.content).toContain("opus");
  });

  it("refuses a stale baseline (file moved on disk)", async () => {
    const { home, d } = sandboxDescriptor();
    const before = await readRuntimeFile(d, join(home, "config.toml"));
    writeFileSync(join(home, "config.toml"), 'model = "changed-behind-your-back"\n');
    await expect(writeRuntimeFile(d, join(home, "config.toml"), 'model = "x"\n', before.sha)).rejects.toThrow(/changed on disk/);
  });

  it("refuses to clobber a Garrison-projected file (ownership-respected)", async () => {
    const { home, d } = sandboxDescriptor();
    writeFileSync(join(home, "AGENTS.md"), `<!-- ${PROJECTION_MARKER} source=orchestrator -->\n# projected\n`);
    const v = await readRuntimeFile(d, join(home, "AGENTS.md"));
    expect(v.projected).toBe(true);
    await expect(writeRuntimeFile(d, join(home, "AGENTS.md"), "# clobber\n", v.sha)).rejects.toThrow(/Garrison-managed projection/);
  });
});

describe("log tails: declared roots only, containment (S5)", () => {
  it("lists and tails a declared log; undeclared root and escaping rel are loud", async () => {
    const { home, d } = sandboxDescriptor();
    const logs = await listRuntimeLogs(d);
    expect(logs.some((l) => l.rel === "run.log")).toBe(true);
    const tail = await tailRuntimeLog(d, join(home, "logs"), "run.log");
    expect(tail.content).toContain("line3");
    await expect(tailRuntimeLog(d, "/var/log", "syslog")).rejects.toThrow(/not declared/);
    await expect(tailRuntimeLog(d, join(home, "logs"), "../config.toml")).rejects.toThrow(/escapes the declared root/);
  });

  it("PROPERTY: no rel path escapes the declared log root", async () => {
    const { home, d } = sandboxDescriptor();
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (rel) => {
        try {
          await tailRuntimeLog(d, join(home, "logs"), rel);
          return true; // read something inside the root — fine
        } catch (err) {
          const s = String(err);
          return /escapes the declared root|ENOENT|EISDIR|EACCES|ENOTDIR/.test(s);
        }
      }),
      { numRuns: 40 }
    );
  });
});

describe("registry + home expansion (S5)", () => {
  it("claude-code maps to the registered deep implementation", () => {
    expect(DEEP_QUARTERS_REGISTRY["claude-code"]).toEqual({ routeBase: "/quarters" });
  });
  it("expandHome expands ~ and leaves absolutes alone", () => {
    expect(expandHome("~/x")).toMatch(/^\/.*\/x$/);
    expect(expandHome("/abs/x")).toBe("/abs/x");
  });
});

// Ratchets for the S5 codex findings: root-itself tails refused; symlink
// escapes caught by realpath; API errors never enumerate the allowlist.
import { symlinkSync } from "node:fs";

describe("log containment hardening (S5 codex ratchet)", () => {
  it("refuses to tail the declared root itself ('' / '.')", async () => {
    const { home, d } = sandboxDescriptor();
    await expect(tailRuntimeLog(d, join(home, "logs"), ".")).rejects.toThrow(/escapes the declared root/);
    await expect(tailRuntimeLog(d, join(home, "logs"), "")).rejects.toThrow(/escapes the declared root/);
  });

  it("a symlink inside the log dir cannot walk outside the declared root", async () => {
    const { home, d } = sandboxDescriptor();
    writeFileSync(join(home, "outside-secret.txt"), "SECRET\n");
    symlinkSync(join(home, "outside-secret.txt"), join(home, "logs", "sneaky.log"));
    await expect(tailRuntimeLog(d, join(home, "logs"), "sneaky.log")).rejects.toThrow(/resolves outside the declared root .*\(symlink\)/);
  });

  it("undeclared-path errors carry a count, never the allowlist", async () => {
    const { home, d } = sandboxDescriptor();
    try {
      await readRuntimeFile(d, join(home, "nope.txt"));
      expect.unreachable();
    } catch (err) {
      const s = String(err);
      expect(s).toMatch(/not declared/);
      expect(s).not.toContain("config.toml"); // no enumeration
    }
  });
});

// S8 (P8/D7): the per-primary projection writes the engine's native context
// file with the SAME marker the generic Quarters tier refuses to clobber —
// one writer, ownership respected end to end.
import { projectPrimaryContext, PRIMARY_CONTEXT_FILES } from "@/lib/orchestrator-projection";

describe("per-primary orchestrator projection (S8)", () => {
  it("codex → AGENTS.md, gemini → GEMINI.md, marker + instructions + printed warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gar-proj-"));
    const res = await projectPrimaryContext({ engine: "codex", instructions: "ROUTE-MARKER [gateway-route: …]\nbe the orchestrator", targetDir: dir });
    expect(res.projected).toBe(true);
    expect(res.file).toBe(join(dir, "AGENTS.md"));
    expect(res.warning).toMatch(/PROMPT AUTHORITY WARNING/);
    const { readFileSync } = await import("node:fs");
    const written = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(written).toContain(PROJECTION_MARKER);
    expect(written).toContain("ROUTE-MARKER");
    const g = await projectPrimaryContext({ engine: "gemini", instructions: "x", targetDir: dir });
    expect(g.file).toBe(join(dir, "GEMINI.md"));
    expect(PRIMARY_CONTEXT_FILES["codex"]).toBe("AGENTS.md");
  });

  it("claude-code and agent-sdk do NOT project (their prompt paths are stronger)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gar-proj-"));
    expect((await projectPrimaryContext({ engine: "claude-code", instructions: "x", targetDir: dir })).projected).toBe(false);
    expect((await projectPrimaryContext({ engine: "agent-sdk", instructions: "x", targetDir: dir })).projected).toBe(false);
  });

  it("the projected file is REFUSED by the generic-tier raw editor (one writer)", async () => {
    const { home, d } = sandboxDescriptor();
    // The sandbox pre-writes a hand-authored AGENTS.md; the projection guard
    // (S8 ratchet) rightly refuses those — clear it so THIS test exercises a
    // clean projection then the editor-refusal path.
    const { rmSync } = await import("node:fs");
    rmSync(join(home, "AGENTS.md"));
    await projectPrimaryContext({ engine: "codex", instructions: "orchestrator text", targetDir: home });
    const v = await readRuntimeFile(d, join(home, "AGENTS.md"));
    expect(v.projected).toBe(true);
    await expect(writeRuntimeFile(d, join(home, "AGENTS.md"), "clobber", v.sha)).rejects.toThrow(/Garrison-managed projection/);
  });
});

// Ratchet for the S8 codex finding: a hand-authored context file is NEVER
// silently clobbered by the projection — refusal is loud and names the fix.
describe("projection never clobbers hand-authored files (S8 ratchet)", () => {
  it("refuses when AGENTS.md exists without the marker; overwrites its own prior projection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gar-proj-own-"));
    writeFileSync(join(dir, "AGENTS.md"), "# my hand-written agents file\n");
    const refused = await projectPrimaryContext({ engine: "codex", instructions: "orch", targetDir: dir });
    expect(refused.projected).toBe(false);
    expect(refused.warning).toMatch(/PROJECTION REFUSED.*hand-authored/s);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("hand-written"); // untouched
    // Our own projection IS overwritten on reprojection (stale prompt never survives).
    const dir2 = mkdtempSync(join(tmpdir(), "gar-proj-own-"));
    await projectPrimaryContext({ engine: "codex", instructions: "v1", targetDir: dir2 });
    const again = await projectPrimaryContext({ engine: "codex", instructions: "v2", targetDir: dir2 });
    expect(again.projected).toBe(true);
    expect(readFileSync(join(dir2, "AGENTS.md"), "utf8")).toContain("v2");
  });
});

// G5: directory-of-files "file sets" (Cursor's rules/skills/agents/hooks/
// desktop settings/project rules) - list/read/write/create/delete confined to
// the declared root + glob, the same containment discipline as the log tail
// above, plus glob matching, merge-write semantics, and platform gating.
import { homedir } from "node:os";
import {
  listFileSet,
  readFileSetEntry,
  writeFileSetEntry,
  createFileSetEntry,
  deleteFileSetEntry,
  matchRestrictedGlob,
  parseFrontmatter,
  knownProjectRoots,
  runtimeHome
} from "@/lib/quarters-runtimes";

function sandboxFileSetDescriptor(): { home: string; d: QuartersDescriptor } {
  const home = mkdtempSync(join(tmpdir(), "gar-qfs-"));
  mkdirSync(join(home, "rules"), { recursive: true });
  mkdirSync(join(home, "skills", "my-skill"), { recursive: true });
  writeFileSync(join(home, "rules", "always.mdc"), "---\ndescription: Always\nalwaysApply: true\n---\nBody text\n");
  writeFileSync(join(home, "rules", "not-a-rule.txt"), "should never be listed\n");
  writeFileSync(join(home, "skills", "my-skill", "SKILL.md"), "# my-skill\n");
  writeFileSync(join(home, "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "existing-hook" }] } }, null, 2) + "\n");
  const d: QuartersDescriptor = {
    tier: "generic",
    id: "cursor",
    home_dir: home,
    file_sets: [
      { id: "rules", label: "Rules", root: join(home, "rules"), glob: "*.mdc", format: "markdown", frontmatter: ["description", "alwaysApply"], create: true },
      { id: "skills", label: "Skills", root: join(home, "skills"), glob: "*/SKILL.md", format: "markdown", create: true },
      { id: "hooks", label: "Hooks", root: home, glob: "hooks.json", format: "json", write: "merge" },
      { id: "desktop", label: "Desktop", root: join(home, "desktop"), glob: "settings.json", format: "json", platform: "win32" }
    ]
  };
  return { home, d };
}

describe("matchRestrictedGlob: segment-by-segment, count must match too", () => {
  it.each([
    ["*.mdc", "always.mdc", true],
    ["*.mdc", "sub/always.mdc", false],
    ["*/SKILL.md", "my-skill/SKILL.md", true],
    ["*/SKILL.md", "SKILL.md", false],
    ["{settings,keybindings}.json", "settings.json", true],
    ["{settings,keybindings}.json", "other.json", false],
    ["hooks.json", "hooks.json", true],
    ["hooks.json", "hooks.json.bak", false]
  ])("glob %s vs rel %s -> %s", (glob, rel, expected) => {
    expect(matchRestrictedGlob(glob, rel)).toBe(expected);
  });
});

describe("parseFrontmatter", () => {
  it("splits a leading --- block from the body, non-throwing on malformed YAML", () => {
    const { frontmatter, body } = parseFrontmatter("---\ndescription: hi\nalwaysApply: true\n---\nBody\n");
    expect(frontmatter).toEqual({ description: "hi", alwaysApply: true });
    expect(body).toBe("Body\n");
    const noFm = parseFrontmatter("just a body\n");
    expect(noFm.frontmatter).toBeNull();
    const bad = parseFrontmatter("---\n: not: valid: yaml: [\n---\nBody\n");
    expect(bad.frontmatter).toBeNull();
    expect(bad.body).toContain("not: valid");
  });
});

describe("file sets: list + read (G5)", () => {
  it("lists only glob-matching files, ignoring siblings that do not match", async () => {
    const { d } = sandboxFileSetDescriptor();
    const rows = await listFileSet(d, "rules");
    expect(rows.map((r) => r.rel)).toEqual(["always.mdc"]);
  });

  it("lists a two-segment glob (dir wildcard + literal file)", async () => {
    const { d } = sandboxFileSetDescriptor();
    const rows = await listFileSet(d, "skills");
    expect(rows.map((r) => r.rel)).toEqual(["my-skill/SKILL.md"]);
  });

  it("returns an empty list for a root that does not exist yet (not an error)", async () => {
    const { d } = sandboxFileSetDescriptor();
    expect(await listFileSet(d, "desktop")).toEqual([]);
  });

  it("reads a markdown entry with parsed frontmatter", async () => {
    const { d } = sandboxFileSetDescriptor();
    const v = await readFileSetEntry(d, "rules", "always.mdc");
    expect(v.exists).toBe(true);
    expect(v.frontmatter).toEqual({ description: "Always", alwaysApply: true });
    expect(v.content).toContain("Body text");
  });

  it("refuses a rel that does not match the declared glob", async () => {
    const { d } = sandboxFileSetDescriptor();
    await expect(readFileSetEntry(d, "rules", "not-a-rule.txt")).rejects.toThrow(/does not match the rules file set's glob/);
  });

  it("refuses an unknown file set id", async () => {
    const { d } = sandboxFileSetDescriptor();
    await expect(listFileSet(d, "nope")).rejects.toThrow(/not declared by the cursor quarters descriptor/);
  });

  it("PROPERTY: no rel path escapes the file set's root", async () => {
    const { d } = sandboxFileSetDescriptor();
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 40 }), async (rel) => {
        try {
          await readFileSetEntry(d, "rules", rel);
          return true; // resolved inside the root - fine
        } catch (err) {
          const s = String(err);
          return /escapes the .* file set's root|does not match the .* file set's glob|is not a relative path/.test(s);
        }
      }),
      { numRuns: 40 }
    );
  });
});

describe("file sets: write (sha guard + projection + merge) (G5)", () => {
  it("refuses to write a file that does not exist yet", async () => {
    const { d } = sandboxFileSetDescriptor();
    await expect(writeFileSetEntry(d, "rules", "brand-new.mdc", "x", null)).rejects.toThrow(/does not exist in the rules file set/);
  });

  it("sha-guards a write against a stale baseline", async () => {
    const { home, d } = sandboxFileSetDescriptor();
    const before = await readFileSetEntry(d, "rules", "always.mdc");
    writeFileSync(join(home, "rules", "always.mdc"), "changed behind your back\n");
    await expect(writeFileSetEntry(d, "rules", "always.mdc", "new content\n", before.sha)).rejects.toThrow(/changed on disk/);
  });

  it("refuses to clobber a Garrison-projected entry", async () => {
    const { home, d } = sandboxFileSetDescriptor();
    writeFileSync(join(home, "rules", "always.mdc"), `<!-- ${PROJECTION_MARKER} -->\nprojected\n`);
    const v = await readFileSetEntry(d, "rules", "always.mdc");
    expect(v.projected).toBe(true);
    await expect(writeFileSetEntry(d, "rules", "always.mdc", "clobber", v.sha)).rejects.toThrow(/Garrison-managed projection/);
  });

  it("write:'merge' on a json set unions arrays and never removes an existing key", async () => {
    const { d } = sandboxFileSetDescriptor();
    const before = await readFileSetEntry(d, "hooks", "hooks.json");
    const incoming = JSON.stringify({ version: 1, hooks: { stop: [{ command: "our-new-hook" }], start: [{ command: "start-hook" }] } });
    const after = await writeFileSetEntry(d, "hooks", "hooks.json", incoming, before.sha);
    const parsed = JSON.parse(after.content);
    expect(parsed.hooks.stop).toEqual(expect.arrayContaining([{ command: "existing-hook" }, { command: "our-new-hook" }]));
    expect(parsed.hooks.start).toEqual([{ command: "start-hook" }]);
  });

  it("rejects malformed json before touching the file", async () => {
    const { d } = sandboxFileSetDescriptor();
    const before = await readFileSetEntry(d, "hooks", "hooks.json");
    await expect(writeFileSetEntry(d, "hooks", "hooks.json", "{not json", before.sha)).rejects.toThrow(/json invalid/);
  });
});

describe("file sets: create + delete gated by 'create' (G5)", () => {
  it("creates a new markdown file when create:true, refuses a duplicate", async () => {
    const { d } = sandboxFileSetDescriptor();
    const created = await createFileSetEntry(d, "rules", "fresh.mdc", "---\ndescription: fresh\n---\nnew\n");
    expect(created.exists).toBe(true);
    await expect(createFileSetEntry(d, "rules", "fresh.mdc", "again")).rejects.toThrow(/already exists/);
  });

  it("refuses to create on a set with no create:true", async () => {
    const { d } = sandboxFileSetDescriptor();
    await expect(createFileSetEntry(d, "hooks", "extra.json", "{}")).rejects.toThrow(/does not allow creating/);
  });

  it("deletes an existing file on a create:true set; refuses on a set without it", async () => {
    const { d } = sandboxFileSetDescriptor();
    await createFileSetEntry(d, "rules", "to-delete.mdc", "temp\n");
    await deleteFileSetEntry(d, "rules", "to-delete.mdc");
    await expect(readFileSetEntry(d, "rules", "to-delete.mdc")).resolves.toMatchObject({ exists: false });
    await expect(deleteFileSetEntry(d, "hooks", "hooks.json")).rejects.toThrow(/does not allow deleting/);
  });

  it("refuses to delete a Garrison-projected file", async () => {
    const { home, d } = sandboxFileSetDescriptor();
    await createFileSetEntry(d, "rules", "proj.mdc", `<!-- ${PROJECTION_MARKER} -->\nx\n`);
    await expect(deleteFileSetEntry(d, "rules", "proj.mdc")).rejects.toThrow(/Garrison-managed projection/);
  });
});

describe("file sets: platform gating (G5)", () => {
  it("a file set declared for another platform lists empty and is skipped by writes", async () => {
    const { d } = sandboxFileSetDescriptor();
    // sandboxFileSetDescriptor's "desktop" set is pinned to win32; this
    // process is never win32 in CI/dev, so it must read as unavailable.
    expect(process.platform).not.toBe("win32");
    expect(await listFileSet(d, "desktop")).toEqual([]);
  });
});

describe("project-scoped file sets + knownProjectRoots (G5)", () => {
  it("refuses a project-scoped file set operation against an unknown project root", async () => {
    const d: QuartersDescriptor = {
      tier: "generic",
      id: "cursor",
      home_dir: "/nonexistent",
      file_sets: [{ id: "project-rules", label: "Project rules", root: ".cursor/rules", glob: "*.mdc", format: "markdown", scope: "project" }]
    };
    await expect(listFileSet(d, "project-rules", "/definitely/not/a/known/project/root")).rejects.toThrow(/is not a known project root/);
  });

  it("refuses a project-scoped operation with no project root given at all", async () => {
    const d: QuartersDescriptor = {
      tier: "generic",
      id: "cursor",
      home_dir: "/nonexistent",
      file_sets: [{ id: "project-rules", label: "Project rules", root: ".cursor/rules", glob: "*.mdc", format: "markdown", scope: "project" }]
    };
    await expect(listFileSet(d, "project-rules")).rejects.toThrow(/is project-scoped/);
  });

  it("knownProjectRoots reads the real default composition's projects_root read-only (no mutation)", async () => {
    // Read-only against the SHIPPED default composition, mirroring how
    // tests/duty-ladder-schema.test.ts already reads it directly - this never
    // writes, so it cannot leave anything behind on the machine.
    const roots = await knownProjectRoots("default");
    expect(Array.isArray(roots)).toBe(true);
  });
});

describe("runtimeHome: the GARRISON_<ID>_HOME test-isolation override (G5)", () => {
  it("uses the override when set, falls back to the real machine home otherwise", () => {
    expect(runtimeHome("cursor", { GARRISON_CURSOR_HOME: "/sandbox/home" } as unknown as NodeJS.ProcessEnv)).toBe("/sandbox/home");
    expect(runtimeHome("cursor", {} as unknown as NodeJS.ProcessEnv)).toBe(homedir());
  });
});
