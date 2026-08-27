// The keepalive that has to run ON the remote machine.
//
// This pins one regression, and it is worth the ten seconds it costs. A restart
// loop already existed on the CSG box and had been "healthy" for thirty hours
// while the tunnel carried nothing: `devtunnel host` does NOT exit when the
// relay drops it ("Another host for the tunnel has connected"), it stays alive
// hosting nothing, so a loop keyed on process exit can never fire. Same shape as
// the ssh -L accept-is-not-health bug in forwards.mjs - liveness is not health,
// twice, in the same fitting. The stub below reproduces exactly that: a host
// that never exits, and a service that says nobody is hosting.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Is a pid still alive? */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Stub host processes left behind by this test's own runs. */
function strays(): number {
  try {
    return execFileSync("pgrep", ["-fc", "sleep 300"], { encoding: "utf8" }).trim() === "0" ? 0 : Number(execFileSync("pgrep", ["-fc", "sleep 300"], { encoding: "utf8" }).trim());
  } catch {
    return 0; // pgrep exits 1 when nothing matches
  }
}

const SCRIPT = path.resolve(__dirname, "../fittings/seed/remote-shell-runtime/scripts/host-tunnel.sh");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "host-tunnel-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A devtunnel whose `host` never exits and whose `show` says what we tell it. */
function stubCli(hostConnections: number) {
  const bin = path.join(dir, "devtunnel");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'case "$1 $2" in "user show") echo "Logged in as tester using GitHub."; exit 0 ;; esac',
      'case "$1" in',
      '  host) echo "hosting $2"; exec sleep 300 ;;',
      `  show) printf '{ "tunnel": { "hostConnections": ${hostConnections} } }\\n'; exit 0 ;;`,
      "esac"
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** Run the supervisor for `ms`, then kill it and hand back what it logged. */
function supervise(bin: string, ms: number): Promise<string> {
  const log = path.join(dir, "log");
  return new Promise((resolve) => {
    const child = execFile("sh", [SCRIPT, "t1"], {
      env: { ...process.env, DEVTUNNEL_BIN: bin, HOST_TUNNEL_INTERVAL: "1", HOST_TUNNEL_LOG: log }
    });
    let out = "";
    // stderr too: the prerequisite failure is reported there, on purpose.
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { out += d; });
    setTimeout(() => {
      // SIGTERM so the script's trap stops its child too, leaving no sleep behind.
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      // POSIX sh runs a trap only once the running command returns, so allow more
      // than one INTERVAL for the teardown to actually happen.
      setTimeout(() => resolve(out + (existsSync(log) ? readFileSync(log, "utf8") : "")), 2000);
    }, ms);
  });
}

describe("host-tunnel supervisor", () => {
  it("tracks the real host process, not a wrapper around it", async () => {
    // Routing the spawn through a shell function makes $CHILD a wrapper subshell.
    // Killing that leaves the actual `devtunnel host` orphaned - alive, still
    // holding the tunnel, invisible to every check here. Found live: three
    // processes where there should have been two.
    const bin = stubCli(1);
    const out = await supervise(bin, 2500);
    expect(out).toMatch(/started devtunnel host \(pid (\d+)\)/);
    const pid = Number(/started devtunnel host \(pid (\d+)\)/.exec(out)![1]);
    // After the supervisor's trap ran, the pid it was tracking must be gone -
    // and so must the host it started, because they are the same process.
    expect(alive(pid)).toBe(false);
    expect(strays()).toBe(0);
  }, 20000);


  it("replaces a host that is alive but hosting nothing", async () => {
    const out = await supervise(stubCli(0), 5000);
    expect(out).toMatch(/started devtunnel host/);
    // The whole point: the process never died, so only the SERVICE could say so.
    expect(out).toMatch(/reports no host while pid \d+ is still alive - replacing it/);
  }, 20000);

  it("leaves a working host alone", async () => {
    const out = await supervise(stubCli(1), 5000);
    expect(out).toMatch(/started devtunnel host/);
    expect(out).not.toMatch(/replacing it/);
    // One start, not a churn of them.
    expect(out.match(/started devtunnel host/g)).toHaveLength(1);
  }, 20000);

  it("stops replacing the host once the credential under it lapses", async () => {
    // The credential outlives nothing: a devtunnel GitHub login lasts under a
    // day, so it WILL lapse beneath a long-running supervisor. `devtunnel host`
    // then cannot authenticate while still refusing to exit, so a supervisor
    // that only checked at startup would replace a doomed child forever, in
    // silence, on a machine reachable only through the tunnel it is failing to
    // hold up. The log is the only channel left; it has to name the fix.
    const bin = path.join(dir, "devtunnel");
    const flag = path.join(dir, "logged-in");
    writeFileSync(flag, "yes");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `case "$1 $2" in "user show") [ "$(cat ${flag})" = yes ] && echo "Logged in as tester using GitHub." || echo "Login token expired."; exit 0 ;; esac`,
        'case "$1" in',
        '  host) echo "hosting $2"; exec sleep 300 ;;',
        `  show) printf '{ "tunnel": { "hostConnections": 0 } }\\n'; exit 0 ;;`,
        "esac"
      ].join("\n")
    );
    chmodSync(bin, 0o755);
    // Lapse the credential a moment after it starts, mid-flight.
    setTimeout(() => writeFileSync(flag, "no"), 1200);
    const out = await supervise(bin, 6000);
    expect(out).toMatch(/LOGIN EXPIRED on this machine/);
    expect(out).toMatch(/devtunnel user login -g -d/);
    expect(out).toMatch(/could not authenticate/);
    // Said once per lapse, not once per cycle - this log is read hours later.
    expect(out.match(/LOGIN EXPIRED/g)).toHaveLength(1);
  }, 20000);

  it("refuses to loop forever on the one prerequisite it cannot fix", async () => {
    const bin = path.join(dir, "devtunnel");
    writeFileSync(bin, '#!/bin/sh\necho "GitHub login required."\nexit 3\n');
    chmodSync(bin, 0o755);
    const out = await supervise(bin, 1500);
    expect(out).toMatch(/no credential/);
    expect(out).not.toMatch(/started devtunnel host/);
  }, 20000);
});
