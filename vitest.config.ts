import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: true,
    // Many tests legitimately spawn real subprocesses (scheduler daemon, own-port
    // fittings, local_command steps) and wait on signals + filesystem state. Under the
    // default forks-pool parallelism (plus a live dev server on this machine) the 5s
    // default is too tight and those tests flake on "Test timed out in 5000ms" — purely
    // CPU starvation, they pass in isolation. 20s matches the explicit per-test timeouts
    // the heavy tests already carry; the ~1350 fast tests are unaffected (they finish in
    // <100ms either way). A genuinely hung test still fails, just 15s later.
    testTimeout: 20000
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname
    }
  }
});
