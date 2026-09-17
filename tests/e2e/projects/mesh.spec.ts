import {test, expect, goto, checkpoint} from './fixture';
test('browses and fetches on the peer and keeps its workspace read-only', async ({page, app, request}, info) => {
  const peer = app.peer!;
  await goto(page, app);
  const groups = page.locator('.projects-node-group'); await expect(groups).toHaveCount(2);
  await expect(groups.first()).toHaveAttribute('data-node', app.id); await expect(groups.last()).toHaveAttribute('data-node', peer.id);
  await expect(groups.last().getByRole('link').filter({hasText: /^delta/})).toContainText('1 changed');
  expect(await groups.first().evaluate(element => getComputedStyle(element).getPropertyValue('--node-accent'))).not.toBe(await groups.last().evaluate(element => getComputedStyle(element).getPropertyValue('--node-accent')));
  await checkpoint(page, info, 'mesh-picker', app);
  await groups.last().getByRole('link').filter({hasText: /^delta/}).click();
  await expect(page.locator('.projects-file-row').filter({hasText: 'README.md'})).toBeVisible();
  await page.locator('.projects-tabs').getByRole('link', {name: 'Git', exact: true}).click();
  await expect(page.locator('.projects-project-header')).toContainText(peer.name);
  await expect(page.locator('.projects-status-strip')).toContainText('main');
  await expect(page.locator('.projects-status-strip')).toContainText('1 changed');
  await checkpoint(page, info, 'peer-git', app);
  const logStart = peer.log.length;
  await page.getByRole('button', {name: 'Fetch', exact: true}).click();
  await expect(page.locator('.projects-action-result')).toHaveText('Fetched. 0 behind, 0 ahead.');
  expect(peer.log.slice(logStart)).toContain(`[projects] git fetch project=delta node=${peer.id}`);
  expect(app.log).not.toContain('[projects] git fetch project=delta');
  await goto(page, app, `/projects/${peer.id}/workspace?path=documents%2F2026-09-13-note.md`);
  await expect(page.getByRole('heading', {name: 'Synthetic note', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Edit', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'New folder', exact: true})).toHaveCount(0);
  expect((await request.put(app.base + `/api/mesh/nodes/${peer.id}/workspace/file`, {data: {path: 'note.md', content: 'refused'}})).status()).toBe(405);
  expect((await request.post(app.base + `/api/mesh/nodes/${peer.id}/workspace/mkdir`, {data: {path: 'refused'}})).status()).toBe(403);
});


test('offline and unreachable nodes show the retry copy without stale project rows', async ({page, app}, info) => {
  const peer = app.peer!; let offline = true;
  await page.route('**/api/mesh/nodes', async route => {
    const response = await route.fetch(), body = await response.json();
    body.nodes = body.nodes.map((node: {id: string}) => node.id === peer.id ? {...node, name: peer.name, state: offline ? 'offline' : (node as {state?: string}).state} : node);
    await route.fulfill({response, json: body});
  });
  await goto(page, app);
  const group = page.locator(`.projects-node-group[data-node="${peer.id}"]`);
  await expect(group).toContainText(`${peer.name} is offline. Its projects will appear when it is back.`);
  await expect(group.getByRole('link')).toHaveCount(0);
  offline = false;
  await page.route(`**/api/mesh/nodes/${peer.id}/projects`, route => route.fulfill({status: 502, json: {error: 'peer-unreachable'}}));
  await page.reload();
  await expect(group).toContainText(`${peer.name} did not answer.`);
  await expect(group.locator(info.project.name === 'mobile' ? '.projects-phone-copy' : '.projects-desktop-copy')).toBeVisible();
  await expect(group.getByRole('link')).toHaveCount(0);
  await page.unroute(`**/api/mesh/nodes/${peer.id}/projects`);
  await group.getByRole('button', {name: 'Try again'}).click();
  await expect(group.getByRole('link').filter({hasText: /^delta/})).toBeVisible();
});

test('shared-state failure disables git actions while file browsing remains available', async ({page, app}) => {
  const message = 'Shared state is unreachable. Git actions need it; browsing still works.';
  await page.route('**/api/mesh/nodes', route => route.fulfill({status: 503, json: {error: message}}));
  await goto(page, app, `/projects/${app.id}/alpha/git`);
  await expect(page.getByText(message, {exact: true})).toBeVisible();
  for (const name of ['Fetch', 'Commit and push', 'Pull from others', 'Push to others']) await expect(page.getByRole('button', {name, exact: true})).toBeDisabled();
  await page.locator('.projects-tabs').getByRole('link', {name: 'Files', exact: true}).click();
  await page.locator('.projects-file-row').filter({hasText: 'README.md'}).click();
  await expect(page.locator('.projects-markdown h1')).toHaveText('Alpha');
  await expect(page.getByRole('button', {name: 'Edit', exact: true})).toHaveCount(0);
});
