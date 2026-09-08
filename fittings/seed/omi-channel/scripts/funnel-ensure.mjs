#!/usr/bin/env node
// Idempotent Tailscale Funnel setup for the Omi webhook ingress. Run BY A
// HUMAN (or a human-approved step) on the prod shell - turning on public
// ingress is a deliberate act, so unlike tailnet-serve-views this is NOT
// invoked by prod:redeploy.
//
// What it does: reads the LIVE omi-channel port from the prod status file
// (never a literal) and mounts ONLY the /omi path prefix on funnel port 8443:
//   tailscale funnel --bg --https=8443 --set-path=/omi http://127.0.0.1:<port>/omi
//
// Guards (mirrors scripts/tailnet-serve-views.mjs):
// - refuses on a non-prod shell (GARRISON_INSTANCE_ID must be "prod");
//   serve/funnel config is node-global and funneling a dev port would hand
//   the public internet a dev server;
// - refuses when the status file is missing (fitting not running);
// - never touches :443 (that would expose the whole prod Garrison app).
//
// The node's tailnet policy already grants funnel on ports 443/8443/10000
// (verified 2026-07-30); 8443 is deliberately excluded from the serve-port
// allocator so nothing can collide.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const FUNNEL_PORT = 8443;

function fail(msg, code = 2) {
  console.error(`[omi-funnel] ${msg}`);
  process.exit(code);
}

const instance = (process.env.GARRISON_INSTANCE_ID || "").trim();
const force = process.argv.includes("--force");
if (instance !== "prod" && !force) {
  fail(
    `refusing to run from a non-prod shell (GARRISON_INSTANCE_ID='${instance || "unset"}'). ` +
      `Funnel config is node-global; only prod may publish. Use --force only if you know better.`
  );
}

const home = process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
const statusFile = path.join(home, "ui-fittings", "omi-channel.json");
let status = null;
try {
  status = JSON.parse(readFileSync(statusFile, "utf8"));
} catch {
  fail(`no live status file at ${statusFile} - start the omi-channel fitting first (composition up)`);
}
const port = Number(status.port);
if (!Number.isInteger(port) || port <= 0) fail(`bad port in ${statusFile}: ${status.port}`);
if (port === 443) fail("refusing: the status file names 443");

const target = `http://127.0.0.1:${port}/omi`;
const args = ["funnel", "--bg", `--https=${FUNNEL_PORT}`, `--set-path=/omi`, target];
console.log(`[omi-funnel] tailscale ${args.join(" ")}`);
try {
  const out = execFileSync("tailscale", args, { encoding: "utf8", timeout: 15000 });
  if (out.trim()) console.log(out.trim());
} catch (err) {
  fail(
    `tailscale funnel failed: ${err?.message ?? err}\n` +
      `If --set-path is unsupported on this tailscale version, run the two-step form:\n` +
      `  tailscale serve --bg --https=${FUNNEL_PORT} --set-path=/omi ${target}\n` +
      `  tailscale funnel --bg --https=${FUNNEL_PORT} on`,
    1
  );
}

const statusOut = execFileSync("tailscale", ["funnel", "status"], { encoding: "utf8", timeout: 10000 });
console.log(statusOut.trim());
console.log(
  `[omi-funnel] public webhook base: https://<this-node-dns-name>:${FUNNEL_PORT}/omi ` +
    `(use it in the Omi app's webhook URLs, with ?key=<OMI_WEBHOOK_SECRET>)`
);
