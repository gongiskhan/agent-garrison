import { afterEach, describe, expect, it, vi } from "vitest";
import { listeningCopy, listeningBadge, ListeningHold } from "../src/components/capture/listening-model";
import type { DeviceListeningState } from "../src/lib/native-bridge";
const record = (actual: DeviceListeningState["actual"], reason: string | null = null): DeviceListeningState => ({
  device_id: "test-phone", device_name: "iPhone", source: "phone", intent: actual === "off" ? "off" : "listening", actual, reason,
  last_seen_at: "2026-09-11T12:00:00Z", intent_changed_at: "2026-09-11T12:00:00Z", actual_changed_at: "2026-09-11T12:00:00Z",
  stall_episode_id: null, stall_pushes_sent: 0, app_version: "1"
});
afterEach(() => vi.useRealTimers());
describe("listening controls", () => {
  it.each([
    ["off", "Not listening", "Phone microphone is off", "Start listening", false],
    ["starting", "Starting", "Setting up the microphone", "Starting", true],
    ["listening", "Listening", "Phone microphone, since", "Hold to stop", false],
    ["interrupted", "Paused by another app", "Will resume automatically", "Hold to stop", false],
    ["stalled", "Stopped listening", "No audio reaching Garrison since", "Resume", false],
    ["failed", "Microphone unavailable", "Could not start the microphone (engine_error)", "Try again", false]
  ] as const)("renders %s copy", (actual, label, sub, button, disabled) => {
    const copy = listeningCopy(record(actual, actual === "failed" ? "engine_error" : null));
    expect(copy).toMatchObject({ label, button, disabled }); expect(copy.sub).toContain(sub);
  });
  it("offers Settings for denied permission and uses pendant copy", () => {
    expect(listeningCopy(record("failed", "permission_denied")).sub).toBe("Microphone permission is off. Open Settings.");
    expect(listeningCopy({ ...record("starting"), source: "pendant" }).sub).toBe("Connecting to the pendant");
    expect(listeningCopy({ ...record("off"), source: "pendant" }).sub).toBe("Pendant is off");
  });
  it("shows the requested start time when no audio ever arrived", () => {
    const state = { ...record("stalled"), last_seen_at: null };
    expect(listeningCopy(state).sub).toBe(`No audio reaching Garrison since ${new Date(state.intent_changed_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`);
  });
  it("hides the badge only when every source is off", () => {
    expect(listeningBadge([record("off"), { ...record("off"), source: "pendant" }])).toBeNull();
    for (const actual of ["starting", "interrupted"] as const) expect(listeningBadge([record(actual)])?.label).toBe("Paused");
    for (const actual of ["stalled", "failed"] as const) expect(listeningBadge([record(actual)])?.label).toBe("Stopped");
    expect(listeningBadge([record("listening")])?.label).toBe("Listening");
  });
  it("cancels a one-second hold and completes only at 1500 ms", () => {
    vi.useFakeTimers(); const hold = new ListeningHold(); const done = vi.fn();
    hold.start(done); vi.advanceTimersByTime(1000); hold.cancel(); vi.advanceTimersByTime(1000); expect(done).not.toHaveBeenCalled();
    hold.start(done); vi.advanceTimersByTime(1499); expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(done).toHaveBeenCalledTimes(1); expect(hold.completed).toBe(true);
    vi.advanceTimersByTime(3000); expect(done).toHaveBeenCalledTimes(1);
  });
});
