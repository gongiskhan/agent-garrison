import {test, expect, goto} from './fixture';
test('creates a local folder and saves an edited markdown artifact', async ({page, app, request}) => {
  await goto(page, app, `/projects/${app.id}/workspace`);
  await page.getByRole('button', {name: 'New folder', exact: true}).click();
  const sheet = page.getByRole('dialog', {name: 'New folder', exact: true});
  await sheet.getByLabel('Folder name').fill('Synthetic folder'); await sheet.getByRole('button', {name: 'Create', exact: true}).click();
  await expect(page.locator('.projects-file-row').filter({hasText: 'Synthetic folder'})).toBeVisible();
  await page.locator('.projects-file-row').filter({hasText: 'documents'}).click();
  await page.locator('.projects-file-row').filter({hasText: '2026-09-13-note.md'}).click();
  await page.getByRole('button', {name: 'Edit', exact: true}).click();
  await page.getByLabel('File content', {exact: true}).fill('# Saved artifact\n\n- Synthetic saved item\n');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await expect(page.getByRole('heading', {name: 'Saved artifact', exact: true})).toBeVisible();
  const saved = await request.get(app.base + '/api/workspace/file?path=documents%2F2026-09-13-note.md');
  expect((await saved.json()).content).toBe('# Saved artifact\n\n- Synthetic saved item\n');
});
