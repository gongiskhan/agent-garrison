import { test, expect } from '@playwright/test';
test('Sharing explains ownership, disables unavailable primitives and saves toggles', async ({ page }, info) => {
  let shared = ['claude-code'];
  await page.route('**/api/fittings/basic-memory/sharing?*', route => route.fulfill({ json: { runtimes: ['claude-code', 'codex', 'gemini'], shared, available: { 'claude-code': true, codex: true, gemini: false } } }));
  await page.route('**/api/muster/standing/config', route => {
    const body = route.request().postDataJSON();
    expect(body.fittingId).toBe('basic-memory'); shared = body.shared;
    return route.fulfill({ json: {} });
  });
  await page.goto('/fitting/basic-memory');
  const section = page.getByTestId('fitting-sharing-basic-memory');
  await expect(section.getByRole('heading', { name: 'Sharing' })).toBeVisible();
  await expect(section).toContainText('Sharing installs this fitting into your own config too (~/.claude, ~/.codex, ~/.gemini)');
  await expect(section.getByRole('switch', { name: 'Also available in your own Gemini sessions' })).toBeDisabled();
  await expect(section).toContainText('Nothing to share for Gemini');
  await section.getByRole('switch', { name: 'Also available in your own Codex sessions' }).check();
  await expect.poll(() => shared).toEqual(['claude-code', 'codex']);
  await section.getByRole('switch', { name: 'Also available in your own Codex sessions' }).uncheck();
  await expect.poll(() => shared).toEqual(['claude-code']);
  await expect(section.getByRole('switch', { name: 'Also available in your own Codex sessions' })).toBeEnabled();
  await section.screenshot({ path: info.outputPath('sharing.png') });
});
