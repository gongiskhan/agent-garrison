// Isolated real Capture service used only by command-line simulator validation.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
const root = mkdtempSync(path.join(os.tmpdir(), "listening-simulator-"));
const token = "isolated-simulator-listening-token";
const cfg = { ...loadConfig({ GARRISON_HOME: root, CAPTURE_TOKEN: token, GARRISON_CAPTURESERVICE_ENABLED: "true", GARRISON_CAPTURESERVICE_PENDANT_ENABLED: "true" }), home: root,
  stateDir: path.join(root, "capture"), statusFile: path.join(root, "status.json"), port: 0, bindHost: "127.0.0.1", listeningPushDryRun: true };
const app = await startServer(cfg);
let heartbeats = 0, blocked = false, mock = null;
const pushes = [];
const hostEvents = [];
function hostEvent(type, detail = null) {
  const event = { type, detail, at: new Date().toISOString() };
  hostEvents.push(event);
  console.log(JSON.stringify(event));
}
const sendPush = app.notifier.sendListeningPush.bind(app.notifier);
app.notifier.sendListeningPush = async payload => { pushes.push(payload); return sendPush(payload); };
const startSession = app.ingress.handleSessionStart.bind(app.ingress);
app.ingress.handleSessionStart = (socket, message, send) => {
  if (blocked) { socket.terminate(); return null; }
  return startSession(socket, message, send);
};
const receive = app.listening.message.bind(app.listening);
app.listening.message = (owner, message) => { if (message.type === "listening.heartbeat") heartbeats++; return receive(owner, message); };
async function captureAppStack(label) {
  try {
    const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,comm="], { timeout: 15000 });
    const processes = stdout.split("\n").filter(line => /\/GarrisonApp\.app\/GarrisonApp$/.test(line));
    hostEvent("journey:app-processes", { label, processes });
    for (const process of processes) {
      const pid = process.trim().split(/\s+/)[0];
      await promisify(execFile)("sample", [pid, "1", "-file", path.resolve(`evidence/phone-listening/${label}-${pid}.sample.txt`)], { timeout: 60000 });
    }
  } catch (error) { hostEvent("journey:sample-failed", { label, message: error.message }); }
}
// Test harness control is on a separate ephemeral loopback listener, outside
// the shipped capture server. It can only affect this isolated node.
const control = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const device = url.searchParams.get("device");
  if (url.pathname === "/sample") void captureAppStack("before-background");
  if (["/open-capture", "/background-app"].includes(url.pathname)) {
    const openingCapture = url.pathname === "/open-capture";
    try {
      if (!openingCapture) await captureAppStack("before-background");
      const simulator = readFileSync("/tmp/listening-simulator-id", "utf8").trim();
      if (!/^[0-9A-F-]{36}$/i.test(simulator)) throw new Error("Invalid isolated simulator identity");
      const command = openingCapture
        ? ["simctl", "openurl", simulator, "garrison://open?path=%2Fcapture%3Fsource%3Dphone"]
        : ["simctl", "launch", simulator, "com.apple.Preferences"];
      await promisify(execFile)("xcrun", command, { timeout: 30000 });
      hostEvent(openingCapture ? "journey:capture-url-opened" : "journey:settings-opened");
    } catch (error) {
      hostEvent(openingCapture ? "journey:capture-url-failed" : "journey:settings-open-failed", { message: error.message, code: error.code, killed: error.killed, signal: error.signal, stderr: error.stderr });
      await captureAppStack("switch-failed");
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message })); return;
    }
  }
  if (url.pathname.startsWith("/event/")) hostEvent(`journey:${url.pathname.slice(7)}`, url.searchParams.get("simulator"));
  if (url.pathname === "/mock-start") {
    mock?.kill();
    mock = spawn(process.execPath, ["scripts/mock-phone-source.mjs", "--url", `http://127.0.0.1:${app.cfg.port}`, "--device", device, "--wait-for-intent", "--duration", "240"], { env: { ...process.env, CAPTURE_TOKEN: token }, stdio: ["ignore", "inherit", "inherit"] });
  }
  if (url.pathname === "/mock-stop") { mock?.kill(); mock = null; }
  if (url.pathname === "/reset-pushes") pushes.length = 0;
  if (url.pathname === "/wake") app.listening.wake(device, "phone");
  const sessions = [...app.ingress.sessions.values()];
  if (url.pathname === "/cut") { blocked = true; for (const session of sessions) session.socket?.terminate(); }
  if (url.pathname === "/unblock") blocked = false;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ heartbeats, pushes, hostEvents, session_ids: [...app.ingress.sessions.keys()], records: app.listening.list(device), frames: sessions.reduce((n, s) => n + s.media.highWater().audio, 0) }));
});
await new Promise(resolve => control.listen(0, "127.0.0.1", resolve));
const info = { url: `http://127.0.0.1:${app.cfg.port}`, control: `http://127.0.0.1:${control.address().port}`, token };
writeFileSync(process.argv[2], JSON.stringify(info));
console.log("Simulator capture node ready");
