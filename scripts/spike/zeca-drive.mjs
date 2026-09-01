// zeca-drive - drive the voice pipeline end to end, without a phone.
//
// Run:  node scripts/spike/zeca-scenarios.mjs
//
// A real end-to-end driver: boots the actual capture-service with a scriptable
// mock Deepgram and a stub gateway/board, opens a pendant session exactly as
// the phone does, and plays out a spoken scenario segment by segment.
//
// This is the harness I should have been using all along - it exercises the
// wake bus, cues, echo guard, speak lane and transcript together, without a
// phone or a deploy in the loop.
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../fittings/seed/capture-service/lib/config.mjs";
import { startServer } from "../../fittings/seed/capture-service/scripts/server.mjs";

const TOKEN = "drive-token";

function dgFinal(text, start = 0, dur = 2) {
  return JSON.stringify({
    type: "Results",
    is_final: true,
    channel: { alternatives: [{ transcript: text, confidence: 0.99, words: [] }] },
    start,
    duration: dur
  });
}

export async function drive({ segments, classifierReply, operativeReply = "Resposta do operativo.", label, beforeSegments = null, afterWake = null }) {
  const home = mkdtempSync(path.join(os.tmpdir(), "zeca-drive-"));
  const dgSockets = [];
  const wss = await new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 }, () => resolve(server));
    server.on("connection", (ws) => dgSockets.push(ws));
  });
  const dgUrl = `ws://127.0.0.1:${wss.address().port}`;

  const gatewayCalls = [];
  const gateway = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      gatewayCalls.push(JSON.parse(body || "{}"));
      const isClassify = String(JSON.parse(body || "{}").message).includes("spoken wake-word command");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: isClassify ? JSON.stringify(classifierReply) : operativeReply }));
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));

  // A stub board, discovered exactly as the real one is: through the fitting
  // status file under GARRISON_HOME.
  const cards = [];
  const board = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/cards" && req.method === "POST") {
        const card = { id: "01CARD" + cards.length, ...JSON.parse(body || "{}") };
        cards.push(card);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ card }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.startsWith("/projects") ? [] : { ok: true }));
    });
  });
  await new Promise((r) => board.listen(0, "127.0.0.1", r));
  mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
  writeFileSync(
    path.join(home, "ui-fittings", "kanban-loop.json"),
    JSON.stringify({ fittingId: "kanban-loop", url: `http://127.0.0.1:${board.address().port}` })
  );

  const env = { GARRISON_HOME: home, CAPTURE_TOKEN: TOKEN, DEEPGRAM_API_KEY: "k", BASIC_MEMORY_VAULT_DIR: path.join(home, "novault") };
  const cfg = loadConfig(env);
  const handle = await startServer({
    ...cfg, env, port: 0, enabled: true, transcribeEnabled: true, wakeEnabled: true,
    pendantEnabled: true, speakEnabled: true, cueEnabled: true, notifyEnabled: false,
    screenContextEnabled: true, screenAudioTranscribe: false,
    gatewayUrl: `http://127.0.0.1:${gateway.address().port}`,
    wakeSilenceCloseMs: 300, wakeSettledCloseMs: 200, wakeMaxCaptureMs: 4000,
    wsFactory: () => new WebSocket(dgUrl)
  });
  const base = `http://127.0.0.1:${handle.cfg.port}`;

  const spoken = [];
  const feedback = [];
  const ws = new WebSocket(base.replace("http", "ws") + "/capture/stream", { headers: { authorization: `Bearer ${TOKEN}` } });
  ws.on("message", (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    if (m.type === "speak") { spoken.push(m.ack.text); ws.send(JSON.stringify({ type: "spoken", spoken: m.ack.id, ok: true })); }
    if (m.type === "feedback") { feedback.push({ name: m.event.name, speak: m.event.speak?.text ?? null }); ws.send(JSON.stringify({ type: "feedback_ack", event_id: m.event.event_id })); }
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "session_start", session_id: "01DRIVE" + Date.now().toString(36).toUpperCase().slice(-8), mode: "pendant", codec: "opus_fs320", device_name: "drive", consent: "shown" }));
  await new Promise((r) => setTimeout(r, 250));

  // A second, concurrent session (the broadcast) when the scenario wants one.
  let side = beforeSegments ? await beforeSegments(base, TOKEN) : null;
  if (side) await new Promise((r) => setTimeout(r, 700));

  let seq = 0;
  for (const seg of segments) {
    ws.send(Buffer.concat([Buffer.from([0]), (() => { const b = Buffer.alloc(16); b.writeUInt32LE(++seq, 0); b.writeDoubleLE(seq * 20, 4); b.writeUInt32LE(6, 12); return b; })(), Buffer.from("opusXX")]));
    await new Promise((r) => setTimeout(r, 40));
    for (const s of dgSockets) if (s.readyState === 1) s.send(dgFinal(seg.text, seg.start ?? 0, seg.dur ?? 2));
    // The broadcast starting mid-capture, after the wake word has landed.
    if (afterWake && !side) {
      side = await afterWake(base, TOKEN);
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, seg.gapMs ?? 120));
  }
  await new Promise((r) => setTimeout(r, 1800));

  const exchanges = await fetch(`${base}/capture/exchanges`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()).catch(() => ({ exchanges: [] }));
  const counters = handle.counters.read();
  side?.stop(); ws.close(); handle.ingress.close(); handle.server.close(); wss.close(); gateway.close(); board.close();
  rmSync(home, { recursive: true, force: true });
  const operativePrompts = gatewayCalls
    .map((c) => String(c.message ?? ""))
    .filter((m) => !m.includes("spoken wake-word command"));
  return { label, spoken, feedback, cards, operativePrompts, exchanges: exchanges.exchanges ?? [], counters };
}
