import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import os from "node:os";

const TEST_STATE_DIR = path.join(os.homedir(), ".garrison-test");
const TEST_STATE_FILE = path.join(TEST_STATE_DIR, "state.json");
const PORT = Number(process.env.GARRISON_E2E_PORT ?? 3401);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // serialise — shared dev server
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/playwright-report" }]],
  outputDir: "test-results/playwright-artifacts",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
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
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      GARRISON_STATE_PATH: TEST_STATE_FILE,
      GARRISON_WORKBENCH_PREFS_PATH: path.join(TEST_STATE_DIR, "workbench-prefs.json"),
      NODE_ENV: process.env.NODE_ENV ?? "development"
    },
    stdout: "ignore",
    stderr: "pipe"
  }
});
