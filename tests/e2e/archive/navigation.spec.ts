import { test, expect, goto } from './fixture';
import { edit } from './editor';

test('visible Back restores search, survives reload, and browser Back/Forward does not loop', async ({ page, app }) => {
  await goto(page, app);
  await page.getByPlaceholder('Search the Archive').fill('maintenance');
  await page.getByRole('button', { name: 'Yours', exact: true }).click();
  await page.getByRole('button', { name: 'Cards', exact: true }).click();
  await page.locator('.archive-result').first().click();
  await expect(page.getByRole('heading', { name: 'House maintenance', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page.getByPlaceholder('Search the Archive')).toHaveValue('maintenance');
  await expect(page.locator('.archive-result').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yours', exact: true })).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button', { name: 'Cards', exact: true })).toHaveAttribute('aria-pressed','true');
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'House maintenance', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByPlaceholder('Search the Archive')).toHaveValue('maintenance');
});

test('note Back returns one folder and a direct card link has a useful list fallback', async ({ page, app }) => {
  await goto(page, app, '/archive/notes?path=Projects%2FGarrison%2FMemory');
  await page.locator('.archive-note-main').getByRole('link', { name: /Architecture/ }).click();
  await expect(page.locator('.archive-note-main h1').first()).toHaveText('Architecture');
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/path=Projects%2FGarrison%2FMemory$/);
  await page.evaluate(() => sessionStorage.removeItem('archive.navigation'));
  await goto(page, app, '/archive/card?path=Archive%2FHouse%2FHouse%20maintenance');
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/archive\/board\?path=Archive%2FHouse$/);
  await expect(page.locator('[data-list="Archive/House"]')).toBeVisible();
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(app.base+'/archive');
});

test('visible Back preserves an unsaved editor when cancelled', async ({ page, app }, info) => {
  await goto(page, app);
  await page.getByPlaceholder('Search the Archive').fill('maintenance');
  await page.locator('.archive-result').first().click();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await edit(page, 'Description editor', 'Unsaved fixture changes', info.project.name);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('link', { name: 'Back', exact: true }).click();
  await expect(page.getByPlaceholder('Search the Archive')).toHaveValue('maintenance');
});
