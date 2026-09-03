// csg-node-preflight.mjs's decision engine (runPreflight). Every I/O
// dependency (devtunnel, ssh) is injected, so the GO/GO-WITH-FIXES/NO-GO
// logic is fully exercised here with no real csg involved - the same split
// this session used throughout: mechanical, deterministic logic gets real
// unit tests; anything that needs a live target gets deferred, and this file
// is exactly the boundary between the two for the preflight.

// @ts-ignore - plain .mjs, no type declarations
import { runPreflight, writeEvidence, evidencePath, UNSTATION_SUGGESTED } from "../scripts/remote-shell/csg-node-preflight.mjs";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const NOW = () => new Date("2026-09-03T22:00:00.000Z");

function fullRemoteChecks(overrides: Record<string, unknown> = {}) {
  return {
    wsl2: true,
    pid1Comm: "init",
    systemdSystem: false,
    systemdUserOk: false,
    nodeVersion: "20.19.4",
    nodeOk: true,
    nvmAvailable: true,
    npmPingOk: true,
    gitVersion: "2.43.0",
    gitOk: true,
    githubReachable: true,
    diskAvailGb: 42.0,
    memTotalGb: 16.0,
    nproc: 8,
    tools: { tmux: true, python3: true, curl: true, ssh: true, gcc: true, make: true, "g++": true, sqlite3: true, claude: true, codex: true, gemini: true, "cursor-agent": true, devtunnel: true, code: true },
    sudoPresent: true,
    sudoNopasswd: true,
    sshdAllowTcpForwarding: "yes",
    proxyEnv: {},
    remoteTimeIso: "2026-09-03T22:00:00.500Z",
    codeTunnelPresent: true,
    peacefulOceanHostRunning: false,
    repoDirExists: true,
    repoDirIsSymlink: false,
    cursorInventory: { hooksJsonSha256: null, cliConfigJsonSha256: null, mcpJsonSha256: null, cursorrulesSha256: null, pnmuiAgentsMdPresent: false, ruleAndSkillFiles: [], pnmuiRuleFiles: [] },
    ...overrides
  };
}

function happyPathDeps(remoteOverrides: Record<string, unknown> = {}) {
  return {
    now: NOW,
    describeTunnelFn: async () => ({ ok: true, hostConnections: 1, ports: [2222] }),
    probeSshBannerFn: async () => ({ state: "up", banner: "SSH-2.0-OpenSSH_9.6", ms: 40 }),
    sshExecFn: async (_t: unknown, cmd: string) => {
      if (cmd === "true") return { code: 0, stdout: "", stderr: "" };
      // the "sh -s" remote-script call
      return { code: 0, stdout: JSON.stringify(fullRemoteChecks(remoteOverrides)), stderr: "" };
    },
    roundTrips: 3
  };
}

describe("csg-node-preflight.mjs runPreflight - devtunnel/service-level short circuits", () => {
  it("STOPs immediately when devtunnel login has expired, before touching ssh at all", async () => {
    let sshCalled = false;
    const result = await runPreflight({
      now: NOW,
      describeTunnelFn: async () => ({ ok: false, reason: "login", expired: true }),
      probeSshBannerFn: async () => { sshCalled = true; return { state: "up" }; },
      sshExecFn: async () => { sshCalled = true; return { code: 0, stdout: "{}", stderr: "" }; }
    });
    expect(result.verdict).toBe("NO-GO");
    expect(result.fixes.join(" ")).toMatch(/devtunnel user login -g -d/);
    expect(sshCalled).toBe(false);
  });

  it("NO-GOes with an actionable fix when csg is not hosting the tunnel (hostConnections: 0) - never attempts ssh", async () => {
    let sshCalled = false;
    const result = await runPreflight({
      now: NOW,
      describeTunnelFn: async () => ({ ok: true, hostConnections: 0, ports: [2222] }),
      probeSshBannerFn: async () => { sshCalled = true; return { state: "up" }; },
      sshExecFn: async () => { sshCalled = true; return { code: 0, stdout: "{}", stderr: "" }; }
    });
    expect(result.verdict).toBe("NO-GO");
    expect(result.fixes.join(" ")).toMatch(/host-tunnel\.sh swift-book-df6tw47\.eun1 --detach/);
    expect(sshCalled).toBe(false);
  });

  it("NO-GOes when the ssh port is not registered on the tunnel", async () => {
    const result = await runPreflight({
      now: NOW,
      describeTunnelFn: async () => ({ ok: true, hostConnections: 1, ports: [31545] }),
      probeSshBannerFn: async () => ({ state: "up" }),
      sshExecFn: async () => ({ code: 0, stdout: "{}", stderr: "" })
    });
    expect(result.verdict).toBe("NO-GO");
    expect(result.fixes.join(" ")).toMatch(/not registered/);
  });

  it("NO-GOes when the ssh banner is not reachable locally, with a pointer to check the tether", async () => {
    const result = await runPreflight({
      now: NOW,
      describeTunnelFn: async () => ({ ok: true, hostConnections: 1, ports: [2222] }),
      probeSshBannerFn: async () => ({ state: "refused", detail: "ECONNREFUSED" }),
      sshExecFn: async () => ({ code: 0, stdout: "{}", stderr: "" })
    });
    expect(result.verdict).toBe("NO-GO");
    expect(result.fixes.join(" ")).toMatch(/GET 127\.0\.0\.1:8098\/tether/);
  });

  it("NO-GOes on an ssh auth/exec failure and stops before the remote script", async () => {
    let remoteScriptCalled = false;
    const result = await runPreflight({
      now: NOW,
      describeTunnelFn: async () => ({ ok: true, hostConnections: 1, ports: [2222] }),
      probeSshBannerFn: async () => ({ state: "up" }),
      sshExecFn: async (_t: unknown, cmd: string) => {
        if (cmd === "sh -s") remoteScriptCalled = true;
        return { code: 255, stdout: "", stderr: "Permission denied" };
      }
    });
    expect(result.verdict).toBe("NO-GO");
    expect(result.fixes.join(" ")).toMatch(/Permission denied/);
    expect(remoteScriptCalled).toBe(false);
  });
});

