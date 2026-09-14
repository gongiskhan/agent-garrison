import {test, expect, goto, checkpoint} from './fixture';
test('shows changes and a diff, then commits, pushes and fetches without force', async ({page, app}, info) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/projects/alpha/git/*', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); expect(body).not.toHaveProperty('force'); bodies.push(body);
    }
    await route.continue();
  });
  await goto(page, app, `/projects/${app.id}/alpha/git`);
  const strip = page.locator('.projects-status-strip');
  await expect(strip).toContainText('main'); await expect(strip).toContainText('1 ahead'); await expect(strip).toContainText('3 changed');
  await expect(page.locator('.projects-change-row')).toHaveCount(3);
  await expect(page.locator('.projects-commit-row')).toHaveCount(2);
  await checkpoint(page, info, 'git', app);
  await page.locator('.projects-change-row').filter({hasText: 'docs/deep/note.md'}).click();
  await expect(page.locator('.projects-diff-added').filter({hasText: 'Updated line'})).toHaveCount(1);
  await expect(page.locator('.projects-diff-removed').filter({hasText: 'Original line'})).toHaveCount(1);
  expect(await page.locator('.projects-diff-added').first().evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(await page.locator('.projects-diff-removed').first().evaluate(element => getComputedStyle(element).backgroundColor));
  await expect(page.locator('.projects-diff-number').first()).toBeAttached();
  const scrolling = await page.getByRole('region', {name: 'Unified diff'}).evaluate(element => {
    const before = window.scrollX;
    element.scrollLeft = element.scrollWidth;
    const result = {overflows: element.scrollWidth > element.clientWidth, moved: element.scrollLeft, page: window.scrollX - before};
    element.scrollLeft = 0;
    return result;
  });
  if (info.project.name === 'mobile') { expect(scrolling.overflows).toBe(true); expect(scrolling.moved).toBeGreaterThan(0); }
  expect(scrolling.page).toBe(0);
  await checkpoint(page, info, 'diff', app);
  await page.getByRole('button', {name: 'Commit and push', exact: true}).click();
  const sheet = page.getByRole('dialog', {name: 'Commit and push', exact: true});
  await expect(sheet.getByLabel('Commit message', {exact: true})).toHaveValue(`workspace: commit-push snapshot from ${app.id}`);
  await checkpoint(page, info, 'commit-sheet', app);
  await sheet.getByRole('button', {name: 'Commit and push', exact: true}).click();
  await expect(page.locator('.projects-action-result')).toHaveText(/Committed and pushed [0-9a-f]{7} to origin\/main\./);
  await expect(strip).not.toContainText('changed');
  await page.locator('.projects-tabs').getByRole('link', {name: 'Git', exact: true}).click();
  await expect(page.getByText('Nothing to commit. The tree is clean.', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(page.locator('.projects-commit-row')).toHaveCount(3);
  await page.getByRole('button', {name: 'Fetch', exact: true}).click();
  await expect(page.locator('.projects-action-result')).toHaveText('Fetched. 0 behind, 0 ahead.');
  expect(bodies).toEqual([{message: `workspace: commit-push snapshot from ${app.id}`}, {}]);
});

test('opens the same dirty file diff from the file viewer', async ({page, app}) => {
  await goto(page, app, `/projects/${app.id}/alpha/files?path=docs%2Fdeep%2Fnote.md`);
  await page.getByRole('link', {name: 'Show diff', exact: true}).click();
  await expect(page).toHaveURL(/\/git\?diff=docs%2Fdeep%2Fnote.md$/);
  await expect(page.locator('.projects-diff-added').filter({hasText: 'Updated line'})).toHaveCount(1);
});
