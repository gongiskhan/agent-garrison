import type { DeviceListeningState } from "@/lib/native-bridge";
import { STOP_HOLD_MS } from "../../../fittings/seed/capture-service/lib/listening-config.mjs";
export { STOP_HOLD_MS };
export function listeningCopy(state: DeviceListeningState) {
  const source = state.source === "phone" ? "Phone microphone" : "Pendant";
  const time = (value: string | null) => value ? new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  switch (state.actual) {
    case "off": return { label: "Not listening", sub: `${source} is off`, button: "Start listening", tone: "off", disabled: false };
    case "starting": return { label: "Starting", sub: state.source === "phone" ? "Setting up the microphone" : "Connecting to the pendant", button: "Starting", tone: "paused", disabled: true };
    case "listening": return { label: "Listening", sub: `${source}, since ${time(state.actual_changed_at)}`, button: "Hold to stop", tone: "live", disabled: false };
    case "interrupted": return { label: "Paused by another app", sub: "Will resume automatically", button: "Hold to stop", tone: "paused", disabled: false };
    case "stalled": return { label: "Stopped listening", sub: `No audio reaching Garrison since ${time(state.last_seen_at ?? state.intent_changed_at)}`, button: "Resume", tone: "stopped", disabled: false };
    case "failed": return { label: "Microphone unavailable", sub: state.reason === "permission_denied" ? "Microphone permission is off. Open Settings." : `Could not start the microphone (${state.reason})`, button: "Try again", tone: "stopped", disabled: false };
  }
}
export function listeningBadge(records: DeviceListeningState[]) {
  const active = records.filter(r => r.actual !== "off");
  if (!active.length) return null;
  if (active.some(r => r.actual === "failed" || r.actual === "stalled")) return { label: "Stopped", tone: "stopped" };
  if (active.some(r => r.actual === "starting" || r.actual === "interrupted")) return { label: "Paused", tone: "paused" };
  return { label: "Listening", tone: "live" };
}
// The same cancellable gesture drives pointer and keyboard input.
export class ListeningHold {
  private timer: ReturnType<typeof setTimeout> | null = null;
  completed = false;
  start(done: () => void) {
    this.cancel(); this.completed = false;
    this.timer = setTimeout(() => { this.timer = null; this.completed = true; done(); }, STOP_HOLD_MS);
  }
  cancel() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
}
