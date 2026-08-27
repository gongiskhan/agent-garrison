// Standalone Playwright config for the remote-shell terminal E2E. Hermetic:
// the test boots the REAL fitting server (against a temp GARRISON_HOME and an
// ssh-to-localhost transport) and drives its own UI in Chromium. Kept out of
// the repo's main suite; run with:
//   npx playwright test -c fittings/seed/remote-shell-runtime/ui/__tests__/terminal.pw.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: __dirname,
  testMatch: /terminal\.pw\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"]
  }
});
