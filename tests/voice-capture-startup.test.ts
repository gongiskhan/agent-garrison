import { afterEach, describe, expect, it, vi } from "vitest";
import { startCapture } from "../packages/talk/ui/voice-clip";

function browserCapture(options: { permissionError?: boolean; resume?: "reject" | "pending" | "suspended"; recorderFailAt?: number } = {}) {
  vi.useFakeTimers();
  const order: string[] = [];
  const track = new EventTarget() as EventTarget & { stop: ReturnType<typeof vi.fn> };
  track.stop = vi.fn();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const analyser = { fftSize: 1024, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) };
  const contexts: FakeAudio[] = [];
  class FakeAudio {
    state = "suspended";
    onstatechange: (() => void) | null = null;
    constructor() { order.push("context"); contexts.push(this); }
    resume = vi.fn(() => {
      order.push("resume");
      if (options.resume === "reject") return Promise.reject(new Error("audio resume denied"));
      if (options.resume === "pending") return new Promise<void>(() => {});
      if (options.resume !== "suspended") this.state = "running";
      return Promise.resolve();
    });
    close = vi.fn(async () => { this.state = "closed"; });
    createMediaStreamSource = vi.fn(() => source);
    createAnalyser = vi.fn(() => analyser);
  }
  const recorders: FakeRecorder[] = [];
  class FakeRecorder {
    static isTypeSupported = () => true;
    state = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { recorders.push(this); }
    start = vi.fn(() => {
      if (recorders.length === options.recorderFailAt) throw new Error("recorder refused microphone");
      this.state = "recording";
      order.push("recording");
    });
    stop = vi.fn(() => {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["synthetic microphone audio"], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
  const getUserMedia = vi.fn(async () => {
    order.push("permission");
    if (options.permissionError) throw new Error("microphone permission denied");
    return stream;
  });
  vi.stubGlobal("window", { isSecureContext: true, AudioContext: FakeAudio, MediaRecorder: FakeRecorder,
    setTimeout, clearTimeout, setInterval, clearInterval });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  const callbacks = { onReady: vi.fn(() => order.push("ready")), onError: vi.fn(), onClose: vi.fn(), onFinal: vi.fn() };
  return { contexts, recorders, track, source, getUserMedia, callbacks, order };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("microphone capture activation and cleanup", () => {
  it("resumes audio in the original gesture before permission, and sends the phone clip after recording starts", async () => {
    const f = browserCapture();
    const fetchClip = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ transcript: "Phone microphone works" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchClip);
    const handle = await startCapture(f.callbacks, { mode: "ptt", language: "en" });
    expect(f.order).toEqual(["context", "resume", "permission", "recording", "ready"]);
    expect(f.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    handle.finish();
    await vi.runAllTimersAsync();
    expect(fetchClip).toHaveBeenCalledOnce();
    expect(fetchClip.mock.calls[0][0]).toBe("/api/voice/stt?language=en");
    expect(f.callbacks.onFinal).toHaveBeenCalledWith("Phone microphone works");
    expect(f.track.stop).toHaveBeenCalled();
    handle.stop();
    expect(f.contexts[0].close).toHaveBeenCalledOnce();
  });

  it.each(["reject", "suspended"] as const)("rejects %s audio activation instead of announcing a silent live recorder", async (resume) => {
    const f = browserCapture({ resume });
    await expect(startCapture(f.callbacks)).rejects.toThrow(resume === "reject" ? "audio resume denied" : "Microphone audio is paused");
    expect(f.callbacks.onReady).not.toHaveBeenCalled();
    expect(f.recorders).toHaveLength(0);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.contexts[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out unresolved activation after permission without retaining a microphone", async () => {
    const f = browserCapture({ resume: "pending" });
    const result = startCapture(f.callbacks);
    const rejected = expect(result).rejects.toThrow("Microphone audio could not start");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(f.callbacks.onReady).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.contexts[0].close).toHaveBeenCalledOnce();
  });

  it("closes the unlocked context when microphone permission is denied", async () => {
    const f = browserCapture({ permissionError: true });
    await expect(startCapture(f.callbacks)).rejects.toThrow("microphone permission denied");
    expect(f.callbacks.onReady).not.toHaveBeenCalled();
    expect(f.contexts[0].close).toHaveBeenCalledOnce();
  });

  it("rejects recorder startup failure and releases every browser resource without onReady", async () => {
    const f = browserCapture({ recorderFailAt: 1 });
    await expect(startCapture(f.callbacks)).rejects.toThrow("recorder refused microphone");
    expect(f.callbacks.onReady).not.toHaveBeenCalled();
    expect(f.source.disconnect).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.contexts[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["recorder", "track", "audio-context"] as const)("closes and reports a %s interruption so dictation can restart", async (kind) => {
    const f = browserCapture();
    const handle = await startCapture(f.callbacks);
    if (kind === "recorder") f.recorders[0].onerror?.();
    if (kind === "track") f.track.dispatchEvent(new Event("ended"));
    if (kind === "audio-context") { f.contexts[0].state = "interrupted"; f.contexts[0].onstatechange?.(); }
    expect(handle.closed).toBe(true);
    expect(f.callbacks.onError).toHaveBeenCalledOnce();
    expect(f.callbacks.onClose).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.contexts[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up when a later segment cannot start instead of leaving a live empty loop", async () => {
    const f = browserCapture({ recorderFailAt: 2 });
    const handle = await startCapture(f.callbacks, { idleRestartMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(handle.closed).toBe(true);
    expect(f.callbacks.onError).toHaveBeenCalledWith("recorder refused microphone");
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
