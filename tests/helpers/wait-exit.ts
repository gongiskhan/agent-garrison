import type { ChildProcess } from "node:child_process";

// Wait for a spawned fixture server to actually EXIT (SIGKILL as a last
// resort) before removing its sandbox GARRISON_HOME. browser-default's
// chromium now keeps a persistent profile under that home and flushes it
// during shutdown - an rmSync racing those writes dies with ENOTEMPTY, and a
// SIGKILL'd server leaves an orphaned chromium still writing there.
// 12s default: below the common 15s afterAll budget, above the server's own
// graceful-chromium hold in the normal case (sub-second; the 15s cap in
// shutdownChromium is a loaded-box worst case).
export function waitExit(child: ChildProcess | null, ms = 12000): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve();
    }, ms);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
