import {test, expect, goto} from './fixture';

test('Pull from others gets one app-pump reply while both compositions are down', async ({page, app}) => {
  await goto(page, app, `/projects/${app.id}/alpha/git`);
  await expect(page.locator('.projects-git').getByText('3 changed', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Pull from others', exact: true}).click();
  await expect(page.getByText(`${app.peer!.id}: replied, skipped, this tree is dirty`, {exact: true})).toBeVisible({timeout: 135_000});
  expect(app.peer!.log.match(/replied pushed for alpha/g)).toHaveLength(1);
  expect(app.peer!.log.match(/pump started node=fixture-b/g)).toHaveLength(1);
  expect(app.log.match(/pump started node=fixture-a/g)).toHaveLength(1);
});

test('Push to others files one merge duty card and Open card shows its detail view', async ({page, app}) => {
  await goto(page, app, `/projects/${app.id}/alpha/git`);
  await expect(page.locator('.projects-git').getByText('3 changed', {exact: true})).toBeVisible();
  const result = page.waitForResponse(response => response.url().endsWith('/alpha/git/push-to-others') && response.request().method() === 'POST');
  await page.getByRole('button', {name: 'Push to others', exact: true}).click();
  const body = await (await result).json();
  expect(body.cards).toHaveLength(1); expect(body.cards[0]).toMatchObject({node: app.peer!.id, status: 'filed'});
  const cardId = body.cards[0].cardId;
  const card = await app.client.getCard(cardId); expect(card).toMatchObject({project: 'alpha', duty: 'merge', placement: {target: app.peer!.id}});
  await expect(page.getByRole('status')).toContainText(`${app.peer!.id}: merge card filed`);
  const link = page.getByRole('link', {name: 'Open card', exact: true}); await expect(link).toHaveAttribute('href', `/embed/kanban-loop?card=${cardId}`);
  await link.click(); await expect(page).toHaveURL(new RegExp(`/embed/kanban-loop\\?card=${cardId}$`));
  const board = page.frameLocator('iframe');
  await expect(board.getByRole('dialog')).toBeVisible();
  await expect(board.getByRole('dialog')).toContainText('merge alpha from fixture-a');
});
