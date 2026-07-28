#!/usr/bin/env node
// Verify hook. Read-only by contract (setup causes side effects, verify proves
// them) - so this checks that the worker is well-formed and, when configured,
// that the host is actually reachable and the token actually authenticates.
//
// A verify that only checked "the file exists" would be the same mistake
// vault-git-sync's hook made: it grepped for REGISTRATION rather than health and
// reported PASS through 36 days of total failure.

import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // 1. The worker exists and parses.
  const worker = path.join(here, "worker.mjs");
  await access(worker);
  await import(worker); // throws on a syntax error

  const host = (process.env.GARRISON_DISPATCH_URL || "").replace(/\/+$/, "");
  const token = process.env.GARRISON_DISPATCH_TOKEN || "";
  const machine = process.env.GARRISON_DISPATCH_MACHINE || "";

  if (!host || !token || !machine) {
    // Unconfigured is a legitimate state: the fitting ships with the host, and
    // only an actual outpost sets these. Say so plainly rather than failing.
    console.log("outpost-worker: present but not configured (no dispatch url/token/machine)");
    console.log("OUTPOST-WORKER-OK");
    return;
  }

  // 2. Configured: prove the host answers AND the token is accepted. A claim
  // with nothing to do returns { job: null } - a perfectly good liveness probe
  // that takes no work off the board.
  const res = await fetch(`${host}/api/dispatch/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ machine, workerId: "verify-probe" }),
    signal: AbortSignal.timeout(10_000)
  });

  if (res.status === 401) {
    console.error(`outpost-worker: host rejected this machine's token (401) - re-pair ${machine}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`outpost-worker: host returned ${res.status} from ${host}`);
    process.exit(1);
  }
  console.log(`outpost-worker: authenticated to ${host} as ${machine}`);
  console.log("OUTPOST-WORKER-OK");
}

main().catch((err) => {
  console.error(`outpost-worker verify failed: ${err.message}`);
  process.exit(1);
});
