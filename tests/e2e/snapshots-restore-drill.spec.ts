import { test, expect } from '@playwright/test';
const fixture = { at: '2026-09-15T05:00:12Z', ok: true, state: { ageHours: 2, restored: { cards: 1412, cardDocs: 3906 }, live: { cards: 1412, cardDocs: 3907 } }, restic: { ageHours: 2.1, conversations: { restored: 318, live: 319 } }, failures: [] as string[] };
for (const state of ['never', 'ok', 'failed'] as const) {
  test(`restore drill ${state}`, async ({ page }, info) => {
    await page.route('**/api/snapshots/status', route => route.fulfill({ json: { state: null, repository: 'fixture', snapshots: [], restoreHint: '', restoreDrill: state === 'never' ? null : { ...fixture, ok: state === 'ok', failures: state === 'failed' ? ['cards: live minus restored 6 exceeds tolerance 5'] : [] }, scheduling: { nodes: [{ node: 'fixture-node', path: 'scheduler', backup: null, prune: null }] } } }));
    await page.goto('/fitting/snapshots-default');
    const panel = page.locator('section').filter({ has: page.getByText('Restore drill', { exact: true }) });
    await expect(panel.getByRole('button', { name: 'Run drill now' })).toBeVisible();
    if (state === 'never') await expect(panel).toContainText('Restore drill has not run yet.');
    else {
      await expect(panel).toContainText(`Last run: 15 Sep 2026, 05:00 · ${state}`);
      await expect(panel).toContainText('Cards 1412 (live 1412) · Card docs 3906 (live 3907) · Conversations 318 (live 319)');
      await expect(panel).toContainText('State snapshot 2h old · Restic snapshot 2h old');
      if (state === 'failed') await expect(panel).toContainText('cards: live minus restored 6 exceeds tolerance 5');
    }
    await panel.screenshot({ path: info.outputPath(`${state}.png`) });
    await page.route('**/api/snapshots/restore-drill', async route => { await new Promise(r => setTimeout(r, 250)); await route.fulfill({ contentType: 'text/plain', body: 'Verified state snapshot fixture\nRestore drill ok\n' }); });
    await panel.getByRole('button', { name: 'Run drill now' }).click();
    await expect(panel.getByRole('button', { name: 'Running drill…' })).toBeDisabled();
    await expect(panel.getByRole('status')).toContainText('Restore drill ok');
  });
}
