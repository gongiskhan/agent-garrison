#!/usr/bin/env node
// Omi channel CLI. `--probe` is the composition verify hook: read-only,
// gateway-independent (up() runs verify before the gateway exists). It proves
// the package is intact and the config layer parses, printing OMI-OK.
import { loadConfig, omiDir, FITTING_ID } from "../lib/config.mjs";
import { existsSync } from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));

function probe() {
  const required = ["start.mjs", "server.mjs"];
  for (const f of required) {
    if (!existsSync(path.join(here, f))) {
      console.error(`[${FITTING_ID}] probe failed: missing scripts/${f}`);
      process.exit(1);
    }
  }
  const cfg = loadConfig();
  if (!Number.isInteger(cfg.port) || cfg.port <= 0) {
    console.error(`[${FITTING_ID}] probe failed: bad port ${cfg.port}`);
    process.exit(1);
  }
  // Read-only: report, never create, the state dir.
  const state = omiDir();
  const flags = [
    cfg.enabled && "ingress",
    cfg.triageEnabled && "triage",
    cfg.wakeEnabled && "wake",
    cfg.notifyEnabled && "notify",
    cfg.chatEnabled && "chat",
    cfg.backfeedEnabled && "backfeed"
  ].filter(Boolean);
  console.error(
    `[${FITTING_ID}] probe: port=${cfg.port} state=${state} ` +
      `flags=${flags.length ? flags.join(",") : "all-off"} gateway=${cfg.gatewayUrl ?? "unset"}`
  );
  console.log("OMI-OK");
}

const arg = process.argv[2] ?? "--probe";
if (arg === "--probe") probe();
else {
  console.error(`usage: omi.mjs --probe`);
  process.exit(2);
}
