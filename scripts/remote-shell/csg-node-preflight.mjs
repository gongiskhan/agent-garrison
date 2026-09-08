#!/usr/bin/env node
// csg-node-preflight.mjs - the dev-madrid runner half of the G6 preflight.
// Combines what ONLY dev-madrid can see (tunnel/service state, round-trip
// timing, clock skew against ITS OWN clock) with what csg-node-preflight.sh
// reports about itself (piped over ssh, never scp'd) into one GO /
// GO-WITH-FIXES / NO-GO verdict, written to evidence/shells/csg/.
//
// `runPreflight()` is the whole decision engine, built to take every I/O
// dependency as an injected function - this is written and unit-tested
// BEFORE csg is reachable (see docs/decisions/2026-09-03-shells-and-mesh-
// sessions.md and evidence/shells/g6/): real csg only proves the exact
// output SHAPE of the remote checks matches what this file assumes, not the
// decision logic itself, which is exercised for real by
// tests/csg-node-preflight.test.ts against fakes.
//
// Usage: node scripts/remote-shell/csg-node-preflight.mjs [--survival] [--survival-hours N]

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeTunnel, sshExec } from "../../fittings/seed/remote-shell-runtime/lib/transports.mjs";
import { probeSshBanner } from "../../fittings/seed/remote-shell-runtime/lib/tunnel-health.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export const TUNNEL_ID = "swift-book-df6tw47.eun1";
export const SSH_PORT = 2222;
export const PREFLIGHT_SH_PATH = path.join(HERE, "csg-node-preflight.sh");

// The exact list csg-local.yml.example already carries - the preflight
// suggests it rather than re-deriving it, so there is exactly one place this
// list is ever authored.
export const UNSTATION_SUGGESTED = [
  "codex-runtime", "gemini-runtime", "opencode-runtime", "browser-default",
  "screen-share-default", "snapshots-default", "basic-memory", "vault-git-sync",
  "improver", "improver-nightly", "slack-channel", "email-channel", "omi-channel",
  "whatsapp-web", "capture-service", "trello", "google", "cortex-automations", "cortex-client"
];

function csgTransport() {
  return {
    ssh: { host: "127.0.0.1", port: SSH_PORT, user: "ggomes", identity: `${process.env.HOME}/.ssh/garrison-remote-shell` }
  };
}

/**
 * The whole decision engine. Every external effect is an injected function
 * so this runs, deterministically, against fakes with no real csg, ssh, or
 * devtunnel involved - see tests/csg-node-preflight.test.ts.
 */
