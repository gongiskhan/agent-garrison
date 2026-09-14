import {test, expect, goto} from './fixture';
test('refuses project writes and offers Edit only for local Garrison files', async ({page, app, request}) => {
  const expected = {error: 'project trees are read-only; changes move through git'};
  const file = await request.put(app.base + '/api/projects/alpha/file', {data: {path: 'README.md', content: 'refused'}});
  expect(file.status()).toBe(403); expect(await file.json()).toEqual(expected);
  const folder = await request.post(app.base + '/api/projects/alpha/mkdir', {data: {path: 'refused'}});
  expect(folder.status()).toBe(403); expect(await folder.json()).toEqual(expected);
  await goto(page, app, `/projects/${app.id}/alpha/files?path=README.md`);
  await expect(page.locator('.projects-viewer')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Edit', exact: true})).toHaveCount(0);
  await goto(page, app, `/projects/${app.id}/workspace?path=documents%2F2026-09-13-note.md`);
  await expect(page.getByRole('button', {name: 'Edit', exact: true})).toBeVisible();
});
