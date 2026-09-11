import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sandbox = process.env.TWO_HOMES_SANDBOX || fs.mkdtempSync(path.join(os.tmpdir(), 'two-homes-browser-'));
process.env.TWO_HOMES_SANDBOX = sandbox;
const port = Number(process.env.GARRISON_E2E_PORT || 3491);
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'snapshots-restore-drill.spec.ts', workers: 1, retries: 0, timeout: 90000,
  outputDir: 'test-results/two-homes', reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, timezoneId: 'UTC', serviceWorkers: 'block', video: 'off', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }, { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } }],
  webServer: {
    command: 'bash scripts/garrison-instance.sh dev next', url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120000,
    env: { HOME: sandbox, PATH: `${path.resolve('node_modules/.bin')}:${process.env.PATH}`, GARRISON_HOME_OVERRIDE: path.join(sandbox, '.garrison-dev'), GARRISON_CLAUDE_HOME_OVERRIDE: path.join(sandbox, '.claude-dev'), GARRISON_STATE_HOME: path.join(sandbox, '.garrison-state'), GARRISON_APP_PORT: String(port), GARRISON_STATE_URL: '', GARRISON_STATE_TOKEN: '', NEXT_DIST_DIR: '.next-two-homes', GARRISON_ASSUME_INSTALLED: '1' }, stdout: 'ignore', stderr: 'pipe'
  }
});
