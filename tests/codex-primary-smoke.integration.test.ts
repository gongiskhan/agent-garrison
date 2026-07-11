import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { projectPrimaryContext } from "@/lib/orchestrator-projection";

// S8 (GARRISON-RUNTIMES-V1 P8): the COMMITTED, re-runnable marker-asserted
// smoke — a switched codex primary demonstrably carries the orchestrator
// behavior. Projects the REAL assembled orchestrator prompt to AGENTS.md in a
// scratch dir and drives a real `codex exec` session there, asserting the
// reply ends with the mandated [route: …] token. Gated like the other live
// integration suites: needs GARRISON_INTEGRATION=1 + the codex CLI + an
// assembled prompt on disk.
const LIVE = process.env.GARRISON_INTEGRATION === "1";
const PROMPT = join(process.cwd(), "compositions", "default", ".garrison", "assembled-system-prompt.md");

describe.skipIf(!LIVE)("codex primary carries the orchestrator contract (S8 live smoke)", () => {
  it("a codex session over the projected AGENTS.md ends with the [route: …] token", async () => {
    expect(existsSync(PROMPT), "assembled prompt must exist (run up once)").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "gar-codex-primary-"));
    const instructions = readFileSync(PROMPT, "utf8");
    const res = await projectPrimaryContext({ engine: "codex", instructions, targetDir: dir });
    expect(res.projected).toBe(true);

    // Isolated CODEX_HOME (auth copied) so repo-configured MCP servers never
    // load — the same hygiene the run's codex gates use.
    const codexHome = mkdtempSync(join(tmpdir(), "gar-codex-home-"));
    cpSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));

    const out = execFileSync(
      "codex",
      [
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--cd",
        dir,
        "You have an AGENTS.md in this directory — follow it as your operating instructions. Task: state in one sentence which platform you are the Operative of, then finish your reply exactly as your instructions require."
      ],
      { env: { ...process.env, CODEX_HOME: codexHome }, timeout: 240000, encoding: "utf8" }
    );
    // Marker-asserted, not vibes: the orchestrator contract mandates the
    // routing token as the reply's last line.
    expect(out).toMatch(/\[route: [^\]|]+\| rule: [^\]|]+\| profile: [^\]]+\]/);
    expect(out.toLowerCase()).toContain("garrison");
  }, 300000);
});
