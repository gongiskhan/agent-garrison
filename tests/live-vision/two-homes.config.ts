import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
const baseURL = process.env.GARRISON_BASE_URL;
if (!baseURL || !process.env.TWO_HOMES_SANDBOX) throw new Error('GARRISON_BASE_URL and TWO_HOMES_SANDBOX are required');
export default defineConfig({ testDir: __dirname, testMatch: 'two-homes.spec.ts', workers: 1, retries: 0, timeout: 600000, expect: { timeout: 30000 }, outputDir: path.resolve('test-results/two-homes-live'), reporter: [['list']], use: { baseURL, video: 'off', trace: 'off', serviceWorkers: 'block' }, projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }] });
