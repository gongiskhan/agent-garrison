import fs from 'node:fs/promises';import path from 'node:path';import {test,expect,goto,checkpoint} from './fixture';
test('documents sort alphabetically, starred first, with recent ordering and a persistent view choice',async({page,app},info)=>{
 await goto(page,app,'/archive/notes?path=Archive%2FHouse');const rows=page.locator('.archive-entry[data-kind="card"]');
 await expect(rows.locator('strong')).toHaveText(['House maintenance','Kitchen receipts']);await expect(page.getByRole('button',{name:/Reorder/})).toHaveCount(0);await checkpoint(page,info,'board',app);
 await page.getByRole('button',{name:'Star Kitchen receipts',exact:true}).click();await expect(rows.first()).toContainText('Kitchen receipts');expect(await fs.readFile(path.join(app.vault,'Archive/House/Kitchen receipts/index.md'),'utf8')).toContain('starred: true');
 await page.reload();await expect(rows.first()).toContainText('Kitchen receipts');await checkpoint(page,info,'board-starred',app);
 await page.getByRole('button',{name:'Document',exact:true}).click();await page.getByLabel('Document title',{exact:true}).fill('Alpha fixture document');await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('heading',{name:'Alpha fixture document',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Back',exact:true}).click();await expect(rows.locator('strong')).toHaveText(['Kitchen receipts','Alpha fixture document','House maintenance']);
 await page.getByLabel('Sort by').selectOption('created');await expect(rows.nth(1)).toContainText('Alpha fixture document');
 const old=await (await page.request.get(app.base+'/api/archive/card?path=Archive%2FHouse%2FHouse%20maintenance')).json();await page.request.patch(app.base+'/api/archive/card',{data:{path:old.path,baseSha:old.sha,description:'Most recently updated fixture'}});
 await page.getByLabel('Sort by').selectOption('updated');await page.reload();await expect(rows.nth(1)).toContainText('House maintenance');
 await page.getByRole('button',{name:'Thumbnail view',exact:true}).click();await expect(page.locator('.archive-entries')).toHaveClass(/thumbnails/);await page.reload();await expect(page.locator('.archive-entries')).toHaveClass(/thumbnails/);
 await page.getByRole('button',{name:'List view',exact:true}).click();await expect(page.locator('.archive-entries')).toHaveClass(/list/);
});
test('list rows use small left images or letters and documents move through the folder chooser',async({page,app},info)=>{
 await goto(page,app,'/archive/notes?path=Archive%2FHouse');const entry=page.locator('[data-path="Archive/House/House maintenance"]');await expect(entry.locator('img')).toBeVisible();
 const image=(await entry.locator('img').boundingBox())!,text=(await entry.locator('strong').boundingBox())!;expect(image.width).toBeLessThanOrEqual(64);expect(image.height).toBeLessThanOrEqual(64);expect(image.x+image.width).toBeLessThanOrEqual(text.x);
 expect((await page.request.post(app.base+'/api/archive/card',{data:{list:'Archive/House',title:'Text-only reference'}})).ok()).toBe(true);await page.reload();const plain=page.locator('[data-path="Archive/House/Text-only reference"]');await expect(plain.locator('.archive-entry-letter')).toHaveText('T');await expect(plain.locator('img')).toHaveCount(0);expect((await plain.boundingBox())!.height).toBeLessThan(145);await checkpoint(page,info,'board',app);
 await entry.locator('a').click();await page.getByRole('button',{name:'Document menu'}).click();await page.getByRole('button',{name:'Move to folder…',exact:true}).click();await page.getByRole('button',{name:'Finance',exact:true}).click();await expect(page).toHaveURL(/Archive%2FFinance%2FHouse%20maintenance/);expect(await fs.stat(path.join(app.vault,'Archive/Finance/House maintenance/sample-document.jpg.md'))).toBeTruthy();
});
