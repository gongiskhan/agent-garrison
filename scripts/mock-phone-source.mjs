#!/usr/bin/env node
// Synthetic source for an isolated Capture node. Never contains provider keys.
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { encodeMediaFrame } from "../fittings/seed/capture-service/lib/ingress.mjs";
import { HEARTBEAT_SECONDS } from "../fittings/seed/capture-service/lib/listening-config.mjs";

const { values } = parseArgs({ options: {
  url: { type: "string" }, device: { type: "string", default: "mock-phone-device-0001" },
  "wait-for-intent": { type: "boolean", default: false },
  "stall-after": { type: "string" }, "resume-after": { type: "string" }, duration: { type: "string", default: "65" }
} });
if (!values.url || !process.env.CAPTURE_TOKEN) throw new Error("Pass --url and CAPTURE_TOKEN for an isolated node");
const ws = new WebSocket(new URL("/capture/stream", values.url), { headers: {
  authorization: `Bearer ${process.env.CAPTURE_TOKEN}`, "x-garrison-device-id": values.device
} });
let seq = 0, started = 0, ready = false, wanted = !values["wait-for-intent"];
const send = message => ws.send(JSON.stringify({ device_id: values.device, source: "phone", at: new Date().toISOString(), ...message }));
const active = () => {
  const seconds = (Date.now() - started) / 1000;
  return wanted && (!values["stall-after"] || seconds < Number(values["stall-after"]) || (values["resume-after"] && seconds >= Number(values["resume-after"])));
};
ws.on("open", () => {
  send({ type: "listening.subscribe", device_name: values["wait-for-intent"] ? undefined : "Mock iPhone", app_version: values["wait-for-intent"] ? undefined : "test" });
  send({ type: "session_start", session_id: randomUUID(), mode: "audio", consent: "suppressed", device_name: "Mock iPhone" });
});
ws.on("message", data => {
  const msg = JSON.parse(String(data));
  if (msg.type !== "ack") console.log(JSON.stringify(msg));
  if (values["wait-for-intent"] && msg.type === "listening.state" && msg.source === "phone") {
    const next = msg.intent === "listening";
    if (next !== wanted && ready) send({ type: "listening.transition", actual: next ? "listening" : "off", reason: next ? "user_start" : "user_stop" });
    wanted = next;
  }
  if (msg.type === "session_started") {
    started = Date.now(); ready = true;
    if (!values["wait-for-intent"]) send({ type: "listening.intent", intent: "listening" });
    if (wanted) send({ type: "listening.transition", actual: "listening", reason: "user_start" });
  }
});
// Valid Opus silence packet; the media framing is the real ingress encoder.
const audio = setInterval(() => {
  if (ready && active() && ws.readyState === WebSocket.OPEN) ws.send(encodeMediaFrame(0, ++seq, Date.now() - started, Buffer.from([0xf8, 0xff, 0xfe])));
}, 20);
const heartbeats = setInterval(() => { if (ready && active() && ws.readyState === WebSocket.OPEN) send({ type: "listening.heartbeat" }); }, HEARTBEAT_SECONDS * 1000);
const timeout = setTimeout(() => ws.terminate(), Number(values.duration) * 1000);
ws.on("close", () => { clearInterval(audio); clearInterval(heartbeats); clearTimeout(timeout); });
ws.on("error", err => { console.error(err.message); process.exitCode = 1; });
