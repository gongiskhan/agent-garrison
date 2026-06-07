import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readClaudeMd, writeClaudeMd, claudeMdPath, type ClaudeMdOpts } from "@/lib/claude-md";

let claudeHome: string;
let projectDir: string;
let opts: ClaudeMdOpts;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "gar-claudemd-"));
  claudeHome = path.join(base, "claude");
  projectDir = path.join(base, "proj");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  opts = { claudeHome, projectDir };
});
afterEach(() => {
  fs.rmSync(path.dirname(claudeHome), { recursive: true, force: true });
});

describe("claude-md editor (keep-both)", () => {
  it("reports a missing file and round-trips a write", async () => {
    const before = await readClaudeMd("user", opts);
    expect(before.exists).toBe(false);
    const w = await writeClaudeMd("user", "# Guidance\n", opts);
    expect(w.ok).toBe(true);
    const after = await readClaudeMd("user", opts);
    expect(after.exists).toBe(true);
    expect(after.content).toBe("# Guidance\n");
  });

  it("resolves user vs project scope to different files", async () => {
    expect(claudeMdPath("user", opts)).toBe(path.join(claudeHome, "CLAUDE.md"));
    expect(claudeMdPath("project", opts)).toBe(path.join(projectDir, "CLAUDE.md"));
    await writeClaudeMd("user", "USER", opts);
    await writeClaudeMd("project", "PROJECT", opts);
    expect((await readClaudeMd("user", opts)).content).toBe("USER");
    expect((await readClaudeMd("project", opts)).content).toBe("PROJECT");
  });

  it("REFUSES to overwrite when the file changed since last read (never-clobber)", async () => {
    await writeClaudeMd("user", "v1", opts);
    const opened = await readClaudeMd("user", opts); // client holds opened.sha
    // someone edits the file externally
    fs.writeFileSync(claudeMdPath("user", opts), "EXTERNAL EDIT");
    const w = await writeClaudeMd("user", "my edit", { ...opts, baselineSha: opened.sha });
    expect(w.ok).toBe(false);
    expect(w).toMatchObject({ code: "conflict" });
    // external content preserved — NOT clobbered
    expect((await readClaudeMd("user", opts)).content).toBe("EXTERNAL EDIT");
  });

  it("writes when baseline matches current", async () => {
    await writeClaudeMd("user", "v1", opts);
    const opened = await readClaudeMd("user", opts);
    const w = await writeClaudeMd("user", "v2", { ...opts, baselineSha: opened.sha });
    expect(w.ok).toBe(true);
    expect((await readClaudeMd("user", opts)).content).toBe("v2");
  });
});
