// Next.js server-boot hook (requires experimental.instrumentationHook in
// next.config.mjs on Next 14). Runs once per server start: views toggled
// eager on /run boot now and rehydrate their persisted instances instead of
// waiting for first open.
//
// The boot work runs in a DETACHED tsx child (scripts/run-eager-boot.ts),
// not in-process: Next 14's webpack instrumentation compilation cannot
// handle node:-scheme imports anywhere in the import graph (every route
// 500s), and the eager-boot chain legitimately needs node:child_process.
// Only the bare "child_process" builtin is imported here, dynamically,
// which webpack externalises cleanly.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  // The e2e sandbox server sets this — its seeded GARRISON_HOME must not
  // spawn real fitting processes.
  if (process.env.GARRISON_DISABLE_EAGER_BOOT === "1") {
    return;
  }
  try {
    // webpackIgnore keeps the specifier out of EVERY webpack compilation
    // (instrumentation is also compiled for non-node contexts where builtins
    // don't resolve); at runtime this is a native dynamic import.
    const { spawn } = await import(/* webpackIgnore: true */ "node:child_process");
    const child = spawn("npx", ["tsx", "scripts/run-eager-boot.ts"], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
    console.log("[garrison] eager-boot runner spawned (logs: ~/.garrison/logs/eager-boot.log)");
  } catch (error) {
    // A failed boot must never take the server down with it.
    console.error("[garrison] eager-boot spawn failed; server continues:", error);
  }
}
