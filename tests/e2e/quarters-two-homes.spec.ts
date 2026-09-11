import { test, expect } from '@playwright/test';
test('separate homes show Shared and Leak ownership with scoped quarantine', async ({ page }, info) => {
  const rows = [
    { id: 'skill:skills/memory', kind: 'skill', ref: 'skills/memory', name: 'memory', sharedOwner: 'basic-memory', canPromote: false },
    { id: 'skill:skills/garrison-old', kind: 'skill', ref: 'skills/garrison-old', name: 'garrison-old', leak: { runtime: 'claude-code', kind: 'skill', name: 'garrison-old', ref: 'skills/garrison-old', reason: 'legacy-name' }, canPromote: false },
    { id: 'skill:skills/mine', kind: 'skill', ref: 'skills/mine', name: 'my-notes', canPromote: true }
  ];
  await page.route('**/api/quarters/user**', route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ runtime: 'claude-code', action: 'quarantine', id: 'skill:skills/garrison-old' });
      rows.splice(1, 1); return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { runtime: 'claude-code', rows, checkedAt: new Date().toISOString() } });
  });
  await page.goto('/quarters');
  await expect(page.getByRole('tab', { name: 'Garrison home' })).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: info.outputPath('garrison-home.png') });
  await page.getByRole('tab', { name: 'Your Claude Code' }).click();
  const panel = page.getByTestId('user-home-claude-code');
  await expect(panel).toContainText('Garrison does not manage this config. Everything here is yours.');
  await expect(panel).toContainText('Shared · basic-memory');
  await expect(panel.getByText('Leak', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Promote to fitting' })).toBeVisible();
  await panel.screenshot({ path: info.outputPath('your-config.png') });
  await panel.getByRole('button', { name: 'Quarantine', exact: true }).click();
  await expect(panel.getByText('garrison-old', { exact: true })).toHaveCount(0);
  await expect(panel).toContainText('my-notes');
});

test('Mesh reports leaks and quarantines the current report', async ({ page }, info) => {
  const leak = { runtime: 'claude-code', kind: 'skill', ref: 'skills/garrison-old', name: 'garrison-old', reason: 'legacy-name' };
  const report = { ok: false, checkedAt: new Date().toISOString(), leaks: [leak], sharedOwners: ['basic-memory'] };
  await page.route('**/api/mesh/nodes', route => route.fulfill({ json: { nodes: [{ id: 'fixture-node', name: 'fixture-node', accentColor: '#287d62', platform: 'linux', state: 'ready', isSelf: true, registered: true, lastSeenAt: new Date().toISOString(), health: { homes: { garrison: '/sandbox/runtime-homes/claude', leaks: 1, checkedAt: new Date().toISOString() } } }] } }));
  await page.route('**/api/mesh/nodes/*/sessions', route => route.fulfill({ json: { sessions: [] } }));
  await page.route('**/api/install/leaks', route => route.fulfill({ json: report }));
  await page.route('**/api/install', route => route.fulfill({ json: { homes: { ...report, ok: true, leaks: [] } } }));
  await page.goto('/mesh');
  await page.getByRole('button', { name: 'Leaks: 1' }).click();
  const dialog = page.getByRole('dialog', { name: 'Homes on fixture-node' });
  await expect(dialog).toContainText('skill · garrison-old · legacy-name');
  await dialog.screenshot({ path: info.outputPath('mesh-leaks.png') });
  await dialog.getByRole('button', { name: 'Quarantine all' }).click();
  await expect(dialog).toContainText('Homes ok');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: 'Homes ok' })).toBeVisible();
});
