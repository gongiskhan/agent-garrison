import path from "node:path";
import { describe, expect, it } from "vitest";

// DS2 resume-by-id gate. claudeCommand() must emit `--resume <id>` for an exact
// session (reboot restore / disambiguating multiple sessions in one cwd) and
// fall back to `--continue` only when no id is known. Imported via a runtime
// path so TS treats the untyped .mjs as `any` (the repo's orchestrator-prefix
// pattern) — no .d.mts needed for ptys.mjs's large API.
const PTYS = path.join(__dirname, "..", "fittings", "seed", "dev-env", "scripts", "ptys.mjs");

describe("claudeCommand — resume-by-id", () => {
  it("emits --resume <id> when resumeId is given (exact-session resume, no shell quoting needed)", async () => {
    const { claudeCommand } = await import(PTYS);
    const cmd = claudeCommand({ resumeId: "abc12345-def0-1234-5678-90abcdef0000" });
    expect(cmd).toContain("--resume abc12345-def0-1234-5678-90abcdef0000");
    expect(cmd).not.toContain("--continue");
  });

  it("emits --continue when resume:true and no id (most-recent-in-cwd fallback)", async () => {
    const { claudeCommand } = await import(PTYS);
    const cmd = claudeCommand({ resume: true });
    expect(cmd).toContain("--continue");
    expect(cmd).not.toContain("--resume");
  });

  it("emits neither --resume nor --continue for a fresh session", async () => {
    const { claudeCommand } = await import(PTYS);
    const cmd = claudeCommand({});
    expect(cmd).not.toContain("--continue");
    expect(cmd).not.toContain("--resume");
    expect(cmd).toContain("--permission-mode auto");
  });

  it("resumeId takes precedence over resume", async () => {
    const { claudeCommand } = await import(PTYS);
    const cmd = claudeCommand({ resume: true, resumeId: "fa70e48f-0040-40e1-986a-b7a925d0db76" });
    expect(cmd).toContain("--resume fa70e48f-0040-40e1-986a-b7a925d0db76");
    expect(cmd).not.toContain("--continue");
  });

  it("ignores a shell-injection resumeId (not the UUID charset) — never emits it, falls back safely", async () => {
    const { claudeCommand } = await import(PTYS);
    for (const evil of ["$(rm -rf ~)", "`reboot`", "a; cat /etc/passwd", "x y", '"q"', "id|sh", "../../etc"]) {
      const cmd = claudeCommand({ resumeId: evil });
      expect(cmd).not.toContain("--resume");
      expect(cmd).not.toContain(evil);
    }
    // an invalid id with resume:true still falls back to the safe --continue
    expect(claudeCommand({ resume: true, resumeId: "bad;id" })).toContain("--continue");
  });
});
