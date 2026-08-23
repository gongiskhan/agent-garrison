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
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
      setTimeout(() => resolve(out + (existsSync(log) ? readFileSync(log, "utf8") : "")), 400);
    }, ms);
  });
}

describe("host-tunnel supervisor", () => {
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

  it("refuses to loop forever on the one prerequisite it cannot fix", async () => {
    const bin = path.join(dir, "devtunnel");
    writeFileSync(bin, '#!/bin/sh\necho "GitHub login required."\nexit 3\n');
    chmodSync(bin, 0o755);
    const out = await supervise(bin, 1500);
    expect(out).toMatch(/not logged in/);
    expect(out).not.toMatch(/started devtunnel host/);
  }, 20000);
});
