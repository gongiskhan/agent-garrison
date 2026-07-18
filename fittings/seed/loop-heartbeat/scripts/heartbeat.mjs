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

const cadenceMinutes = Number(process.env.GARRISON_HEARTBEAT_MINUTES ?? "40");
const gatewayUrl = process.env.GARRISON_GATEWAY_URL ?? "http://127.0.0.1:24777/jobs";

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

async function tick() {
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(TICK_PAYLOAD)
    });
    const txt = await res.text();
    process.stdout.write(
      JSON.stringify({
        ts: startedAt,
        kind: "heartbeat-tick",
        status: res.status,
        ack: txt.slice(0, 120)
      }) + "\n"
    );
    return res.status;
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        ts: startedAt,
        kind: "heartbeat-error",
        error: err.message
      }) + "\n"
    );
    return -1;
  }
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
    process.stdout.write("ok\n");
    return 0;
  }
  if (cmd === "--once") {
    const status = await tick();
    return status >= 200 && status < 300 ? 0 : 1;
  }
  if (cmd === "daemon" || cmd === undefined) {
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
