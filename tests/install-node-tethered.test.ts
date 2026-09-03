// install-node.sh's --tethered support (G6: csg has no tailnet interface of
// its own, reachable only through dev-madrid's reverse tunnel). The full
// script does real, heavy, machine-mutating work (git clone, npm install,
// systemd/launchd units, tailscale serve) that has no safe way to run in a
// test - there were zero tests for this script before this file. What IS
// safely and meaningfully testable without touching any of that:
//
//   1. Argument validation - deterministic, side-effect-free, runs entirely
//      before the first network/filesystem touch.
//   2. The tethered-vs-not preflight branch actually taking effect - proven
//      by running the REAL script against a curated PATH (real git/node/npm/
//      curl via symlinks, tailscale deliberately absent) and watching it
//      fail at the RIGHT step: tethered skips past the tailscale requirement
//      and dies at "state service unreachable" (a real curl against a
//      guaranteed-empty loopback port); untethered still dies at "tailscale
//      not found" - proving the branch is genuinely conditional, not a
//      blanket skip. Both paths exit 1 before any file is written or any
//      process spawned, so this is as safe as the validation-only tests.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "install-node.sh");

function resolveBin(name: string): string {
  return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

function run(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  // Invoke the fake-bin bash explicitly (it's a symlink to the real one) so
  // the script's own shebang lookup never falls back to whatever `bash`
  // Node's own PATH would find - only the curated env.PATH governs what the
  // SCRIPT itself sees when it calls `command -v`.
  const bash = path.join(env.PATH.split(":")[0], "bash");
  try {
    const stdout = execFileSync(bash, [SCRIPT, ...args], {
      encoding: "utf8",
      env: env as unknown as NodeJS.ProcessEnv,
      timeout: 15_000
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? null, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

// Argument-validation tests: real bash, but every case below exits (2) before
// the script ever calls `command -v` on anything, so PATH content is
// irrelevant here - process.env.PATH is enough.
function runValidationOnly(args: string[], extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv } as unknown as NodeJS.ProcessEnv,
      input: extraEnv.__stdin ?? "",
      timeout: 10_000
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? null, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

describe("install-node.sh argument validation (no side effects)", () => {
  it("refuses when required args are missing", () => {
    const result = runValidationOnly([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: install-node\.sh/);
  });

  it("refuses an unknown argument", () => {
    const result = runValidationOnly(["--bogus"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/unknown argument: --bogus/);
  });

  it("refuses an invalid --repo-source value", () => {
    const result = runValidationOnly(["--name", "n", "--token", "t", "--state-url", "http://x", "--repo-source", "ftp"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--repo-source must be github or mirror/);
  });

  it("refuses --token and --token-stdin together", () => {
    const result = runValidationOnly(["--name", "n", "--token", "t", "--state-url", "http://x", "--token-stdin"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/pass either --token or --token-stdin, not both/);
  });

  it("refuses --tethered without --tether-host and --app-origin", () => {
    const result = runValidationOnly(["--name", "n", "--token", "t", "--state-url", "http://x", "--tethered"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--tethered requires --tether-host and --app-origin/);
  });

  it("accepts a token via stdin and reaches past validation (proven by the NEXT failure being a real preflight error, not exit 2)", () => {
    const result = runValidationOnly(
      ["--name", "n", "--token-stdin", "--state-url", "http://127.0.0.1:1"],
      { __stdin: "the-token\n" }
    );
    // Validation passed (would be exit 2 with the usage string otherwise);
    // it now fails downstream at the real preflight, proving TOKEN was
    // actually populated from stdin rather than left empty.
    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/usage: install-node\.sh/);
  });
});

describe("install-node.sh --tethered preflight (real subprocess, curated PATH)", () => {
  let fakeBin: string;

  beforeAll(() => {
    fakeBin = mkdtempSync(path.join(tmpdir(), "install-node-fakebin-"));
    // Real git/node/npm/curl/bash via symlink - tailscale deliberately absent.
    for (const bin of ["bash", "git", "node", "npm", "curl"]) {
      symlinkSync(resolveBin(bin), path.join(fakeBin, bin));
    }
  });

  afterAll(() => {
    rmSync(fakeBin, { recursive: true, force: true });
  });

  it("tethered: skips the tailscale requirement and fails at the state-health check instead (proof the reverse leg is what's actually being tested)", () => {
    const scratchHome = mkdtempSync(path.join(tmpdir(), "install-node-home-"));
    const result = run(
      ["--name", "csg-test", "--token", "tok", "--state-url", "http://127.0.0.1:1", "--tethered", "--tether-host", "dev-madrid", "--app-origin", "https://example.ts.net:8977"],
      { PATH: fakeBin, HOME: scratchHome }
    );
    rmSync(scratchHome, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/state service unreachable/);
    expect(result.stderr).not.toMatch(/tailscale not found/);
  });

  it("NOT tethered: still requires tailscale (no accidental broadening of the skip)", () => {
    const scratchHome = mkdtempSync(path.join(tmpdir(), "install-node-home-"));
    const result = run(
      ["--name", "some-node", "--token", "tok", "--state-url", "http://127.0.0.1:1"],
      { PATH: fakeBin, HOME: scratchHome }
    );
    rmSync(scratchHome, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/tailscale not found/);
  });
});
