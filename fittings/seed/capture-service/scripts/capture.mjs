// Verify hook (--probe): read-only, gateway-independent, prints CAPTURE-OK.
// up() runs this BEFORE the gateway exists, so it must not touch the network
// or require any secret — it proves the fitting's code loads and its config
// resolves, nothing more.
import { loadConfig, FITTING_ID } from "../lib/config.mjs";

const arg = process.argv[2];

if (arg === "--probe") {
  const cfg = loadConfig();
  if (!Number.isInteger(cfg.port) || cfg.port <= 0) {
    console.error(`[${FITTING_ID}] probe failed: resolved port is invalid (${cfg.port})`);
    process.exit(1);
  }
  console.log(`CAPTURE-OK port=${cfg.port} flags=ingress:${cfg.enabled},transcribe:${cfg.transcribeEnabled},wake:${cfg.wakeEnabled},notify:${cfg.notifyEnabled},speak:${cfg.speakEnabled}`);
  process.exit(0);
}

console.error("usage: capture.mjs --probe");
process.exit(2);
