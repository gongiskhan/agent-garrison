#!/usr/bin/env node
// coord — the coordination observability CLI. Renders the SINGLE coordination-state
// source (lib/coord-state.mjs buildCoordState) that the agent digest and the
// Coordination web view also consume, so they can never disagree. Subcommands:
//   coord status          hero verdict + liveness + sessions + planning locks + leases
//   coord status --tail   tail the hook heartbeat log
//   coord state --json    emit buildCoordState() as JSON (consumed by the web view)
//   coord canary          self-test the write->detect->inject chain (direct path)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCoordState, heartbeatLogPath } from "./lib/coord-state.mjs";
import { repoRoot } from "./lib/repo.mjs";
import { forceReleaseLock } from "./lib/plan-lock.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`
};

const VERDICT_RENDER = {
  "live-and-used": (s) => C.green(`● LIVE & IN USE — ${s}`),
  idle: (s) => C.dim(`○ LIVE (idle) — ${s}`),
  degraded: (s) => C.yellow(`▲ DEGRADED — ${s}`),
  down: (s) => C.red(`■ DOWN — ${s}`),
  unknown: (s) => C.red(`? UNKNOWN — ${s}`)
};

function focusRepo() {
  return repoRoot(process.cwd());
}

async function status() {
  const now = new Date();
  const st = await buildCoordState(focusRepo(), now, { liveness: true, globalSessions: true });

  // Hero verdict — the one-second answer.
  const hv = st.heroVerdict || { overall: "unknown", reasons: ["state unavailable"] };
  const render = VERDICT_RENDER[hv.overall] || VERDICT_RENDER.unknown;
  console.log("\n" + C.bold("Coordination") + "  " + render(hv.reasons[0] || ""));
  for (const r of hv.reasons.slice(1)) console.log("  " + C.dim("• " + r));

  // Liveness
  console.log(C.bold("\nLiveness"));
  const b = st.liveness.beads;
  const a = st.liveness.agentMail;
  console.log(`  Beads (bd CLI):   ${b.up ? C.green("UP") : C.red("DOWN")}${b.up ? C.dim(`  ${b.latencyMs}ms`) : ""}`);
  console.log(`  agent_mail HTTP:  ${a.up ? C.green("UP") : C.red("DOWN")}${a.up ? C.dim(`  ${a.latencyMs}ms  ${a.url}`) : a.reason ? C.dim(`  (${a.reason})`) : ""}`);

  // Sessions grouped by repo
  console.log(C.bold("\nActive sessions (by repo, within lookback)"));
  if (!st.sessions.length) console.log(C.dim("  (no active sessions in the lookback window)"));
  const byRepo = {};
  for (const s of st.sessions) (byRepo[s.repo] ||= []).push(s);
  for (const [repo, list] of Object.entries(byRepo)) {
    const intentCount = st.recentIntents.filter((i) => i.repo === repo).length;
    console.log(`  ${C.bold(repo)}  ${C.dim(`(intents: ${intentCount})`)}`);
    for (const s of list.slice(0, 5)) {
      const flag =
        s.flag === "active"
          ? C.green(`${s.fires} hook fires`)
          : s.flag === "red"
            ? C.red("RED active now, ZERO coord writes")
            : C.dim("idle (no coord activity)");
      console.log(`    ${s.sessionId.slice(0, 8)}  ${s.gitBranch || C.dim("-")}  active ${s.ageMinutes}m ago  ${flag}${s.conflicts ? C.yellow(`  ${s.conflicts} conflicts`) : ""}`);
    }
    if (list.length > 5) console.log(C.dim(`    +${list.length - 5} more`));
  }

  // Planning locks
  console.log(C.bold("\nPlanning locks"));
  if (!st.locks.length) console.log(C.dim("  (no active planning locks)"));
  for (const l of st.locks) {
    const state = l.expired ? C.red(`STALE (expired ${l.expiresAt})`) : C.green(`held ${l.heldMinutes}m`);
    console.log(`  ${C.bold(l.repo)}  ${state}`);
    console.log(`    holder: ${l.session}  ${C.dim(`"${(l.summary || "").slice(0, 80)}"`)}`);
    for (const w of l.waiters) console.log(`    waiting: ${w.session}  ${w.waitMinutes}m  ${w.waitMinutes > 15 ? C.red("(long wait)") : ""}`);
  }

  // Leases (the second coordination channel)
  console.log(C.bold("\nFile leases (agent_mail, this repo)"));
  if (!st.leases.length) console.log(C.dim("  (none)"));
  for (const l of st.leases) {
    console.log(`  ${l.exclusive ? "[excl]" : "[shared]"} ${l.pathPattern}  ${C.dim(`${l.agent} — "${(l.reason || "").slice(0, 60)}"`)}${l.stale ? C.yellow(" (stale)") : ""}`);
  }
  console.log("");
}

async function emitStateJson() {
  const repoArg = (process.argv.find((a) => a.startsWith("--repo=")) || "").split("=")[1];
  const st = await buildCoordState(repoArg || focusRepo(), new Date(), { liveness: true, globalSessions: true });
  process.stdout.write(JSON.stringify(st, null, 2) + "\n");
}

function tailHeartbeat() {
  const lines = Number((process.argv.find((a) => a.startsWith("--lines=")) || "--lines=20").split("=")[1]) || 20;
  let txt = "";
  try {
    txt = fs.readFileSync(heartbeatLogPath(), "utf8");
  } catch {
    console.log(C.dim("(no heartbeat log yet — the coord hook has not fired)"));
    return;
  }
  const all = txt.split("\n").filter((l) => l.trim());
  console.log(C.bold(`\nHook heartbeat — last ${Math.min(lines, all.length)} of ${all.length}\n`));
  for (const line of all.slice(-lines)) {
    try {
      const o = JSON.parse(line);
      console.log(`  ${o.ts}  ${o.event}  ${(o.session || "").slice(0, 8)}  ${o.repo || ""}  conflicts=${o.conflicts}  bytes=${o.digestBytes}`);
    } catch {
      /* skip */
    }
  }
  console.log("");
}

async function canary() {
  const { runCanary } = await import(path.join(__dirname, "lib", "canary.mjs"));
  const res = await runCanary();
  if (res.ok) {
    console.log(C.green("\nCOORD-CANARY OK") + C.dim(`  (conflict surfaced in injected digest; ${res.detail})`));
    process.exit(0);
  } else {
    console.log(C.red(`\nCOORD-CANARY FAIL — ${res.error}`));
    process.exit(1);
  }
}

function releaseLockCmd() {
  const repo = (process.argv.find((a) => a.startsWith("--repo=")) || "").split("=")[1] || focusRepo();
  const r = forceReleaseLock(repo);
  process.stdout.write(JSON.stringify(r) + "\n");
}

const cmd = process.argv[2];
(async () => {
  if (cmd === "status" && process.argv.includes("--tail")) tailHeartbeat();
  else if (cmd === "status") await status();
  else if (cmd === "state") await emitStateJson();
  else if (cmd === "canary") await canary();
  else if (cmd === "release-lock") releaseLockCmd();
  else {
    console.log("usage: coord status [--tail] | coord state --json [--repo=PATH] | coord canary | coord release-lock --repo=PATH");
    process.exit(2);
  }
})();
