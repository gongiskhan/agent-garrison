import type { ChildProcess } from "node:child_process";

// Wait for a spawned fixture server to actually EXIT (SIGKILL as a last
// resort) before removing its sandbox GARRISON_HOME. browser-default's
// chromium now keeps a persistent profile under that home and flushes it
// during shutdown - an rmSync racing those writes dies with ENOTEMPTY, and a
// SIGKILL'd server leaves an orphaned chromium still writing there.
// 12s default: below the common 15s afterAll budget, above the server's own
// graceful-chromium hold in the normal case (sub-second; the 15s cap in
// shutdownChromium is a loaded-box worst case).
//
// Returns TRUE when the child exited on its own and FALSE when the SIGKILL
// fallback was needed. Callers that only need the sandbox to be safe to delete
// can ignore it; callers asserting "the shutdown did not hang" must use it
// rather than reading child.exitCode/signalCode, because those fields are still
// null immediately after kill() - the exit is delivered asynchronously, so an
// assertion in the same tick reads a process that has been signalled but not
// yet reaped and concludes, wrongly, that it never died.
export function waitExit(child: ChildProcess | null, ms = 12000): Promise<boolean> {
  return new Promise((resolve) => {
    if (!child) return resolve(true);
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);

    let settled = false;
    const finish = (exitedOnItsOwn: boolean) => {
      if (settled) return;
      settled = true;
      resolve(exitedOnItsOwn);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // Give the kernel a moment to deliver the exit so the child is REAPED
      // before we return. Without this the caller races an unreaped process:
      // it may rmSync the sandbox while the dying child still holds it, and
      // exitCode/signalCode are both still null.
      const reap = setTimeout(() => finish(false), 2000);
      child.once("exit", () => {
        clearTimeout(reap);
        finish(false);
      });
    }, ms);

    child.once("exit", () => {
      clearTimeout(timer);
      finish(true);
    });
  });
}
