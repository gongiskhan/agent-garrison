// Isolated real Capture service used only by command-line simulator validation.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
const root = mkdtempSync(path.join(os.tmpdir(), "listening-simulator-"));
const token = "isolated-simulator-listening-token";
const cfg = { ...loadConfig({ GARRISON_HOME: root, CAPTURE_TOKEN: token, GARRISON_CAPTURESERVICE_ENABLED: "true", GARRISON_CAPTURESERVICE_PENDANT_ENABLED: "true" }), home: root,
  stateDir: path.join(root, "capture"), statusFile: path.join(root, "status.json"), port: 0, bindHost: "127.0.0.1", listeningPushDryRun: true };
const app = await startServer(cfg);
let heartbeats = 0;
const receive = app.listening.message.bind(app.listening);
app.listening.message = (owner, message) => { if (message.type === "listening.heartbeat") heartbeats++; return receive(owner, message); };
// Test harness control is on a separate ephemeral loopback listener, outside
// the shipped capture server. It can only affect this isolated node.
const control = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const device = url.searchParams.get("device");
  if (url.pathname === "/wake") app.listening.wake(device, "phone");
  const sessions = [...app.ingress.sessions.values()];
  if (url.pathname === "/cut") for (const session of sessions) session.socket?.terminate();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ heartbeats, records: app.listening.list(device), frames: sessions.reduce((n, s) => n + s.media.highWater().audio, 0) }));
});
await new Promise(resolve => control.listen(0, "127.0.0.1", resolve));
const info = { url: `http://127.0.0.1:${app.cfg.port}`, control: `http://127.0.0.1:${control.address().port}`, token };
writeFileSync(process.argv[2], JSON.stringify(info));
console.log("Simulator capture node ready");
