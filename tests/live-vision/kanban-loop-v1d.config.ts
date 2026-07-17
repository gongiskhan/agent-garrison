import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// Live-vision Playwright config for Kanban Loop V1d.
//
// Separate from the CI playwright.config.ts on purpose: the V1d brief requires
// the REAL composition up (real http-gateway on :24777, real Claude operative,
// real Next on :27777, real kanban-loop own-port board started by the runner).
// The CI config sandboxes ~/.claude and ~/.garrison and would silently use a
// fake homedir — exactly the failure mode V1d exists to prevent.
//
// Run it manually (the user must have brought `default` up first):
//   KANBAN_V1D_RUN_DIR=docs/autothing/runs/<runId> \
//   GARRISON_BASE_URL=http://127.0.0.1:27777 \
//   npx playwright test --config tests/live-vision/kanban-loop-v1d.config.ts
//
// Screenshots land under <KANBAN_V1D_RUN_DIR>/vision/ and the spec writes a
// numbered FINDINGS.md draft next to them; the operative must then read each
// PNG and confirm/edit the OK markers before the run prints KANBAN-LOOP-V1D OK.

const BASE_URL = process.env.GARRISON_BASE_URL || "http://127.0.0.1:27777";

export default defineConfig({
  testDir: path.resolve(__dirname),
  testMatch: /kanban-loop-v1d\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A real Plan turn through a real operative runs many minutes; give the spec
  // 30 minutes per test so one Plan dispatch can complete end-to-end.
  timeout: 30 * 60 * 1000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "test-results/kanban-loop-v1d",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "off", // the spec drives its own screenshot writes per state
    video: "off"
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    }
  ],
  // No webServer — the user's real Garrison is the server. Failing fast on
  // unreachable base URL is the right behavior (the spec's first step pings
  // /api/health to surface a clear "Garrison not running").
});
