import {test, expect, goto, checkpoint} from './fixture';
test('shows the self group, confined projects, summaries and a case-insensitive filter', async ({page, app}, info) => {
  await goto(page, app);
  const group = page.locator('.projects-node-group');
  await expect(group).toHaveCount(1); await expect(group).toHaveAttribute('data-node', app.id);
  await expect(group.locator('.projects-picker-row').first()).toContainText('Garrison files');
  await expect(group.getByRole('link').filter({hasText: /^alpha/})).toContainText('main, 3 changed, 1 ahead');
  await expect(group.getByRole('link').filter({hasText: /^beta/})).toContainText('main');
  await expect(group.getByRole('link', {name: /gamma|sneaky/})).toHaveCount(0);
  await checkpoint(page, info, 'picker', app);
  await page.getByPlaceholder('Filter projects').fill('ALPHA');
  await expect(group.getByRole('link')).toHaveCount(1);
  await page.getByPlaceholder('Filter projects').fill('nothing matches'); await expect(group).toHaveCount(0);
  await page.getByPlaceholder('Filter projects').fill('FIXTURE A'); await expect(group.getByRole('link')).toHaveCount(3);
});
