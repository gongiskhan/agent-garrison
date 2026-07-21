import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import { CLAUDE_SANDBOX, GARRISON_SANDBOX } from "./tests/e2e/sandbox";

const TEST_STATE_DIR = path.join(os.homedir(), ".garrison-test");
const TEST_STATE_FILE = path.join(TEST_STATE_DIR, "state.json");
const PORT = Number(process.env.GARRISON_E2E_PORT ?? 3401);

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false, // serialise — shared dev server
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/playwright-report" }]],
  outputDir: "test-results/playwright-artifacts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // opt-in flow video capture (evidence): GARRISON_E2E_VIDEO=1
    video: process.env.GARRISON_E2E_VIDEO === "1" ? "on" : "off"
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
    },
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } }
    },
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      }
    }
  ],
  webServer: {
    command: `npx next dev --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    // Never reuse a stray server on this port: an externally-started process
    // may run with the live ~/.claude and the shared .next/ dist dir, which is
    // exactly what the sandbox env + NEXT_DIST_DIR isolation exist to prevent.
    // A busy port fails fast instead of silently testing the wrong server.
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      GARRISON_STATE_PATH: TEST_STATE_FILE,
      GARRISON_CLAUDE_HOME: CLAUDE_SANDBOX,
      GARRISON_HOME: GARRISON_SANDBOX,
      // Two `next dev` processes sharing one .next/ poison each other's route
      // cache (the live launchd server owns .next/), so the e2e sandbox server
      // gets its own dist dir. next.config.mjs reads this env var.
      NEXT_DIST_DIR: ".next-e2e",
      NODE_ENV: process.env.NODE_ENV ?? "development"
    },
    stdout: "ignore",
    stderr: "pipe"
  }
});
