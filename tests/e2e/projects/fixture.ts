import path from 'node:path';
import {test as base, expect, type Page, type TestInfo} from '@playwright/test';
import {startProjectsApp, type ProjectsApp} from './app-fixture';
import {judge} from './vision-judge';

export {startProjectsApp, expect};
export type {ProjectsApp};
export async function isolateShell(page: Page, app: ProjectsApp) {
  await page.route(/\/api\/(?!projects(?:\/|$)|workspace\/|mesh\/(?:self|nodes)(?:\/|$)|archive\/)/, route => {
    if (new URL(route.request().url()).origin !== app.base) return route.continue();
    const values: Record<string, unknown> = {'/api/fittings/views': {views: app.boardBase ? [{fittingId: 'kanban-loop', url: app.boardBase, port: Number(new URL(app.boardBase).port), healthy: true, tailnetUrl: null}] : []}, '/api/library': {entries: []}, '/api/compositions': {compositions: []}, '/api/vault/secrets': {secrets: []}, '/api/composition/active': {id: 'fixture'}, '/api/runner': {runners: []}, '/api/sidebar/pins': {pins: []}, '/api/nodes/current': {id: 'fixture-a'}, '/api/messages/counts': {counts: {all: 0}}};
    return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(values[new URL(route.request().url()).pathname] || {})});
  });
}
export const test = base.extend<{app: ProjectsApp}>({
  serviceWorkers: 'block',
  app: async ({}, use, info) => {
    info.setTimeout(process.env.PROJECTS_VISION === '1' ? 600_000 : 240_000);
    const peer = /\/(mesh|pull)\.spec\.ts$/.test(info.file);
    const app = await startProjectsApp({peer, pump: info.file.endsWith('/pull.spec.ts')});
    try {await use(app);} finally {
      await app.stop();
      await info.attach('self-server-log', {body: app.log, contentType: 'text/plain'});
      if (app.peer) await info.attach('peer-server-log', {body: app.peer.log, contentType: 'text/plain'});
    }
  },
  page: async ({page, app}, use) => {
    void app;
    const errors: string[] = [], gitBodies: Record<string, unknown>[] = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {if (request.method() === 'POST' && /\/projects\/[^/]+\/git\//.test(request.url())) gitBodies.push(JSON.parse(request.postData() || '{}'));});
    await isolateShell(page, app); await use(page);
    await page.unrouteAll({behavior: 'wait'}); await page.close();
    expect(errors, 'No runtime errors during the Projects journey').toEqual([]);
    for (const body of gitBodies) expect(body, 'Every UI git action omits force').not.toHaveProperty('force');
  }
});
export async function goto(page: Page, app: ProjectsApp, route = '/projects') {
  await page.goto(app.base + route); await expect(page.locator('.projects-app')).toBeVisible();
}
export async function checkpoint(page: Page, info: TestInfo, name: string, app: ProjectsApp) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.projects-app img').evaluateAll(async images => {await Promise.all(images.map(image => (image as HTMLImageElement).decode().catch(() => {})));});
  const file = info.outputPath(`${path.basename(info.file, '.spec.ts')}-${name}-${info.project.name}.png`);
  await page.screenshot({path: file, fullPage: true}); await info.attach(name, {path: file, contentType: 'image/png'});
  if (process.env.PROJECTS_VISION === '1') await judge(app, file, name, info);
}
