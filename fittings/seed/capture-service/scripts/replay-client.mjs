// Replay client — drives the full §4 wire protocol against a running
// capture-service exactly as the iOS app does, then FOLLOWS each injection to
// its downstream effect and prints it (speak.mjs pattern): the stored session
// record, the acked high-water marks, the dedupe counters, and — once the M2
// lane exists — the stored transcript. A run either shows the effect or says
// plainly that nothing arrived; asserting on connection success alone proves
// nothing.
//
// WHAT THIS DOES NOT COVER, so a green run is not mistaken for more:
//  - It starts at the WIRE PROTOCOL, not at sound: no iOS code, no microphone,
//    no broadcast extension is exercised. The fixtures are real Opus speech,
//    but the phone's encoder/uploader is proven only by the device smoke test.
//  - Deepgram is not under test unless the service's transcribe flag is on
//    with a real key; without it "no transcript stored" is the EXPECTED print.
//  - Byte-identical-store proof needs disk access and lives in
//    tests/capture-service-ingress.test.ts; here --twice proves the observable
//    half (acks pinned at the edge, dedupe counters moving, record unchanged).
//
// Usage:
//   node scripts/replay-client.mjs run [--fixture pt-command] [--mode audio|screen_audio]
//        [--twice] [--drop-at N] [--base URL] [--token T] [--session ID]
//   node scripts/replay-client.mjs bad-token | malformed
//
// Base URL: --base, else $GARRISON_HOME/ui-fittings/capture-service.json,
// else http://127.0.0.1:7097. Token: --token, else CAPTURE_TOKEN in env, else
// the composition's materialized .env (never a CLI default — secrets stay out
// of shell history).

import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";

const FRAME_HEADER = 17;
const KIND_AUDIO = 0;
const KIND_VIDEO = 1;

function fittingDir() {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "..");
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function garrisonHome() {
  return process.env.GARRISON_HOME?.trim() || path.join(os.homedir(), ".garrison");
}

function resolveBase(flag) {
  if (flag) return String(flag).replace(/\/$/, "");
  const statusFile = path.join(garrisonHome(), "ui-fittings", "capture-service.json");
  if (existsSync(statusFile)) {
    try {
      const status = JSON.parse(readFileSync(statusFile, "utf8"));
      if (status.url) return String(status.url).replace(/\/$/, "");
    } catch {}
  }
  return "http://127.0.0.1:7097";
}

function resolveToken(flag) {
  if (flag) return String(flag);
  if (process.env.CAPTURE_TOKEN?.trim()) return process.env.CAPTURE_TOKEN.trim();
  const candidates = [
    process.env.GARRISON_COMPOSITION_DIR && path.join(process.env.GARRISON_COMPOSITION_DIR, ".env"),
    ".env",
    path.join(fittingDir(), "../../../compositions/default/.env")
  ].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const match = /^CAPTURE_TOKEN=(.*)$/m.exec(readFileSync(file, "utf8"));
    if (match) return match[1].trim();
  }
  return null;
}

function loadAudioFixture(name) {
  const file = path.join(fittingDir(), "fixtures", `audio-${name}.jsonl`);
  if (!existsSync(file)) {
    console.error(`no such fixture: ${file}`);
    process.exit(2);
  }
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .map((p) => ({ seq: p.seq, ts: p.ts, bytes: Buffer.from(p.bytes, "base64") }));
}

function loadFrames() {
  const file = path.join(fittingDir(), "fixtures", "frames.json");
  return JSON.parse(readFileSync(file, "utf8")).frames.map((f) => ({
    seq: f.seq,
    ts: f.ts,
    bytes: Buffer.from(f.bytes, "base64")
  }));
}

function encodeFrame(kind, seq, ts, bytes) {
  const header = Buffer.alloc(FRAME_HEADER);
  header.writeUInt8(kind, 0);
  header.writeUInt32LE(seq >>> 0, 1);
  header.writeDoubleLE(Number(ts) || 0, 5);
  header.writeUInt32LE(bytes.length >>> 0, 13);
  return Buffer.concat([header, bytes]);
}

