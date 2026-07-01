import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore - pure .mjs
import { runEcosystemUpdate, readEcosystemUpdateLog } from "../fittings/seed/improver/lib/ecosystem-update.mjs";

function lockFixture(depCount: number): string {
  const deps = Array.from({ length: depCount }, (_, i) =>
    [
      `- repo_url: _local/dep-${i}`,
      `  package_type: apm_package`,
      `  deployed_files:`,
      `  - skills/dep-${i}`,
      `  source: local`,
      `  local_path: /tmp/dep-${i}`,
    ].join("\n")
  ).join("\n");
  return `lockfile_version: '1'\ngenerated_at: '2026-06-10T01:00:00Z'\napm_version: 0.11.0\ndependencies:\n${deps}\n`;
}

function makeComposition(root: string, depCount: number): string {
  const dir = join(root, "composition");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "apm.yml"), "name: test-composition\ntarget: claude\n", "utf8");
  writeFileSync(join(dir, "apm.lock.yaml"), lockFixture(depCount), "utf8");
  return dir;
}

describe("ecosystem-update - runEcosystemUpdate", () => {
  it("runs `apm outdated -v` then unconditionally `apm install --update --force`, never -g/--global", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-ecosys-"));
    const compositionDir = makeComposition(root, 2);
    const stateDir = join(root, "state");

    const calls: Array<{ args: string[]; cwd: string }> = [];
    const runApm = async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      if (args[0] === "outdated") return { ok: true, code: 0, stdout: "[*] No remote dependencies to check\n", stderr: "" };
      return { ok: true, code: 0, stdout: "installed\n", stderr: "" };
    };

    const entry = await runEcosystemUpdate({ runApm, compositionDir, stateDir });

    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(["outdated", "-v"]);
    expect(calls[1].args).toEqual(["install", "--update", "--force"]);
    for (const c of calls) {
      expect(c.cwd).toBe(compositionDir);
      expect(c.args).not.toContain("-g");
      expect(c.args).not.toContain("--global");
    }

    expect(entry.outdatedLog).toContain("No remote dependencies to check");
    expect(entry.installResult.ok).toBe(true);
    expect(entry.installResult.depCountBefore).toBe(2);
    expect(entry.installResult.depCountAfter).toBe(2);

    const log = await readEcosystemUpdateLog(stateDir);
    expect(log).toHaveLength(1);
    expect(log[0]).toEqual(entry);
  });

  it("is a no-op (logged, not silent) when compositionDir isn't a real APM composition", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-ecosys-noop-"));
    const notAComposition = join(root, "just-a-dir");
    mkdirSync(notAComposition, { recursive: true });
    const stateDir = join(root, "state");

    let called = false;
    const runApm = async () => {
      called = true;
      return { ok: true, code: 0, stdout: "", stderr: "" };
    };

    const entry = await runEcosystemUpdate({ runApm, compositionDir: notAComposition, stateDir });
    expect(called).toBe(false);
    expect(entry.skipped).toMatch(/no apm\.yml/);

    const log = await readEcosystemUpdateLog(stateDir);
    expect(log).toHaveLength(1);
    expect(log[0].skipped).toBeTruthy();
  });

  it("records an install failure without throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-ecosys-fail-"));
    const compositionDir = makeComposition(root, 1);
    const stateDir = join(root, "state");

    const runApm = async (args: string[]) => {
      if (args[0] === "outdated") return { ok: true, code: 0, stdout: "", stderr: "" };
      return { ok: false, code: 1, stdout: "", stderr: "boom" };
    };

    const entry = await runEcosystemUpdate({ runApm, compositionDir, stateDir });
    expect(entry.installResult.ok).toBe(false);
    expect(entry.installResult.code).toBe(1);
    expect(entry.installResult.stderr).toBe("boom");
  });

  it("never throws when runApm rejects", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-ecosys-reject-"));
    const compositionDir = makeComposition(root, 1);
    const stateDir = join(root, "state");

    const runApm = async () => {
      throw new Error("apm not on PATH");
    };

    await expect(runEcosystemUpdate({ runApm, compositionDir, stateDir })).resolves.toBeDefined();
    const log = await readEcosystemUpdateLog(stateDir);
    expect(log).toHaveLength(1);
    expect(log[0].installResult.ok).toBe(false);
    expect(log[0].outdatedLog).toContain("apm not on PATH");
  });

  it("starts a fresh log when the prior log file is missing or corrupt", async () => {
    const root = mkdtempSync(join(tmpdir(), "gar-ecosys-corrupt-"));
    const compositionDir = makeComposition(root, 0);
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ecosystem-update-log.json"), "{ not json", "utf8");

    const runApm = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });
    await runEcosystemUpdate({ runApm, compositionDir, stateDir });

    const log = await readEcosystemUpdateLog(stateDir);
    expect(log).toHaveLength(1); // corrupt prior contents were discarded, not appended-to garbage
  });
});
