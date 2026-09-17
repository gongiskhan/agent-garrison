import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { judgeScreenshot } from './two-homes-vision';
const execute = promisify(execFile);
let root: string, receipt: any;
test.beforeAll(async ({ request }) => {
  root = process.env.TWO_HOMES_SANDBOX!;
  if (!root || !(await fs.realpath(root)).startsWith(await fs.realpath(os.tmpdir()) + path.sep)) throw new Error('Live vision requires the prepared temporary home');
  receipt = JSON.parse(await fs.readFile(path.join(root, 'acceptance.json'), 'utf8'));
  expect(receipt.state.version).toBe(2); expect(receipt.state.report.leaks).toBe(0);
  expect((await request.get('/api/install/leaks')).ok()).toBe(true);
});
test('real migrated homes, user skill listing and Mesh status', async ({ page }, info) => {
  await page.goto('/quarters'); await page.getByRole('tab', { name: 'Garrison home', exact: true }).click();
  await expect(page.getByText('loading…', { exact: true })).toBeHidden();
  const runtimeToggle = page.getByTestId('quarters-section-toggle-claude-code-runtime');
  if (await runtimeToggle.count() && await runtimeToggle.getAttribute('aria-expanded') !== 'true') await runtimeToggle.click();
  await expect(page.getByTestId('quarters-grid')).toBeVisible();
  const managedShot = info.outputPath('garrison-home.png'); await page.screenshot({ path: managedShot, fullPage: true });
  await judgeScreenshot(managedShot, 'Quarters shows the Garrison home tab selected and a distinct Your Claude Code tab. The config categories are visible and readable.', info);
  await page.getByRole('tab', { name: 'Your Claude Code', exact: true }).click();
  const panel = page.getByTestId('user-home-claude-code'); await expect(panel).toContainText('my-notes'); await expect(panel).toContainText('Shared · basic-memory');
  const userShot = info.outputPath('your-code.png'); await panel.screenshot({ path: userShot });
  await judgeScreenshot(userShot, 'Visible banner: Garrison does not manage this config. Everything here is yours. Items marked Shared were installed by a Garrison fitting and are removed when you unshare it or uninstall Garrison. A Shared · basic-memory chip and my-notes row are visible. No Leak chip.', info);
  await page.goto('/mesh'); await expect(page.getByRole('button', { name: 'Homes ok' })).toBeVisible();
  const meshShot = info.outputPath('mesh-homes.png'); await page.screenshot({ path: meshShot, fullPage: true });
  await judgeScreenshot(meshShot, 'The Mesh page has a readable node row and a green Homes ok control.', info);
  // The explicit shared memory skill keeps its shipped name. All unshared
  // discipline skills must be absent from the user's sandbox.
  const skills = await fs.readdir(path.join(root, '.claude/skills'));
  expect(skills.filter(name => /^(garrison|autothing)/.test(name))).toEqual(['garrison-memory']);
  expect(await fs.readFile(path.join(root, '.claude/skills/my-notes/SKILL.md'), 'utf8')).toContain('Keep these user notes.');
  const cli = await execute('claude', ['mcp', 'list'], { cwd: root, env: { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: undefined, GARRISON_CLAUDE_HOME: path.join(root, '.claude'), GARRISON_CLAUDE_JSON: path.join(root, '.claude.json') }, timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  await info.attach('user-mcp-list', { body: cli.stdout, contentType: 'text/plain' }); expect(cli.stdout).toContain('basic-memory');
  expect((await fs.readdir(path.join(receipt.managed, 'skills')))).toContain('garrison-implement');
});
