import {test,expect,goto,checkpoint} from './fixture';
test('bookmarks save documents and notes, stay distinct from stars and reopen the original item',async({page,app},info)=>{
 await goto(page,app);await page.getByRole('link',{name:'Bookmarks',exact:true}).click();await expect(page.getByText('Bookmark a document or note to find it quickly here.')).toBeVisible();await expect(page.getByLabel('Website address')).toHaveCount(0);
 await goto(page,app,'/archive/notes?path=Archive%2FHouse');await page.getByRole('button',{name:'Bookmark House maintenance',exact:true}).click();await expect(page.getByRole('button',{name:'Remove bookmark for House maintenance',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('button',{name:'Star House maintenance',exact:true})).toHaveAttribute('aria-pressed','false');
 await goto(page,app,'/archive/notes?path=Projects%2FGarrison%2FMemory%2FArchitecture.md');await page.getByRole('button',{name:'Bookmark Architecture',exact:true}).click();await expect(page.getByRole('button',{name:'Remove bookmark for Architecture',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Bookmarks',exact:true}).click();await expect(page.locator('.archive-entry strong')).toHaveText(['Architecture','House maintenance']);await page.reload();await expect(page.locator('.archive-entry')).toHaveCount(2);await checkpoint(page,info,'bookmarks',app);
 await page.locator('.archive-entry').filter({hasText:'House maintenance'}).locator('a').click();await expect(page.locator('.archive-card-heading h1')).toHaveText('House maintenance');await page.getByRole('button',{name:'Remove bookmark for House maintenance',exact:true}).click();await expect(page.getByRole('button',{name:'Bookmark House maintenance',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Bookmarks',exact:true}).click();await expect(page.locator('.archive-entry strong')).toHaveText(['Architecture']);
 await goto(page,app,'/archive/search?q=Architecture&bookmarked=1');await expect(page.locator('.archive-result strong')).toHaveText(['Architecture']);await expect(page.getByRole('button',{name:'Bookmarked',exact:true})).toHaveAttribute('aria-pressed','true');
});

test('a missing bookmark can be removed without touching any document',async({page,app})=>{
 const p='Archive/House/House maintenance';await page.request.post(app.base+'/api/archive/bookmark',{data:{path:p,bookmarked:true}});await page.request.delete(app.base+'/api/archive/card',{data:{path:p}});
 await goto(page,app,'/archive/bookmarks');await page.getByText('Unavailable bookmarks (1)',{exact:true}).click();await page.getByRole('button',{name:'Remove bookmark for House maintenance',exact:true}).click();await expect(page.getByText('Unavailable bookmarks (1)',{exact:true})).toHaveCount(0);
 const trash=await (await page.request.get(app.base+'/api/archive/trash')).json();expect(trash.entries.some((e:any)=>e.original===p)).toBe(true);
});

test('ordinary notes use the same star ordering as documents',async({page,app})=>{
 await goto(page,app,'/archive/notes?path=Memory');await page.getByRole('button',{name:'Star Welcome',exact:true}).click();await expect(page.locator('.archive-entry strong').first()).toHaveText('Welcome');await page.reload();await expect(page.locator('.archive-entry strong').first()).toHaveText('Welcome');await page.locator('.archive-entry a').first().click();await expect(page.getByRole('button',{name:'Unstar note',exact:true})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Unstar note',exact:true}).click();await expect(page.getByRole('button',{name:'Star note',exact:true})).toHaveAttribute('aria-pressed','false');
});
