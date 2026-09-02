import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // No `include` here on purpose: vitest.workspace.ts splits the suite into
    // two projects that `extends` this file, and extending CONCATENATES arrays,
    // so an include here would put every test into both projects. Each project
    // declares its own.
    setupFiles: ["./tests/setup.ts"],
    globals: true,
    // Many tests legitimately spawn real subprocesses (scheduler daemon, own-port
    // fittings, local_command steps) and wait on signals + filesystem state. Under the
    // default forks-pool parallelism (plus a live dev server on this machine) the 5s
    // default is too tight and those tests flake on "Test timed out in 5000ms" — purely
    // CPU starvation, they pass in isolation. 20s matches the explicit per-test timeouts
    // the heavy tests already carry; the ~1350 fast tests are unaffected (they finish in
    // <100ms either way). A genuinely hung test still fails, just 15s later.
    testTimeout: 20000,
    // The same starvation hits beforeAll/afterAll: the fixture suites launch a
    // real Chromium behind an own-port server and wait for it to exit on
    // teardown. Under the full parallel run those hooks blow the 10s default
    // ("Hook timed out in 10000ms") while every test inside them passes, and
    // pass again in isolation. 30s covers the observed worst case with room;
    // a hook that is truly stuck still fails.
    hookTimeout: 30000
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname
    }
  }
});