export async function runPreflight({
  describeTunnelFn = describeTunnel,
  probeSshBannerFn = probeSshBanner,
  sshExecFn = sshExec,
  now = () => new Date(),
  transport = csgTransport(),
  preflightScript = null,
  roundTrips = 5
} = {}) {
  const result = {
    at: now().toISOString(),
    tunnelId: TUNNEL_ID,
    verdict: "NO-GO",
    fixes: [],
    repoSource: "github",
    supervisor: "systemd-user",
    tunnelPlan: "swift-book",
    unstationSuggested: UNSTATION_SUGGESTED,
    checks: {}
  };
  const fail = (reason) => { result.checks.stoppedAt = reason; return result; };

  // 1. Tunnel/login state - one query settles both (describeTunnel already
  // distinguishes login-expired from not-hosted from missing).
  const tunnel = await describeTunnelFn(TUNNEL_ID);
  result.checks.tunnel = tunnel;
  if (!tunnel.ok) {
    if (tunnel.reason === "login") {
      result.fixes.push(
        tunnel.expired
          ? "devtunnel login on dev-madrid has expired - run: devtunnel user login -g -d"
          : "dev-madrid is not logged in to devtunnel - run: devtunnel user login -g -d"
      );
    } else {
      result.fixes.push(`devtunnel show ${TUNNEL_ID} failed: ${tunnel.reason}${tunnel.detail ? ` (${tunnel.detail})` : ""}`);
    }
    return fail("devtunnel-show");
  }
  if (tunnel.hostConnections < 1) {
    result.fixes.push(
      `csg is not hosting ${TUNNEL_ID} (hostConnections: 0) - on csg, run: DEVTUNNEL_BIN=~/.local/bin/devtunnel sh ~/.garrison/host-tunnel.sh ${TUNNEL_ID} --detach`
    );
    return fail("host-not-connected");
  }
  if (!tunnel.ports.includes(SSH_PORT)) {
    result.fixes.push(`port ${SSH_PORT} is not registered on ${TUNNEL_ID} - it must be added on csg (devtunnel port create)`);
    return fail("port-not-registered");
  }

  // 2. Local ssh reachability (the client leg - a live host does not by
  // itself prove dev-madrid's OWN forward/connect leg is carrying traffic).
  const banner = await probeSshBannerFn(transport.ssh.host, transport.ssh.port);
  result.checks.sshBanner = banner;
  if (banner.state !== "up") {
    result.fixes.push(
      `ssh port ${transport.ssh.host}:${transport.ssh.port} is not reachable from dev-madrid (${banner.state}) - is the fitting's own tether/connect client running? check GET 127.0.0.1:8098/tether`
    );
    return fail("ssh-banner");
  }

  // 3. Auth + round-trip timing (5x, p50/p95 - a slow but working link still
  // needs to be known, not just pass/fail).
  const timings = [];
  for (let i = 0; i < roundTrips; i++) {
    const started = now().getTime();
    const r = await sshExecFn(transport, "true");
    if (r.code !== 0) {
      result.fixes.push(`ssh auth/exec to csg failed (exit ${r.code}): ${(r.stderr || "").trim().slice(0, 200)}`);
      result.checks.roundTrips = timings;
      return fail("ssh-auth");
    }
    timings.push(now().getTime() - started);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  result.checks.roundTrips = { samples: timings, p50Ms: pct(50), p95Ms: pct(95) };

  // 4. The remote-side checks (csg-node-preflight.sh, piped over stdin -
  // never scp'd, this script writes nothing to csg).
  const scriptContent = preflightScript ?? readFileSync(PREFLIGHT_SH_PATH, "utf8");
  const remote = await sshExecFn(transport, "sh -s", { input: scriptContent, timeoutMs: 30_000 });
  if (remote.code !== 0) {
    result.fixes.push(`csg-node-preflight.sh exited ${remote.code}: ${(remote.stderr || "").trim().slice(0, 300)}`);
    return fail("remote-script");
  }
  let remoteChecks;
  try {
    remoteChecks = JSON.parse(remote.stdout);
  } catch {
    result.fixes.push("csg-node-preflight.sh did not print valid JSON");
    return fail("remote-script-parse");
  }
  result.checks.remote = remoteChecks;

  // Clock skew: compare csg's reported UTC time against dev-madrid's own,
  // right now - the round trip itself is small next to the 60s tolerance.
  if (remoteChecks.remoteTimeIso) {
    const skewMs = Math.abs(now().getTime() - new Date(remoteChecks.remoteTimeIso).getTime());
    result.checks.clockSkewMs = skewMs;
    if (skewMs > 60_000) result.fixes.push(`clock skew ${Math.round(skewMs / 1000)}s exceeds the 60s tolerance`);
  }

  // ── blocking (NO-GO) conditions ────────────────────────────────────────
  const blocking = [];
  if (remoteChecks.repoDirIsSymlink) blocking.push("~/dev/garrison on csg is a symlink - refused, same as install-node.sh's own symlink-refusal rule");
  if (remoteChecks.sshdAllowTcpForwarding === "no") blocking.push("sshd on csg has AllowTcpForwarding no - the tether's -R/-L legs cannot work at all");
  if (!remoteChecks.gitOk) blocking.push(`git on csg is missing or older than 2.30 (found: ${remoteChecks.gitVersion ?? "none"})`);
  if (!remoteChecks.nodeOk && !remoteChecks.nvmAvailable) blocking.push("node on csg is missing/too old (<20.11) and nvm is not available to install it");
  if (remoteChecks.diskAvailGb != null && remoteChecks.diskAvailGb < 15) blocking.push(`disk on csg has only ${remoteChecks.diskAvailGb}GB free (need >=15GB)`);
  if (remoteChecks.memTotalGb != null && remoteChecks.memTotalGb < 8) blocking.push(`csg has only ${remoteChecks.memTotalGb}GB RAM (need >=8GB)`);

  // ── non-blocking (GO-WITH-FIXES) conditions ────────────────────────────
  const fixes = [];
  if (!remoteChecks.nodeOk && remoteChecks.nvmAvailable) fixes.push(`node on csg is <20.11 (found: ${remoteChecks.nodeVersion ?? "none"}) but nvm is available - install-node.sh will need an nvm install step`);
  if (!remoteChecks.npmPingOk) fixes.push("npm ping failed on csg - registry access may be degraded or proxied");
  if (!remoteChecks.githubReachable) {
    fixes.push("csg cannot reach github.com directly - falling back to --repo-source mirror");
    result.repoSource = "mirror";
  }
  for (const tool of ["tmux", "sqlite3", "cursor-agent"]) {
    if (remoteChecks.tools && remoteChecks.tools[tool] === false) fixes.push(`${tool} is not installed on csg`);
  }
  if (!remoteChecks.systemdUserOk) {
    result.supervisor = "node-supervisor";
    fixes.push("systemd --user is not usable on csg (common on WSL2) - install-node.sh will use node-supervisor.sh instead");
  } else if (!remoteChecks.sudoNopasswd) {
    fixes.push("sudo on csg needs a password - loginctl enable-linger may need to be run manually if the automatic attempt fails");
  }
  if (remoteChecks.proxyEnv && Object.keys(remoteChecks.proxyEnv).length > 0) {
    fixes.push(`csg has proxy env set (${Object.keys(remoteChecks.proxyEnv).join(", ")}) - install-node.sh --tethered sets NO_PROXY automatically`);
  }
  if (remoteChecks.peacefulOceanHostRunning) {
    fixes.push("the retiring peaceful-ocean host-tunnel.sh is still running on csg - stop it once G8 confirms swift-book works (never before)");
  }
  if (remoteChecks.wsl2 && !remoteChecks.codeTunnelPresent) {
    fixes.push("csg is WSL2 but the `code` CLI was not found - the VS Code Remote Tunnel this whole path depends on may not be set up the way expected");
  }

  result.checks.blocking = blocking;
  result.fixes.push(...fixes);
  if (blocking.length > 0) {
    result.fixes.push(...blocking);
    result.verdict = "NO-GO";
  } else if (result.fixes.length > 0) {
    result.verdict = "GO-WITH-FIXES";
  } else {
    result.verdict = "GO";
  }
  return result;
}

export function evidencePath(now = new Date(), repoRoot = REPO_ROOT) {
  return path.join(repoRoot, "evidence", "shells", "csg", `preflight-${now.toISOString().replace(/[:.]/g, "-")}.json`);
}

export function writeEvidence(result, { now = new Date(), repoRoot = REPO_ROOT } = {}) {
  const dest = evidencePath(now, repoRoot);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, JSON.stringify(result, null, 2));
  return dest;
}

