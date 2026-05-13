// Screen-share capture loop. Adapted from
// /Users/ggomes/Projects/harmonika-all/lib/screen/capture.ts.
// Garrison v1 simplifications:
//   - macOS primary display only (drop -D selector + displays helper)
//   - Linux path retained verbatim (mac-first; Linux untested in T6)
//   - Lock file path renamed to /tmp/garrison-screen-running.lock so
//     Garrison and Harmonika don't fight if both run
//
// Public API:
//   startCapture() / stopCapture() / getCaptureState() /
//   getScreenshotPath() / hasRecentScreenshot()

import { spawn, type ChildProcess, execSync } from "node:child_process";
import { existsSync, statSync, writeFileSync, unlinkSync } from "node:fs";

const SCREENSHOT_PATH = "/tmp/garrison-screen-latest.jpg";
const RUNNING_LOCK_PATH = "/tmp/garrison-screen-running.lock";
const CAPTURE_INTERVAL_MS = 1_000;
const IS_LINUX = process.platform === "linux";
const IS_MACOS = process.platform === "darwin";

interface CaptureState {
  running: boolean;
  permissionGranted: boolean;
  lastError: string | null;
  lastCaptureAt: number | null;
}

let captureInterval: ReturnType<typeof setInterval> | null = null;
let captureProcess: ChildProcess | null = null;
const state: CaptureState = {
  running: false,
  permissionGranted: true,
  lastError: null,
  lastCaptureAt: null,
};

// Remove any stale lock from a previous Garrison process.
removeRunningLock();

function createRunningLock(): void {
  try {
    writeFileSync(RUNNING_LOCK_PATH, Date.now().toString(), "utf8");
  } catch {
    // ignore
  }
}

function removeRunningLock(): void {
  try {
    if (existsSync(RUNNING_LOCK_PATH)) unlinkSync(RUNNING_LOCK_PATH);
  } catch {
    // ignore
  }
}

function isRunningFromLock(): boolean {
  try {
    if (!existsSync(RUNNING_LOCK_PATH)) return false;
    const stats = statSync(RUNNING_LOCK_PATH);
    return Date.now() - stats.mtimeMs < 5_000;
  } catch {
    return false;
  }
}

function getLinuxDisplay(): string {
  return process.env.DISPLAY || ":99";
}

function captureMacOS(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    captureProcess = spawn("screencapture", ["-x", "-t", "jpg", SCREENSHOT_PATH]);
    let stderr = "";
    captureProcess.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    captureProcess.on("close", (code) => {
      captureProcess = null;
      if (code === 0 && existsSync(SCREENSHOT_PATH) && statSync(SCREENSHOT_PATH).size > 0) {
        state.lastCaptureAt = Date.now();
        state.permissionGranted = true;
        state.lastError = null;
        resolve({ success: true });
        return;
      }
      const errorLower = stderr.toLowerCase();
      const looksLikePermission =
        errorLower.includes("cannot capture") ||
        errorLower.includes("could not create image") ||
        errorLower.includes("not permitted");
      const permError = looksLikePermission
        ? "Screen Recording permission required. Open System Settings → Privacy & Security → Screen Recording and enable the app that started Garrison (Terminal / iTerm / Claude Code), then restart it."
        : stderr || `screencapture exited code=${code}`;
      state.permissionGranted = false;
      state.lastError = permError;
      resolve({ success: false, error: permError });
    });
    captureProcess.on("error", (err) => {
      captureProcess = null;
      state.lastError = err.message;
      resolve({ success: false, error: err.message });
    });
  });
}

function captureLinux(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let cmd: string;
    let args: string[];
    try {
      execSync("which scrot");
      cmd = "scrot";
      args = ["-o", "-q", "85", SCREENSHOT_PATH];
    } catch {
      try {
        execSync("which import");
        cmd = "import";
        args = ["-window", "root", "-quality", "85", SCREENSHOT_PATH];
      } catch {
        resolve({ success: false, error: "No screenshot tool found. Install scrot or imagemagick." });
        return;
      }
    }
    const env = { ...process.env, DISPLAY: getLinuxDisplay() };
    captureProcess = spawn(cmd, args, { env });
    let stderr = "";
    captureProcess.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    captureProcess.on("close", (code) => {
      captureProcess = null;
      if (code === 0 && existsSync(SCREENSHOT_PATH) && statSync(SCREENSHOT_PATH).size > 0) {
        state.lastCaptureAt = Date.now();
        state.permissionGranted = true;
        state.lastError = null;
        resolve({ success: true });
        return;
      }
      const errorMsg = stderr || `${cmd} exited code=${code}`;
      state.lastError = errorMsg;
      resolve({ success: false, error: errorMsg });
    });
    captureProcess.on("error", (err) => {
      captureProcess = null;
      state.lastError = err.message;
      resolve({ success: false, error: err.message });
    });
  });
}

async function captureOnce(): Promise<{ success: boolean; error?: string }> {
  if (IS_MACOS) return captureMacOS();
  if (IS_LINUX) return captureLinux();
  return { success: false, error: `Unsupported platform: ${process.platform}` };
}

export async function startCapture(): Promise<{ success: boolean; error?: string }> {
  if (state.running) return { success: true };
  const first = await captureOnce();
  if (!first.success) return first;
  state.running = true;
  createRunningLock();
  captureInterval = setInterval(() => {
    if (state.running) {
      createRunningLock();
      void captureOnce();
    }
  }, CAPTURE_INTERVAL_MS);
  return { success: true };
}

export async function stopCapture(): Promise<void> {
  state.running = false;
  removeRunningLock();
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  if (captureProcess) {
    try {
      captureProcess.kill();
    } catch {
      // ignore
    }
    captureProcess = null;
  }
}

export function getCaptureState(): CaptureState {
  return { ...state };
}

export function getScreenshotPath(): string {
  return SCREENSHOT_PATH;
}

export function hasRecentScreenshot(): boolean {
  try {
    if (!existsSync(SCREENSHOT_PATH)) return false;
    const stats = statSync(SCREENSHOT_PATH);
    return Date.now() - stats.mtimeMs < CAPTURE_INTERVAL_MS * 3;
  } catch {
    return false;
  }
}
