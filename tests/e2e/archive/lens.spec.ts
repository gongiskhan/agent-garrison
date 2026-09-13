import {test,expect,goto} from './fixture';
test('both areas share folder browsing and display options, folders can be created, and document tags cleared',async({page,app})=>{
 await goto(page,app,'/archive/notes?path=Memory');await expect(page.locator('.archive-entries')).toContainText('Welcome');await page.getByRole('button',{name:'Thumbnail view',exact:true}).click();await page.locator('.archive-entry').filter({hasText:'Welcome'}).locator('a').click();await expect(page.locator('.archive-note-main')).toContainText('Synthetic memory');
 await goto(page,app);await page.locator('.archive-yours').getByRole('button',{name:'Folder',exact:true}).click();await page.getByLabel('Folder name').fill('New fixture folder');await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.locator('[data-path="Archive/New fixture folder"]')).toBeVisible();await expect(page.locator('.archive-yours .archive-entries')).toHaveClass(/thumbnails/);
 await goto(page,app,'/archive/card?path=Archive%2FHouse%2FHouse%20maintenance');await page.getByRole('button',{name:'Edit tags'}).click();await page.getByLabel('Tags, separated by commas').fill('');await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('button',{name:'Edit tags'})).toHaveText('+ Tags');
});

test('personal folders can be renamed and an empty one moves to Trash',async({page,app})=>{
 await goto(page,app,'/archive/notes?path=Archive');await page.getByRole('button',{name:'Folder',exact:true}).click();await page.getByLabel('Folder name').fill('Empty folder');await page.getByRole('button',{name:'Continue',exact:true}).click();await page.locator('[data-path="Archive/Empty folder"] a').click();
 await page.getByRole('button',{name:'Folder menu'}).click();await page.getByRole('button',{name:'Rename folder',exact:true}).click();await page.getByLabel('Folder name').fill('Renamed folder');await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page).toHaveURL(/Archive%2FRenamed%20folder/);
 await page.getByRole('button',{name:'Folder menu'}).click();await page.getByRole('button',{name:'Delete folder',exact:true}).click();await page.getByRole('button',{name:'Move to trash',exact:true}).click();await expect(page).toHaveURL(/path=Archive$/);await expect(page.locator('[data-path="Archive/Renamed folder"]')).toHaveCount(0);
 await goto(page,app,'/archive/trash');await expect(page.locator('.archive-trash-list')).toContainText('Archive/Renamed folder');
});
