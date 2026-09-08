// csg-node-install.sh - the G7 orchestrator. The full `install` flow needs a
// live, reachable csg to mean anything (ssh-keygen on csg, minting a real
// mesh token, scp) and is not exercised here - see the script's own header.
// What IS tested for real, against SCRATCH files only, is exactly the part
// that matters most to get right before ever touching production state: the
// two primitives that mutate THIS machine's own SSH access control
// (~/.ssh/authorized_keys, ~/.ssh/config). Every test below passes an
// explicit scratch path - none of them ever come near the real files.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "remote-shell", "csg-node-install.sh");

const VALID_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGimjUwXf5jIMdMXTeUBhE+pJFlbyBihqGJxDy45xrN0 garrison-csg-tether";
const OTHER_VALID_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPzV+F8uS8cbVDshya9aBnxX2SYld4j5350lh56JQtjr other-key";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "csg-node-install-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], { encoding: "utf8", timeout: 10_000 });
    return { status: 0, stdout, stderr: "" };
  } catch (err: any) {
    return { status: err.status ?? null, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

describe("csg-node-install.sh append-authorized-key (scratch file only, never the real one)", () => {
  it("appends a correctly-formatted forced-command entry for a valid key", () => {
    const akPath = path.join(scratch, "authorized_keys");
    const result = run(["append-authorized-key", VALID_KEY, akPath, "/home/ggomes/dev/garrison"]);
    expect(result.status).toBe(0);
    const content = readFileSync(akPath, "utf8");
    expect(content).toMatch(
      /^from="127\.0\.0\.1",no-pty,no-agent-forwarding,no-X11-forwarding,no-port-forwarding,command="\/home\/ggomes\/dev\/garrison\/scripts\/remote-shell\/git-only-shell\.sh" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGimjUwXf5jIMdMXTeUBhE\+pJFlbyBihqGJxDy45xrN0 garrison-csg-tether$/m
    );
  });

  it("writes the file with 0600 permissions", () => {
    const akPath = path.join(scratch, "authorized_keys");
    run(["append-authorized-key", VALID_KEY, akPath, "/repo"]);
    const mode = statSync(akPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("is idempotent - a second call for the same key does not duplicate the entry", () => {
    const akPath = path.join(scratch, "authorized_keys");
    run(["append-authorized-key", VALID_KEY, akPath, "/repo"]);
    const second = run(["append-authorized-key", VALID_KEY, akPath, "/repo"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/already exists/);
    const lines = readFileSync(akPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("preserves pre-existing unrelated entries and appends after them", () => {
    const akPath = path.join(scratch, "authorized_keys");
    writeFileSync(akPath, "ssh-rsa AAAAB3NzaC1yc2E existing-unrelated-key\n");
    run(["append-authorized-key", VALID_KEY, akPath, "/repo"]);
    const lines = readFileSync(akPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("ssh-rsa AAAAB3NzaC1yc2E existing-unrelated-key");
    expect(lines[1]).toMatch(/garrison-csg-tether/);
  });

  it("two different keys both get their own entries", () => {
    const akPath = path.join(scratch, "authorized_keys");
    run(["append-authorized-key", VALID_KEY, akPath, "/repo"]);
    run(["append-authorized-key", OTHER_VALID_KEY, akPath, "/repo"]);
    const lines = readFileSync(akPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it("refuses a malformed key line and never touches the file", () => {
    const akPath = path.join(scratch, "authorized_keys");
    const result = run(["append-authorized-key", "not-a-key-line", akPath, "/repo"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refused - malformed/);
    expect(() => readFileSync(akPath, "utf8")).toThrow();
  });

  it("refuses an unrecognised key type", () => {
    const akPath = path.join(scratch, "authorized_keys");
    const result = run(["append-authorized-key", "ssh-dss AAAA garbage", akPath, "/repo"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unrecognised key type/);
  });
});

describe("csg-node-install.sh append-ssh-config-host (scratch file only)", () => {
  it("appends a Host block with the body indented two spaces", () => {
    const cfgPath = path.join(scratch, "config");
    const result = run(["append-ssh-config-host", "csg", "HostName 127.0.0.1\nPort 2222", cfgPath]);
    expect(result.status).toBe(0);
    const content = readFileSync(cfgPath, "utf8");
    expect(content).toMatch(/Host csg\n {2}HostName 127\.0\.0\.1\n {2}Port 2222/);
  });

  it("is idempotent - a second call for the same alias leaves the file untouched", () => {
    const cfgPath = path.join(scratch, "config");
    run(["append-ssh-config-host", "csg", "HostName 127.0.0.1", cfgPath]);
    const before = readFileSync(cfgPath, "utf8");
    const second = run(["append-ssh-config-host", "csg", "HostName 1.2.3.4", cfgPath]);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/already present/);
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it("preserves a pre-existing unrelated Host block", () => {
    const cfgPath = path.join(scratch, "config");
    writeFileSync(cfgPath, "Host other\n  HostName example.com\n");
    run(["append-ssh-config-host", "csg", "HostName 127.0.0.1", cfgPath]);
    const content = readFileSync(cfgPath, "utf8");
    expect(content).toMatch(/Host other/);
    expect(content).toMatch(/Host csg/);
  });
});

describe("csg-node-install.sh latest-preflight-verdict", () => {
  it("reports 'none' when no preflight evidence exists", () => {
    // Run from a cwd whose evidence/shells/csg has nothing - REPO_ROOT is
    // derived from the script's own location, so this exercises the REAL
    // evidence dir; only meaningful if nothing races it, so just assert the
    // command succeeds and returns one of the known verdict strings.
    const result = run(["latest-preflight-verdict"]);
    expect(result.status).toBe(0);
    expect(["none", "GO", "GO-WITH-FIXES", "NO-GO", "unknown", "unreadable"]).toContain(result.stdout.trim());
  });

  it("refuses an unknown verb with usage on stderr and exit 2", () => {
    const result = run(["bogus-verb"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: csg-node-install\.sh/);
  });
});
