import fs from 'node:fs/promises';import path from 'node:path';import {test,expect,goto} from './fixture';
test('direct card and note URLs and rendered Archive links work',async({page,app})=>{await goto(page,app,'/archive/card?path='+encodeURIComponent('Archive/House/House maintenance'));await expect(page.getByRole('heading',{name:'House maintenance',exact:true})).toBeVisible();await fs.writeFile(path.join(app.vault,'Memory/Links.md'),'# Links\n\n[House](garrison://archive/Archive/House/House%20maintenance)\n\n[Architecture](garrison://archive/Projects/Garrison/Memory/Architecture.md)\n\n[[House maintenance]]\n');await goto(page,app,'/archive/notes?path=Memory%2FLinks.md');const note=page.locator('.archive-note-main');await expect(note.getByRole('link',{name:'House',exact:true})).toHaveAttribute('href','/archive/card?path=Archive%2FHouse%2FHouse%20maintenance');await note.getByRole('link',{name:'Architecture',exact:true}).click();await expect(page.locator('.archive-note-main h1').first()).toHaveText('Architecture');});

test('folder links, images and bookmark writes work from a non-localhost HTTPS origin',async({page,app})=>{
 const origin='https://archive-fixture.invalid';
 await page.route(origin+'/**',async route=>{
  const incoming=new URL(route.request().url());if(/^\/api\/(?!archive\/)/.test(incoming.pathname))return route.fallback();
  const response=await route.fetch({url:app.base+incoming.pathname+incoming.search,headers:{...route.request().headers(),host:incoming.host}});
  await route.fulfill({response});
 });
 await page.goto(origin+'/archive/notes?path=Archive%2FHouse');await expect(page.locator('.archive-entry').first()).toBeVisible();
 await page.getByRole('button',{name:'Bookmark House maintenance',exact:true}).click();await expect(page.getByRole('button',{name:'Remove bookmark for House maintenance',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Bookmarks',exact:true}).click();await expect(page.getByRole('heading',{name:'Bookmarks',exact:true})).toBeVisible();await expect(page.locator('.archive-entry')).toHaveCount(1);await page.locator('.archive-entry a').click();await expect(page.locator('.archive-card-heading h1')).toHaveText('House maintenance');expect(new URL(page.url()).origin).toBe(origin);
 await expect.poll(()=>page.locator('.archive-app img').first().evaluate(n=>(n as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
 const images=await page.locator('.archive-app img').evaluateAll(nodes=>nodes.map(n=>(n as HTMLImageElement).src));expect(images.length).toBeGreaterThan(0);expect(images.every(src=>new URL(src).origin===origin)).toBe(true);
});
