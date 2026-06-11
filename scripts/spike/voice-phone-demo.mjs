#!/usr/bin/env node
// Self-contained phone-testable VOICE demo: real deepgram-voice Fitting + real
// web-channel UI + a mock gateway that echoes the message back (so the voice
// loop — mic → STT → send → reply → read-aloud — is fully live without booting
// the real Operative). For the real agent + Trello, restart Garrison and `up`.
//
// Usage: DEEPGRAM_API_KEY=... node scripts/spike/voice-phone-demo.mjs
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const KEY = process.env.DEEPGRAM_API_KEY || "";
const GATEWAY_PORT = 4779;
const VOICE_PORT = 7085;
const WEB_PORT = 7083;

// Fresh .garrison root for the spawned fittings (shared, so web-channel still
// discovers the voice instance) — never touch the live ~/.garrison status files.
const GARRISON_HOME = mkdtempSync(path.join(os.tmpdir(), "voice-phone-demo-garrison-"));

if (!KEY) { console.error("DEEPGRAM_API_KEY required"); process.exit(2); }

// Mock gateway — echoes the message as a friendly demo reply.
http.createServer((req, res) => {
  const u = url.parse(req.url || "/", true);
  if (u.pathname === "/chat/stream" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg = "";
      try { msg = JSON.parse(body).message || ""; } catch {}
      const reply = `I heard you say: "${msg}". (Demo reply — voice in/out is live; restart Garrison and run the composition for the real agent + Trello.)`;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(`event: chunk\ndata: ${JSON.stringify({ text: reply })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ reply, session_id: "phone-demo" })}\n\n`);
      res.end();
    });
    return;
  }
  if (u.pathname === "/channels/web/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write(": keepalive\n\n");
    return;
  }
  res.writeHead(404); res.end();
}).listen(GATEWAY_PORT, "127.0.0.1", () => console.log(`[demo] mock gateway on ${GATEWAY_PORT}`));

function start(name, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: path.dirname(path.dirname(script)),
    env: { ...process.env, GARRISON_HOME, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

start("voice", path.join(ROOT, "fittings/seed/deepgram-voice/scripts/start.mjs"), {
  DEEPGRAM_API_KEY: KEY, DEEPGRAM_VOICE_PORT: String(VOICE_PORT)
});
start("web", path.join(ROOT, "fittings/seed/web-channel-default/scripts/start.mjs"), {
  WEB_CHANNEL_PORT: String(WEB_PORT),
  WEB_CHANNEL_HOST: "127.0.0.1",
  GARRISON_GATEWAY_URL: `http://127.0.0.1:${GATEWAY_PORT}`
});

console.log(`[demo] web-channel on http://127.0.0.1:${WEB_PORT}  (voice on ${VOICE_PORT})`);
console.log("[demo] ready — expose with: tailscale serve --bg --https=8444 http://127.0.0.1:7083");
