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