// ── --survival: the port-survival protocol (mechanical polling only - the
// operator coordination it needs, e.g. asking to close every VS Code window
// first, is the calling agent's job, not this script's) ────────────────────
export async function runSurvivalCheck({ describeTunnelFn = describeTunnel, sshExecFn = sshExec, now = () => new Date(), transport = csgTransport() } = {}) {
  const tunnel = await describeTunnelFn(TUNNEL_ID);
  const entry = { at: now().toISOString(), hostConnections: tunnel.ok ? tunnel.hostConnections : null, ports: tunnel.ok ? tunnel.ports : [], ok: tunnel.ok };
  if (tunnel.ok) {
    const banner = await sshExecFn(transport, "true", { timeoutMs: 8000 });
    entry.sshOk = banner.code === 0;
  }
  return entry;
}

async function runSurvivalLoop(hours) {
  const dest = path.join(REPO_ROOT, "evidence", "shells", "csg", "port-survival.jsonl");
  mkdirSync(path.dirname(dest), { recursive: true });
  const deadline = Date.now() + hours * 3_600_000;
  let recreateAttempted = false;
  while (Date.now() < deadline) {
    const entry = await runSurvivalCheck();
    appendFileSync(dest, JSON.stringify(entry) + "\n");
    console.log(`[csg-node-preflight --survival] ${entry.at} hostConnections=${entry.hostConnections} sshOk=${entry.sshOk ?? "n/a"}`);
    if (entry.ok && entry.ports.includes(SSH_PORT)) {
      // still there - nothing to do
    } else if (!recreateAttempted) {
      recreateAttempted = true;
      console.log(`[csg-node-preflight --survival] port ${SSH_PORT} missing from the tunnel - attempting one recreate`);
      await sshExec(csgTransport(), `devtunnel port create ${TUNNEL_ID} -p ${SSH_PORT} --protocol auto`, { timeoutMs: 20_000 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 5 * 60_000));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--survival")) {
    const hIdx = args.indexOf("--survival-hours");
    const hours = hIdx >= 0 ? Number(args[hIdx + 1]) || 1 : 1;
    console.log(`[csg-node-preflight] --survival: polling every 5 minutes for ${hours}h`);
    await runSurvivalLoop(hours);
    return;
  }
  const result = await runPreflight();
  const dest = writeEvidence(result);
  console.log(`[csg-node-preflight] verdict: ${result.verdict}`);
  for (const f of result.fixes) console.log(`  - ${f}`);
  console.log(`[csg-node-preflight] wrote ${dest}`);
  if (result.verdict === "NO-GO") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[csg-node-preflight] fatal:", err);
    process.exitCode = 1;
  });
}
