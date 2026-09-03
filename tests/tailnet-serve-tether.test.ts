// scripts/tailnet-serve-tether.mjs - the owner-side half of a tether: reads
// $GARRISON_HOME/remote-shell/tether.json and publishes each forward's
// localPort to its declared servePort. Spawned as a REAL subprocess (a
// scratch GARRISON_HOME, --dry-run so no actual `tailscale serve` write is
// attempted) rather than importing main(), since the interesting behavior -
// the node-identity guard and the reserved-servePort refusal - both happen
// before any real tailscale call, and dry-run mode never reaches one either.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "tailnet-serve-tether.mjs");

function sandbox() {
  const home = mkdtempSync(path.join(tmpdir(), "gar-tether-serve-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function run(home: string, args: string[] = []) {
  return execFileSync(process.execPath, [SCRIPT, "--dry-run", ...args], {
    encoding: "utf8",
    env: { ...process.env, GARRISON_HOME: home, GARRISON_INSTANCE_ID: "" },
    // Both success (report only) and refusal (exit 1) are meaningful outputs
    // here, not failures of the test harness itself.
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runExpectFailure(home: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = run(home, args);
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? null, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

describe("tailnet-serve-tether.mjs", () => {
  it("refuses (exit 2) when there is no node.json - no --force", () => {
    const { home, cleanup } = sandbox();
    try {
      const result = runExpectFailure(home);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/no node identity/);
    } finally {
      cleanup();
    }
  });

  it("exits 0 with a plain message when node.json exists but there is no tether.json yet", () => {
    const { home, cleanup } = sandbox();
    try {
      writeFileSync(path.join(home, "node.json"), "{}");
      const out = run(home);
      expect(out).toMatch(/No tether\.json/);
    } finally {
      cleanup();
    }
  });

  it("publishes a forward whose servePort is OUTSIDE the reserved band (dry-run: would-add)", () => {
    const { home, cleanup } = sandbox();
    try {
      writeFileSync(path.join(home, "node.json"), "{}");
      mkdirSync(path.join(home, "remote-shell"), { recursive: true });
      writeFileSync(
        path.join(home, "remote-shell", "tether.json"),
        JSON.stringify({ transport: "csg", node: "csg", forwards: [{ name: "app", localPort: 9777, servePort: 8977 }] })
      );
      const out = run(home);
      expect(out).toMatch(/would-add/);
      expect(out).not.toMatch(/FAILED/);
    } finally {
      cleanup();
    }
  });

  it("refuses a forward whose servePort falls in the 8400-8499 own-port band (exit 1)", () => {
    const { home, cleanup } = sandbox();
    try {
      writeFileSync(path.join(home, "node.json"), "{}");
      mkdirSync(path.join(home, "remote-shell"), { recursive: true });
      writeFileSync(
        path.join(home, "remote-shell", "tether.json"),
        JSON.stringify({ transport: "csg", node: "csg", forwards: [{ name: "shells", localPort: 9098, servePort: 8450 }] })
      );
      const result = runExpectFailure(home);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/servePort 8450 is reserved/);
    } finally {
      cleanup();
    }
  });

  it("refuses a fixed infrastructure servePort (443/8443-8445/8860) too", () => {
    const { home, cleanup } = sandbox();
    try {
      writeFileSync(path.join(home, "node.json"), "{}");
      mkdirSync(path.join(home, "remote-shell"), { recursive: true });
      writeFileSync(
        path.join(home, "remote-shell", "tether.json"),
        JSON.stringify({ transport: "csg", node: "csg", forwards: [{ name: "weird", localPort: 9099, servePort: 8860 }] })
      );
      const result = runExpectFailure(home);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/servePort 8860 is reserved/);
    } finally {
      cleanup();
    }
  });
});
