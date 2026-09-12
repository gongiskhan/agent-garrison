// Isolated real Capture service used only by command-line simulator validation.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { loadConfig } from "../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../fittings/seed/capture-service/scripts/server.mjs";
const root = mkdtempSync(path.join(os.tmpdir(), "listening-simulator-"));
const token = "isolated-simulator-listening-token";
const cfg = { ...loadConfig({ GARRISON_HOME: root, CAPTURE_TOKEN: token, GARRISON_CAPTURESERVICE_ENABLED: "true", GARRISON_CAPTURESERVICE_PENDANT_ENABLED: "true" }), home: root,
  stateDir: path.join(root, "capture"), statusFile: path.join(root, "status.json"), port: 0, bindHost: "127.0.0.1", listeningPushDryRun: true, speakEnabled: true };
const app = await startServer(cfg);
let heartbeats = 0, blocked = false, mock = null;
const pushes = [];
const speechReceipts = [];
const spokenReceipt = app.ingress.onSpokenReceipt;
app.ingress.onSpokenReceipt = (message, sessionId) => {
  speechReceipts.push({ ...message, sessionId });
  spokenReceipt?.(message, sessionId);
};
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
// Test harness control is on a separate ephemeral loopback listener, outside
// the shipped capture server. It can only affect this isolated node.
const control = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const device = url.searchParams.get("device");
  if (url.pathname.startsWith("/event/")) hostEvent(`journey:${url.pathname.slice(7)}`, url.searchParams.get("simulator"));
  if (url.pathname === "/mock-start") {
    mock?.kill();
    mock = spawn(process.execPath, ["scripts/mock-phone-source.mjs", "--url", `http://127.0.0.1:${app.cfg.port}`, "--device", device, "--wait-for-intent", "--duration", "240"], { env: { ...process.env, CAPTURE_TOKEN: token }, stdio: ["ignore", "inherit", "inherit"] });
  }
  if (url.pathname === "/mock-stop") { mock?.kill(); mock = null; }
  if (url.pathname === "/reset-pushes") pushes.length = 0;
  if (url.pathname === "/wake") app.listening.wake(device, "phone");
  const sessions = [...app.ingress.sessions.values()];
  const speechSession = sessions.find(session => session.record.id === url.searchParams.get("session"));
  if (url.pathname === "/voice-play" && speechSession) {
    await app.ackSink.handleAck({ id: "simulator-reply", text: "The report is ready for your review.", audioPath: "/speak/simulator.mp3", sessionId: speechSession.record.id });
    hostEvent("voice:play");
  }
  if (url.pathname === "/voice-interrupt" && speechSession) {
    app.ackSink.considerInterruption(speechSession.record.id, { text: "Please change the date.", confidence: 0.98, final: true, start: 0, end: 1 });
    hostEvent("voice:interrupt");
  }
  if (url.pathname === "/cut") { blocked = true; for (const session of sessions) session.socket?.terminate(); }
  if (url.pathname === "/unblock") blocked = false;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ heartbeats, pushes, hostEvents, speechReceipts, session_ids: [...app.ingress.sessions.keys()], records: app.listening.list(device), frames: sessions.reduce((n, s) => n + s.media.highWater().audio, 0) }));
});
await new Promise(resolve => control.listen(0, "127.0.0.1", resolve));
const info = { url: `http://127.0.0.1:${app.cfg.port}`, control: `http://127.0.0.1:${control.address().port}`, token };
writeFileSync(process.argv[2], JSON.stringify(info));
console.log("Simulator capture node ready");