describe("csg-node-preflight.mjs runPreflight - the full happy path and blocking/non-blocking classification", () => {
  it("verdicts GO when every check is clean", async () => {
    // The shared fixture defaults to systemdUserOk:false (the realistic WSL2
    // shape other tests rely on) - a fully clean run overrides it explicitly.
    const result = await runPreflight(happyPathDeps({ systemdUserOk: true }));
    expect(result.verdict).toBe("GO");
    expect(result.fixes).toEqual([]);
    expect(result.checks.roundTrips.samples).toHaveLength(3);
    expect(result.unstationSuggested).toEqual(UNSTATION_SUGGESTED);
  });

  it("GO-WITH-FIXES when systemd --user is unusable (WSL2's common case) - routes supervisor to node-supervisor.sh, not blocking", async () => {
    const result = await runPreflight(happyPathDeps({ systemdUserOk: false }));
    expect(result.verdict).toBe("GO-WITH-FIXES");
    expect(result.supervisor).toBe("node-supervisor");
    expect(result.fixes.join(" ")).toMatch(/node-supervisor\.sh instead/);
  });

  it("GO-WITH-FIXES and repoSource flips to mirror when GitHub is unreachable from csg", async () => {
    const result = await runPreflight(happyPathDeps({ githubReachable: false }));
    expect(result.verdict).toBe("GO-WITH-FIXES");
    expect(result.repoSource).toBe("mirror");
  });

  it("NO-GO (blocking) when git is missing/too old - regardless of everything else being clean", async () => {
    const result = await runPreflight(happyPathDeps({ gitOk: false, gitVersion: "2.10.0" }));
    expect(result.verdict).toBe("NO-GO");
    expect(result.fixes.join(" ")).toMatch(/git on csg is missing or older than 2\.30/);
  });

  it("NO-GO (blocking) when ~/dev/garrison on csg is already a symlink", async () => {
    const result = await runPreflight(happyPathDeps({ repoDirIsSymlink: true }));
    expect(result.verdict).toBe("NO-GO");
    expect(result.fixes.join(" ")).toMatch(/symlink/);
  });

  it("NO-GO (blocking) when sshd explicitly disallows TCP forwarding - the tether cannot exist at all", async () => {
    const result = await runPreflight(happyPathDeps({ sshdAllowTcpForwarding: "no" }));
    expect(result.verdict).toBe("NO-GO");
    expect(result.fixes.join(" ")).toMatch(/AllowTcpForwarding no/);
  });

  it("NO-GO (blocking) on insufficient disk or RAM", async () => {
    const disk = await runPreflight(happyPathDeps({ diskAvailGb: 4.2 }));
    expect(disk.verdict).toBe("NO-GO");
    expect(disk.fixes.join(" ")).toMatch(/only 4\.2GB free/);

    const ram = await runPreflight(happyPathDeps({ memTotalGb: 3.5 }));
    expect(ram.verdict).toBe("NO-GO");
    expect(ram.fixes.join(" ")).toMatch(/only 3\.5GB RAM/);
  });

  it("flags clock skew beyond 60s as a fix", async () => {
    const result = await runPreflight(happyPathDeps({ remoteTimeIso: "2026-09-03T22:05:00.000Z" }));
    expect(result.verdict).toBe("GO-WITH-FIXES");
    expect(result.fixes.join(" ")).toMatch(/clock skew/);
    expect(result.checks.clockSkewMs).toBeGreaterThan(60_000);
  });

  it("node too old but nvm available is a fix, not a block; node too old with no nvm blocks", async () => {
    const withNvm = await runPreflight(happyPathDeps({ nodeOk: false, nodeVersion: "18.2.0", nvmAvailable: true }));
    expect(withNvm.verdict).toBe("GO-WITH-FIXES");

    const withoutNvm = await runPreflight(happyPathDeps({ nodeOk: false, nodeVersion: "18.2.0", nvmAvailable: false }));
    expect(withoutNvm.verdict).toBe("NO-GO");
  });
});

describe("csg-node-preflight.mjs writeEvidence", () => {
  it("writes the verdict JSON under evidence/shells/csg/ with a timestamped filename", async () => {
    const scratchRepo = mkdtempSync(path.join(tmpdir(), "csg-preflight-evidence-"));
    const result = await runPreflight(happyPathDeps({ systemdUserOk: true }));
    const dest = writeEvidence(result, { now: NOW(), repoRoot: scratchRepo });
    expect(dest).toBe(evidencePath(NOW(), scratchRepo));
    const written = JSON.parse(readFileSync(dest, "utf8"));
    expect(written.verdict).toBe("GO");
    rmSync(scratchRepo, { recursive: true, force: true });
  });
});
