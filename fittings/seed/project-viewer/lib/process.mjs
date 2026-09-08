import { spawn } from "node:child_process";

/** Bounded subprocess with process-group cancellation, including descendants that
 * retain stdout after their parent exits. Output is never silently truncated.
 */
export function runProcess(command, args, { cwd, env = process.env, timeoutMs = 30_000,
  maxBytes = 8 * 1024 * 1024, keepLine = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", pending = "", failure = null, forceTimer;
    const kill = signal => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const stop = reason => {
      if (failure) return;
      failure = new Error(reason);
      kill("SIGTERM");
      forceTimer = setTimeout(() => {
        kill("SIGKILL");
        child.stdout.destroy(); child.stderr.destroy();
        clearTimeout(timer);
        reject(failure);
      }, 150);
    };
    const timer = setTimeout(() => stop("subprocess deadline exceeded"), timeoutMs);
    const append = text => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(text) > maxBytes) stop("subprocess output limit exceeded");
      else stdout += text;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (failure) return;
      if (!keepLine) return append(chunk);
      pending += chunk;
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) if (keepLine(line)) append(`${line}\n`);
      if (Buffer.byteLength(pending) > 1024 * 1024) stop("subprocess line limit exceeded");
    });
    child.stderr.on("data", chunk => {
      if (Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > maxBytes) stop("subprocess error output limit exceeded");
      else stderr += chunk;
    });
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); };
    child.once("error", err => { cleanup(); reject(err); });
    child.once("close", code => {
      if (pending && keepLine?.(pending)) append(`${pending}\n`);
      // Kill any remaining members even when the parent exited promptly on TERM.
      if (failure) kill("SIGKILL");
      cleanup();
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}
