// Real WebSocket/watchdog journey with external providers disabled.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
const root = mkdtempSync(path.join(os.tmpdir(), "phone-listening-proof-"));
const logs = [];
const original = console.log;
console.log = (...args) => { logs.push(args.join(" ")); original(...args); };
const cfg = { ...loadConfig({ GARRISON_HOME: root, CAPTURE_TOKEN: "isolated-phone-proof", GARRISON_CAPTURESERVICE_ENABLED: "true" }),
  home: root, stateDir: path.join(root, "capture"), statusFile: path.join(root, "status.json"), port: 0, bindHost: "127.0.0.1", listeningPushDryRun: true };
const app = await startServer(cfg);
const child = spawn(process.execPath, ["scripts/mock-phone-source.mjs", "--url", `ws://127.0.0.1:${app.cfg.port}`, "--stall-after", "10", "--resume-after", "40", "--duration", "45"], {
  env: { ...process.env, CAPTURE_TOKEN: "isolated-phone-proof" }, stdio: ["ignore", "pipe", "pipe"] });
const states = [];
let pending = "";
child.stdout.on("data", data => {
  pending += data;
  const lines = pending.split("\n"); pending = lines.pop();
  for (const line of lines) { logs.push(line); const value = JSON.parse(line); if (value.type === "listening.state") states.push({ received: Date.now(), ...value }); }
});
child.stderr.on("data", data => logs.push(String(data)));
try {
  const code = await new Promise(resolve => child.on("exit", resolve));
  assert.equal(code, 0);
  const stalled = states.find(s => s.actual === "stalled");
  assert(stalled, "stalled state arrived");
  assert(stalled.received - Date.parse(stalled.last_seen_at) <= 25000, "stall within 25 seconds");
  const recovered = states.find(s => s.reason === "watchdog_recovered");
  assert(recovered, "recovery arrived"); assert.equal(recovered.stall_episode_id, null);
  const pushes = logs.filter(s => s.startsWith("listening push dry-run"));
  assert.equal(pushes.length, 1); assert(pushes[0].includes("The phone microphone stopped sending audio. Tap to resume."));
  mkdirSync("evidence/phone-listening", { recursive: true });
  writeFileSync("evidence/phone-listening/phase1-events.log", logs.join("\n") + "\n");
  original("Server journey passed: one stall push, recovery, cleared episode.");
} finally {
  child.kill(); app.ingress.close(); app.transcriber.close(); app.server.closeAllConnections(); app.server.close(); rmSync(root, { recursive: true, force: true });
}
process.exit(0);
