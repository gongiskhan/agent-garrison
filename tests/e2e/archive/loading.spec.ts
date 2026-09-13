import fs from 'node:fs/promises';import path from 'node:path';import {test,expect,goto} from './fixture';
test('folder visits request only immediate children and phones do not load a hidden desktop tree',async({page,app},info)=>{
 const trees:URL[]=[];page.on('request',r=>{const url=new URL(r.url());if(url.pathname==='/api/archive/tree')trees.push(url);});
 await goto(page,app,'/archive/notes?path=Projects%2FGarrison%2FMemory');await expect(page.locator('.archive-note-main .archive-entry')).toHaveCount(3);
 expect(trees.length).toBeGreaterThan(0);expect(trees.every(url=>url.searchParams.get('depth')==='0')).toBe(true);
 if(['phone','mobile'].includes(info.project.name))expect(trees.every(url=>url.searchParams.get('path')==='Projects/Garrison/Memory')).toBe(true);
});
test('large folders show a bounded first page and keep a starred document first across pages',async({page,app})=>{
 const folder='Archive/Large fixture folder';await fs.mkdir(path.join(app.vault,folder));
 await Promise.all(Array.from({length:151},async(_,i)=>{const title='Reference '+String(i).padStart(3,'0'),dir=path.join(app.vault,folder,title);await fs.mkdir(dir);await fs.writeFile(path.join(dir,'index.md'),`---\ngarrison: card\ntitle: ${title}\nstarred: ${i===125}\n---\nSynthetic reference ${i}.\n`);}));
 await goto(page,app,'/archive/notes?path='+encodeURIComponent(folder));const rows=page.locator('.archive-entry[data-kind="card"]');await expect(rows).toHaveCount(100);await expect(rows.first().locator('strong')).toHaveText('Reference 125');await page.getByRole('button',{name:'Show more (51 remaining)',exact:true}).click();await expect(rows).toHaveCount(151);await expect(rows.first().locator('strong')).toHaveText('Reference 125');await expect(rows.last().locator('strong')).toHaveText('Reference 150');
});

test('search and document opening do not wait for a slow status panel',async({page,app})=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let statusSettled=false;
 await page.route('**/api/archive/status',async route=>{await gate;statusSettled=true;await route.continue().catch(()=>{});});
 try{
  await goto(page,app,'/archive/search?q=maintenance');await expect(page.locator('.archive-result').first()).toBeVisible();expect(statusSettled).toBe(false);
  await page.locator('.archive-result').first().click();await expect(page.locator('.archive-card-heading h1')).toHaveText('House maintenance');expect(statusSettled).toBe(false);
 }finally{release();await page.unroute('**/api/archive/status');}
});

test('a cancelled slow search never replaces results for the latest query',async({page,app})=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let requested!:()=>void;const oldRequested=new Promise<void>(r=>requested=r);
 await page.route('**/api/archive/search?**',async route=>{if(new URL(route.request().url()).searchParams.get('q')==='maintenance'){requested();await gate;}await route.continue().catch(()=>{});});
 try{
  await goto(page,app);await page.getByPlaceholder('Search the Archive').fill('maintenance');await oldRequested;
  await page.getByPlaceholder('Search the Archive').fill('cartao');await expect(page.locator('.archive-result strong')).toHaveText(['Cartão de Cidadão']);release();await expect(page.locator('.archive-result strong')).toHaveText(['Cartão de Cidadão']);
 }finally{release();}
});
