import fs from 'node:fs/promises';
import path from 'node:path';
import {test,expect,goto,fixtures} from './fixture';
import {judge} from './vision-judge';
import type {Page,TestInfo} from '@playwright/test';
import type {ArchiveApp} from './fixture';

const documentPath='Archive/House/House maintenance';
const filename='Sample certificate with a deliberately long filename for mobile layout.pdf';
async function safeArea(page:Page,landscape=false){
 await page.addStyleTag({content:`:root { --archive-safe-top: ${landscape?0:59}px; --archive-safe-bottom: ${landscape?21:34}px; --archive-safe-left: ${landscape?59:0}px; --archive-safe-right: ${landscape?59:0}px; }`});
}
async function insideSafeArea(page:Page,landscape=false){
 const insets=landscape?{top:0,bottom:21,left:59,right:59}:{top:59,bottom:34,left:0,right:0};
 const bounds=await page.locator('.archive-viewer button,.archive-viewer a').evaluateAll(elements=>elements.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};}));
 // DOM rectangles can carry floating point noise below one browser layout unit.
 const viewport=page.viewportSize()!;
 for(const b of bounds){expect(b.top).toBeGreaterThanOrEqual(insets.top);expect(b.bottom).toBeLessThanOrEqual(viewport.height-insets.bottom);expect(b.left).toBeGreaterThanOrEqual(insets.left);expect(b.right).toBeLessThanOrEqual(viewport.width-insets.right);expect(Math.round(b.height*64)/64).toBeGreaterThanOrEqual(44);expect(Math.round(b.width*64)/64).toBeGreaterThanOrEqual(44);}
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}
async function screenshot(page:Page,app:ArchiveApp,info:TestInfo,name:string){
 await expect(page.locator('[data-sensitive-expanded="true"]')).toHaveCount(0);
 const file=info.outputPath(`attachment-viewer-${name}-${info.project.name}.png`);
 await page.screenshot({path:file});await info.attach(name,{path:file,contentType:'image/png'});
 if(process.env.ARCHIVE_VISION==='1')await judge(app,file,name,info.project.name,info);
}

test('PDF details stay compact, clear phone safe areas, and keep deletion reachable',async({page,app},info)=>{
 await fs.copyFile(path.join(fixtures,'sample-text.pdf'),path.join(app.vault,documentPath,filename));
 await goto(page,app,'/archive/card?path='+encodeURIComponent(documentPath));
 await safeArea(page);
 const attachment=page.locator('.archive-attachment-open').filter({hasText:filename});
 await attachment.click();
 const viewer=page.getByRole('dialog',{name:filename,exact:true});
 await expect(viewer).toBeVisible();
 await insideSafeArea(page);
 const bounds=await viewer.boundingBox();expect(bounds!.height).toBeLessThan(480);
 const open=viewer.getByRole('link',{name:'Open PDF',exact:true});await expect(open).toBeVisible();
 const url=await open.getAttribute('href');expect(url).toBe('/api/archive/file?path='+encodeURIComponent(documentPath+'/'+filename));
 const response=await page.request.get(app.base+url);expect(response.status()).toBe(200);expect(response.headers()['content-type']).toBe('application/pdf');
 await screenshot(page,app,info,'attachment-file');
 await viewer.getByRole('button',{name:'Delete',exact:true}).click();
 const confirm=page.getByRole('dialog',{name:'Delete attachment',exact:true});await expect(confirm).toBeVisible();
 await confirm.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(viewer).toBeVisible();await insideSafeArea(page);
 await viewer.getByRole('button',{name:'Close viewer'}).click();await expect(viewer).toHaveCount(0);
 await expect(attachment).toBeFocused();
 await attachment.click();await page.keyboard.press('Escape');await expect(viewer).toHaveCount(0);
 await attachment.click();await viewer.getByRole('button',{name:'Delete',exact:true}).click();
 await confirm.getByRole('button',{name:'Move to trash',exact:true}).click();
 await expect(attachment).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(await fs.stat(path.join(app.vault,documentPath,filename)).catch(()=>null)).toBeNull();
});

test('image controls fit portrait, landscape and a short viewport; zoom resets on reopen',async({page,app},info)=>{
 await goto(page,app,'/archive/card?path='+encodeURIComponent(documentPath));await safeArea(page);
 const attachment=page.locator('.archive-attachment-open').first();await attachment.click();
 const viewer=page.locator('.archive-viewer');await expect(viewer).toBeVisible();await insideSafeArea(page);
 const image=viewer.locator('img');await expect(image).toBeVisible();await image.evaluate((el:HTMLImageElement)=>el.decode());
 await screenshot(page,app,info,'attachment-image');
 await viewer.getByRole('button',{name:'Zoom image'}).click();
 expect(await image.evaluate(el=>el.getBoundingClientRect().width)).toBeGreaterThan(page.viewportSize()!.width);
 await viewer.getByRole('button',{name:'Close viewer'}).click();await attachment.click();
 expect(await viewer.locator('img').evaluate(el=>el.getBoundingClientRect().width)).toBeLessThanOrEqual(page.viewportSize()!.width);
 await page.setViewportSize({width:844,height:390});await safeArea(page,true);await insideSafeArea(page,true);
 await screenshot(page,app,info,'attachment-landscape');
 await page.setViewportSize({width:320,height:568});await safeArea(page);await insideSafeArea(page);
 await viewer.getByRole('button',{name:'Set as cover',exact:true}).click();await expect(viewer).toHaveCount(0);
});