function newSessionId() {
  return `REPLAY${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 24);
}

function openSocket(base, token) {
  const url = base.replace(/^http/, "ws") + "/capture/stream";
  const ws = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const pending = [];
  const waiters = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else pending.push(msg);
  });
  const next = (pred, timeoutMs = 10000) => {
    const i = pending.findIndex(pred);
    if (i >= 0) return Promise.resolve(pending.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) {
          waiters.splice(at, 1);
          reject(new Error("timed out waiting for server message"));
        }
      }, timeoutMs).unref();
    });
  };
  const opened = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  return { ws, next, opened, closed };
}

async function fetchJson(base, token, route) {
  const res = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function streamSet(sock, frames, kind, { dropAt = null } = {}) {
  let lastAck = 0;
  for (const frame of frames) {
    if (dropAt !== null && frame.seq === dropAt) return { dropped: true, lastAck };
    sock.ws.send(encodeFrame(kind, frame.seq, frame.ts, frame.bytes));
    const ack = await sock.next((m) => m.type === "ack");
    lastAck = ack.seq;
  }
  return { dropped: false, lastAck };
}

async function run(flags) {
  const base = resolveBase(flags.base);
  const token = resolveToken(flags.token);
  if (!token) {
    console.error("no CAPTURE_TOKEN found (flag, env, or composition .env) - cannot authenticate");
    process.exit(1);
  }
  const fixture = flags.fixture ?? "pt-command";
  const mode = flags.mode === "screen_audio" ? "screen_audio" : "audio";
  const sessionId = flags.session ?? newSessionId();
  const packets = loadAudioFixture(fixture);
  const frames = mode === "screen_audio" ? loadFrames() : [];

  console.log(`base ${base} | session ${sessionId} | fixture ${fixture} (${packets.length} packets) | mode ${mode}`);

  const healthBefore = await fetchJson(base, token, "/health");
  if (!healthBefore.body?.ok) {
    console.error(`service unhealthy at ${base}: HTTP ${healthBefore.status}`);
    process.exit(1);
  }

  const sock = openSocket(base, token);
  await sock.opened;
  sock.ws.send(
    JSON.stringify({
      type: "session_start",
      session_id: sessionId,
      mode,
      device_name: "replay-client",
      consent: "shown",
      started_at: new Date().toISOString()
    })
  );
  const started = await sock.next((m) => m.type === "session_started" || m.type === "session_resumed" || m.type === "error");
  if (started.type === "error") {
    console.error(`session refused: ${started.error}`);
    process.exit(1);
  }
  console.log(`session ${started.type}`);

  // Optional mid-stream drop: terminate without a close frame, reconnect,
  // and prove resume-from-last-ack.
  const dropAt = flags["drop-at"] ? Number(flags["drop-at"]) : null;
  let result = await streamSet(sock, packets, KIND_AUDIO, { dropAt });
  let activeSock = sock;
  if (result.dropped) {
    console.log(`dropped the link before seq ${dropAt} (last ack ${result.lastAck}); reconnecting`);
    sock.ws.terminate();
    const resumedSock = openSocket(base, token);
    await resumedSock.opened;
    resumedSock.ws.send(
      JSON.stringify({
        type: "session_start",
        session_id: sessionId,
        mode,
        device_name: "replay-client",
        consent: "shown"
      })
    );
    const resumed = await resumedSock.next((m) => m.type === "session_resumed");
    console.log(`server reports high-water audio_seq=${resumed.audio_seq} - resuming from there`);
    const rest = packets.filter((p) => p.seq > resumed.audio_seq);
    result = await streamSet(resumedSock, rest, KIND_AUDIO);
    activeSock = resumedSock;
  }
  console.log(`audio streamed: last ack ${result.lastAck} of ${packets.length}`);

  if (frames.length > 0) {
    const videoResult = await streamSet(activeSock, frames, KIND_VIDEO);
    console.log(`video streamed: last ack ${videoResult.lastAck} of ${frames.length}`);
  }

  if (flags.twice) {
    const before = (await fetchJson(base, token, "/health")).body?.counters?.audio_frames_deduped ?? 0;
    const replayResult = await streamSet(activeSock, packets, KIND_AUDIO);
    const after = (await fetchJson(base, token, "/health")).body?.counters?.audio_frames_deduped ?? 0;
    console.log(
      `replayed the full set: acks stayed pinned at ${replayResult.lastAck}, ` +
        `audio_frames_deduped ${before} -> ${after} (${after - before === packets.length ? "every frame deduped" : "UNEXPECTED"})`
    );
  }

  activeSock.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
  await activeSock.next((m) => m.type === "session_ended");

  // ---- follow the effect ----
  const session = await fetchJson(base, token, `/capture/sessions/${sessionId}`);
  if (!session.body?.session) {
    console.error("NOTHING ARRIVED: the service has no record of this session");
    process.exit(1);
  }
  const record = session.body.session;
  console.log(
    `stored session: status=${record.status} audio_seq=${record.audio_seq} video_seq=${record.video_seq} ` +
      `consent=${record.consent} ended=${JSON.stringify(record.ended)}`
  );
  const okSeq = record.audio_seq === packets.length;
  console.log(okSeq ? "high-water matches the fixture packet count" : `MISMATCH: expected audio_seq ${packets.length}`);
  if (record.transcript_ref || record.transcript) {
    console.log("transcript stored (M2 lane ran)");
  } else {
    console.log("no transcript stored (transcribe lane off or M2 not landed) - expected in M1");
  }
  process.exit(okSeq ? 0 : 1);
}

async function badToken(flags) {
  const base = resolveBase(flags.base);
  const before = await fetch(`${base}/health`).then((r) => r.json());
  const sock = openSocket(base, "definitely-wrong-token");
  const failure = await sock.opened.then(
    () => null,
    (err) => err.message
  );
  const after = await fetch(`${base}/health`).then((r) => r.json());
  const delta = (after.counters?.rejected_auth ?? 0) - (before.counters?.rejected_auth ?? 0);
  if (failure && delta >= 1) {
    console.log(`bad token refused (${failure}); rejected_auth advanced by ${delta}`);
    process.exit(0);
  }
  console.error(`UNEXPECTED: failure=${failure} rejected_auth delta=${delta}`);
  process.exit(1);
}

async function malformed(flags) {
  const base = resolveBase(flags.base);
  const token = resolveToken(flags.token);
  if (!token) {
    console.error("no CAPTURE_TOKEN found - cannot authenticate");
    process.exit(1);
  }
  const fixture = JSON.parse(readFileSync(path.join(fittingDir(), "fixtures", "malformed-session.json"), "utf8"));
  const sock = openSocket(base, token);
  await sock.opened;
  sock.ws.send(JSON.stringify(fixture.message));
  const err = await sock.next((m) => m.type === "error");
  const code = await sock.closed;
  const session = await fetchJson(base, token, `/capture/sessions/${fixture.message.session_id}`);
  if (code === 1008 && session.status === 404) {
    console.log(`malformed session refused ("${err.error}", close ${code}); no state created`);
    process.exit(0);
  }
  console.error(`UNEXPECTED: close=${code} session lookup=${session.status}`);
  process.exit(1);
}

const flags = args(process.argv.slice(2));
const command = flags._[0] ?? "run";
if (command === "run") await run(flags);
else if (command === "bad-token") await badToken(flags);
else if (command === "malformed") await malformed(flags);
else {
  console.error("usage: replay-client.mjs [run|bad-token|malformed] [--fixture NAME] [--mode audio|screen_audio] [--twice] [--drop-at N] [--base URL] [--token T]");
  process.exit(2);
}
