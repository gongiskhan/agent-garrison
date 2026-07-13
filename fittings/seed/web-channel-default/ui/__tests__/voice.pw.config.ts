// Dedicated Playwright config for the S6b fake-media voice test. Deliberately
// standalone — no webServer (the test spins up its own http + mock-relay server)
// and Chromium fake-media flags so getUserMedia returns a synthetic stream. Kept
// out of the repo's main tests/e2e suite (which boots Next) so this hermetic test
// runs fast in isolation:  npx playwright test -c <this file>
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: __dirname,
  testMatch: /voice-capture\.pw\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});
