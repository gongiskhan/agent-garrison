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
//   node scripts/replay-client.mjs run [--fixture pt-command] [--mode audio|screen_audio|pendant]
//        [--twice] [--drop-at N] [--base URL] [--token T] [--session ID]
//        [--cadence real|fast]
//   node scripts/replay-client.mjs bad-token | malformed
//
// Pendant mode (Pendant Direct): plays the Companion-relaying-the-pendant
// role - session_start carries mode "pendant" + codec, every
// {type:"feedback"} event from the server is logged with a timestamp and
// answered with {type:"feedback_ack"} exactly as the app's device/phone sinks
// would, and the effect-following knows that under the wake_only capture
// policy NO session record is the expected outcome. --cadence real streams
// packets at their fixture timing (20 ms Opus cadence) so the latency
// metrics on /health mean something.
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
  // Feedback events (pendant sessions): collected with arrival timestamps and
  // auto-acked, standing in for the app's device haptic + phone sinks.
  const feedback = [];
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const msg = JSON.parse(data.toString());
    if (msg.type === "feedback" && msg.event) {
      feedback.push({ event: msg.event, receivedAtMs: Date.now() });
      try {
        ws.send(JSON.stringify({ type: "feedback_ack", event_id: msg.event.event_id }));
      } catch {}
      return;
    }
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
  return { ws, next, opened, closed, feedback };
}

async function fetchJson(base, token, route) {
  const res = await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function streamSet(sock, frames, kind, { dropAt = null, cadence = "fast" } = {}) {
  let lastAck = 0;
  let prevTs = null;
  for (const frame of frames) {
    if (dropAt !== null && frame.seq === dropAt) return { dropped: true, lastAck };
    if (cadence === "real" && prevTs !== null && frame.ts > prevTs) {
      await new Promise((r) => setTimeout(r, frame.ts - prevTs));
    }
    prevTs = frame.ts;
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
  const mode = flags.mode === "screen_audio" || flags.mode === "pendant" ? flags.mode : "audio";
  const cadence = flags.cadence === "real" ? "real" : "fast";
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
      ...(mode === "pendant" ? { codec: "opus_fs320" } : {}),
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
  const streamStartedAt = Date.now();
  let result = await streamSet(sock, packets, KIND_AUDIO, { dropAt, cadence });
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

  // Pendant sessions: give the wake window + feedback loop a beat to close
  // before ending the session, so the feedback log below is complete.
  if (mode === "pendant") {
    const settleMs = Number(flags["settle-ms"] ?? 4000);
    await new Promise((r) => setTimeout(r, settleMs));
  }

  activeSock.ws.send(JSON.stringify({ type: "session_end", reason: "user" }));
  await activeSock.next((m) => m.type === "session_ended");

  // ---- follow the effect ----
  if (mode === "pendant") {
    // The feedback log IS the pendant's effect trail: every tier event with
    // its arrival offset from stream start (the device/phone sink stand-in).
    if (activeSock.feedback.length === 0 && sock.feedback.length === 0) {
      console.log("feedback: none received (wake flag off, or the fixture never woke)");
    } else {
      for (const entry of [...sock.feedback, ...(activeSock === sock ? [] : activeSock.feedback)]) {
        console.log(
          `feedback +${entry.receivedAtMs - streamStartedAt}ms: ${entry.event.name}` +
            (entry.event.reason ? ` (${entry.event.reason})` : "") +
            (entry.event.card_id ? ` card ${entry.event.card_id}` : "") +
            (entry.event.interim ? " [interim]" : "")
        );
      }
    }
    const health = await fetchJson(base, token, "/health");
    const c = health.body?.counters ?? {};
    if (c.wake_to_device_ack_ms_last !== undefined) {
      console.log(`wake_to_device_ack_ms: ${c.wake_to_device_ack_ms_last}`);
    }
    if (c.card_commit_to_created_ack_ms_last !== undefined) {
      console.log(`card_commit_to_created_ack_ms: ${c.card_commit_to_created_ack_ms_last}`);
    }
    const session = await fetchJson(base, token, `/capture/sessions/${sessionId}`);
    if (session.status === 404) {
      console.log("no session record stored - the wake_only capture policy at work (expected default)");
    } else if (session.body?.session) {
      const record = session.body.session;
      console.log(
        `stored session (ambient policy): status=${record.status} audio_seq=${record.audio_seq} ` +
          `transcript=${record.transcript_ref ? "stored" : "none"}`
      );
    }
    const okSeq = result.lastAck === packets.length;
    console.log(okSeq ? "every packet acked" : `MISMATCH: last ack ${result.lastAck} of ${packets.length}`);
    process.exit(okSeq ? 0 : 1);
  }

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
  console.error(
    "usage: replay-client.mjs [run|bad-token|malformed] [--fixture NAME] [--mode audio|screen_audio|pendant] [--cadence real|fast] [--twice] [--drop-at N] [--base URL] [--token T]"
  );
  process.exit(2);
}
