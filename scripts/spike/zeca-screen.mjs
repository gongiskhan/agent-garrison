// The broadcast: pendant hears the command, the screen supplies the referent.
//
// Two live sessions at once, exactly as the wearer runs it - the pendant
// carries mic/wake/haptics/voice, the broadcast carries pixels - and they are
// joined by time, not by any shared id. This drives that join for real.
import { WebSocket } from "ws";
import { drive } from "./zeca-drive.mjs";

// A minimal JPEG (SOI + APP0 + EOI) - enough to be a real frame on disk.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

function videoFrame(seq, ts, bytes) {
  const head = Buffer.alloc(17);
  head.writeUInt8(1, 0);
  head.writeUInt32LE(seq, 1);
  head.writeDoubleLE(ts, 5);
  head.writeUInt32LE(bytes.length, 13);
  return Buffer.concat([head, bytes]);
}

// Opens a broadcast session alongside the pendant one and keeps pushing frames.
async function openBroadcast(base, token) {
  const ws = new WebSocket(base.replace("http", "ws") + "/capture/stream", {
    headers: { authorization: `Bearer ${token}` }
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({
    type: "session_start",
    session_id: "01SCREEN" + Date.now().toString(36).toUpperCase().slice(-6),
    mode: "screen_audio",
    device_name: "broadcast",
    consent: "shown"
  }));
  let seq = 0;
  const timer = setInterval(() => ws.send(videoFrame(++seq, seq * 667, JPEG)), 300);
  return { ws, stop: () => { clearInterval(timer); ws.close(); } };
}

const r = await drive({
  label: "screen context",
  segments: [
    { text: "Zeca.", gapMs: 200 },
    { text: "Responde-lhe que é melhor amanhã.", start: 2 }
  ],
  classifierReply: { intent: "delegate", request: "Responder que é melhor amanhã", needs_screen: true, ack: "Deixa-me ver o ecrã." },
  operativeReply: "Enviei a mensagem.",
  beforeSegments: process.env.NO_SCREEN ? null : openBroadcast
});

console.log("\ncues       :", r.feedback.filter((f) => f.speak).map((f) => f.speak).join(" | "));
console.log("said aloud :", r.spoken.join(" | ") || "(NOTHING)");
console.log("exchange   :", r.exchanges[0]?.intent, "|", JSON.stringify(r.exchanges[0]?.command ?? null));
console.log("operative prompt saw a frame:", r.operativePrompts?.some((p) => /frames\/\d+\.jpg/.test(p)) ?? "n/a");
const frameLine = (r.operativePrompts ?? []).flatMap((p) => p.split("\n")).find((l) => l.includes("frames/"));
console.log("frame line :", frameLine ? frameLine.slice(0, 150) : "(none - the screen was NOT fused)");
console.log("counters   :", JSON.stringify(Object.fromEntries(Object.entries(r.counters).filter(([k]) => /screen|video_frames_in/.test(k)))));
process.exit(0);
