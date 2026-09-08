#!/usr/bin/env node
// Read-only verify probe (Rule 6: must pass UNCONFIGURED — a fresh clone with
// no transports, no devtunnel login, and the server down still verifies).
// Checks only what a broken install would get wrong: local binaries present
// and the fitting's own files loadable.
import { spawnSync } from "node:child_process";

const problems = [];

const ssh = spawnSync("ssh", ["-V"], { encoding: "utf8", timeout: 5000 });
if (ssh.error) problems.push("ssh binary not found on PATH");

try {
  await import("../lib/transports.mjs");
  await import("../lib/sessions.mjs");
  await import("../lib/remote-shell-adapter.mjs");
  await import("../lib/runtimes.mjs");
  await import("../lib/session-index.mjs");
  await import("../lib/node-identity.mjs");
  await import("../lib/index-publisher.mjs");
  await import("../lib/origin-guard.mjs");
  await import("./install-hooks.mjs");
  await import("./uninstall-hooks.mjs");
} catch (err) {
  problems.push(`module load failed: ${err.message}`);
}

if (problems.length > 0) {
  console.error(`probe failed: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("ok");
