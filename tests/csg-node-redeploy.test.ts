// csg-node-redeploy.sh - the dev-madrid-side wrapper that pulls csg's node/csg
// branch and restarts its Garrison node process over the tether. Full,
// live-target behaviour (actually ssh-ing to a real csg, fetching, running
// npm) is a G7-and-later concern, not testable here. What IS safely testable
// without a real csg: argument validation (zero side effects), and the most
// likely real-world failure mode - csg unreachable over ssh - correctly
// reported AND correctly containing its blast radius (never falling through
// to attempt a git fetch/npm run against an unreachable target).

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "remote-shell", "csg-node-redeploy.sh");
const FAKE_SSH = path.resolve(__dirname, "fixtures", "csg-node-redeploy", "fake-ssh-unreachable.sh");

function resolveBin(name: string): string {
  return execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

function run(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
      timeout: 10_000
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? null, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

describe("csg-node-redeploy.sh argument validation (no side effects)", () => {
  it("refuses when no verb is given", () => {
    const result = run([], {});
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: csg-node-redeploy\.sh <reload\|redeploy>/);
  });

  it("refuses an unknown verb", () => {
    const result = run(["bogus"], {});
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: csg-node-redeploy\.sh/);
  });

  it("accepts reload and redeploy as the only two verbs", () => {
    // Both proceed past validation (to the real, unfaked `ssh`, which will
    // fail fast with no `Host csg` configured here) - proving neither verb
    // is itself rejected by the case statement.
    for (const verb of ["reload", "redeploy"]) {
      const result = run([verb], {});
      expect(result.status).not.toBe(2);
    }
  });
});

describe("csg-node-redeploy.sh against an unreachable csg (real subprocess, fake ssh)", () => {
  it("reports the unreachable-over-ssh error and never proceeds to fetch/npm (exactly one ssh call)", () => {
    const fakeBin = mkdtempSync(path.join(tmpdir(), "csg-redeploy-fakebin-"));
    const callsFile = path.join(fakeBin, "calls.log");
    symlinkSync(FAKE_SSH, path.join(fakeBin, "ssh"));
    for (const bin of ["bash", "curl", "node"]) {
      symlinkSync(resolveBin(bin), path.join(fakeBin, bin));
    }

    const result = run(["reload"], { PATH: fakeBin, FAKE_SSH_CALLS: callsFile });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/csg unreachable over ssh/);

    const calls = readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean);
    // Exactly the one node.json read - never a second call attempting fetch
    // or npm against a target that just proved unreachable.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/node\.json/);

    rmSync(fakeBin, { recursive: true, force: true });
  });
});
