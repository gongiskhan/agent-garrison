#!/usr/bin/env node
// Heartbeat for Garrison.
// Periodically POSTs a synthetic tick payload to the gateway /jobs
// endpoint. The Operative's system prompt explains how to handle a
// tick — suggest, don't execute; stay silent if nothing's actionable;
// dedup against recent suggestions; honour decline cooldown.
//
// Usage:
//   node heartbeat.mjs --probe   # health check, prints "ok"
//   node heartbeat.mjs --once    # fire one tick, exit
//   node heartbeat.mjs daemon    # tick every cadence_minutes until killed

import { randomUUID } from "node:crypto";

const cadenceMinutes = Number(process.env.GARRISON_HEARTBEAT_MINUTES ?? "40");
// NO port literal fallback, deliberately. This value is another process's
// address, and defaulting it is a guess about which instance we belong to: the
// literal here was once 24777 (the CODEX gateway), then 4777 (the DEV gateway),
// and each time it silently posted one instance's jobs to another instance's
// operative — right on the box where it was authored, wrong everywhere else.
// scripts/setup.sh bakes the resolved address into the registered job command,
// because the scheduler daemon runs jobs with its own env and carries none.
const gatewayUrl = (process.env.GARRISON_GATEWAY_URL ?? "").trim() || null;

function requireGateway() {
  if (gatewayUrl) return gatewayUrl;
  process.stderr.write(
    "loop-heartbeat: GARRISON_GATEWAY_URL is not set — refusing to guess which " +
      "instance's gateway to post to. Re-run the fitting's setup hook so the job " +
      "command carries this instance's address.\n"
  );
  return null;
}

const TICK_PAYLOAD = {
  kind: "heartbeat-tick",
  instructions: [
    "Look at my open Trello tasks ('A Fazer' list).",
    "Pick one or two I should pick up now, with brief reasons.",
    "Post the suggestion to Slack via the channel.",
    "Do not do the work — only suggest. Plan-on-approval applies.",
    "Stay silent if there's nothing actionable.",
    "Don't repeat a suggestion the principal already saw on the previous tick."
  ].join(" ")
};

const POST_ATTEMPTS = 3;
const POST_RETRY_BASE_MS = 250;
const configuredPostTimeoutMs = Number(process.env.GARRISON_JOB_POST_TIMEOUT_MS);
const POST_TIMEOUT_MS = Number.isFinite(configuredPostTimeoutMs) && configuredPostTimeoutMs > 0
  ? configuredPostTimeoutMs
  : 10_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tick() {
  const startedAt = new Date().toISOString();
  // One occurrence id per cadence tick: all retries share it (at-most-once at
  // ingress), while the next legitimate 40-minute tick remains distinct instead
  // of being suppressed by the gateway's multi-hour replay window.
  const payload = { ...TICK_PAYLOAD, occurrence_id: randomUUID() };
  let lastStatus = -1;
  for (let attempt = 1; attempt <= POST_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(gatewayUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS)
      });
      const txt = await res.text();
      lastStatus = res.status;
      process.stdout.write(
        JSON.stringify({
          ts: startedAt,
          kind: "heartbeat-tick",
          status: res.status,
          attempt,
          ack: txt.slice(0, 120)
        }) + "\n"
      );
      // 5xx (including ingress backpressure 503) is explicitly retryable. A
      // 4xx is a bad payload/config and must not be amplified.
      if (res.status < 500 || attempt === POST_ATTEMPTS) return res.status;
    } catch (err) {
      process.stderr.write(
        JSON.stringify({
          ts: startedAt,
          kind: "heartbeat-error",
          attempt,
          error: err.message
        }) + "\n"
      );
      if (attempt === POST_ATTEMPTS) return -1;
    }
    await wait(POST_RETRY_BASE_MS * (2 ** (attempt - 1)));
  }
  return lastStatus;
}

async function daemon() {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      kind: "heartbeat-start",
      cadenceMinutes,
      gatewayUrl
    }) + "\n"
  );
  // Sleep first, then tick — avoids a tick on daemon startup, which
  // tends to fire while the operative is still warming up.
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, cadenceMinutes * 60_000));
    await tick();
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (cmd === "--probe") {
    // Report what this heartbeat would actually do. The old probe printed a bare
    // "ok" whatever the state, so verify passed for a Fitting that nothing had
    // registered and that could not name a gateway.
    if (!requireGateway()) return 1;
    process.stdout.write(
      `probe: cadence=${cadenceMinutes}m target=${gatewayUrl}\nok\n`
    );
    return 0;
  }
  if (cmd === "--once") {
    if (!requireGateway()) return 1;
    const status = await tick();
    return status >= 200 && status < 300 ? 0 : 1;
  }
  if (cmd === "daemon" || cmd === undefined) {
    if (!requireGateway()) return 1;
    await daemon();
    return 0;
  }
  process.stderr.write(`unknown command: ${cmd}\n`);
  process.stderr.write("commands: --probe | --once | daemon\n");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => { console.error(err.stack ?? err.message); process.exit(1); }
);
